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
//
// Built by scripts/native.js (and by Pane itself the first time, while you're working on it).
import Cocoa
import AVFoundation
import UniformTypeIdentifiers

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
  var size: String? // full | smaller | smallest: how hard to squeeze the file
}

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
    // Smallest: no bigger than 960×540 (or 540×960 standing up).
    if o.size == "smallest" {
      let long = max(size.width, size.height), short = min(size.width, size.height)
      let k = min(1, 960 / long, 540 / short)
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
  if !audioOut, let vc = videoComp, o.size == "smaller" || o.size == "smallest" {
    squeezeVideo(comp, vc, mix, smallest: o.size == "smallest", fileType: fileType, out: outURL)
    return
  }

  // wav / aiff / caf: make an m4a first, then afconvert turns it into plain samples.
  // A smaller m4a also goes through afconvert, which can set the bit rate (the export preset can't).
  let squeeze = o.format == "m4a" && (o.size == "smaller" || o.size == "smallest")
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
    let kbps = o.size == "smallest" ? "64000" : "96000" // AAC won't go lower than 64 kbps for stereo here
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
func squeezeVideo(_ comp: AVComposition, _ vc: AVVideoComposition, _ mix: AVAudioMix?, smallest: Bool, fileType: AVFileType, out: URL) {
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
  let bitrate = max(300_000, Double(w * h) * fps * (smallest ? 0.06 : 0.1))
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
    let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: smallest ? 64000 : 96000])
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

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "hover": hover(panePid: args.count > 2 ? pid_t(args[2]) ?? 0 : 0)
case "media": media(args.count > 2 ? args[2] : "")
case "frame": frame(args[2], Double(args[3]) ?? 0, args[4])
default: fail("Usage: pane-files hover <pid> | media <json> | frame <in> <sec> <out>")
}
