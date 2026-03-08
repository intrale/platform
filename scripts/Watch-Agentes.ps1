<#
.SYNOPSIS
    Vigila agentes Claude y ejecuta ciclo continuo al finalizar.

.DESCRIPTION
    Lee sprint-plan.json y monitorea las sesiones de cada agente.
    Al detectar que todos finalizaron:
    1. Ejecuta Stop-Agente.ps1 all (commit + PR + merge + cleanup)
    2. Genera reporte de sprint (sprint-report.js)
    3. AUTOMATICO: Propone nuevas historias via Telegram (planner-propose-interactive.js)
       - El usuario aprueba/descarta cada propuesta con botones inline
    4. AUTOMATICO: Planifica el siguiente sprint con priorización (auto-plan-sprint.js)
       - Técnico -> QA -> Negocio
    5. Notifica via Telegram con botones: Lanzar sprint / Ver plan

    Sin preguntar manualmente si planificar. El flujo es completamente automatico.
    El usuario solo interactua via Telegram para aprobar/descartar propuestas.

.PARAMETER PollInterval
    Intervalo de polling en segundos (default: 30).

.PARAMETER SkipMerge
    Si se indica, se pasa -SkipMerge a Stop-Agente.ps1 (PR sin merge automatico).

.PARAMETER NoAutoPlan
    Si se indica, no ejecuta el flujo automatico de propuestas + planificacion.
    Equivalente al comportamiento anterior con -NoAutoProponer.

.PARAMETER PropuestaTimeout
    Segundos a esperar por aprobacion de propuestas antes de continuar con auto-plan (default: 120).

.EXAMPLE
    .\Watch-Agentes.ps1
    .\Watch-Agentes.ps1 -PollInterval 60
    .\Watch-Agentes.ps1 -SkipMerge
    .\Watch-Agentes.ps1 -NoAutoPlan
#>
param(
    [int]$PollInterval = 30,
    [switch]$SkipMerge,
    # Alias de compatibilidad con el param anterior
    [switch]$NoAutoProponer,
    [switch]$NoAutoPlan,
    [int]$PropuestaTimeout = 120
)

Write-Warning "DEPRECADO: Watch-Agentes.ps1 esta siendo reemplazado por agent-monitor.js integrado en Commander. Usar Commander para monitoreo automatico."

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$MainRepo  = "C:\Workspaces\Intrale\platform"
$PlanFile  = Join-Path $PSScriptRoot "sprint-plan.json"
$AskScript = Join-Path $PSScriptRoot "ask-next-sprint.js"
$ProposeScript = Join-Path $PSScriptRoot "planner-propose-interactive.js"
$AutoPlanScript = Join-Path $PSScriptRoot "auto-plan-sprint.js"

# --- Helpers ---
$P = '>>'

function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "$P [$ts] $Msg" -ForegroundColor $Color
}

function Send-TelegramMessage {
    param([string]$Text)
    try {
        $cfgPath = Join-Path (Join-Path (Join-Path $MainRepo ".claude") "hooks") "telegram-config.json"
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $uri = "https://api.telegram.org/bot$($cfg.bot_token)/sendMessage"
        Invoke-RestMethod -Uri $uri -Method Post -Body @{
            chat_id    = $cfg.chat_id
            text       = $Text
            parse_mode = "HTML"
        } -ErrorAction SilentlyContinue | Out-Null
    }
    catch {
        Write-Log ('Telegram: no se pudo enviar ({0})' -f $_.Exception.Message) 'Yellow'
    }
}

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error ('No se encontro el plan: {0}' -f $PlanFile)
    exit 1
}

# --- Leer plan ---
$Plan = Get-Content $PlanFile -Raw | ConvertFrom-Json

# --- Validar sprint activo ---
function Test-SprintActivo {
    param([Parameter(Mandatory)] $Plan)

    if (-not $Plan.fechaFin) {
        Write-Error ("El plan no tiene campo 'fechaFin'. El sprint no es valido.`n" +
                     "Ejecuta /planner sprint para planificar un nuevo sprint antes de lanzar agentes.")
        exit 1
    }

    try {
        $fechaFin = [DateTime]::ParseExact($Plan.fechaFin, 'yyyy-MM-dd', $null)
    }
    catch {
        Write-Error ("No se pudo parsear fechaFin '{0}'. Formato esperado: yyyy-MM-dd.`n" +
                     "Ejecuta /planner sprint para generar un plan valido." -f $Plan.fechaFin)
        exit 1
    }

    if ((Get-Date).Date -gt $fechaFin.Date) {
        Write-Error ("El sprint del plan actual ha expirado (fechaFin: {0}).`n" +
                     "Ejecuta /planner sprint para planificar un nuevo sprint antes de lanzar agentes." -f $Plan.fechaFin)
        exit 1
    }

    Write-Log ('Sprint activo (fechaFin: {0})' -f $Plan.fechaFin) 'Green'
}

Test-SprintActivo -Plan $Plan

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
if ($SkipMerge) {
    Write-Log 'SkipMerge activado — PRs sin merge automatico' 'Yellow'
}
$EffectiveNoAutoPlan = $NoAutoPlan -or $NoAutoProponer
if ($EffectiveNoAutoPlan) {
    Write-Log 'Auto-plan deshabilitado (-NoAutoPlan / -NoAutoProponer)' 'Yellow'
}
Write-Host ''

$tgMsg = "Watch-Agentes iniciado -- vigilando $AgentCount agente(s) del sprint $($Plan.fecha)"
Send-TelegramMessage $tgMsg

foreach ($a in $Plan.agentes) {
    Write-Log ('  Agente {0}: issue #{1} ({2})' -f $a.numero, $a.issue, $a.slug)
}
Write-Host ''

# --- Funciones de deteccion ---

function Get-WorktreePath {
    param($Agente)
    return '{0}\..\platform.agent-{1}-{2}' -f $MainRepo, $Agente.issue, $Agente.slug
}

function Test-AgentDone {
    param(
        [string]$WtDir,
        [int]$AgentNumber
    )

    # Worktree no existe → done (nunca arranco o ya fue limpiado)
    if (-not (Test-Path $WtDir)) { return $true }

    $wtResolved = (Resolve-Path $WtDir -ErrorAction SilentlyContinue)
    if (-not $wtResolved) { return $true }

    # Check principal: verificar si la terminal del agente sigue viva (via PID)
    # Sin -NoExit, la terminal se cierra cuando claude termina → PID muerto = done
    $pidsFile = Join-Path $PSScriptRoot "sprint-pids.json"
    if ((Test-Path $pidsFile) -and $AgentNumber -gt 0) {
        $pidsData = Get-Content $pidsFile -Raw | ConvertFrom-Json
        $pidKey = "agente_$AgentNumber"
        $terminalPid = $pidsData.$pidKey
        if ($terminalPid) {
            $proc = Get-Process -Id $terminalPid -ErrorAction SilentlyContinue
            if (-not $proc) { return $true }
        }
    }

    # Fallback: buscar session files con status "done" en .claude/sessions/
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
    # Claude Code corre como node.exe ejecutando cli.js, no como "claude"
    # Usar Get-CimInstance porque Get-Process no expone CommandLine en PS 5.1
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    if (-not $nodeProcs) { return $true }
    foreach ($p in $nodeProcs) {
        if ($p.CommandLine -match 'claude-code[/\\]cli\.js' -and $p.CommandLine -match 'bypassPermissions') {
            return $false
        }
    }
    return $true
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
        $isDone = Test-AgentDone -WtDir $wtDir -AgentNumber $a.numero
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

$elapsedTotal = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
$tgMsg = "Watch-Agentes finalizado -- todos terminaron ($elapsedTotal min). Ejecutando Stop-Agente..."
Send-TelegramMessage $tgMsg

# --- Ejecutar Stop-Agente.ps1 all ---
Write-Log 'Ejecutando Stop-Agente.ps1 all...' 'Cyan'
$stopScript = Join-Path $PSScriptRoot 'Stop-Agente.ps1'
try {
    & $stopScript all -SkipMerge:$SkipMerge
    Write-Log 'Stop-Agente.ps1 finalizado.' 'Green'
}
catch {
    Write-Log ('Error en Stop-Agente: {0}' -f $_.Exception.Message) 'Red'
    # Continuar igualmente -- el usuario puede resolver manualmente
}

Write-Host ''

# --- Generar reporte de sprint ---
$sprintReportScript = Join-Path $PSScriptRoot 'sprint-report.js'
if (Test-Path $sprintReportScript) {
    Write-Log 'Generando reporte de sprint...' 'Cyan'
    try {
        & node $sprintReportScript $PlanFile
        Write-Log 'Reporte de sprint generado.' 'Green'
    }
    catch {
        Write-Log ('Error generando reporte: {0}' -f $_.Exception.Message) 'Yellow'
        # Fail-open: continuar igualmente
    }
}
else {
    Write-Log 'sprint-report.js no encontrado, omitiendo reporte.' 'Yellow'
}

Write-Host ''

# --- Flujo automatico: Propuestas + Planificacion ---

if ($EffectiveNoAutoPlan) {
    Write-Host ''
    Write-Log 'Auto-plan deshabilitado. Ciclo continuo finalizado.' 'Magenta'
    exit 0
}

# --- Actualizar main antes de analizar ---
Write-Host ''
Write-Log 'Actualizando main con merges del sprint anterior...' 'Cyan'
Push-Location $MainRepo
try {
    git fetch origin main --quiet 2>$null
    git pull origin main --quiet 2>$null
    Write-Log 'Main actualizado.' 'Green'
}
catch {
    Write-Log ('Advertencia al actualizar main: {0}' -f $_.Exception.Message) 'Yellow'
    # Fail-open: continuar igualmente
}
finally {
    Pop-Location
}

Write-Host ''

# --- Paso 1: Propuestas interactivas via Telegram ---
Write-Log 'Ejecutando planner-propose-interactive.js...' 'Cyan'
$tgMsg = 'Iniciando propuesta automatica de nuevas historias para el siguiente sprint...'
Send-TelegramMessage $tgMsg

if (Test-Path $ProposeScript) {
    try {
        & node $ProposeScript
        Write-Log 'planner-propose-interactive.js completado.' 'Green'

        # Esperar PropuestaTimeout segundos para que el usuario interactue con las propuestas en Telegram
        Write-Log ('Esperando {0}s para que el usuario apruebe/descarte propuestas en Telegram...' -f $PropuestaTimeout) 'Yellow'
        Write-Host ">> Revisá las propuestas en Telegram y aprobá/descartá cada una." -ForegroundColor Yellow
        Write-Host ">> Continuando en $PropuestaTimeout segundos..." -ForegroundColor DarkYellow
        Start-Sleep -Seconds $PropuestaTimeout
    }
    catch {
        Write-Log ('Error en planner-propose-interactive.js: {0}' -f $_.Exception.Message) 'Yellow'
        # Fail-open: continuar con planificacion igualmente
    }
}
else {
    Write-Log 'planner-propose-interactive.js no encontrado. Omitiendo propuestas.' 'Yellow'
}

Write-Host ''

# --- Paso 2: Planificacion automatica con priorizacion ---
Write-Log 'Ejecutando auto-plan-sprint.js (Tecnico -> QA -> Negocio)...' 'Cyan'

if (Test-Path $AutoPlanScript) {
    try {
        & node $AutoPlanScript
        Write-Log 'auto-plan-sprint.js completado. Sprint plan generado.' 'Green'
    }
    catch {
        Write-Log ('Error en auto-plan-sprint.js: {0}' -f $_.Exception.Message) 'Red'
        # Fallback: lanzar planner interactivo si falla el automatico
        Write-Log 'Fallback: lanzando /planner sprint en nueva terminal...' 'Yellow'
        $cmdSprint = "Set-Location '$MainRepo'; claude '/planner sprint'"
        Start-Process powershell -ArgumentList "-Command", $cmdSprint
    }
}
else {
    Write-Log 'auto-plan-sprint.js no encontrado. Fallback a /planner sprint.' 'Yellow'
    $cmdSprint = "Set-Location '$MainRepo'; claude '/planner sprint'"
    Start-Process powershell -ArgumentList "-Command", $cmdSprint
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Magenta
Write-Host '  Ciclo continuo -- flujo automatico completado'  -ForegroundColor Magenta
Write-Host '  Propuestas + Plan generados via Telegram'       -ForegroundColor Magenta
Write-Host '============================================' -ForegroundColor Magenta
