<#
.SYNOPSIS
    Lanza agentes Claude en worktrees aislados consumiendo el plan del Oraculo.

.DESCRIPTION
    Lee sprint-plan.json y crea worktrees para los agentes indicados.
    Copia permisos de Claude Code y abre nueva terminal PowerShell con claude ejecutando.

.PARAMETER Numero
    Numero de agente (1, 2, 3...) o "all" para lanzar todos en paralelo.

.EXAMPLE
    .\Start-Agente.ps1 1
    .\Start-Agente.ps1 all
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Numero
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$GitWt    = "C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Packages\max-sixty.worktrunk_Microsoft.Winget.Source_8wekyb3d8bbwe\git-wt.exe"
$Gh       = "C:\Workspaces\gh-cli\bin\gh.exe"
$MainRepo = "C:\Workspaces\Intrale\platform"
$PlanFile = Join-Path $PSScriptRoot "sprint-plan.json"

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error "No se encontro el plan: $PlanFile`nEjecuta /planner sprint para generarlo."
    exit 1
}

if (-not (Test-Path $GitWt)) {
    Write-Error "No se encontro git-wt en: $GitWt"
    exit 1
}

if (-not (Test-Path $MainRepo)) {
    Write-Error "No se encontro el repo principal en: $MainRepo"
    exit 1
}

# --- Leer plan ---
$Plan = Get-Content $PlanFile -Raw | ConvertFrom-Json

function Start-UnAgente {
    param(
        [Parameter(Mandatory)] $Agente
    )

    $issue  = $Agente.issue
    $slug   = $Agente.slug
    $prompt = $Agente.prompt
    $branch = "codex/$issue-$slug"
    $wtDir  = "$MainRepo\..\platform.codex-$issue-$slug"

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Agente $($Agente.numero): issue #$issue ($slug)" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan

    # Verificar si el worktree ya existe
    $wtExists = $false
    if (Test-Path $wtDir) {
        $wtExists = $true
        Write-Host ">> Worktree existente, reutilizando: $wtDir" -ForegroundColor Yellow
    }

    if (-not $wtExists) {
        # Ir al repo principal y actualizar main
        Push-Location $MainRepo
        try {
            Write-Host ">> Actualizando main..."
            git fetch origin main --quiet 2>$null

            Write-Host ">> Creando worktree: $branch"
            & $GitWt switch --create $branch
        }
        finally {
            Pop-Location
        }
    }

    # Resolver ruta absoluta del worktree
    $wtDirResolved = (Resolve-Path $wtDir -ErrorAction SilentlyContinue)
    if (-not $wtDirResolved) {
        # Fallback: buscar en worktree list
        $wtDirResolved = $wtDir
    }

    # Copiar settings.local.json de Claude Code (permisos)
    $settingsSrc = Join-Path $MainRepo ".claude\settings.local.json"
    if (Test-Path $settingsSrc) {
        $claudeDir = Join-Path $wtDirResolved ".claude"
        if (-not (Test-Path $claudeDir)) {
            New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
        }
        Copy-Item $settingsSrc (Join-Path $claudeDir "settings.local.json") -Force
        Write-Host ">> Copiado permisos de Claude Code"
    }

    # Abrir nueva terminal PowerShell con claude ejecutando
    $escapedPrompt = $prompt -replace '"', '\"'
    $command = "Set-Location '$wtDirResolved'; Write-Host ''; Write-Host '  Agente $($Agente.numero) - issue #$issue ($slug)' -ForegroundColor Cyan; Write-Host '  Branch: $branch' -ForegroundColor Cyan; Write-Host ''; claude `"$escapedPrompt`""

    Write-Host ">> Abriendo terminal con claude..."
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $command

    Write-Host ">> Agente $($Agente.numero) lanzado en nueva terminal" -ForegroundColor Green
}

# --- Ejecutar ---
if ($Numero -eq "all") {
    Write-Host ">> Lanzando TODOS los agentes del plan ($($Plan.agentes.Count))..." -ForegroundColor Magenta
    foreach ($agente in $Plan.agentes) {
        Start-UnAgente -Agente $agente
    }
    Write-Host ""
    Write-Host ">> Todos los agentes lanzados." -ForegroundColor Green
}
else {
    $num = [int]$Numero
    $agente = $Plan.agentes | Where-Object { $_.numero -eq $num }

    if (-not $agente) {
        Write-Error "Agente $num no encontrado en el plan. Agentes disponibles: $($Plan.agentes | ForEach-Object { $_.numero } | Join-String -Separator ', ')"
        exit 1
    }

    Start-UnAgente -Agente $agente
}
