<#
.SYNOPSIS
    Finaliza agentes Claude: commit + push + PR + merge + cleanup.

.DESCRIPTION
    Lee oraculo-plan.json para obtener datos del agente. Ejecuta el flujo
    completo de cierre: commit, push, PR, squash-merge y limpieza de worktree.

.PARAMETER Numero
    Numero de agente (1, 2, 3...) o "all" para procesar todos secuencialmente.

.PARAMETER SkipMerge
    Crea PR sin mergear (para revision manual).

.PARAMETER Abort
    Descarta cambios y limpia worktree sin commit ni PR.

.EXAMPLE
    .\Stop-Agente.ps1 1
    .\Stop-Agente.ps1 1 -SkipMerge
    .\Stop-Agente.ps1 1 -Abort
    .\Stop-Agente.ps1 all
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Numero,

    [switch]$SkipMerge,

    [switch]$Abort
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$GitWt    = "C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Packages\max-sixty.worktrunk_Microsoft.Winget.Source_8wekyb3d8bbwe\git-wt.exe"
$Gh       = "C:\Workspaces\gh-cli\bin\gh.exe"
$MainRepo = "C:\Workspaces\Intrale\platform"
$PlanFile = Join-Path $PSScriptRoot "oraculo-plan.json"

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error "No se encontro el plan: $PlanFile"
    exit 1
}

# --- Leer plan ---
$Plan = Get-Content $PlanFile -Raw | ConvertFrom-Json

function Stop-UnAgente {
    param(
        [Parameter(Mandatory)] $Agente,
        [switch]$SkipMerge,
        [switch]$Abort
    )

    $issue  = $Agente.issue
    $slug   = $Agente.slug
    $branch = "codex/$issue-$slug"
    $wtDir  = "$MainRepo\..\platform.codex-$issue-$slug"

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Stop Agente $($Agente.numero): issue #$issue ($slug)" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan

    # Verificar que el worktree existe
    if (-not (Test-Path $wtDir)) {
        Write-Host ">> Worktree no encontrado: $wtDir — nada que hacer." -ForegroundColor Yellow
        return
    }

    $wtDirResolved = (Resolve-Path $wtDir).Path

    # --- Modo Abort: descartar todo y limpiar ---
    if ($Abort) {
        Write-Host ">> ABORT: descartando cambios y limpiando worktree..." -ForegroundColor Red
        Push-Location $wtDirResolved
        try {
            git checkout -- . 2>$null
            git clean -fd 2>$null
        }
        finally {
            Pop-Location
        }

        # Volver a main y eliminar worktree + branch
        Push-Location $MainRepo
        try {
            git worktree remove $wtDirResolved --force 2>$null
            git branch -D $branch 2>$null
            git worktree prune 2>$null
        }
        finally {
            Pop-Location
        }

        Write-Host ">> Agente $($Agente.numero) abortado y limpiado." -ForegroundColor Green
        return
    }

    # --- Verificar si hay procesos claude corriendo en el worktree ---
    $claudeProcs = Get-Process -Name "claude" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.CommandLine -match [regex]::Escape($wtDirResolved) }
    if ($claudeProcs) {
        Write-Host ">> ADVERTENCIA: hay procesos claude corriendo en el worktree." -ForegroundColor Red
        Write-Host ">> Cerrá la terminal del agente antes de continuar." -ForegroundColor Red
        return
    }

    Push-Location $wtDirResolved
    try {
        # --- Verificar cambios ---
        $status = git status --porcelain 2>$null
        if (-not $status) {
            Write-Host ">> Sin cambios en el worktree." -ForegroundColor Yellow

            # Solo limpiar
            Pop-Location
            Push-Location $MainRepo
            git worktree remove $wtDirResolved --force 2>$null
            git branch -D $branch 2>$null
            git worktree prune 2>$null
            Write-Host ">> Worktree limpiado (sin cambios)." -ForegroundColor Green
            return
        }

        Write-Host ">> Cambios detectados:" -ForegroundColor Yellow
        git status --short

        # --- Obtener titulo del issue desde GitHub ---
        $issueTitle = ""
        try {
            $issueTitle = & $Gh issue view $issue --json title --jq ".title" 2>$null
        }
        catch {
            $issueTitle = $slug
        }
        if (-not $issueTitle) { $issueTitle = $slug }

        # --- Commit ---
        Write-Host ">> Committing cambios..."
        git add -A
        $commitMsg = "feat: $issueTitle (Closes #$issue)`n`nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
        git commit -m $commitMsg

        # --- Push ---
        Write-Host ">> Pushing branch $branch..."
        git push -u origin $branch

        # --- Crear PR ---
        Write-Host ">> Creando PR..."
        $prTitle = "feat: $issueTitle (Closes #$issue)"
        $prBody = @"
## Summary
- Implementacion automatizada del issue #$issue
- Branch: ``$branch``

Closes #$issue

## Test plan
- [ ] Verificar que compila: ``./gradlew clean build``
- [ ] Verificar tests: ``./gradlew check``

:robot: Generated with [Claude Code](https://claude.com/claude-code)
"@
        $prUrl = & $Gh pr create --base main --title $prTitle --body $prBody --assignee leitolarreta 2>&1
        Write-Host ">> PR creado: $prUrl" -ForegroundColor Green

        # --- Merge (salvo --skip-merge) ---
        if ($SkipMerge) {
            Write-Host ">> --SkipMerge: PR creado sin mergear." -ForegroundColor Yellow
        }
        else {
            # Extraer numero del PR
            $prNumber = $null
            if ($prUrl -match "/pull/(\d+)") {
                $prNumber = $Matches[1]
            }
            else {
                # Intentar obtener via gh
                $prNumber = & $Gh pr view --json number --jq ".number" 2>$null
            }

            if ($prNumber) {
                Write-Host ">> Squash-merging PR #$prNumber..."
                & $Gh pr merge $prNumber --squash --delete-branch
                Write-Host ">> PR #$prNumber mergeado." -ForegroundColor Green
            }
            else {
                Write-Host ">> No se pudo determinar el numero del PR para merge." -ForegroundColor Red
            }
        }
    }
    finally {
        Pop-Location
    }

    # --- Cleanup worktree ---
    Push-Location $MainRepo
    try {
        git fetch origin --prune --quiet 2>$null

        if (-not $SkipMerge) {
            # Si ya se mergeo, el worktree se puede limpiar
            if (Test-Path $wtDirResolved) {
                git worktree remove $wtDirResolved --force 2>$null
            }
            git branch -D $branch 2>$null
            git worktree prune 2>$null
            Write-Host ">> Worktree limpiado." -ForegroundColor Green
        }
        else {
            Write-Host ">> Worktree conservado (--SkipMerge). Usa 'git worktree remove' para limpiarlo." -ForegroundColor Yellow
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ">> Agente $($Agente.numero) finalizado." -ForegroundColor Green
}

# --- Ejecutar ---
if ($Numero -eq "all") {
    Write-Host ">> Procesando TODOS los agentes secuencialmente ($($Plan.agentes.Count))..." -ForegroundColor Magenta
    foreach ($agente in $Plan.agentes) {
        Stop-UnAgente -Agente $agente -SkipMerge:$SkipMerge -Abort:$Abort
    }
    Write-Host ""
    Write-Host ">> Todos los agentes procesados." -ForegroundColor Green
}
else {
    $num = [int]$Numero
    $agente = $Plan.agentes | Where-Object { $_.numero -eq $num }

    if (-not $agente) {
        Write-Error "Agente $num no encontrado en el plan. Agentes disponibles: $($Plan.agentes | ForEach-Object { $_.numero } | Join-String -Separator ', ')"
        exit 1
    }

    Stop-UnAgente -Agente $agente -SkipMerge:$SkipMerge -Abort:$Abort
}
