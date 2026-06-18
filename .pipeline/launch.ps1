# Launch - Arranca el pipeline V2 y registra/endurece las tareas del watchdog
# Uso: powershell -NonInteractive -File .pipeline/launch.ps1
#
# Nota (#4077): el worktree `platform.ops` fue eliminado (ver memoria
# ops-worktree-removed). El pipeline corre desde `platform/` directamente y el
# watchdog hace `git reset --hard FETCH_HEAD` para mantenerse en main. La
# versión anterior de este archivo estaba corrupta (perdió los `$` y los `\`):
# se reconstruyó desde cero como parte de #4077.
#
# Reconstrucción verificada contra la tarea ya registrada en el host:
#   Action: powershell.exe -NonInteractive -File C:\Workspaces\Intrale\platform\.pipeline\watchdog.ps1
#   Principal: Administrator · RunLevel Limited (NO Highest, NO SYSTEM — SEC-3)

$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Workspaces\Intrale\platform'
$PipelineDir = "$RepoRoot\.pipeline"

$env:PIPELINE_STATE_DIR = $PipelineDir
$env:PIPELINE_MAIN_ROOT = $RepoRoot
$env:NODE_PATH = "$RepoRoot\node_modules"

Write-Host '=== Pipeline V2 - Lanzamiento ===' -ForegroundColor Cyan

function Start-PipelineService($Script, $Style) {
    $scriptPath = "$PipelineDir\$Script"
    if (-not (Test-Path $scriptPath)) {
        Write-Host "WARN: no existe $scriptPath" -ForegroundColor Yellow
        return
    }
    Start-Process -FilePath 'node' -ArgumentList @($scriptPath) -WorkingDirectory $RepoRoot -WindowStyle $Style
}

Write-Host 'Lanzando Pulpo...' -ForegroundColor Yellow
Start-PipelineService 'pulpo.js' 'Minimized'
Start-Sleep -Seconds 2

Write-Host 'Lanzando Listener Telegram...' -ForegroundColor Yellow
Start-PipelineService 'listener-telegram.js' 'Minimized'
Start-Sleep -Seconds 2

Write-Host 'Lanzando servicios...' -ForegroundColor Yellow
Start-PipelineService 'servicio-telegram.js' 'Hidden'
Start-PipelineService 'servicio-github.js' 'Hidden'
Start-PipelineService 'servicio-drive.js' 'Hidden'
Start-PipelineService 'dashboard.js' 'Hidden'

# =============================================================================
# Tareas de Task Scheduler (#4077)
# =============================================================================
$WatchdogTask = 'Intrale-Pipeline-V2-Watchdog'
$SupervisorTask = 'Intrale-Pipeline-V2-Watchdog-Supervisor'

# --- Tarea principal: endurecida (#4077) ------------------------------------
# WakeToRun: despierta la máquina para correr (ataca el incidente real: host
#   suspendido/dormido — lo que el supervisor same-host NO puede cubrir).
# RestartCount/RestartInterval: reintenta instancias fallidas.
# ExecutionTimeLimit 5 min: una instancia colgada ya no bloquea 72h (PT72H era
#   parte del incidente).
$mainSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -WakeToRun `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$watchdogAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NonInteractive -File $PipelineDir\watchdog.ps1"
$watchdogTrigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 2) -Once -At (Get-Date)

$existingWatchdog = Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
if ($existingWatchdog) {
    # Set-ScheduledTask sin -Principal preserva el principal actual (SEC-3).
    Write-Host 'Endureciendo settings de la tarea watchdog principal...' -ForegroundColor Yellow
    Set-ScheduledTask -TaskName $WatchdogTask -Action $watchdogAction -Trigger $watchdogTrigger -Settings $mainSettings | Out-Null
    Write-Host 'Watchdog principal endurecido OK' -ForegroundColor Green
} else {
    Write-Host 'Registrando watchdog principal...' -ForegroundColor Yellow
    Register-ScheduledTask -TaskName $WatchdogTask -Action $watchdogAction -Trigger $watchdogTrigger -Settings $mainSettings -Description 'Watchdog Pipeline V2 Intrale (#4077)' | Out-Null
    Write-Host 'Watchdog principal registrado OK' -ForegroundColor Green
}

# --- 2da tarea: supervisor del watchdog (#4077) -----------------------------
# SEC-3: se registra con el MISMO principal/usuario que la principal (sin
# -Principal => usuario interactivo que corre launch.ps1, RunLevel Limited).
# NO elevar a SYSTEM ni RunLevel Highest: el script vive en .pipeline/, ruta
# escribible por los agentes.
$supSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$supAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NonInteractive -File $PipelineDir\watchdog-supervisor.ps1"
$supTrigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 5) -Once -At (Get-Date)

$existingSup = Get-ScheduledTask -TaskName $SupervisorTask -ErrorAction SilentlyContinue
if ($existingSup) {
    Write-Host 'Actualizando tarea supervisora...' -ForegroundColor Yellow
    Set-ScheduledTask -TaskName $SupervisorTask -Action $supAction -Trigger $supTrigger -Settings $supSettings | Out-Null
    Write-Host 'Supervisor actualizado OK' -ForegroundColor Green
} else {
    Write-Host 'Registrando tarea supervisora del watchdog...' -ForegroundColor Yellow
    Register-ScheduledTask -TaskName $SupervisorTask -Action $supAction -Trigger $supTrigger -Settings $supSettings -Description 'Supervisor del Watchdog Pipeline V2 Intrale (#4077) - mismo principal que la principal (SEC-3)' | Out-Null
    Write-Host 'Supervisor registrado OK' -ForegroundColor Green
}

Write-Host ''
Write-Host '=== Pipeline V2 operativo ===' -ForegroundColor Green
Write-Host "  Root:        $RepoRoot"
Write-Host '  Pulpo:       corriendo'
Write-Host '  Listener:    corriendo'
Write-Host '  Servicios:   telegram, github, drive, dashboard'
Write-Host '  Watchdog:    cada 2 min (WakeToRun, RestartCount=3, ExecTimeLimit 5 min)'
Write-Host '  Supervisor:  cada 5 min (relanza el watchdog si el heartbeat esta stale)'
