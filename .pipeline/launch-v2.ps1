# Launch V2 — Arranca todo el pipeline V2
# Uso: powershell -File .pipeline/launch-v2.ps1

$PipelineDir = "C:\Workspaces\Intrale\platform\.pipeline"
$RootDir = "C:\Workspaces\Intrale\platform"

Write-Host "=== Pipeline V2 — Lanzamiento ===" -ForegroundColor Cyan

# 1. Pulpo
Write-Host "Lanzando Pulpo..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList "$PipelineDir\pulpo.js" `
    -WorkingDirectory $RootDir -WindowStyle Minimized
Start-Sleep -Seconds 2

# 2. Listener Telegram
Write-Host "Lanzando Listener Telegram..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList "$PipelineDir\listener-telegram.js" `
    -WorkingDirectory $RootDir -WindowStyle Minimized
Start-Sleep -Seconds 2

# 3. Servicios fire-and-forget
Write-Host "Lanzando servicios..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList "$PipelineDir\servicio-telegram.js" `
    -WorkingDirectory $RootDir -WindowStyle Hidden
Start-Process -FilePath "node" -ArgumentList "$PipelineDir\servicio-github.js" `
    -WorkingDirectory $RootDir -WindowStyle Hidden
Start-Process -FilePath "node" -ArgumentList "$PipelineDir\servicio-drive.js" `
    -WorkingDirectory $RootDir -WindowStyle Hidden

# 4. Registrar watchdog en Task Scheduler (una sola vez)
$taskName = "Intrale-Pipeline-V2-Watchdog"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existingTask) {
    Write-Host "Registrando watchdog en Task Scheduler..." -ForegroundColor Yellow
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NonInteractive -File $PipelineDir\watchdog.ps1"
    $trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 2) `
        -Once -At (Get-Date)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action `
        -Trigger $trigger -Settings $settings -Description "Watchdog Pipeline V2 Intrale"
    Write-Host "Watchdog registrado OK" -ForegroundColor Green
} else {
    Write-Host "Watchdog ya registrado" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Pipeline V2 operativo ===" -ForegroundColor Green
Write-Host "  Pulpo:     corriendo"
Write-Host "  Listener:  corriendo"
Write-Host "  Servicios: telegram, github, drive"
Write-Host "  Watchdog:  cada 2 min"
Write-Host ""
Write-Host "Comandos utiles:"
Write-Host "  Estado:   ls .pipeline/desarrollo/*/pendiente/"
Write-Host "  Pausar:   touch .pipeline/.paused"
Write-Host "  Reanudar: rm .pipeline/.paused"
Write-Host "  Detener:  taskkill /F /PID (cat .pipeline/pulpo.pid)"
