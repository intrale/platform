#!/usr/bin/env bash
# QA #6459 pasada 5 — concatena las dos partes de la narracion en un solo mp3
# (el camino edge trunca a 5000 chars; sin esto el relato quedaba cortado).
set -eu
FF="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg"
FP="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffprobe"
D=/c/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/qa-rev5
EV=/c/Workspaces/Intrale/platform.agent-6459-pipeline-dev/qa/evidence/6459
W=C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/qa-rev5

echo "p1 dur = $("$FP" -v error -show_entries format=duration -of csv=p=0 "$D/narr-p1.mp3")"
echo "p2 dur = $("$FP" -v error -show_entries format=duration -of csv=p=0 "$D/narr-p2.mp3")"

printf "file '%s'\nfile '%s'\n" "$W/narr-p1.mp3" "$W/narr-p2.mp3" > "$D/narr.concat"
"$FF" -y -v error -f concat -safe 0 -i "$D/narr.concat" -c copy "$EV/qa-6459-narration.mp3"
echo "narracion final:"
"$FP" -v error -show_entries format=duration,size -of default=nw=1 "$EV/qa-6459-narration.mp3"
