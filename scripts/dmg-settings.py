# dmgbuild settings: the window that opens when someone double-clicks Pane.dmg.
# Paths come in from scripts/dmg.sh through -D app=… -D background=… -D icon=…
import os

application = defines["app"]
app_name = os.path.basename(application)

format = "ULMO"  # read-only, LZMA-compressed: about a quarter smaller than zlib (UDZO); opens on macOS 10.15 and newer
files = [application]
symlinks = {"Applications": "/Applications"}
icon = defines["icon"]  # the disk's own icon in Finder and on the desktop

# Window: matches assets/dmg/background.png (640×420; the @2x copy is picked up for Retina).
background = defines["background"]
window_rect = ((200, 140), (640, 420))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False

# Icons sit on the background's floor, either side of the lilac arrow.
icon_size = 128
text_size = 13
arrange_by = None
icon_locations = {
    app_name: (170, 200),
    "Applications": (470, 200),
}
