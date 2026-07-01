# =============================================================================
# register-quota-snapshot-task.ps1 — Supervisión del capturador de cuota (CA-2)
# Issue #4326 (split de #4324).
#
# QUÉ HACE
#   Registra (o actualiza) una tarea de Windows Task Scheduler que ejecuta el
#   scheduler de snapshots de cuota en modo `--once` de forma periódica. Es la
#   Opción B recomendada por el arquitecto: DESACOPLA la captura (dependencia
#   ambiental dura sobre Claude Desktop) del gate de smoke-test/auto-rollback de
#   `restart.js`. Un fallo de captura ambiental NO debe tumbar el pipeline
#   residente (Riesgo #1 del issue).
#
#   Mismo patrón que el watchdog (#4077): tarea de Task Scheduler, cada disparo
#   es un proceso nuevo `node quota-snapshot-scheduler.js --once`; un hueco en
#   `logs/quota-snapshot.log` significa "no hubo captura en ese tick", no caída.
#
# USO
#   powershell -NonInteractive -File .pipeline/scripts/register-quota-snapshot-task.ps1
#   powershell -NonInteractive -File .pipeline/scripts/register-quota-snapshot-task.ps1 -IntervalMinutes 30
#   powershell -NonInteractive -File .pipeline/scripts/register-quota-snapshot-task.ps1 -Unregister
#   powershell -NonInteractive -File .pipeline/scripts/register-quota-snapshot-task.ps1 -Verify
#
# SEGURIDAD (CA-6 / SEC-4)
#   - Principal por defecto: el usuario interactivo que corre este script,
#     RunLevel Limited (SIN -Principal, NO SYSTEM, NO Highest). El script vive en
#     `.pipeline/`, ruta escribible por los agentes; elevar sería un vector de
#     escalada.
#   - La acción invoca `node.exe` con argumentos como array (Task Scheduler no
#     interpola shell): sin string de shell, sin env envenenada interpolada.
#   - Las 3 env vars sensibles (QUOTA_SNAPSHOT_ENABLED, CLAUDE_DESKTOP_PATH,
#     EXPECTED_CLAUDE_ACCOUNT) las provee el operador a nivel máquina/usuario;
#     este script NO las hardcodea (Riesgo #2 del issue).
# =============================================================================

[CmdletBinding()]
param(
    [string]$RepoRoot = 'C:\Workspaces\Intrale\platform',
    [int]$IntervalMinutes = 60,
    [switch]$Unregister,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Intrale-Pipeline-V2-QuotaSnapshot'
$PipelineDir = Join-Path $RepoRoot '.pipeline'
$SchedulerScript = Join-Path $PipelineDir 'quota-snapshot-scheduler.js'
$LogFile = Join-Path (Join-Path $PipelineDir 'logs') 'quota-snapshot.log'

# --- Unregister ------------------------------------------------------------
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Tarea '$TaskName' desregistrada." -ForegroundColor Green
    } else {
        Write-Host "Tarea '$TaskName' no existe, nada que desregistrar." -ForegroundColor Yellow
    }
    exit 0
}

# --- Verify ----------------------------------------------------------------
if ($Verify) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "Tarea '$TaskName' NO registrada." -ForegroundColor Red
        exit 1
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Tarea '$TaskName' registrada." -ForegroundColor Green
    Write-Host "  State:        $($existing.State)"
    Write-Host "  LastRunTime:  $($info.LastRunTime)"
    Write-Host "  LastResult:   $($info.LastTaskResult)"
    Write-Host "  NextRunTime:  $($info.NextRunTime)"
    Write-Host "  Action:       $($existing.Actions[0].Execute) $($existing.Actions[0].Arguments)"
    Write-Host "  Log:          $LogFile"
    exit 0
}

# --- Register / actualizar -------------------------------------------------
if ($IntervalMinutes -lt 5)    { $IntervalMinutes = 5 }
if ($IntervalMinutes -gt 1440) { $IntervalMinutes = 1440 }

if (-not (Test-Path -LiteralPath $SchedulerScript)) {
    throw "No existe el scheduler: $SchedulerScript"
}

# Resolver node.exe: Task Scheduler no hereda el PATH del shell interactivo, así
# que pinneamos la ruta absoluta resuelta al momento del registro.
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    throw "node no está en el PATH; no se puede pinnear node.exe para la tarea."
}
$NodePath = $NodeCmd.Source

# Acción: node.exe quota-snapshot-scheduler.js --once (argumentos como array,
# sin interpolación de shell — SEC-4).
$action = New-ScheduledTaskAction -Execute $NodePath `
    -Argument "`"$SchedulerScript`" --once" `
    -WorkingDirectory $RepoRoot

# Trigger: repetición cada N minutos, indefinida. `-Once -At (Get-Date)` +
# RepetitionInterval == mismo patrón que el watchdog c/2min.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# Settings: arrancar cuando esté disponible, y ExecutionTimeLimit de 5 min para
# que una instancia colgada nunca bloquee (el hard-cap interno de captura es
# 90s). Sin RestartCount agresivo: un fallo de captura es esperable (ambiental).
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Principal: SIN -Principal → usuario interactivo que corre este script,
# RunLevel Limited. NO SYSTEM, NO Highest (SEC-4).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Actualizando tarea '$TaskName'..." -ForegroundColor Yellow
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
    Write-Host "Tarea '$TaskName' actualizada OK (cada $IntervalMinutes min)." -ForegroundColor Green
} else {
    Write-Host "Registrando tarea '$TaskName'..." -ForegroundColor Yellow
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description 'Capturador de cuota Anthropic (OCR) supervisado - Pipeline V2 Intrale (#4326). Corre quota-snapshot-scheduler.js --once periodicamente, desacoplado del auto-rollback de restart.js.' | Out-Null
    Write-Host "Tarea '$TaskName' registrada OK (cada $IntervalMinutes min)." -ForegroundColor Green
}

Write-Host ''
Write-Host '=== Capturador de cuota supervisado ===' -ForegroundColor Green
Write-Host "  Tarea:     $TaskName"
Write-Host "  Node:      $NodePath"
Write-Host "  Script:    $SchedulerScript --once"
Write-Host "  Intervalo: cada $IntervalMinutes min"
Write-Host "  Log:       $LogFile"
Write-Host ''
Write-Host 'Recordatorio (Riesgo #2): resolver con el operador las 3 env vars a' -ForegroundColor Cyan
Write-Host 'nivel maquina/usuario ANTES de esperar dato fresco:' -ForegroundColor Cyan
Write-Host '  QUOTA_SNAPSHOT_ENABLED (!=false), CLAUDE_DESKTOP_PATH, EXPECTED_CLAUDE_ACCOUNT' -ForegroundColor Cyan
