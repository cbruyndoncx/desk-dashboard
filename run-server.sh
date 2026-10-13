#!/bin/bash
# Starts the dashboard collector (used by the screensaver and for manual start).
cd "$(dirname "$(readlink -f "$0")")"
# Non-interactive shells (wsl.exe from Windows) often lack nvm on PATH: fall back to the newest nvm node.
NODE="${NODE_BIN:-$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)}"
exec "$NODE" server.js
