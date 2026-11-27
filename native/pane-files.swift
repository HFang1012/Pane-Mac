// Tweak's native helper. Pane runs it for the two things Electron can't do on its own:
//
//   pane-files hover <panePid>     Reads "x y" lines on stdin. For each, answers with one JSON line: the file
//                                  under that screen point on the desktop, in a Finder window or in any app's
//                                  Open/Save dialog (its path and its frame on screen), or {} for none. Uses
//                                  Accessibility, which Pane has.
//   pane-files media '<json>'      Trims, crops, rotates, flips, mutes or quiets a video or a song, or pulls the
//                                  sound out of a video, with AVFoundation. Prints {"progress":0.4} lines while
//                                  it works and {"ok":true} or {"error":"…"} at the end. "size" makes it smaller:
//                                  "smaller" is HEVC video at ~0.1 bits a pixel / 96 kbps sound, "smallest" caps video
//                                  at 960×540 and ~0.06 bits a pixel, and sound at 64 kbps.
//   pane-files frame <in> <sec> <out.png>   Saves one frame of a video as a picture.
//   pane-files frames <in> <outdir>          Every frame of a picture (a GIF's or APNG's frames, an icon's sizes, a
//                                            TIFF's pages) as PNGs in outdir. Prints {"count":n,"frames":[…]}; one
//                                            frame prints just {"count":1} and writes nothing.
//   pane-files assemble '<json>'             The other way: PNGs (with delays, or @2x sizes) into one animated GIF or
//                                            PNG, an icon (ICNS, ICO), or a TIFF or PDF of pages.
//   pane-files probe <in>                    A video's or song's size, frame rate and bit rates, for size estimates.
//   pane-files wifi scan                     Plugin's Wi-Fi list: {"wifi":[{device,ssid,current}],"networks":[{ssid,rssi,secure,device}],"named":bool}.
//                                            macOS hides network names from apps without Location access (named:false).
//   pane-files wifi join                     Reads {"device","ssid","password"} from stdin and joins that network.
//   pane-files tap                           Plugin's per-app volume. Reads lines on stdin: "pids <pid>…" (the app's
//                                            processes) and "gain <0…2>". Taps those processes' sound (Core Audio
//                                            process taps, macOS 14.2+), mutes the original and plays it back at that
//                                            gain. Prints {"tapped":n,"peak":x} once a second. Quits when stdin closes,
//                                            and macOS removes the tap with it, so the app's sound is back as it was.
//   pane-files windows <panePid>             Plugin's eyes. Reads one command a line on stdin and answers each with
//                                            one JSON line (see windowsServe): the windows on screen, front to back,
//                                            the apps that are running, and hiding or showing apps for Focus mode.
//
// "quality" (0…1) for media squeezes continuously; 1 is as it is. Pane's editor estimates the result with the
// same numbers (edit.js, mediaEstimate), so keep the two in step.
//
// Built by scripts/native.js (and by Pane itself the first time, while you're working on it).
import Cocoa
import AVFoundation
import UniformTypeIdentifiers
import CoreWLAN
import CoreAudio
import CoreLocation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) { print(s) }
}

// ---------- hover: what file is under the pointer ----------

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func role(_ e: AXUIElement) -> String { (attr(e, kAXRoleAttribute) as? String) ?? "" }
func frameOf(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute),
        CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}
// Finder hands out file reference URLs (file:///.file/id=…); turn them into real paths.
func filePath(_ e: AXUIElement) -> String? {
  guard let v = attr(e, kAXURLAttribute) else { return nil }
  var url: URL?
  if let u = v as? NSURL { url = u.filePathURL } else if let s = v as? String { url = URL(string: s) }
  guard let u = url, u.isFileURL else { return nil }
  let path = u.path
  return path.isEmpty || path == "/" ? nil : path
}
// Column views (in Finder and in Open/Save dialogs) keep each column's list under AXContents, not AXChildren.
func children(_ e: AXUIElement) -> [AXUIElement] {
  for name in ["AXVisibleRows", kAXVisibleChildrenAttribute, kAXChildrenAttribute, "AXContents"] {
    if let kids = attr(e, name) as? [AXUIElement], !kids.isEmpty { return kids }
  }
  return []
}
// A file anywhere inside a list row (its icon or its name cell carries the URL).
func pathInside(_ e: AXUIElement, depth: Int) -> String? {
  if let p = filePath(e) { return p }
  if depth <= 0 { return nil }
  for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
    if let p = pathInside(k, depth: depth - 1) { return p }
  }
  return nil
}

struct Hit { let path: String; let frame: CGRect }

// Our own hit-test: walk down only into elements whose frame holds the point. The system-wide
// AXUIElementCopyElementAtPosition would find Pane's own targeting layer, which sits on top of everything.
func descend(_ e: AXUIElement, _ pt: CGPoint, _ depth: Int) -> Hit? {
  if depth > 16 { return nil }
  for k in children(e).reversed() { // later children are drawn on top
    let f = frameOf(k)
    if let f = f, !f.insetBy(dx: -1, dy: -1).contains(pt) { continue }
    let r = role(k)
    if r == "AXRow" || r == "AXCell" {
      if let p = pathInside(k, depth: 4), let f = f { return Hit(path: p, frame: f) }
    }
    // A column view's item: a small group of the file's icon and its name (which carries the URL).
    if r == "AXGroup", let f = f, f.height < 120 {
      if let p = (attr(k, kAXChildrenAttribute) as? [AXUIElement])?.lazy.compactMap({ filePath($0) }).first { return Hit(path: p, frame: f) }
    }
    if let hit = descend(k, pt, depth + 1) { return hit }
    if let p = filePath(k), let f = f { return Hit(path: p, frame: f) }
  }
  return nil
}

// Sandboxed apps' Open/Save dialogs are drawn by this service, in a window it owns, on the app's behalf.
let panelService = "com.apple.appkit.xpc.openAndSavePanelService"
// Open/Save dialogs that aren't sheets float at the modal-panel level.
let modalPanelLayer = Int(CGWindowLevelForKey(.modalPanelWindow))

// The window in front at this point that isn't Pane's.
func windowAt(_ pt: CGPoint, skip: Set<pid_t>) -> (pid: pid_t, layer: Int, bounds: CGRect)? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list {
    guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, !skip.contains(pid) else { continue }
    if let a = w[kCGWindowAlpha as String] as? Double, a < 0.05 { continue }
    // The Window Server's own surfaces are never what you're pointing at. One of them ("underbelly") lies
    // over the top ~100 points of the screen, just above the desktop's icons, and hid the top row from Tweak.
    if (w[kCGWindowOwnerName as String] as? String) == "Window Server" { continue }
    guard let bd = w[kCGWindowBounds as String] as? NSDictionary, let b = CGRect(dictionaryRepresentation: bd as CFDictionary),
          b.contains(pt) else { continue }
    let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
    // Floating windows are looked through: the menu bar, the Dock (whose window spans the whole screen),
    // see-through overlays like the screenshot tool's, other apps' panels. Files live in normal windows,
    // on the desktop, and in Open/Save dialogs (which float a little).
    if layer > 0 && layer != modalPanelLayer && layer != modalPanelLayer + 1 { continue }
    return (pid, layer, b)
  }
  return nil
}

func near(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX - b.minX) < 3 && abs(a.minY - b.minY) < 3 && abs(a.width - b.width) < 3 && abs(a.height - b.height) < 3
}

// An app's windows and the sheets hanging off them (an Open/Save sheet is a child of its window). Some apps
// (Discord, and others built on Electron) list no windows at all while a sheet is up, but their focused
// window is the sheet itself.
func windowsAndSheets(_ app: AXUIElement) -> [AXUIElement] {
  var out: [AXUIElement] = []
  var tops = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if let f = attr(app, kAXFocusedWindowAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() { tops.append(f as! AXUIElement) }
  for w in tops {
    out.append(w)
    for k in (attr(w, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where role(k) == "AXSheet" { out.append(k) }
  }
  return out
}
func isFileDialog(_ e: AXUIElement) -> Bool {
  let sub = (attr(e, kAXSubroleAttribute) as? String) ?? ""
  return role(e) == "AXSheet" || sub == "AXDialog" || sub == "AXSystemDialog"
}

// The Accessibility element for an on-screen window in some app other than Finder: only an Open/Save dialog
// (a sheet or a dialog) counts, so Pane never walks a whole browser page or document looking for files.
func dialogElement(pid: pid_t, bounds: CGRect) -> AXUIElement? {
  let owner = NSRunningApplication(processIdentifier: pid)
  let isService = owner?.bundleIdentifier == panelService
  var apps: [pid_t] = [pid]
  // The service's window holds a view of the dialog that's read through the app it's for, which is in front.
  if isService, let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front != pid { apps.insert(front, at: 0) }
  for p in apps {
    let app = AXUIElementCreateApplication(p)
    for w in windowsAndSheets(app) {
      guard let f = frameOf(w), near(f, bounds) else { continue }
      if isService || isFileDialog(w) { return w }
    }
  }
  return nil
}

func hover(panePid: pid_t) {
  var skip: Set<pid_t> = [getpid()]
  if panePid > 0 { skip.insert(panePid) }
  while let line = readLine() {
    let parts = line.split(separator: " ").compactMap { Double($0) }
    guard parts.count >= 2 else { emit([:]); continue }
    let pt = CGPoint(x: parts[0], y: parts[1])
    // PANE_HOVER_DESKTOP looks only at the desktop's icons, whatever is in front (for testing).
    let forceDesktop = ProcessInfo.processInfo.environment["PANE_HOVER_DESKTOP"] != nil
    let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first
    guard let win = forceDesktop ? (finder?.processIdentifier ?? 0, -1, CGRect.null) : windowAt(pt, skip: skip) else { emit([:]); continue }
    var hit: Hit?
    if let finder = finder, win.pid == finder.processIdentifier {
      let app = AXUIElementCreateApplication(finder.processIdentifier)
      if win.layer < 0 {
        // The desktop: Finder's scroll area of icons (not one of its AXWindows).
        for top in (attr(app, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where role(top) == "AXScrollArea" {
          hit = descend(top, pt, 0)
          if hit != nil { break }
        }
      } else if let w = windowsAndSheets(app).first(where: { frameOf($0).map { near($0, win.bounds) } ?? false }) {
        hit = descend(w, pt, 0)
      }
    } else if win.layer >= 0, let d = dialogElement(pid: win.pid, bounds: win.bounds) {
      // Another app asking for a file: its Open/Save dialog lists files much like a Finder window.
      hit = descend(d, pt, 0)
    }
    if let h = hit {
      var isDir: ObjCBool = false
      FileManager.default.fileExists(atPath: h.path, isDirectory: &isDir)
      let pkg = NSWorkspace.shared.isFilePackage(atPath: h.path)
      emit(["path": h.path, "x": h.frame.minX, "y": h.frame.minY, "w": h.frame.width, "h": h.frame.height, "dir": isDir.boolValue || pkg, "desktop": win.layer < 0])
    } else {
      emit([:])
    }
  }
}

// ---------- media: video and sound ----------

struct MediaOpts: Decodable {
  let input: String
  let output: String
  let format: String // mp4 mov m4v gif | m4a wav aiff caf
  var start: Double?
  var end: Double?
  var crop: [Double]? // x y w h, in the video's upright pixels
  var rotate: Int? // extra quarter turns clockwise: 90 180 270
  var flipH: Bool?
  var flipV: Bool?
  var volume: Double? // 0…1
  var mute: Bool?
  var gifFps: Double?
  var gifWidth: Double?
  var size: String? // full | smaller | smallest: how hard to squeeze the file (older; quality wins)
  var quality: Double? // 0…1: how much to keep. 1 is as it is
  var q: Double { quality ?? (size == "smallest" ? 0.15 : size == "smaller" ? 0.55 : 1) }
  var squeezed: Bool { q < 0.999 }
}

// What a squeeze keeps, from quality q (0…1). Mirrored in edit.js.
func squeezeLongSide(_ q: Double) -> CGFloat? { q < 0.2 ? 960 : q < 0.45 ? 1280 : q < 0.7 ? 1920 : nil }
func squeezeBitsPerPixel(_ q: Double) -> Double { 0.025 + 0.2 * q }
func squeezeAudioRate(_ q: Double) -> Int { q < 0.25 ? 64000 : q < 0.5 ? 96000 : q < 0.75 ? 128000 : 160000 }

func fail(_ msg: String) -> Never { emit(["error": msg]); exit(1) }

func even(_ v: CGFloat) -> CGFloat { max(2, (v / 2).rounded(.down) * 2) }

// Move a transformed rectangle back so its top-left corner is at 0,0.
func normalized(_ t: CGAffineTransform, _ size: CGSize) -> (CGAffineTransform, CGSize) {
  let r = CGRect(origin: .zero, size: size).applying(t)
  return (t.concatenating(CGAffineTransform(translationX: -r.minX, y: -r.minY)), CGSize(width: abs(r.width), height: abs(r.height)))
}

func media(_ json: String) {
  guard let data = json.data(using: .utf8), let o = try? JSONDecoder().decode(MediaOpts.self, from: data) else { fail("Bad options.") }
  let inURL = URL(fileURLWithPath: o.input), outURL = URL(fileURLWithPath: o.output)
  let asset = AVURLAsset(url: inURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
  let duration = asset.duration
  guard duration.seconds > 0 else { fail("Pane can't read this file.") }
  let s = max(0, o.start ?? 0), e = min(duration.seconds, o.end ?? duration.seconds)
  guard e - s > 0.05 else { fail("The clip is too short.") }
  let range = CMTimeRange(start: CMTime(seconds: s, preferredTimescale: 600), end: CMTime(seconds: e, preferredTimescale: 600))

  let audioOut = ["m4a", "wav", "aiff", "caf"].contains(o.format)
  let comp = AVMutableComposition()
  let srcVideo = asset.tracks(withMediaType: .video).first
  var compVideo: AVMutableCompositionTrack?
  if !audioOut, let v = srcVideo {
    compVideo = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    do { try compVideo?.insertTimeRange(range, of: v, at: .zero) } catch { fail("Couldn't read the video.") }
  }
  if !audioOut && srcVideo == nil { fail("This file has no picture.") }
  var compAudio: [AVMutableCompositionTrack] = []
  if o.mute != true || audioOut {
    for a in asset.tracks(withMediaType: .audio) {
      guard let t = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
      do { try t.insertTimeRange(range, of: a, at: .zero); compAudio.append(t) } catch {}
    }
  }
  if audioOut && compAudio.isEmpty { fail("This file has no sound.") }

  // Picture: upright it, crop, turn and flip, all in one transform.
  var videoComp: AVMutableVideoComposition?
  if let v = srcVideo, let cv = compVideo {
    var (t, size) = normalized(v.preferredTransform, v.naturalSize)
    if let c = o.crop, c.count == 4, c[2] > 4, c[3] > 4 {
      let x = max(0, min(CGFloat(c[0]), size.width - 4)), y = max(0, min(CGFloat(c[1]), size.height - 4))
      let w = min(CGFloat(c[2]), size.width - x), h = min(CGFloat(c[3]), size.height - y)
      t = t.concatenating(CGAffineTransform(translationX: -x, y: -y))
      size = CGSize(width: w, height: h)
    }
    let quarter = ((o.rotate ?? 0) % 360 + 360) % 360
    if quarter != 0 { (t, size) = normalizedAfter(t, size, CGAffineTransform(rotationAngle: CGFloat(quarter) * .pi / 180)) }
    if o.flipH == true { (t, size) = normalizedAfter(t, size, CGAffineTransform(scaleX: -1, y: 1)) }
    if o.flipV == true { (t, size) = normalizedAfter(t, size, CGAffineTransform(scaleX: 1, y: -1)) }
    // A hard squeeze also makes it smaller on screen: no bigger than 960×540, 1280×720 or 1920×1080.
    if o.squeezed, let cap = squeezeLongSide(o.q) {
      let long = max(size.width, size.height), short = min(size.width, size.height)
      let k = min(1, cap / long, cap * 9 / 16 / short)
      if k < 1 {
        t = t.concatenating(CGAffineTransform(scaleX: k, y: k))
        size = CGSize(width: size.width * k, height: size.height * k)
      }
    }
    let render = CGSize(width: even(size.width), height: even(size.height))
    let vc = AVMutableVideoComposition()
    vc.renderSize = render
    let fps = v.nominalFrameRate > 0 ? v.nominalFrameRate : 30
    vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))
    let ins = AVMutableVideoCompositionInstruction()
    ins.timeRange = CMTimeRange(start: .zero, duration: comp.duration)
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: cv)
    layer.setTransform(t, at: .zero)
    ins.layerInstructions = [layer]
    vc.instructions = [ins]
    videoComp = vc
  }

  var mix: AVMutableAudioMix?
  if let vol = o.volume, vol < 0.999, !compAudio.isEmpty {
    let m = AVMutableAudioMix()
    m.inputParameters = compAudio.map { t in
      let p = AVMutableAudioMixInputParameters(track: t)
      p.setVolume(Float(max(0, min(1, vol))), at: .zero)
      return p
    }
    mix = m
  }

  try? FileManager.default.removeItem(at: outURL)

  if o.format == "gif" { gif(comp, videoComp, o, outURL); return }

  // Smaller video: written frame by frame at a bit rate Pane picks (the export presets choose their own,
  // which barely shrinks anything).
  let fileType: AVFileType = audioOut ? .m4a : (o.format == "mov" ? .mov : o.format == "m4v" ? .m4v : .mp4)

  // Nothing to redraw (only trimmed, or moved to another of the same kinds of file): copy the frames and
  // sound as they are instead of encoding them again. For a big video that's seconds instead of minutes.
  let cropped = (o.crop?.count ?? 0) == 4 && (o.crop![2] > 4 && o.crop![3] > 4)
  let untouched = !cropped && ((o.rotate ?? 0) % 360 + 360) % 360 == 0 && o.flipH != true && o.flipV != true &&
    (o.volume ?? 1) >= 0.999 && !o.squeezed
  if untouched && ["mp4", "mov", "m4v", "m4a"].contains(o.format) {
    if let v = srcVideo { compVideo?.preferredTransform = v.preferredTransform } // a phone video stays upright
    if let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough), ex.supportedFileTypes.contains(fileType) {
      ex.outputURL = outURL
      ex.outputFileType = fileType
      let done = DispatchSemaphore(value: 0)
      ex.exportAsynchronously { done.signal() }
      while done.wait(timeout: .now() + 0.25) == .timedOut { emit(["progress": Double(ex.progress)]) }
      if ex.status == .completed { emit(["ok": true]); return }
      try? FileManager.default.removeItem(at: outURL) // couldn't copy as is: encode it the usual way below
      compVideo?.preferredTransform = .identity // the encoders below apply the turn themselves
    }
  }
  if !audioOut, let vc = videoComp, o.squeezed {
    let srcRate = Double(srcVideo?.estimatedDataRate ?? 0)
    let srcAudio = Double(asset.tracks(withMediaType: .audio).first?.estimatedDataRate ?? 0)
    squeezeVideo(comp, vc, mix, q: o.q, srcRate: srcRate, srcAudio: srcAudio, fileType: fileType, out: outURL)
    return
  }

  // wav / aiff / caf: make an m4a first, then afconvert turns it into plain samples.
  // A smaller m4a also goes through afconvert, which can set the bit rate (the export preset can't).
  let squeeze = o.format == "m4a" && o.squeezed
  let viaM4A = ["wav", "aiff", "caf"].contains(o.format) || squeeze
  let exportURL = viaM4A ? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pane-\(UUID().uuidString).m4a") : outURL
  let preset = audioOut ? AVAssetExportPresetAppleM4A : AVAssetExportPresetHighestQuality
  guard let ex = AVAssetExportSession(asset: comp, presetName: preset) else { fail("Can't save this kind of file.") }
  ex.outputURL = exportURL
  ex.outputFileType = fileType
  ex.videoComposition = videoComp
  ex.audioMix = mix
  ex.shouldOptimizeForNetworkUse = true
  let done = DispatchSemaphore(value: 0)
  ex.exportAsynchronously { done.signal() }
  while done.wait(timeout: .now() + 0.25) == .timedOut { emit(["progress": Double(ex.progress) * (viaM4A ? 0.8 : 1)]) }
  guard ex.status == .completed else { fail(ex.error?.localizedDescription ?? "Saving didn't work.") }

  if viaM4A {
    let srcAudio = Int(asset.tracks(withMediaType: .audio).first?.estimatedDataRate ?? 0)
    var rate = squeezeAudioRate(o.q) // AAC won't go lower than 64 kbps for stereo here
    if srcAudio > 64000 { rate = min(rate, max(64000, srcAudio / 32000 * 32000)) } // never more than it had
    let kbps = String(rate)
    let fmt: [String] = squeeze ? ["-f", "m4af", "-d", "aac", "-b", kbps] : o.format == "wav" ? ["-f", "WAVE", "-d", "LEI16"] : o.format == "aiff" ? ["-f", "AIFF", "-d", "BEI16"] : ["-f", "caff", "-d", "LEI16"]
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
    p.arguments = fmt + [exportURL.path, outURL.path]
    do { try p.run(); p.waitUntilExit() } catch { fail("Couldn't convert the sound.") }
    try? FileManager.default.removeItem(at: exportURL)
    guard p.terminationStatus == 0 else { fail("Couldn't convert the sound.") }
  }
  emit(["ok": true])
}

// Reads the edited picture and sound (crop, turns, trim, volume all applied by the composition) and writes
// them again with HEVC at a set bit rate (H.264 where HEVC can't go) and AAC sound.
func squeezeVideo(_ comp: AVComposition, _ vc: AVVideoComposition, _ mix: AVAudioMix?, q: Double, srcRate: Double, srcAudio: Double, fileType: AVFileType, out: URL) {
  let reader: AVAssetReader, writer: AVAssetWriter
  do { reader = try AVAssetReader(asset: comp); writer = try AVAssetWriter(outputURL: out, fileType: fileType) } catch { fail("Couldn't start making it smaller.") }
  let vOut = AVAssetReaderVideoCompositionOutput(videoTracks: comp.tracks(withMediaType: .video),
    videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
  vOut.videoComposition = vc
  vOut.alwaysCopiesSampleData = false
  reader.add(vOut)
  let aTracks = comp.tracks(withMediaType: .audio)
  var aOut: AVAssetReaderAudioMixOutput?
  if !aTracks.isEmpty {
    // Plain 44.1 kHz stereo samples, whatever the source was, so the AAC settings below always fit.
    let o = AVAssetReaderAudioMixOutput(audioTracks: aTracks, audioSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2,
      AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
    o.audioMix = mix
    reader.add(o)
    aOut = o
  }
  let w = vc.renderSize.width, h = vc.renderSize.height
  let fps = vc.frameDuration.seconds > 0 ? 1 / vc.frameDuration.seconds : 30
  var bitrate = max(300_000, Double(w * h) * fps * squeezeBitsPerPixel(q))
  if srcRate > 0 { bitrate = min(bitrate, max(300_000, srcRate * 0.95)) } // a squeeze never comes out bigger
  var aRate = squeezeAudioRate(q)
  if srcAudio > 64000 { aRate = min(aRate, max(64000, Int(srcAudio) / 32000 * 32000)) }
  func videoSettings(_ codec: AVVideoCodecType) -> [String: Any] {
    [AVVideoCodecKey: codec, AVVideoWidthKey: w, AVVideoHeightKey: h,
     AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoExpectedSourceFrameRateKey: fps]]
  }
  let codec: AVVideoCodecType = writer.canApply(outputSettings: videoSettings(.hevc), forMediaType: .video) ? .hevc : .h264
  let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings(codec))
  vIn.expectsMediaDataInRealTime = false
  writer.add(vIn)
  var aIn: AVAssetWriterInput?
  if aOut != nil {
    let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: aRate])
    i.expectsMediaDataInRealTime = false
    writer.add(i)
    aIn = i
  }
  guard reader.startReading(), writer.startWriting() else { fail(writer.error?.localizedDescription ?? reader.error?.localizedDescription ?? "Couldn't start making it smaller.") }
  writer.startSession(atSourceTime: .zero)
  let total = max(0.01, comp.duration.seconds)
  let group = DispatchGroup()
  func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderOutput, _ name: String, report: Bool) {
    group.enter()
    var finished = false
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "pane.\(name)")) {
      while !finished && input.isReadyForMoreMediaData {
        guard let sb = output.copyNextSampleBuffer() else { finished = true; input.markAsFinished(); group.leave(); return }
        if report { emit(["progress": min(1, CMSampleBufferGetPresentationTimeStamp(sb).seconds / total)]) }
        if !input.append(sb) { finished = true; input.markAsFinished(); group.leave(); return }
      }
    }
  }
  pump(vIn, vOut, "video", report: true)
  if let a = aIn, let o = aOut { pump(a, o, "audio", report: false) }
  group.wait()
  if reader.status == .failed { writer.cancelWriting(); fail(reader.error?.localizedDescription ?? "Couldn't read the video.") }
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else { fail(writer.error?.localizedDescription ?? "Saving didn't work.") }
  emit(["ok": true])
}

func normalizedAfter(_ t: CGAffineTransform, _ size: CGSize, _ extra: CGAffineTransform) -> (CGAffineTransform, CGSize) {
  // Turn the picture already placed at 0,0 (size), then move it back to 0,0.
  let r = CGRect(origin: .zero, size: size).applying(extra)
  let next = t.concatenating(extra).concatenating(CGAffineTransform(translationX: -r.minX, y: -r.minY))
  return (next, CGSize(width: abs(r.width), height: abs(r.height)))
}

// A looping GIF: frames pulled from the clip at a few per second, kept small.
func gif(_ comp: AVComposition, _ vc: AVVideoComposition?, _ o: MediaOpts, _ out: URL) {
  let gen = AVAssetImageGenerator(asset: comp)
  gen.videoComposition = vc
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  let w = CGFloat(o.gifWidth ?? 480)
  gen.maximumSize = CGSize(width: w, height: w * 4)
  let fps = max(4, min(24, o.gifFps ?? 12))
  let total = comp.duration.seconds
  let count = max(1, Int(total * fps))
  guard count <= 1500 else { fail("That clip is too long for a GIF. Trim it to under a minute.") }
  guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.gif.identifier as CFString, count, nil) else { fail("Can't write a GIF.") }
  CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
  let frameProps = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 1.0 / fps]] as CFDictionary
  for i in 0..<count {
    let t = CMTime(seconds: Double(i) / fps, preferredTimescale: 600)
    if let img = try? gen.copyCGImage(at: t, actualTime: nil) { CGImageDestinationAddImage(dest, img, frameProps) }
    if i % 5 == 0 { emit(["progress": Double(i) / Double(count)]) }
  }
  guard CGImageDestinationFinalize(dest) else { fail("Couldn't finish the GIF.") }
  emit(["ok": true])
}

func frame(_ input: String, _ at: Double, _ output: String) {
  let gen = AVAssetImageGenerator(asset: AVURLAsset(url: URL(fileURLWithPath: input)))
  gen.appliesPreferredTrackTransform = true
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  guard let img = try? gen.copyCGImage(at: CMTime(seconds: at, preferredTimescale: 600), actualTime: nil),
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("Couldn't grab that frame.") }
  CGImageDestinationAddImage(dest, img, nil)
  guard CGImageDestinationFinalize(dest) else { fail("Couldn't save the frame.") }
  emit(["ok": true])
}

// ---------- io: how much each process has read from and written to storage ----------
// Debug's per-app Disk numbers. proc_pid_rusage needs no permission for your own processes (every app you
// opened); macOS's own root tasks are refused and simply left out. One "pid read written" line each.
// With no pids it looks at every process there is.
func allPids() -> [Int32] {
  let n = proc_listallpids(nil, 0)
  guard n > 0 else { return [] }
  var buf = [Int32](repeating: 0, count: Int(n) + 64)
  let got = buf.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
  return Array(buf.prefix(Int(max(0, got)))).filter { $0 > 0 }
}
func io(_ args: [String]) {
  var out = ""
  for pid in args.isEmpty ? allPids() : args.compactMap({ Int32($0) }) {
    var info = rusage_info_v2()
    let r = withUnsafeMutablePointer(to: &info) { p in
      p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
    }
    if r == 0 { out += "\(pid) \(info.ri_diskio_bytesread) \(info.ri_diskio_byteswritten)\n" }
  }
  FileHandle.standardOutput.write(out.data(using: .utf8)!)
}

// ---------- pictures with more than one frame ----------

func delayOf(_ props: [CFString: Any]) -> Double {
  for key in [kCGImagePropertyGIFDictionary, kCGImagePropertyPNGDictionary, kCGImagePropertyHEICSDictionary] {
    guard let d = props[key] as? [CFString: Any] else { continue }
    for k in [kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyGIFDelayTime, kCGImagePropertyAPNGUnclampedDelayTime,
              kCGImagePropertyAPNGDelayTime, kCGImagePropertyHEICSUnclampedDelayTime, kCGImagePropertyHEICSDelayTime] {
      if let v = d[k] as? Double, v > 0 { return v }
    }
  }
  return 0
}

func frames(_ input: String, _ dir: String) {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil) else { fail("Pane can't read this picture.") }
  let n = CGImageSourceGetCount(src)
  if n <= 1 { emit(["count": n]); return }
  let max = min(n, 600)
  var out: [[String: Any]] = []
  for i in 0..<max {
    guard let img = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
    let props = (CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]) ?? [:]
    let path = (dir as NSString).appendingPathComponent("\(i).png")
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { continue }
    let dpi = (props[kCGImagePropertyDPIWidth] as? Double) ?? 72
    out.append(["path": path, "w": img.width, "h": img.height, "delay": delayOf(props), "dpi": dpi])
  }
  var loop = 0
  if let all = CGImageSourceCopyProperties(src, nil) as? [CFString: Any] {
    if let g = all[kCGImagePropertyGIFDictionary] as? [CFString: Any], let l = g[kCGImagePropertyGIFLoopCount] as? Int { loop = l }
    if let p = all[kCGImagePropertyPNGDictionary] as? [CFString: Any], let l = p[kCGImagePropertyAPNGLoopCount] as? Int { loop = l }
  }
  emit(["count": n, "frames": out, "loop": loop, "partial": n > max])
}

struct AssembleFrame: Decodable { let path: String; var delay: Double?; var dpi: Double? }
struct AssembleOpts: Decodable { let output: String; let type: String; let frames: [AssembleFrame]; var loop: Int? }

func assemble(_ json: String) {
  guard let data = json.data(using: .utf8), let o = try? JSONDecoder().decode(AssembleOpts.self, from: data), !o.frames.isEmpty else { fail("Bad options.") }
  let types: [String: String] = ["gif": UTType.gif.identifier, "png": UTType.png.identifier, "tiff": UTType.tiff.identifier,
    "icns": UTType.icns.identifier, "ico": UTType.ico.identifier, "pdf": UTType.pdf.identifier]
  guard let uti = types[o.type] else { fail("Pane can't write that kind of picture with frames.") }
  let url = URL(fileURLWithPath: o.output)
  try? FileManager.default.removeItem(at: url)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, uti as CFString, o.frames.count, nil) else { fail("Can't write that kind of picture.") }
  let loop = o.loop ?? 0
  if o.type == "gif" { CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: loop]] as CFDictionary) }
  if o.type == "png" { CGImageDestinationSetProperties(dest, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: loop]] as CFDictionary) }
  for (i, f) in o.frames.enumerated() {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: f.path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fail("Couldn't read frame \(i + 1).") }
    var props: [CFString: Any] = [:]
    let d = max(0.02, f.delay ?? 0.1)
    if o.type == "gif" { props[kCGImagePropertyGIFDictionary] = [kCGImagePropertyGIFDelayTime: d] }
    if o.type == "png" { props[kCGImagePropertyPNGDictionary] = [kCGImagePropertyAPNGDelayTime: d] }
    if let dpi = f.dpi, dpi > 0 { props[kCGImagePropertyDPIWidth] = dpi; props[kCGImagePropertyDPIHeight] = dpi }
    if o.type == "tiff" { props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFCompression: 5] } // LZW
    CGImageDestinationAddImage(dest, img, props as CFDictionary)
  }
  guard CGImageDestinationFinalize(dest) else { fail("Couldn't finish writing it.") }
  emit(["ok": true])
}

func probe(_ input: String) {
  let asset = AVURLAsset(url: URL(fileURLWithPath: input))
  var out: [String: Any] = ["duration": asset.duration.seconds]
  if let v = asset.tracks(withMediaType: .video).first {
    let (_, size) = normalized(v.preferredTransform, v.naturalSize)
    out["w"] = size.width; out["h"] = size.height
    out["fps"] = v.nominalFrameRate > 0 ? Double(v.nominalFrameRate) : 30
    out["vRate"] = Double(v.estimatedDataRate)
  }
  if let a = asset.tracks(withMediaType: .audio).first {
    out["aRate"] = Double(a.estimatedDataRate)
    if let f = a.formatDescriptions.first, let d = CMAudioFormatDescriptionGetStreamBasicDescription(f as! CMAudioFormatDescription)?.pointee {
      out["sampleRate"] = d.mSampleRate; out["channels"] = Int(d.mChannelsPerFrame)
    }
  }
  emit(out)
}


// ---------- windows: what Plugin's picker outlines and where its badges sit ----------
// Window frames need no permission (their titles need Screen Recording, and are left out without it).
// Commands, one a line, each starting with a number the answer carries back as "n" (so a late answer can't
// be taken for the next one's):
//   w              {"w":[{pid,x,y,w,h,title}]}  every normal window on screen, frontmost first
//   a              {"a":[{pid,bundle,name,path,active,hidden}]}  running apps with a Dock icon
//   hide <pid>…    hide those apps          unhide <pid>…  show them again
//   only <pid>     hide every other app (Focus mode), answering with the pids it hid
// Hiding goes through NSRunningApplication, so it needs no Automation permission either.
func listWindows(skip: pid_t) -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var out: [[String: Any]] = []
  for w in list {
    guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != skip else { continue }
    if ((w[kCGWindowLayer as String] as? Int) ?? 0) != 0 { continue }
    if let a = w[kCGWindowAlpha as String] as? Double, a < 0.05 { continue }
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    if owner == "Window Server" || owner == "Dock" { continue }
    guard let bd = w[kCGWindowBounds as String] as? NSDictionary, let b = CGRect(dictionaryRepresentation: bd as CFDictionary),
          b.width >= 60, b.height >= 40 else { continue }
    out.append(["pid": pid, "x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height,
                "title": (w[kCGWindowName as String] as? String) ?? "", "owner": owner])
  }
  return out
}
func regularApps(skip: pid_t) -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != skip && !$0.isTerminated }
}
func listApps(skip: pid_t) -> [[String: Any]] {
  regularApps(skip: skip).map { a in
    ["pid": a.processIdentifier, "bundle": a.bundleIdentifier ?? "", "name": a.localizedName ?? "",
     "path": a.bundleURL?.path ?? "", "active": a.isActive, "hidden": a.isHidden]
  }
}
func windowsServe(panePid: pid_t) {
  // NSWorkspace keeps its list of apps fresh on the main run loop, so stdin is read on another thread.
  Thread.detachNewThread {
    while let line = readLine() {
      var parts = line.split(separator: " ").map(String.init)
      let n = Int(parts.first ?? "") ?? 0
      if !parts.isEmpty && Int(parts[0]) != nil { parts.removeFirst() }
      guard let cmd = parts.first else { continue }
      let pids = Set(parts.dropFirst().compactMap { pid_t($0) })
      func emit(_ obj: [String: Any]) { var o = obj; o["n"] = n; if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { print(s) } }
      DispatchQueue.main.sync {
        switch cmd {
        case "w": emit(["w": listWindows(skip: panePid)])
        case "a": emit(["a": listApps(skip: panePid)])
        case "hide":
          for p in pids { _ = NSRunningApplication(processIdentifier: p)?.hide() }
          emit(["ok": true])
        case "unhide":
          for p in pids { _ = NSRunningApplication(processIdentifier: p)?.unhide() }
          emit(["ok": true])
        case "only":
          var hid: [pid_t] = []
          for a in regularApps(skip: panePid) where !pids.contains(a.processIdentifier) && !a.isHidden && a.bundleIdentifier != "com.apple.finder" {
            if a.hide() { hid.append(a.processIdentifier) }
          }
          emit(["hid": hid])
        default: emit(["error": "unknown command"])
        }
      }
    }
    exit(0)
  }
  RunLoop.main.run()
}

// ---------- wifi: Plugin's "join a network" ----------
// Since macOS 14 an app only sees Wi-Fi names with Location access, so a scan first asks for it (once; macOS
// shows the prompt for Pane). Without it the networks still come back, nameless, and Pane says why.
final class LocWait: NSObject, CLLocationManagerDelegate {
  let m = CLLocationManager()
  var done = false
  override init() { super.init(); m.delegate = self }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus != .notDetermined { done = true }
  }
}
func askLocation() -> Bool {
  let w = LocWait()
  if w.m.authorizationStatus == .notDetermined {
    w.m.requestWhenInUseAuthorization()
    let until = Date().addingTimeInterval(12)
    while !w.done && Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }
  }
  let s = w.m.authorizationStatus
  return s == .authorizedAlways || s.rawValue == 4 // 4: authorized when in use
}
func wifi(_ args: [String]) {
  let client = CWWiFiClient.shared()
  let ifs = client.interfaces() ?? []
  if args.first == "join" {
    guard let line = readLine(), let d = line.data(using: .utf8),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let ssid = o["ssid"] as? String else { fail("Nothing to join.") }
    let dev = o["device"] as? String
    let pw = o["password"] as? String
    guard let i = ifs.first(where: { dev == nil || $0.interfaceName == dev }) ?? ifs.first else { fail("This Mac has no Wi-Fi.") }
    do {
      let found = try i.scanForNetworks(withName: ssid)
      guard let net = found.first else { fail("Couldn’t find \(ssid). Move closer, or check the name.") }
      try i.associate(to: net, password: (pw?.isEmpty ?? true) ? nil : pw)
      emit(["ok": true, "ssid": ssid, "device": i.interfaceName ?? ""])
    } catch {
      let ns = error as NSError
      fail(ns.code == -3900 || ns.code == -3905 ? "Wrong password for \(ssid)." : "Couldn’t join \(ssid).")
    }
    return
  }
  let named = askLocation()
  var list: [[String: Any]] = []
  var seen = Set<String>()
  for i in ifs {
    let nets = (try? i.scanForNetworks(withName: nil)) ?? []
    for n in nets.sorted(by: { $0.rssiValue > $1.rssiValue }) {
      let name = n.ssid ?? ""
      if !name.isEmpty { if seen.contains(name) { continue }; seen.insert(name) }
      let open = n.supportsSecurity(.none)
      list.append(["ssid": name, "rssi": n.rssiValue, "secure": !open, "device": i.interfaceName ?? ""])
    }
  }
  emit(["wifi": ifs.map { ["device": $0.interfaceName ?? "", "ssid": $0.ssid() ?? "", "on": $0.powerOn()] }, "networks": list, "named": named])
}

// ---------- tap: one app's sound, at its own volume ----------
// A process tap captures the app's audio and (mutedWhenTapped) silences what it was sending to your speakers.
// A private aggregate device made of your current output plus the tap plays it back through an IOProc that
// multiplies every sample by the gain. Nothing is installed: the tap and the device belong to this process and
// vanish with it.
func caGet<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ fallback: T) -> T {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v = fallback
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : fallback
}
func caList(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}
func caString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr, let s = v?.takeRetainedValue() else { return nil }
  return s as String
}
let caSystem = AudioObjectID(kAudioObjectSystemObject)

final class AppTap {
  var gain: Float = 1
  var peak: Float = 0
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggID = AudioObjectID(kAudioObjectUnknown)
  private var proc: AudioDeviceIOProcID?
  private(set) var objects: [AudioObjectID] = []
  private(set) var outputUID = ""
  var error: String?

  func stop() {
    if let p = proc { AudioDeviceStop(aggID, p); AudioDeviceDestroyIOProcID(aggID, p) }
    proc = nil
    if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
    aggID = AudioObjectID(kAudioObjectUnknown)
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    tapID = AudioObjectID(kAudioObjectUnknown)
    objects = []
  }
  func start(_ objs: [AudioObjectID], output: String) {
    stop()
    error = nil
    guard !objs.isEmpty, !output.isEmpty else { return }
    let desc = CATapDescription(stereoMixdownOfProcesses: objs)
    desc.uuid = UUID()
    desc.muteBehavior = .mutedWhenTapped
    desc.isPrivate = true
    desc.name = "Pane Plugin"
    var tap = AudioObjectID(kAudioObjectUnknown)
    var st = AudioHardwareCreateProcessTap(desc, &tap)
    guard st == noErr else { error = "tap \(st)"; return }
    tapID = tap
    let agg: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Pane Plugin",
      kAudioAggregateDeviceUIDKey: "pane.plugin.\(UUID().uuidString)",
      kAudioAggregateDeviceMainSubDeviceKey: output,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: output]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
    ]
    var dev = AudioObjectID(kAudioObjectUnknown)
    st = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &dev)
    guard st == noErr else { error = "device \(st)"; stop(); return }
    aggID = dev
    var p: AudioDeviceIOProcID?
    st = AudioDeviceCreateIOProcIDWithBlock(&p, dev, nil) { [unowned self] _, inData, _, outData, _ in
      let ins = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
      let outs = UnsafeMutableAudioBufferListPointer(outData)
      let g = self.gain
      var pk: Float = 0
      for (i, out) in outs.enumerated() {
        guard let o = out.mData?.assumingMemoryBound(to: Float.self) else { continue }
        let n = Int(out.mDataByteSize) / MemoryLayout<Float>.size
        // The tap's buffer for this output buffer (or its first, if the shapes differ).
        let src = ins.count > i ? ins[i] : ins.first
        guard let sb = src, let s = sb.mData?.assumingMemoryBound(to: Float.self) else { memset(o, 0, Int(out.mDataByteSize)); continue }
        let m = min(n, Int(sb.mDataByteSize) / MemoryLayout<Float>.size)
        for k in 0..<m {
          // Exactly the gain below 80% of full scale; above it a soft knee rounds the peaks off instead of
          // clipping them into crackle (only reachable past 100%).
          var v = s[k] * g
          let a = abs(v)
          if a > 0.8 { v = (v < 0 ? -1 : 1) * (0.8 + 0.2 * tanhf((a - 0.8) / 0.2)) }
          o[k] = v
          pk = max(pk, abs(v))
        }
        if m < n { for k in m..<n { o[k] = 0 } }
      }
      self.peak = max(self.peak * 0.9, pk)
    }
    guard st == noErr, let pp = p else { error = "io \(st)"; stop(); return }
    proc = pp
    st = AudioDeviceStart(dev, pp)
    guard st == noErr else { error = "start \(st)"; stop(); return }
    objects = objs
    outputUID = output
  }
}

func tapServe() {
  let t = AppTap()
  var want = Set<pid_t>()
  let lock = NSLock()
  Thread.detachNewThread {
    while let line = readLine() {
      let parts = line.split(separator: " ").map(String.init)
      lock.lock()
      if parts.first == "pids" { want = Set(parts.dropFirst().compactMap { pid_t($0) }) }
      if parts.first == "gain", parts.count > 1, let g = Float(parts[1]) { t.gain = max(0, min(2, g)) }
      lock.unlock()
    }
    t.stop()
    exit(0)
  }
  // Once a second: which of the app's processes are making sound now, and where sound goes. When either
  // changes, the tap is made again for them (a new tab starts playing, you switch to headphones).
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    lock.lock(); let pids = want; lock.unlock()
    let objs = caList(caSystem, kAudioHardwarePropertyProcessObjectList)
      .filter { pids.contains(caGet($0, kAudioProcessPropertyPID, pid_t(-1))) }
      .sorted()
    let out = caGet(caSystem, kAudioHardwarePropertyDefaultOutputDevice, AudioDeviceID(0))
    let uid = caString(out, kAudioDevicePropertyDeviceUID) ?? ""
    if objs != t.objects || uid != t.outputUID { t.start(objs, output: uid) }
    var o: [String: Any] = ["tapped": t.objects.count, "peak": Double(t.peak)]
    if let e = t.error { o["error"] = e }
    emit(o)
    t.peak *= 0.5
  }
  RunLoop.main.run()
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "hover": hover(panePid: args.count > 2 ? pid_t(args[2]) ?? 0 : 0)
case "media": media(args.count > 2 ? args[2] : "")
case "frame": frame(args[2], Double(args[3]) ?? 0, args[4])
case "io": io(Array(args.dropFirst(2)))
case "frames": frames(args[2], args[3])
case "assemble": assemble(args.count > 2 ? args[2] : "")
case "probe": probe(args[2])
case "tap": tapServe()
case "wifi": wifi(Array(args.dropFirst(2)))
case "windows": windowsServe(panePid: args.count > 2 ? pid_t(args[2]) ?? 0 : 0)
default: fail("Usage: pane-files hover <pid> | media <json> | frame <in> <sec> <out> | io <pid>…")
}
