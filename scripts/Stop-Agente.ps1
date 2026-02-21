<#
.SYNOPSIS
    Finaliza agentes Claude: commit + push + PR + merge + cleanup.

.DESCRIPTION
    Lee oraculo-plan.json y procesa el cierre de agentes.
    Flujo: commit, push, PR, squash-merge y limpieza de worktree.

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

# --- Helpers ---
$P = '>>'  # prefijo para mensajes de log

function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    Write-Host "$P $Msg" -ForegroundColor $Color
}

# --- Validaciones ---
if (-not (Test-Path $PlanFile)) {
    Write-Error ('No se encontro el plan: {0}' -f $PlanFile)
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
    $branch = 'codex/{0}-{1}' -f $issue, $slug
    $wtDir  = '{0}\..\platform.codex-{1}-{2}' -f $MainRepo, $issue, $slug

    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host ('  Stop Agente {0}: issue #{1} ({2})' -f $Agente.numero, $issue, $slug) -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan

    # Verificar que el worktree existe
    if (-not (Test-Path $wtDir)) {
        Write-Log ('Worktree no encontrado: {0} - nada que hacer.' -f $wtDir) 'Yellow'
        return
    }

    $wtDirResolved = (Resolve-Path $wtDir).Path

    # --- Modo Abort: descartar todo y limpiar ---
    if ($Abort) {
        Write-Log 'ABORT: descartando cambios y limpiando worktree...' 'Red'
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

        Write-Log ('Agente {0} abortado y limpiado.' -f $Agente.numero) 'Green'
        return
    }

    # --- Verificar si hay procesos claude corriendo en el worktree ---
    $claudeProcs = Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.CommandLine -match [regex]::Escape($wtDirResolved) }
    if ($claudeProcs) {
        Write-Log 'ADVERTENCIA: hay procesos claude corriendo en el worktree.' 'Red'
        Write-Log 'Cerra la terminal del agente antes de continuar.' 'Red'
        return
    }

    # --- Verificar si es un repo git valido ---
    $gitMarker = Join-Path $wtDirResolved '.git'
    if (-not (Test-Path $gitMarker)) {
        Write-Log 'Directorio no es un repo git valido, limpiando...' 'Yellow'
        Push-Location $MainRepo
        try {
            git worktree remove $wtDirResolved --force 2>$null
            git branch -D $branch 2>$null
            git worktree prune 2>$null
        }
        catch { }
        finally { Pop-Location }
        # Fallback: borrar directorio si sigue existiendo
        if (Test-Path $wtDirResolved) {
            Remove-Item $wtDirResolved -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Log 'Limpiado.' 'Green'
        return
    }

    Push-Location $wtDirResolved
    try {
        # --- Verificar cambios ---
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        $status = git status --porcelain 2>$null
        $ErrorActionPreference = $prevEAP
        if (-not $status) {
            Write-Log 'Sin cambios en el worktree.' 'Yellow'

            # Solo limpiar
            Pop-Location
            Push-Location $MainRepo
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = 'SilentlyContinue'
            git worktree remove $wtDirResolved --force 2>$null
            git branch -D $branch 2>$null
            git worktree prune 2>$null
            $ErrorActionPreference = $prevEAP
            if (Test-Path $wtDirResolved) {
                Remove-Item $wtDirResolved -Recurse -Force -ErrorAction SilentlyContinue
            }
            Write-Log 'Worktree limpiado (sin cambios).' 'Green'
            return
        }

        Write-Log 'Cambios detectados:' 'Yellow'
        git status --short

        # --- Obtener titulo del issue desde GitHub ---
        $issueTitle = ''
        try {
            $issueTitle = & $Gh issue view $issue --json title --jq '.title' 2>$null
        }
        catch {
            $issueTitle = $slug
        }
        if (-not $issueTitle) { $issueTitle = $slug }

        # --- Commit ---
        Write-Log 'Committing cambios...' 'White'
        git add -A
        $coAuthor = 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'
        $commitMsg = ('feat: {0} (Closes #{1})' -f $issueTitle, $issue) + "`n`n$coAuthor"
        git commit -m $commitMsg

        # --- Push ---
        Write-Log ('Pushing branch {0}...' -f $branch) 'White'
        git push -u origin $branch

        # --- Crear PR ---
        Write-Log 'Creando PR...' 'White'
        $prTitle = 'feat: {0} (Closes #{1})' -f $issueTitle, $issue
        $bodyLines = @(
            '## Summary'
            ('- Implementacion automatizada del issue #{0}' -f $issue)
            ('- Branch: `{0}`' -f $branch)
            ''
            ('Closes #{0}' -f $issue)
            ''
            '## Test plan'
            '- Verificar que compila: `./gradlew clean build`'
            '- Verificar tests: `./gradlew check`'
            ''
            ':robot: Generated with [Claude Code](https://claude.com/claude-code)'
        )
        $prBody = $bodyLines -join "`n"
        $prUrl = & $Gh pr create --base main --title $prTitle --body $prBody --assignee leitolarreta
        Write-Log ('PR creado: {0}' -f $prUrl) 'Green'

        # --- Merge (salvo --skip-merge) ---
        if ($SkipMerge) {
            Write-Log '--SkipMerge: PR creado sin mergear.' 'Yellow'
        }
        else {
            # Extraer numero del PR
            $prNumber = $null
            if ($prUrl -match '/pull/(\d+)') {
                $prNumber = $Matches[1]
            }
            else {
                # Intentar obtener via gh
                $prNumber = & $Gh pr view --json number --jq '.number' 2>$null
            }

            if ($prNumber) {
                Write-Log ('Squash-merging PR #{0}...' -f $prNumber) 'White'
                & $Gh pr merge $prNumber --squash --delete-branch
                Write-Log ('PR #{0} mergeado.' -f $prNumber) 'Green'
            }
            else {
                Write-Log 'No se pudo determinar el numero del PR para merge.' 'Red'
            }
        }
    }
    finally {
        Pop-Location
    }

    # --- Cleanup worktree ---
    Push-Location $MainRepo
    try {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        git fetch origin --prune --quiet 2>$null

        if (-not $SkipMerge) {
            # Si ya se mergeo, el worktree se puede limpiar
            if (Test-Path $wtDirResolved) {
                git worktree remove $wtDirResolved --force 2>$null
            }
            git branch -D $branch 2>$null
            git worktree prune 2>$null
            $ErrorActionPreference = $prevEAP
            Write-Log 'Worktree limpiado.' 'Green'
        }
        else {
            $ErrorActionPreference = $prevEAP
            Write-Log 'Worktree conservado (--SkipMerge). Usa git worktree remove para limpiarlo.' 'Yellow'
        }
    }
    finally {
        Pop-Location
    }

    Write-Log ('Agente {0} finalizado.' -f $Agente.numero) 'Green'
}

# --- Ejecutar ---
if ($Numero -eq 'all') {
    Write-Host ('>> Procesando TODOS los agentes secuencialmente ({0})...' -f $Plan.agentes.Count) -ForegroundColor Magenta
    foreach ($agente in $Plan.agentes) {
        Stop-UnAgente -Agente $agente -SkipMerge:$SkipMerge -Abort:$Abort
    }
    Write-Host ''
    Write-Host '>> Todos los agentes procesados.' -ForegroundColor Green
}
else {
    $num = [int]$Numero
    $agente = $Plan.agentes | Where-Object { $_.numero -eq $num }

    if (-not $agente) {
        Write-Error ('Agente {0} no encontrado en el plan. Agentes disponibles: {1}' -f $num, (($Plan.agentes | ForEach-Object { $_.numero }) -join ', '))
        exit 1
    }

    Stop-UnAgente -Agente $agente -SkipMerge:$SkipMerge -Abort:$Abort
}
