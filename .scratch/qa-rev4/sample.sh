#!/usr/bin/env bash
# QA rev4 #6459 — muestreo de color de los badges (render real vs mockup).
set -u
FF="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg"
FP="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffprobe"
D=/c/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/qa-rev4

dims() { "$FP" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1"; }
echo "render-rev4.png dims: $(dims $D/render-rev4.png)"
echo "mockup-rev4.png dims: $(dims $D/mockup-rev4.png)"

hist() { # file crop label
  "$FF" -v error -i "$2" -vf "crop=$3" -f rawvideo -pix_fmt rgb24 - 2>/dev/null \
  | node -e '
    const chunks=[];process.stdin.on("data",d=>chunks.push(d)).on("end",()=>{
      const b=Buffer.concat(chunks); const m=new Map();
      for(let i=0;i+2<b.length;i+=3){const k=("#"+b[i].toString(16).padStart(2,"0")+b[i+1].toString(16).padStart(2,"0")+b[i+2].toString(16).padStart(2,"0")).toUpperCase();m.set(k,(m.get(k)||0)+1);}
      const top=[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
      console.log(process.argv[1].padEnd(22)+top.map(([c,n])=>c+" x"+n).join("  "));
    });' "$1"
}
