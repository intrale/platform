<#
.SYNOPSIS
    Lanza agentes Claude en worktrees aislados consumiendo el plan del Oraculo.

.DESCRIPTION
    Lee sprint-plan.json y crea worktrees para los agentes indicados.
    Enlaza .claude/ del repo principal via symlink y abre nueva terminal PowerShell con claude ejecutando.

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

    # Symlink de .claude/ para heredar confianza y permisos del repo principal
    $claudeSrc = Join-Path $MainRepo ".claude"
    $claudeDst = Join-Path $wtDirResolved ".claude"
    if (Test-Path $claudeSrc) {
        $createSymlink = $false

        if (Test-Path $claudeDst) {
            $item = Get-Item $claudeDst -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                Write-Host ">> Symlink .claude/ ya existe, reutilizando"
            }
            elseif (-not $wtExists) {
                # Worktree recien creado: reemplazar .claude/ checkeado por git con symlink
                Remove-Item $claudeDst -Recurse -Force
                $createSymlink = $true
            }
            else {
                Write-Host ">> .claude/ real existente, no se sobreescribe" -ForegroundColor Yellow
            }
        }
        else {
            $createSymlink = $true
        }

        if ($createSymlink) {
            try {
                New-Item -ItemType SymbolicLink -Path $claudeDst -Target $claudeSrc -Force | Out-Null
                Write-Host ">> Symlink .claude/ creado"
            }
            catch {
                # Fallback: junction si symlink falla (permisos Windows)
                cmd /c mklink /J "$claudeDst" "$claudeSrc" 2>$null | Out-Null
                Write-Host ">> Junction .claude/ creado (fallback)"
            }
        }
    }

    # Abrir nueva terminal PowerShell con claude ejecutando
    $escapedPrompt = $prompt -replace '"', '\"'
    $command = "Set-Location '$wtDirResolved'; Write-Host ''; Write-Host '  Agente $($Agente.numero) - issue #$issue ($slug)' -ForegroundColor Cyan; Write-Host '  Branch: $branch' -ForegroundColor Cyan; Write-Host ''; claude `"$escapedPrompt`""

    Write-Host ">> Abriendo terminal con claude..."
    $proc = Start-Process powershell -ArgumentList "-NoExit", "-Command", $command -PassThru

    # Guardar PID en sprint-pids.json
    $pidsFile = Join-Path $PSScriptRoot "sprint-pids.json"
    $pidsData = if (Test-Path $pidsFile) {
        Get-Content $pidsFile -Raw | ConvertFrom-Json
    } else {
        [PSCustomObject]@{}
    }
    $pidsData | Add-Member -NotePropertyName "agente_$($Agente.numero)" -NotePropertyValue $proc.Id -Force
    $pidsData | ConvertTo-Json | Set-Content $pidsFile

    Write-Host ">> Agente $($Agente.numero) lanzado en nueva terminal (PID $($proc.Id))" -ForegroundColor Green
}

function Start-MonitorLive {
    $monitorProcs = Get-Process -Name 'node' -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dashboard\.js' }

    if ($monitorProcs) {
        Write-Host ">> Monitor ya activo (PID: $($monitorProcs.Id)) — reutilizando." -ForegroundColor Yellow
        return
    }

    $dashboardPath = Join-Path $MainRepo ".claude\dashboard.js"
    if (-not (Test-Path $dashboardPath)) {
        Write-Host ">> dashboard.js no encontrado en: $dashboardPath — omitiendo monitor." -ForegroundColor Yellow
        return
    }

    $command = "Set-Location '$MainRepo'; " +
               "Write-Host '  Monitor Live — Dashboard multi-sesion' -ForegroundColor Cyan; " +
               "node '$dashboardPath'"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $command
    Write-Host ">> Monitor live lanzado." -ForegroundColor Green
}

# --- Ejecutar ---
if ($Numero -eq "all") {
    Write-Host ">> Lanzando TODOS los agentes del plan ($($Plan.agentes.Count))..." -ForegroundColor Magenta
    foreach ($agente in $Plan.agentes) {
        Start-UnAgente -Agente $agente
    }
    Write-Host ""
    Write-Host ">> Todos los agentes lanzados." -ForegroundColor Green
    Start-MonitorLive
}
else {
    $num = [int]$Numero
    $agente = $Plan.agentes | Where-Object { $_.numero -eq $num }

    if (-not $agente) {
        Write-Error "Agente $num no encontrado en el plan. Agentes disponibles: $($Plan.agentes | ForEach-Object { $_.numero } | Join-String -Separator ', ')"
        exit 1
    }

    Start-UnAgente -Agente $agente
    Start-MonitorLive
}
