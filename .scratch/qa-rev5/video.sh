#!/usr/bin/env bash
set -eu
FF="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg"
FP="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffprobe"
R=/c/Workspaces/Intrale/platform.agent-6459-pipeline-dev
D=$R/.scratch/qa-rev5
W=C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/qa-rev5
EV=$R/qa/evidence/6459

norm() { "$FF" -y -v error -i "$1" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0d1117" "$D/n-$2.png"; }
norm "$D/slide-s00.png"             00
norm "$D/slide-s01.png"             01
norm "$D/slide-s02.png"             02
norm "$D/render-rev5.png"           03
norm "$D/sxs.png"                   04
norm "$D/render-degraded-rev5.png"  05
norm "$D/slide-s05.png"             06

{
  echo "file '$W/n-00.png'"; echo "duration 58"
  echo "file '$W/n-01.png'"; echo "duration 56"
  echo "file '$W/n-02.png'"; echo "duration 78"
  echo "file '$W/n-03.png'"; echo "duration 52"
  echo "file '$W/n-04.png'"; echo "duration 82"
  echo "file '$W/n-05.png'"; echo "duration 32"
  echo "file '$W/n-06.png'"; echo "duration 62"
  echo "file '$W/n-06.png'"
} > "$D/deck.concat"

"$FF" -y -v error -f concat -safe 0 -i "$D/deck.concat" -pix_fmt yuv420p -c:v libx264 -preset veryfast -crf 26 -r 12 "$D/deck.mp4"
echo "deck.mp4 dur=$("$FP" -v error -show_entries format=duration -of csv=p=0 "$D/deck.mp4")"

"$FF" -y -v error -i "$D/deck.mp4" -i "$EV/qa-6459-narration.mp3" -c:v copy -c:a aac -b:a 128k -shortest "$EV/qa-6459.mp4"
echo "--- qa-6459.mp4 ---"
"$FP" -v error -show_entries format=duration,size -show_entries stream=codec_type,codec_name,duration -of default=nw=1 "$EV/qa-6459.mp4"
