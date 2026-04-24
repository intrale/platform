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

if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

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
    @{ Name = 'dashboard';     Script = 'dashboard-v2.js' }
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

# Segunda fuente de verdad: el marker ready. El servicio (si está vivo) hace
# heartbeat cada 30s reescribiendo .pipeline/ready/<name>.ready con su PID
# y readyAt actual (ver issue #2450). Si el marker es fresh y el PID del
# marker está vivo, preferimos confiar en él antes que respawnear.
#
# Motivo: Test-ServiceAlive puede dar falso negativo en casos raros (Win32
# query stale en la misma ventana, CommandLine corrompido, etc.). Respawnear
# en esas condiciones dispara el loop singleton-abort → marker stale, que
# es exactamente el bug que arrastramos acá.
function Test-MarkerFresh($Name, [int]$StaleSeconds = 120) {
    $markerPath = "$PipelineDir\ready\$Name.ready"
    if (-not (Test-Path $markerPath)) { return $false }
    try {
        $raw = Get-Content -Path $markerPath -Raw -ErrorAction Stop
        $data = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $false
    }
    if (-not $data.pid -or -not $data.readyAt) { return $false }
    # ¿PID del marker sigue vivo?
    try {
        $null = Get-Process -Id $data.pid -ErrorAction Stop
    } catch {
        return $false
    }
    # ¿readyAt es fresh?
    try {
        $readyAt = [datetime]::Parse($data.readyAt)
        $ageSec = ((Get-Date).ToUniversalTime() - $readyAt.ToUniversalTime()).TotalSeconds
        if ($ageSec -gt $StaleSeconds) { return $false }
    } catch {
        return $false
    }
    return $true
}

$dead = @()
foreach ($svc in $Services) {
    if (-not (Test-ServiceAlive $svc.Script)) {
        # Antes de marcar dead: segunda opinión desde el marker ready.
        # Si el marker dice que hay un PID vivo con heartbeat reciente,
        # confiamos en él (issue #2450).
        if (Test-MarkerFresh $svc.Name) {
            Write-Log "  $($svc.Name) : Test-ServiceAlive=false pero marker fresh con PID vivo — no respawn"
            continue
        }
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

    # Double-check justo antes de spawnear: el primer scan podría ser stale
    # de 1-2s y el servicio puede haber arrancado en ese ínterin (por ejemplo,
    # restart.js que largó los procesos entre que hicimos el scan y ahora).
    if (Test-ServiceAlive $script) {
        Write-Log "  $svcName : ya arrancó entre el scan y el spawn, skip"
        continue
    }
    # Segunda verificación: marker fresh + PID vivo. Mismo racional que el
    # filtro inicial — evitar respawns spurious por detecciones ambiguas.
    if (Test-MarkerFresh $svcName) {
        Write-Log "  $svcName : marker fresh con PID vivo entre scan y spawn, skip"
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
