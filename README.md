<p align="center">
  <img src="assets/logo.svg" width="96" alt="Pane logo">
</p>

<h1 align="center">Pane</h1>

<p align="center">Small tools that sit on top of your Mac.</p>

<p align="center">
  <a href="https://hfang1012.github.io/Pane-Mac/">Website</a> ·
  <a href="https://github.com/HFang1012/Pane-Mac/releases/latest">Download</a>
</p>

---

Pane is a menu-bar app with six tools. Each one opens from a key or a shortcut, right where you're working, then gets out of the way.

| Tool | What it does | Opens with (by default) |
| --- | --- | --- |
| **Scrawl** | Draw on your screen. Pick a pencil, eraser or color picker from a wheel and mark up anything. | Hold left `⌥` |
| **Away** | Blur your screen and hide the pointer while you step away, with a note and icon of your own. | `⌃⌘A` |
| **Spin** | Run your music from a wheel: play, pause, skip, volume, and scroll the queue. Works with Spotify, Apple Music, or any player through the media keys. | Hold right `⌘` |
| **Jot** | Write a quick note, pick a timer, and it comes back when it's time. Snooze it or mark it done. | Double-tap left `⌃` |
| **Tweak** | Point at a file and edit it: crop, turn and resize pictures, trim videos and songs, find and replace in text, rename or convert. | Double-tap right `⌥` |
| **Debug** | A small panel that scores how your Mac is holding up and offers one-click fixes. | `⌃⌘B` |

Every key and shortcut can be changed in Pane's settings, and each tool can be turned off on its own.

## Install

Pane needs a Mac with Apple silicon (M1 or newer).

**One command** (no "can't verify" prompt, since `curl` doesn't add the quarantine mark):

```bash
curl -fsSL https://hfang1012.github.io/Pane-Mac/install.sh | sh
```

**Or the regular download:** get `Pane.dmg` from the [latest release](https://github.com/HFang1012/Pane-Mac/releases/latest) and drag Pane to Applications.

Then turn Pane on in **System Settings → Privacy & Security → Accessibility** when it asks. Scrawl, Spin, Jot and Tweak need it to hear your keys. Away works without any extra permissions.

Pane updates itself. An update usually downloads as a small patch (about a megabyte) instead of the whole disk image.

> Pane used to be called Scrawl. Installing Pane replaces an old `Scrawl.app` and keeps its settings and drawings.

## Development

Pane is an [Electron](https://www.electronjs.org/) app, plus a little native code for things Electron can't do. You'll need Node 22 and Xcode or the Command Line Tools.

```bash
npm install
```

```bash
npm start
```

`npm install` also rebuilds the key hook (see [Native pieces](#native-pieces)).

### Project layout

| Path | What's there |
| --- | --- |
| `main.js` | The main process: settings, shortcuts, key hook, windows, menu bar |
| `tools.js` | The tool list, glyphs, colors and Away's moods, shared by every window |
| `overlay.*`, `wheel.js` | Scrawl's drawing layer and tool wheel |
| `away*` | Away's blur screen and its settings |
| `spin*`, `music.js` | Spin's music wheel and player control |
| `jot*` | Jot's notes and reminders |
| `edit.*`, `target.*`, `tweak-*` | Tweak's file picker and editor |
| `debug*` | Debug's panel and the stats behind it |
| `plugin-*` | Plugin (work in progress, hidden: `PLUGIN_READY` in `main.js`): its picker, pods and menu; `plugin-engine.js` applies each plugin's shares, `plugin-proxy.js` gives an app its own network |
| `settings.*`, `switcher.js` | The settings window and the tool switcher |
| `updater.js`, `update.js`, `app-patch.js` | Self-updates and small binary patches |
| `native/pane-files.swift` | Tweak's native helper (finding files under the pointer, media edits) |
| `scripts/` | Packaging, signing, icons, the DMG, and native builds |
| `docs/` | The website, served by GitHub Pages, and `install.sh` |

### Native pieces

- **Key hook.** `scripts/uiohook.js` patches [`uiohook-napi`](https://github.com/SnosMe/uiohook-napi) so macOS never wakes Pane for mouse movement or scrolling, only keys and clicks. It runs after every install.
- **Tweak's helper.** `scripts/native.js` builds `native/pane-files` from Swift. It uses Accessibility to find the file under the pointer and AVFoundation to edit video and audio. Plugin uses it too (`pane-files windows`), to see where every window is and to hide apps for Focus mode.

### Building

```bash
npm run release
```

That builds `build/Pane.app` and `build/Pane.dmg`. The version comes from your newest git tag.

Pane is signed with its own long-lived certificate, so an update keeps the permissions you gave the last version. Builds look for it in `~/.pane-signing/` (or `PANE_SIGN_P12` / `PANE_SIGN_PASSWORD`). Without it, the build is signed ad hoc: fine for trying it out, but macOS will ask for permissions again after each build.

### Releasing

```bash
npm run ship
```

That bumps the patch version, tags it, and pushes. Use `ship:minor` or `ship:major` for bigger steps. The [release workflow](.github/workflows/release.yml) then builds and signs Pane, makes patches from the last few releases, and publishes a GitHub release.

The release notes are that version's commit titles, and Pane shows them as the changelog in its update prompt. So write commit titles for the people using Pane.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run icons` | Regenerates the app icons |
| `npm run dmg:background` | Regenerates the DMG background |
| `npm run downloads` | Shows download counts for each release |
| `npm run stats` | Opens the stats page |
