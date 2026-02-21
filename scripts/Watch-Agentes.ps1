<#
.SYNOPSIS
    Vigila agentes Claude y ejecuta ciclo continuo al finalizar.

.DESCRIPTION
    Lee sprint-plan.json y monitorea las sesiones de cada agente.
    Al detectar que todos finalizaron:
    1. Ejecuta Stop-Agente.ps1 all (commit + PR + merge + cleanup)
    2. Pregunta via Telegram si planificar el siguiente sprint
    3. Si confirma: git pull + nueva terminal con claude '/planner sprint'
       + nueva terminal con claude '/planner proponer' (en paralelo)

.PARAMETER PollInterval
    Intervalo de polling en segundos (default: 30).

.PARAMETER NoAutoProponer
    Si se indica, no se lanza automaticamente '/planner proponer' en paralelo.

.EXAMPLE
    .\Watch-Agentes.ps1
    .\Watch-Agentes.ps1 -PollInterval 60
    .\Watch-Agentes.ps1 -NoAutoProponer
#>
param(
    [int]$PollInterval = 30,
    [switch]$NoAutoProponer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$MainRepo  = "C:\Workspaces\Intrale\platform"
$PlanFile  = Join-Path $PSScriptRoot "sprint-plan.json"
$AskScript = Join-Path $PSScriptRoot "ask-next-sprint.js"

# --- Helpers ---
$P = '>>'

function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "$P [$ts] $Msg" -ForegroundColor $Color
}

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error ('No se encontro el plan: {0}' -f $PlanFile)
    exit 1
}

# --- Leer plan ---
$Plan = Get-Content $PlanFile -Raw | ConvertFrom-Json
$AgentCount = $Plan.agentes.Count

if ($AgentCount -eq 0) {
    Write-Log 'El plan no tiene agentes. Nada que vigilar.' 'Yellow'
    exit 0
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Magenta
Write-Host '  Watch-Agentes -- Ciclo Continuo'            -ForegroundColor Magenta
Write-Host '============================================' -ForegroundColor Magenta
Write-Host ''
Write-Log ('Vigilando {0} agente(s) del sprint {1}' -f $AgentCount, $Plan.fecha) 'Cyan'
Write-Log ('Intervalo de polling: {0}s' -f $PollInterval) 'Cyan'
if ($NoAutoProponer) {
    Write-Log 'Auto-proponer deshabilitado (-NoAutoProponer)' 'Yellow'
}
Write-Host ''

foreach ($a in $Plan.agentes) {
    Write-Log ('  Agente {0}: issue #{1} ({2})' -f $a.numero, $a.issue, $a.slug)
}
Write-Host ''

# --- Funciones de deteccion ---

function Get-WorktreePath {
    param($Agente)
    return '{0}\..\platform.codex-{1}-{2}' -f $MainRepo, $Agente.issue, $Agente.slug
}

function Test-AgentDone {
    param([string]$WtDir)

    # Worktree no existe → done (nunca arranco o ya fue limpiado)
    if (-not (Test-Path $WtDir)) { return $true }

    $wtResolved = (Resolve-Path $WtDir -ErrorAction SilentlyContinue)
    if (-not $wtResolved) { return $true }

    # Buscar session files con status "done" en .claude/sessions/ del worktree
    # El hook stop-notify.js marca la sesion como "done" cuando claude finaliza
    $sessionsDir = Join-Path $wtResolved '.claude' 'sessions'
    if (Test-Path $sessionsDir) {
        $sessionFiles = Get-ChildItem $sessionsDir -Filter '*.json' -ErrorAction SilentlyContinue
        foreach ($sf in $sessionFiles) {
            try {
                $sess = Get-Content $sf.FullName -Raw | ConvertFrom-Json
                if ($sess.status -eq 'done') { return $true }
            }
            catch { }
        }
    }

    return $false
}

function Test-NoClaude {
    # Failsafe: verificar si hay ALGUN proceso claude corriendo
    $procs = Get-Process -Name 'claude' -ErrorAction SilentlyContinue
    return (-not $procs -or @($procs).Count -eq 0)
}

# --- Polling loop ---
$startTime = Get-Date
$allDone = $false
$FailsafeMinutes = 240  # 4 horas

while (-not $allDone) {
    $doneCount = 0
    $statusParts = @()

    foreach ($a in $Plan.agentes) {
        $wtDir = Get-WorktreePath $a
        $isDone = Test-AgentDone $wtDir
        if ($isDone) {
            $doneCount++
            $statusParts += ('{0}:OK' -f $a.numero)
        }
        else {
            $statusParts += ('{0}:...' -f $a.numero)
        }
    }

    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
    $statusLine = $statusParts -join '  '
    Write-Log ('{0}/{1} finalizados  [{2}]  ({3} min)' -f $doneCount, $AgentCount, $statusLine, $elapsed)

    if ($doneCount -ge $AgentCount) {
        $allDone = $true
        break
    }

    # Failsafe: si paso mucho tiempo y no hay procesos claude, considerar terminados
    if ($elapsed -gt $FailsafeMinutes -and (Test-NoClaude)) {
        Write-Log 'Failsafe: no hay procesos claude activos tras {0} min. Procediendo.' 'Yellow' -f $elapsed
        $allDone = $true
        break
    }

    Start-Sleep -Seconds $PollInterval
}

Write-Host ''
Write-Log 'Todos los agentes finalizaron!' 'Green'
Write-Host ''

# --- Ejecutar Stop-Agente.ps1 all ---
Write-Log 'Ejecutando Stop-Agente.ps1 all...' 'Cyan'
$stopScript = Join-Path $PSScriptRoot 'Stop-Agente.ps1'
try {
    & $stopScript all
    Write-Log 'Stop-Agente.ps1 finalizado.' 'Green'
}
catch {
    Write-Log ('Error en Stop-Agente: {0}' -f $_.Exception.Message) 'Red'
    # Continuar igualmente -- el usuario puede resolver manualmente
}

Write-Host ''

# --- Preguntar si planificar el siguiente sprint ---
$confirmed = $false

if (Test-Path $AskScript) {
    # Intentar via Telegram (Node.js helper)
    Write-Log 'Consultando via Telegram...' 'Cyan'
    try {
        $rawResult = & node $AskScript 2>$null
        $result = $rawResult | ConvertFrom-Json
        if ($result.confirmed -eq $true) {
            $confirmed = $true
            Write-Log 'Usuario confirmo: planificar siguiente sprint.' 'Green'
        }
        elseif ($result.timeout -eq $true) {
            Write-Log 'Timeout en Telegram, preguntando en terminal...' 'Yellow'
            $resp = Read-Host '>> Sprint completado. Planificar siguiente sprint y proponer nuevas historias? (s/N)'
            if ($resp -match '^[sS]') { $confirmed = $true }
        }
        else {
            Write-Log 'Usuario rechazo: fin del ciclo.' 'Yellow'
        }
    }
    catch {
        Write-Log ('Telegram no disponible ({0}), preguntando en terminal...' -f $_.Exception.Message) 'Yellow'
        $resp = Read-Host '>> Sprint completado. Planificar siguiente sprint y proponer nuevas historias? (s/N)'
        if ($resp -match '^[sS]') { $confirmed = $true }
    }
}
else {
    # Fallback: preguntar en terminal
    $resp = Read-Host '>> Sprint completado. Planificar siguiente sprint y proponer nuevas historias? (s/N)'
    if ($resp -match '^[sS]') { $confirmed = $true }
}

if (-not $confirmed) {
    Write-Host ''
    Write-Log 'Ciclo continuo finalizado. Hasta la proxima!' 'Magenta'
    exit 0
}

# --- Actualizar main y relanzar planner ---
Write-Host ''
Write-Log 'Actualizando main con merges del sprint anterior...' 'Cyan'
Push-Location $MainRepo
try {
    git fetch origin main --quiet
    git pull origin main --quiet
    Write-Log 'Main actualizado.' 'Green'
}
catch {
    Write-Log ('Error actualizando main: {0}' -f $_.Exception.Message) 'Red'
}
finally {
    Pop-Location
}

# Lanzar nueva terminal con /planner sprint
Write-Log 'Lanzando nuevo ciclo de planificacion...' 'Cyan'
$cmdSprint = "Set-Location '$MainRepo'; " +
             "Write-Host ''; " +
             "Write-Host '  Nuevo sprint -- planificando...' -ForegroundColor Cyan; " +
             "Write-Host ''; " +
             "claude '/planner sprint'"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmdSprint

# Lanzar /planner proponer en paralelo (segunda terminal)
if (-not $NoAutoProponer) {
    Write-Log 'Lanzando analisis de propuestas en paralelo...' 'Magenta'
    $cmdProponer = "Set-Location '$MainRepo'; " +
                   "Write-Host ''; " +
                   "Write-Host '  Analizando codebase para nuevas propuestas...' -ForegroundColor Magenta; " +
                   "Write-Host ''; " +
                   "claude '/planner proponer'"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmdProponer
}

$bannerMsg = if ($NoAutoProponer) { 'sprint iniciado' } else { 'sprint + proponer iniciados' }
Write-Log ('Nuevo ciclo lanzado en nueva(s) terminal(es).') 'Green'
Write-Host ''
Write-Host '============================================' -ForegroundColor Magenta
Write-Host "  Ciclo continuo -- $bannerMsg"                -ForegroundColor Magenta
Write-Host '============================================' -ForegroundColor Magenta
