# Watchdog V2 — Vigila Pulpo + Listener Telegram
# Se ejecuta cada 2 minutos via Windows Task Scheduler

$PipelineDir = 'C:\Workspaces\Intrale\platform\.pipeline'
$LogFile = "$PipelineDir\logs\watchdog.log"

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $msg" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

function Test-ProcessAlive($pidFile) {
    if (-not (Test-Path $pidFile)) { return $false }
    $procId = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
    if (-not $procId -or $procId -eq 0) { return $false }
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        return ($proc.ProcessName -eq 'node')
    } catch {
        return $false
    }
}

# --- Pulpo ---
if (-not (Test-ProcessAlive "$PipelineDir\pulpo.pid")) {
    Write-Log 'Pulpo caido - relanzando via .bat'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$PipelineDir\start-pulpo.bat" -WindowStyle Minimized
}

# --- Listener Telegram ---
if (-not (Test-ProcessAlive "$PipelineDir\listener.pid")) {
    Write-Log 'Listener caido - relanzando via .bat'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$PipelineDir\start-listener.bat" -WindowStyle Minimized
}
