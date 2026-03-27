# Watchdog V2 — Vigila Pulpo + Listener Telegram
# Se ejecuta cada 2 minutos via Windows Task Scheduler

$PipelineDir = "C:\Workspaces\Intrale\platform\.pipeline"
$LogFile = "$PipelineDir\logs\watchdog.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] $msg" | Out-File -Append -FilePath $LogFile
}

function Test-ProcessAlive($pidFile) {
    if (-not (Test-Path $pidFile)) { return $false }
    $pid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
    if (-not $pid) { return $false }
    try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# --- Pulpo ---
$pulpoPid = "$PipelineDir\pulpo.pid"
if (-not (Test-ProcessAlive $pulpoPid)) {
    Write-Log "Pulpo caido - relanzando"
    Start-Process -FilePath "node" -ArgumentList "$PipelineDir\pulpo.js" `
        -WorkingDirectory "C:\Workspaces\Intrale\platform" `
        -WindowStyle Hidden -RedirectStandardOutput "$PipelineDir\logs\pulpo.log" `
        -RedirectStandardError "$PipelineDir\logs\pulpo-err.log"
}

# --- Listener Telegram ---
$listenerPid = "$PipelineDir\listener.pid"
if (-not (Test-ProcessAlive $listenerPid)) {
    Write-Log "Listener Telegram caido - relanzando"
    Start-Process -FilePath "node" -ArgumentList "$PipelineDir\listener-telegram.js" `
        -WorkingDirectory "C:\Workspaces\Intrale\platform" `
        -WindowStyle Hidden -RedirectStandardOutput "$PipelineDir\logs\listener.log" `
        -RedirectStandardError "$PipelineDir\logs\listener-err.log"
}
