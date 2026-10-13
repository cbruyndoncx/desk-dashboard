#!/bin/bash
# Builds dashboard.scr into C:\Users\<you>\DeskDashboard using the .NET Framework csc.exe already on Windows.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$1"   # extracted Microsoft.Web.WebView2 nupkg dir
WINUSER="${WINUSER:-$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')}"
OUT="/mnt/c/Users/$WINUSER/DeskDashboard"
mkdir -p "$OUT"
cp "$PKG"/lib/net462/Microsoft.Web.WebView2.Core.dll "$PKG"/lib/net462/Microsoft.Web.WebView2.WinForms.dll "$PKG"/runtimes/win-x64/native/WebView2Loader.dll "$OUT"/
cp "$HERE/DeskDashboard.cs" "$OUT/DeskDashboard.cs"
cd "$OUT"
powershell.exe -NoProfile -Command '& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /out:DeskDashboard.scr /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll DeskDashboard.cs' | tr -d '\r'
ls -la "$OUT"
