<#
.SYNOPSIS
    Monitorea agentes Claude y ejecuta Stop-Agente cuando todos finalizan.

.DESCRIPTION
    Lee sprint-plan.json y hace polling de procesos claude por worktree.
    Cuando todos los agentes terminan, ejecuta Stop-Agente.ps1 all automaticamente.
    Envia notificaciones Telegram al inicio y al finalizar.

.PARAMETER PollIntervalSec
    Intervalo de polling en segundos (default 60).

.PARAMETER SkipMerge
    Pasa --SkipMerge a Stop-Agente.ps1 (crea PRs sin mergear).

.EXAMPLE
    .\Watch-Agentes.ps1
    .\Watch-Agentes.ps1 -PollIntervalSec 30
    .\Watch-Agentes.ps1 -SkipMerge
#>
param(
    [int]$PollIntervalSec = 60,

    [switch]$SkipMerge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$MainRepo = "C:\Workspaces\Intrale\platform"
$PlanFile = Join-Path $PSScriptRoot "sprint-plan.json"

# --- Telegram ---
$BotToken = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk"
$ChatId   = "6529617704"

# --- Helpers ---
$P = '>>'

function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "$P [$ts] $Msg" -ForegroundColor $Color
}

function Send-Telegram {
    param([string]$Text)
    try {
        $body = @{ chat_id = $ChatId; text = $Text; parse_mode = "HTML" }
        Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/sendMessage" `
            -Method Post -Body $body -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
        Write-Log 'Telegram: mensaje enviado' 'Gray'
    }
    catch {
        Write-Log "Telegram error: $_" 'Yellow'
    }
}

function Test-AgenteActivo {
    param($Agente)

    $issue = $Agente.issue
    $slug  = $Agente.slug
    $wtDir = '{0}\..\platform.codex-{1}-{2}' -f $MainRepo, $issue, $slug

    # Si el worktree ya no existe, el agente termino (o fue limpiado)
    if (-not (Test-Path $wtDir)) {
        return $false
    }

    $wtDirResolved = (Resolve-Path $wtDir).Path

    # Patron identico a Stop-Agente.ps1:112
    $claudeProcs = Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.CommandLine -match [regex]::Escape($wtDirResolved) }

    return [bool]$claudeProcs
}

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error ('No se encontro el plan: {0}' -f $PlanFile)
    exit 1
}

$Plan = Get-Content $PlanFile -Raw | ConvertFrom-Json

if (-not $Plan.agentes -or $Plan.agentes.Count -eq 0) {
    Write-Error 'El plan no contiene agentes.'
    exit 1
}

$totalAgentes = $Plan.agentes.Count

# --- Inicio ---
Write-Host ''
Write-Host '============================================' -ForegroundColor Magenta
Write-Host '  Watch-Agentes: monitoreo automatico' -ForegroundColor Magenta
Write-Host '============================================' -ForegroundColor Magenta
Write-Host ''
Write-Log ('Plan: {0} agentes | Polling: {1}s | SkipMerge: {2}' -f $totalAgentes, $PollIntervalSec, $SkipMerge.IsPresent) 'Cyan'

$listaAgentes = ($Plan.agentes | ForEach-Object { '#{0} ({1})' -f $_.issue, $_.slug }) -join ', '
Write-Log ('Agentes: {0}' -f $listaAgentes) 'Cyan'

Send-Telegram ("&#128065; <b>Watch-Agentes iniciado</b>`nMonitoreando $totalAgentes agentes (polling cada ${PollIntervalSec}s)`n$listaAgentes")

# --- Polling loop ---
$ciclo = 0

while ($true) {
    $ciclo++
    $activos = @()

    foreach ($agente in $Plan.agentes) {
        if (Test-AgenteActivo -Agente $agente) {
            $activos += ('#{0}' -f $agente.issue)
        }
    }

    $numActivos = $activos.Count

    if ($numActivos -eq 0) {
        Write-Log ('Ciclo {0}: 0/{1} activos - todos finalizaron!' -f $ciclo, $totalAgentes) 'Green'
        break
    }

    $listaActivos = $activos -join ', '
    Write-Log ('Ciclo {0}: {1}/{2} activos [{3}]' -f $ciclo, $numActivos, $totalAgentes, $listaActivos) 'White'

    Start-Sleep -Seconds $PollIntervalSec
}

# --- Ejecutar Stop-Agente ---
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Todos los agentes finalizaron' -ForegroundColor Green
Write-Host '  Ejecutando Stop-Agente.ps1 all...' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''

$stopScript = Join-Path $PSScriptRoot "Stop-Agente.ps1"

if (-not (Test-Path $stopScript)) {
    Write-Log 'ERROR: No se encontro Stop-Agente.ps1' 'Red'
    Send-Telegram "&#10060; <b>Watch-Agentes: error</b>`nNo se encontro Stop-Agente.ps1"
    exit 1
}

$stopArgs = @('all')
if ($SkipMerge) { $stopArgs += '-SkipMerge' }

try {
    & $stopScript @stopArgs
    $resultado = 'completado'
}
catch {
    Write-Log ('Error en Stop-Agente: {0}' -f $_) 'Red'
    $resultado = 'con errores'
}

# --- Notificacion final ---
$skipNote = if ($SkipMerge) { ' (PRs sin merge)' } else { '' }
Send-Telegram ("&#9989; <b>Watch-Agentes finalizado</b>`nTodos los agentes procesados $resultado$skipNote`nCiclos de monitoreo: $ciclo")

Write-Host ''
Write-Log ('Watch-Agentes finalizado ({0}). Ciclos: {1}' -f $resultado, $ciclo) 'Green'
