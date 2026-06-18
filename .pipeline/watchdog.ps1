# Watchdog V2 — Vigila servicios del pipeline
# Se ejecuta cada 2 minutos via Windows Task Scheduler
# Todo corre desde platform/ (repo principal, siempre en main)
#
# Fuente de verdad: el SO (Get-CimInstance Win32_Process filtrando por
# CommandLine). NO leemos archivos .pid — pueden estar desincronizados de
# la realidad (proceso muerto pero archivo intacto, o viceversa).
# Eso provocaba re-spawns mientras un restart estaba en curso → EADDRINUSE
# en el puerto 3200.

$RepoRoot = 'C:\Workspaces\Intrale\platform'
$PipelineDir = "$RepoRoot\.pipeline"
$LogDir = "$PipelineDir\logs"
$LogFile = "$LogDir\watchdog.log"
# #4077 — Heartbeat propio del watchdog. Lo lee el supervisor externo
# (watchdog-supervisor.ps1) para detectar si el watchdog dejó de correr.
$HeartbeatFile = "$LogDir\watchdog.heartbeat"

if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

# #4077 (SEC-1) — Heartbeat atómico. Contiene el PID del proceso powershell que
# ejecuta ESTE ciclo + timestamp ISO8601, para que el supervisor pueda cruzar
# contra el SO (no decidir sólo por mtime/contenido). Escritura tmp +
# Move-Item -Force: el supervisor nunca lee un archivo a medio escribir.
function Write-Heartbeat {
    try {
        $payload = @{ pid = $PID; ts = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
        $tmp = "$HeartbeatFile.tmp"
        $payload | Out-File -FilePath $tmp -Encoding utf8 -NoNewline
        Move-Item -Path $tmp -Destination $HeartbeatFile -Force
    } catch {
        Write-Log "WARN no se pudo escribir heartbeat: $_"
    }
}

# Emitir el heartbeat lo antes posible: es señal de "el watchdog corrió este
# ciclo", no de "actué". Se escribe incluso en ciclos de stand-by (restart
# reciente) y antes del scan de servicios, de modo que un fallo posterior de
# Get-CimInstance no suprima la señal de vida.
Write-Heartbeat

# Si hay un restart en curso (lock o last-restart.json muy reciente), no
# tocar nada — el restart mata todo y relanza, y un spawn nuestro acá
# genera la carrera "watchdog respawnea el mismo puerto que restart va a usar".
$LastRestartFile = "$PipelineDir\last-restart.json"
if (Test-Path $LastRestartFile) {
    $mtime = (Get-Item $LastRestartFile).LastWriteTime
    $ageSeconds = (Get-Date) - $mtime
    if ($ageSeconds.TotalSeconds -lt 90) {
        Write-Log "Restart reciente ($([int]$ageSeconds.TotalSeconds)s) — watchdog en stand-by"
        exit 0
    }
}

# Servicios críticos: nombre del componente → script file que lo identifica
# en la command line del proceso node.exe.
$Services = @(
    @{ Name = 'pulpo';         Script = 'pulpo.js' },
    @{ Name = 'listener';      Script = 'listener-telegram.js' },
    @{ Name = 'svc-telegram';  Script = 'servicio-telegram.js' },
    @{ Name = 'svc-github';    Script = 'servicio-github.js' },
    @{ Name = 'svc-drive';     Script = 'servicio-drive.js' },
    @{ Name = 'dashboard';     Script = 'dashboard.js' }
)

# Un único scan del SO, reutilizado para todos los componentes.
try {
    $allNodeProcs = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
} catch {
    Write-Log "ERROR al listar procesos node.exe: $_"
    exit 1
}

function Test-ServiceAlive($Script) {
    foreach ($p in $allNodeProcs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$Script*") {
            # Validar que el proceso siga vivo (Win32_Process puede tener entradas stale
            # dentro de la misma ventana de query, aunque raro).
            try {
                $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') { return $true }
            } catch {}
        }
    }
    return $false
}

$dead = @()
foreach ($svc in $Services) {
    if (-not (Test-ServiceAlive $svc.Script)) {
        $dead += $svc.Name
    }
}

if ($dead.Count -eq 0) {
    exit 0
}

$deadList = $dead -join ', '
Write-Log "Servicios caidos detectados: $deadList"

$ScriptMap = @{
    'pulpo'        = 'pulpo.js'
    'listener'     = 'listener-telegram.js'
    'svc-telegram' = 'servicio-telegram.js'
    'svc-github'   = 'servicio-github.js'
    'svc-drive'    = 'servicio-drive.js'
    'dashboard'    = 'dashboard.js'
}

# Sincronizar con main antes de levantar (para tener scripts actualizados)
try {
    git -C $RepoRoot fetch origin main 2>$null
    git -C $RepoRoot reset --hard FETCH_HEAD 2>$null
} catch {}

$NodeModules = "$RepoRoot\node_modules"
$env:NODE_PATH = $NodeModules

foreach ($svcName in $dead) {
    $script = $ScriptMap[$svcName]
    if (-not $script) { continue }
    $scriptPath = "$PipelineDir\$script"
    if (-not (Test-Path $scriptPath)) {
        Write-Log "  $svcName : script no encontrado ($scriptPath)"
        continue
    }

    # Double-check justo antes de spawnear: el primer scan podria ser stale
    # de 1-2s y el servicio puede haber arrancado en ese interin (por ejemplo,
    # restart.js que largo los procesos entre que hicimos el scan y ahora).
    if (Test-ServiceAlive $script) {
        Write-Log "  $svcName : ya arranco entre el scan y el spawn, skip"
        continue
    }

    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList @($scriptPath) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
        Write-Log ("  " + $svcName + " : levantado PID " + $proc.Id)
    } catch {
        $errMsg = $_.Exception.Message
        Write-Log ("  " + $svcName + " : ERROR al levantar - " + $errMsg)
    }
}
