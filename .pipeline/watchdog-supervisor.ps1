# =============================================================================
# watchdog-supervisor.ps1 — Supervisor del watchdog (#4077)
#
# 2da tarea de Windows Task Scheduler (Intrale-Pipeline-V2-Watchdog-Supervisor),
# independiente de la tarea principal. Corre cada ~5 min. Su único trabajo:
# detectar si el watchdog dejó de correr (heartbeat stale o tarea no viva) y
# relanzar la tarea principal.
#
# Diseño (SEC-1..SEC-5, fase criterios #4077):
#   - Capa fina de SO: recolecta hechos (heartbeat + estado de la tarea) y
#     delega la DECISIÓN a Node (watchdog-supervisor-run.js), que es la única
#     fuente de verdad testeada (`node --test`).
#   - SEC-2: $RepoRoot hardcodeado, NO de input. Sin Invoke-Expression. El
#     relanzamiento es Start-ScheduledTask con nombre fijo.
#   - SEC-1: además del heartbeat, cruza contra el SO (estado de la tarea).
#   - SEC-3: se registra con el mismo principal/usuario que la tarea principal
#     (ver launch.ps1), sin elevar a SYSTEM/Highest.
#   - SEC-4/SEC-5: cap, cooldown y alerta Telegram los maneja el runner Node.
#
# Limitación documentada: un supervisor same-host NO cubre el incidente real
# (host suspendido/dormido). Eso lo ataca WakeToRun:True + plan de energía
# sobre la tarea principal (ver launch.ps1). El supervisor off-host queda
# fuera de scope (ver PR de #4077).
# =============================================================================

$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Workspaces\Intrale\platform'        # SEC-2: hardcodeado, NO input
$PipelineDir = "$RepoRoot\.pipeline"
$HeartbeatFile = "$PipelineDir\logs\watchdog.heartbeat"
$SupLog = "$PipelineDir\logs\watchdog-supervisor.log"
$RunnerJs = "$PipelineDir\watchdog-supervisor-run.js"
$MainTask = 'Intrale-Pipeline-V2-Watchdog'

if (-not (Test-Path "$PipelineDir\logs")) {
    New-Item -Path "$PipelineDir\logs" -ItemType Directory -Force | Out-Null
}

function Write-SupLog($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $SupLog -Encoding utf8
}

# --- 1. Hechos del heartbeat -------------------------------------------------
$hbExists = '0'
$hbAgeMs = ''
if (Test-Path $HeartbeatFile) {
    try {
        $mtime = (Get-Item $HeartbeatFile).LastWriteTime
        $hbAgeMs = [int]((Get-Date) - $mtime).TotalMilliseconds
        $hbExists = '1'
    } catch {
        # Ilegible => lo tratamos como ausente (fail-closed lo resuelve el runner).
        $hbExists = '0'
        $hbAgeMs = ''
    }
}

# --- 2. Cross-check contra el SO (SEC-1) -------------------------------------
# El watchdog es una tarea de corta duración (corre y termina), así que NO
# buscamos un proceso vivo: consultamos el estado de la tarea principal. Si la
# tarea no existe o está deshabilitada, no hay red de seguridad => no-healthy.
$taskHealthy = ''
try {
    $task = Get-ScheduledTask -TaskName $MainTask -ErrorAction Stop
    if ($task.State -eq 'Disabled') {
        $taskHealthy = '0'
    } else {
        $taskHealthy = '1'
    }
} catch {
    # La tarea no existe / no se pudo consultar => no hay supervisión activa.
    $taskHealthy = '0'
}

# --- 3. Delegar la decisión a Node (única fuente de verdad) ------------------
$env:WDS_HB_EXISTS = $hbExists
$env:WDS_HB_AGE_MS = "$hbAgeMs"
$env:WDS_TASK_HEALTHY = $taskHealthy
$env:NODE_PATH = "$RepoRoot\node_modules"

$decision = 'ACTION:skip'
try {
    $output = & node $RunnerJs 2>&1
    Write-SupLog "runner: $output"
    foreach ($line in @($output)) {
        if ("$line" -match 'ACTION:(relaunch|skip|escalate)') {
            $decision = "ACTION:$($matches[1])"
        }
    }
} catch {
    Write-SupLog "ERROR ejecutando runner Node: $_"
    exit 0
}

# --- 4. Ejecutar la acción (SEC-2: nombre de tarea fijo, sin IEX) ------------
if ($decision -eq 'ACTION:relaunch') {
    try {
        Start-ScheduledTask -TaskName $MainTask -ErrorAction Stop
        Write-SupLog "Watchdog relanzado via Start-ScheduledTask ($MainTask)"
    } catch {
        Write-SupLog "ERROR al relanzar watchdog: $_"
    }
} else {
    Write-SupLog "Sin acción (decision=$decision)"
}

exit 0
