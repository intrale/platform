# Watchdog V2 — Vigila Pulpo + Listener Telegram
# Se ejecuta cada 2 minutos via Windows Task Scheduler
# SIEMPRE lanza desde platform.ops (worktree en main) si está disponible

 = 'C:WorkspacesIntraleplatform.ops'
 = 'C:WorkspacesIntraleplatform'

if (Test-Path "\.pipelinepulpo.js") {
     = "\.pipeline"
     = } else {
     = "\.pipeline"
     = }

 = "\.pipeline"
 = "\logswatchdog.log"

function Write-Log() {
     = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[] " | Out-File -Append -FilePath  -Encoding utf8
}

function Test-ProcessAlive() {
    if (-not (Test-Path )) { return  }
     = [int](Get-Content  -ErrorAction SilentlyContinue)
    if (-not  -or  -eq 0) { return  }
    try {
         = Get-Process -Id  -ErrorAction Stop
        return (.ProcessName -eq 'node')
    } catch {
        return     }
}

if ( -eq ) {
    try {
        git -C  fetch origin main 2>        git -C  checkout FETCH_HEAD --force 2>    } catch {}
}

if (-not (Test-ProcessAlive "\pulpo.pid")) {
    Write-Log "Pulpo caido - relanzando desde "
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "\start-pulpo.bat" -WindowStyle Minimized
}

if (-not (Test-ProcessAlive "\listener.pid")) {
    Write-Log "Listener caido - relanzando desde "
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "\start-listener.bat" -WindowStyle Minimized
}
