# Watchdog V2 — Vigila servicios del pipeline
# Se ejecuta cada 2 minutos via Windows Task Scheduler
# Todo corre desde platform/ (repo principal, siempre en main)

$RepoRoot = 'C:\Workspaces\Intrale\platform'
$PipelineDir = "$RepoRoot\.pipeline"
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

# Servicios criticos — PIDs en el mismo directorio donde corren
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

# Hay servicios caidos — levantar individualmente
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

# Sincronizar con main antes de levantar (para tener scripts actualizados)
try {
    git -C $RepoRoot fetch origin main 2>$null
    git -C $RepoRoot reset --hard FETCH_HEAD 2>$null
} catch {}

$NodeModules = "$RepoRoot\node_modules"

foreach ($svcName in $dead) {
    $script = $ScriptMap[$svcName]
    if (-not $script) { continue }
    $scriptPath = "$PipelineDir\$script"
    if (-not (Test-Path $scriptPath)) {
        Write-Log "  $svcName : script no encontrado ($scriptPath)"
        continue
    }
    try {
        $cmd = "set `"NODE_PATH=$NodeModules`" && node `"$scriptPath`""
        $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -PassThru
        Write-Log "  $svcName : levantado PID $($proc.Id)"
    } catch {
        Write-Log "  $svcName : ERROR al levantar - $_"
    }
}
