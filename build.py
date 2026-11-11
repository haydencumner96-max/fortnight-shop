#!/usr/bin/env python3
"""Builds index.html for the standalone app from the claude.ai version of the list (src/list.html).
Both versions run the same list code; standalone.js supplies login, sync and Claude in this one.
Run:  python3 build.py   (bumps the version so phones pick up the update)"""
import re, json, pathlib, datetime

root = pathlib.Path(__file__).parent
src = (root / "src" / "list.html").read_text()

# the claude.ai page carries its own <title> and a claude.ai-only meta tag; those move into <head>
src = re.sub(r"<title>.*?</title>\s*", "", src, count=1, flags=re.S)
src = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\s*', "", src, count=1)

version = datetime.datetime.now().strftime("%Y.%m.%d-%H%M")

head = f"""<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Fortnight Shop</title>
<meta name="description" content="Fortnight grocery list for Aldi and Woolworths, with recipes and live sync.">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#f3f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121715" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Shop">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<style>
:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}
body{{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}
img{{max-width:100%}}
[hidden]{{display:none!important}}
</style>
<script>window.APP_VERSION={json.dumps(version)};</script>
<script src="config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.97.0"></script>
<script src="standalone.js"></script>
</head>
<body>
"""

tail = """
<script>
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
</script>
</body>
</html>
"""

(root / "index.html").write_text(head + src + tail)

sw = (root / "sw.template.js").read_text().replace("__VERSION__", version)
(root / "sw.js").write_text(sw)
print("built", version)
