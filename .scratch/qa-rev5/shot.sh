#!/usr/bin/env bash
# QA #6459 pasada 5 — captura del HTML servido por el dashboard real.
set -u
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
R=/c/Workspaces/Intrale/platform.agent-6459-pipeline-dev
W=C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev

shot() { # $1=html relativo  $2=png destino relativo  $3=w  $4=h  $5=perfil
  rm -rf "$R/.scratch/qa-rev5/$5"; mkdir -p "$R/.scratch/qa-rev5/$5"
  "$CH" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=$3,$4 --virtual-time-budget=4000 \
    --user-data-dir="$W/.scratch/qa-rev5/$5" \
    --screenshot="$W/$2" \
    "file:///$W/$1" >/dev/null 2>&1
  echo "$2 -> $(stat -c%s "$R/$2" 2>/dev/null || echo FAIL) bytes"
}

shot "$@"
