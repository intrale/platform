CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
cd /c/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/rev3
for n in 00 01 02 03 04 05 06; do
  rm -rf cp-$n; mkdir -p cp-$n
  "$CH" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --window-size=1280,720 --virtual-time-budget=2500 \
    --user-data-dir="C:\Workspaces\Intrale\platform.agent-6459-pipeline-dev\.scratch\rev3\cp-$n" \
    --screenshot="C:\Workspaces\Intrale\platform.agent-6459-pipeline-dev\.scratch\rev3\s-$n.png" \
    "file:///C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev/.scratch/rev3/s-$n.html" >/dev/null 2>&1
done
