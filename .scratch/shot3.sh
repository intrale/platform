CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
cd /c/Workspaces/Intrale/platform.agent-6459-pipeline-dev
shot() { # $1=html $2=outname $3=w $4=h
  rm -rf .scratch/cp3; mkdir -p .scratch/cp3
  "$CH" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=$3,$4 --virtual-time-budget=3000 \
    --user-data-dir='C:\Workspaces\Intrale\platform.agent-6459-pipeline-dev\.scratch\cp3' \
    --screenshot="C:\Workspaces\Intrale\platform.agent-6459-pipeline-dev\.scratch\$2" \
    "file:///C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev/$1" >/dev/null 2>&1
  echo "$2 -> $(stat -c%s .scratch/$2 2>/dev/null || echo FAIL)"
}
shot .scratch/qa-rev2/render.html shot-render.png 1100 420
cp .scratch/shot-render.png qa/evidence/6459/dashboard-huerfano-rev3.png
ls -la qa/evidence/6459/dashboard-huerfano-rev3.png
