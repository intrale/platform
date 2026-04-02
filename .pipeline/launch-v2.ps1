# Launch V2 - Arranca todo el pipeline V2
# Uso: powershell -File .pipeline/launch-v2.ps1
# SIEMPRE lanza desde platform.ops (worktree en main) si está disponible

 = 'C:WorkspacesIntraleplatform.ops'
 = 'C:WorkspacesIntraleplatform'

if (Test-Path "\.pipelinepulpo.js") {
     = "\.pipeline"
     =     Write-Host 'Ejecutando desde worktree ops (main)' -ForegroundColor Green
} else {
     = "\.pipeline"
     =     Write-Host 'WARN: worktree ops no disponible, usando directorio principal' -ForegroundColor Yellow
}

if ( -eq ) {
    Write-Host 'Sincronizando ops con origin/main...' -ForegroundColor DarkGray
    try {
        git -C  fetch origin main 2>        git -C  checkout FETCH_HEAD --force 2>        Write-Host 'Sincronizado OK' -ForegroundColor DarkGray
    } catch {
        Write-Host 'Warning: no se pudo sincronizar ops' -ForegroundColor Yellow
    }
}

:PIPELINE_STATE_DIR = "\.pipeline"
:PIPELINE_MAIN_ROOT = 
Write-Host '=== Pipeline V2 - Lanzamiento ===' -ForegroundColor Cyan

Write-Host 'Lanzando Pulpo...' -ForegroundColor Yellow
Start-Process -FilePath 'node' -ArgumentList "\pulpo.js" -WorkingDirectory  -WindowStyle Minimized
Start-Sleep -Seconds 2

Write-Host 'Lanzando Listener Telegram...' -ForegroundColor Yellow
Start-Process -FilePath 'node' -ArgumentList "\listener-telegram.js" -WorkingDirectory  -WindowStyle Minimized
Start-Sleep -Seconds 2

Write-Host 'Lanzando servicios...' -ForegroundColor Yellow
Start-Process -FilePath 'node' -ArgumentList "\servicio-telegram.js" -WorkingDirectory  -WindowStyle Hidden
Start-Process -FilePath 'node' -ArgumentList "\servicio-github.js" -WorkingDirectory  -WindowStyle Hidden
Start-Process -FilePath 'node' -ArgumentList "\servicio-drive.js" -WorkingDirectory  -WindowStyle Hidden

 = 'Intrale-Pipeline-V2-Watchdog'
 = Get-ScheduledTask -TaskName  -ErrorAction SilentlyContinue
if (-not ) {
    Write-Host 'Registrando watchdog en Task Scheduler...' -ForegroundColor Yellow
     = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -File \.pipelinewatchdog.ps1"
     = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 2) -Once -At (Get-Date)
     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName  -Action  -Trigger  -Settings  -Description 'Watchdog Pipeline V2 Intrale'
    Write-Host 'Watchdog registrado OK' -ForegroundColor Green
} else {
    Write-Host 'Watchdog ya registrado' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=== Pipeline V2 operativo ===' -ForegroundColor Green
Write-Host "  Root:      "
Write-Host '  Pulpo:     corriendo'
Write-Host '  Listener:  corriendo'
Write-Host '  Servicios: telegram, github, drive'
Write-Host '  Watchdog:  cada 2 min'
