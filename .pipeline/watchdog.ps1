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

# PIDs siempre se escriben en el repo principal (PIPELINE_STATE_DIR de restart.js)
$PidDir = "$FallbackRoot\.pipeline"

# Servicios criticos que deben estar siempre vivos
$Services = @(
    @{ Name = 'pulpo';         Pid = "$PidDir\pulpo.pid" },
    @{ Name = 'listener';      Pid = "$PidDir\listener.pid" },
    @{ Name = 'svc-telegram';  Pid = "$PidDir\svc-telegram.pid" },
    @{ Name = 'svc-github';    Pid = "$PidDir\svc-github.pid" },
    @{ Name = 'svc-drive';     Pid = "$PidDir\svc-drive.pid" },
    @{ Name = 'dashboard';     Pid = "$PidDir\dashboard.pid" }
)

# Sincronizar worktree ops con main (silencioso)
if ($WorkDir -eq $OpsRoot) {
    try {
        git -C $OpsRoot fetch origin main 2>$null
        git -C $OpsRoot checkout FETCH_HEAD --force 2>$null
    } catch {}
}

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

# Hay servicios caidos — restart completo
$deadList = $dead -join ', '
Write-Log "Servicios caidos detectados: $deadList -- ejecutando restart.js"

try {
    $restartScript = "$PipelineDir\restart.js"
    $output = & node $restartScript 2>&1
    foreach ($line in $output) {
        Write-Log "  $line"
    }
    Write-Log "Restart completado"
} catch {
    Write-Log "ERROR en restart: $_"
}
