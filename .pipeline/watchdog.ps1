# Watchdog V2 — Vigila todos los servicios del pipeline
# Se ejecuta cada 2 minutos via Windows Task Scheduler
# Usa platform.ops (worktree ops en main) si esta disponible

$OpsRoot = 'C:\Workspaces\Intrale\platform.ops'
$FallbackRoot = 'C:\Workspaces\Intrale\platform'

if (Test-Path "$OpsRoot\.pipeline\pulpo.js") {
    $PipelineDir = "$OpsRoot\.pipeline"
    $WorkDir = $OpsRoot
} else {
    $PipelineDir = "$FallbackRoot\.pipeline"
    $WorkDir = $FallbackRoot
}

$LogDir = "$PipelineDir\logs"
$LogFile = "$LogDir\watchdog.log"

# Crear directorio de logs si no existe
if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

function Test-ProcessAlive($PidFile) {
    if (-not (Test-Path $PidFile)) { return $false }
    $pidStr = Get-Content $PidFile -ErrorAction SilentlyContinue
    if (-not $pidStr -or $pidStr.Trim() -eq '') { return $false }
    $procId = [int]$pidStr.Trim()
    if ($procId -eq 0) { return $false }
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        return ($proc.ProcessName -eq 'node')
    } catch {
        return $false
    }
}

# Servicios escriben PIDs en su propio directorio (PipelineDir = ops o fallback)
# NO sincronizar ops con git aquí — el checkout --force borra los .pid files
# El restart.js ya hace git sync en su fase START
$Services = @(
    @{ Name = 'pulpo';         Pid = "$PipelineDir\pulpo.pid" },
    @{ Name = 'listener';      Pid = "$PipelineDir\listener.pid" },
    @{ Name = 'svc-telegram';  Pid = "$PipelineDir\svc-telegram.pid" },
    @{ Name = 'svc-github';    Pid = "$PipelineDir\svc-github.pid" },
    @{ Name = 'svc-drive';     Pid = "$PipelineDir\svc-drive.pid" },
    @{ Name = 'dashboard';     Pid = "$PipelineDir\dashboard.pid" }
)

# Verificar cada servicio
$dead = @()
foreach ($svc in $Services) {
    if (-not (Test-ProcessAlive $svc.Pid)) {
        $dead += $svc.Name
    }
}

if ($dead.Count -eq 0) {
    # Todo vivo, no loguear para no llenar el log
    exit 0
}

# Hay servicios caidos — levantar individualmente con Start-Process (sobrevive al cierre del task)
$deadList = $dead -join ', '
Write-Log "Servicios caidos detectados: $deadList"

# Mapeo de servicio a script
$ScriptMap = @{
    'pulpo'        = 'pulpo.js'
    'listener'     = 'listener-telegram.js'
    'svc-telegram' = 'servicio-telegram.js'
    'svc-github'   = 'servicio-github.js'
    'svc-drive'    = 'servicio-drive.js'
    'dashboard'    = 'dashboard-v2.js'
}

$MainRoot = $FallbackRoot
$NodeModules = "$MainRoot\node_modules"

foreach ($svcName in $dead) {
    $script = $ScriptMap[$svcName]
    if (-not $script) { continue }
    $scriptPath = "$PipelineDir\$script"
    if (-not (Test-Path $scriptPath)) {
        Write-Log "  $svcName : script no encontrado ($scriptPath)"
        continue
    }
    try {
        $cmd = "set `"PIPELINE_STATE_DIR=$MainRoot\.pipeline`" && set `"PIPELINE_MAIN_ROOT=$MainRoot`" && set `"NODE_PATH=$NodeModules`" && node `"$scriptPath`""
        $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd `
            -WorkingDirectory $WorkDir `
            -WindowStyle Hidden `
            -PassThru
        Write-Log "  $svcName : levantado PID $($proc.Id)"
    } catch {
        Write-Log "  $svcName : ERROR al levantar - $_"
    }
}
