<#
.SYNOPSIS
    Lanza agentes Claude en worktrees aislados consumiendo el plan del Oraculo.

.DESCRIPTION
    Lee sprint-plan.json y crea worktrees para los agentes indicados.
    Copia .claude/ del repo principal y abre nueva terminal PowerShell con claude ejecutando.

.PARAMETER Numero
    Numero de agente (1, 2, 3...) o "all" para lanzar todos en paralelo.

.PARAMETER SkipMerge
    Si se indica, se pasa -SkipMerge al Watch-Agentes (PRs sin merge automatico).

.PARAMETER Force
    Si se indica, elimina el worktree existente y lo recrea desde el ultimo commit de origin/main.
    Usado por agent-concurrency-check.js al promover agentes de la cola (#1399).

.EXAMPLE
    .\Start-Agente.ps1 1
    .\Start-Agente.ps1 1 -Force
    .\Start-Agente.ps1 all
    .\Start-Agente.ps1 all -SkipMerge
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Numero,
    [switch]$SkipMerge,
    [switch]$Force
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

    Write-Host ">> Sprint activo (fechaFin: $($Plan.fechaFin))" -ForegroundColor Green
}

Test-SprintActivo -Plan $Plan

# --- Pre-sprint ops check ---
try {
    $opsResult = & node "$MainRepo\.claude\hooks\ops-check.js" --sprint 2>$null
    if ($opsResult -match '"critical"\s*:\s*true') {
        Write-Host ">> OPS: Problemas criticos detectados. Ejecutar /ops --fix antes del sprint." -ForegroundColor Red
    } elseif ($opsResult -match '"warnings"\s*:\s*\[' -and $opsResult -notmatch '"warnings"\s*:\s*\[\s*\]') {
        Write-Host ">> OPS: Warnings detectados (no criticos). Ejecutar /ops para detalles." -ForegroundColor Yellow
    } else {
        Write-Host ">> OPS: Entorno saludable" -ForegroundColor Green
    }
} catch {
    # Fail-open: si ops-check falla, no bloquear el sprint
    Write-Host ">> OPS: Check no disponible (fail-open)" -ForegroundColor DarkGray
}

# --- Pre-sprint cleanup de worktrees huérfanos ---
# Los worktrees de sprints anteriores se acumulan y saturan git,
# causando que los agentes no puedan arrancar (SPR-028 incident 2026-03-14)
function Invoke-WorktreeCleanup {
    $parentDir = Split-Path $MainRepo -Parent
    $baseName  = Split-Path $MainRepo -Leaf
    $siblings  = @(Get-ChildItem -Path $parentDir -Directory -Filter "$baseName.agent-*" -ErrorAction SilentlyContinue)

    if ($siblings.Count -eq 0) {
        Write-Host ">> Cleanup: sin worktrees huérfanos" -ForegroundColor Green
        return
    }

    # Obtener slugs de agentes del sprint actual para no eliminarlos
    $currentSlugs = @()
    foreach ($a in $Plan.agentes) { $currentSlugs += "agent-$($a.issue)-$($a.slug)" }
    foreach ($q in $Plan._queue)  { $currentSlugs += "agent-$($q.issue)-$($q.slug)" }

    $removed = 0
    $kept    = 0

    foreach ($wt in $siblings) {
        $suffix = $wt.Name -replace "^$([regex]::Escape($baseName))\.", ""

        if ($currentSlugs -contains $suffix) {
            $kept++
            continue
        }

        try {
            $junctionPath = Join-Path $wt.FullName ".claude"
            if (Test-Path $junctionPath) {
                cmd /c rmdir "$junctionPath" 2>$null
            }

            Push-Location $MainRepo
            git worktree remove $wt.FullName --force 2>$null
            Pop-Location

            if (Test-Path $wt.FullName) {
                Remove-Item $wt.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }

            $removed++
        } catch {
            Write-Host ">> Cleanup: no se pudo eliminar $($wt.Name): $_" -ForegroundColor Yellow
        }
    }

    Push-Location $MainRepo
    git worktree prune 2>$null
    Pop-Location

    if ($removed -gt 0) {
        Write-Host ">> Cleanup: $removed worktree(s) huérfano(s) eliminado(s) ($kept del sprint actual conservados)" -ForegroundColor Green
    } elseif ($siblings.Count -gt 0) {
        Write-Host ">> Cleanup: $($siblings.Count) worktree(s) encontrados, todos del sprint actual" -ForegroundColor Green
    }
}

Invoke-WorktreeCleanup

# Pre-registrar confianza del worktree en Claude Code para evitar dialogo interactivo de trust
function PreRegister-Trust {
    param([string]$AbsPath)
    # Claude Code almacena trust en ~/.claude/projects/<path-mangled>/
    # Path mangling: reemplazar :, \, / con -
    $mangled = $AbsPath -replace '[:\\/]', '-'
    $trustDir = Join-Path $env:USERPROFILE ".claude\projects\$mangled"
    if (-not (Test-Path $trustDir)) {
        New-Item -ItemType Directory -Path $trustDir -Force | Out-Null
        Write-Host ">> Trust pre-registrado: $mangled"
    }
}

function Start-UnAgente {
    param(
        [Parameter(Mandatory)] $Agente
    )

    $issue  = $Agente.issue
    $slug   = $Agente.slug
    $prompt = $Agente.prompt
    $branch = "agent/$issue-$slug"
    $wtDir  = "$MainRepo\..\platform.agent-$issue-$slug"

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Agente $($Agente.numero): issue #$issue ($slug)" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan

    # Verificar si el worktree ya existe
    $wtExists = $false
    if (Test-Path $wtDir) {
        $wtExists = $true
        Write-Host ">> Worktree encontrado: $wtDir" -ForegroundColor Yellow
    }

    # -Force (#1399): eliminar worktree existente y recrear desde origin/main actual
    # Usado para agentes promovidos de la cola — evita trabajar desde commit viejo
    if ($wtExists -and $Force) {
        Write-Host ">> -Force activado: eliminando worktree existente para recrear desde origin/main..." -ForegroundColor Yellow
        Push-Location $MainRepo
        try {
            # Quitar registro del worktree en git
            git worktree remove "$wtDir" --force 2>$null
            # Si el directorio sigue existiendo (race condition o fallo silencioso), eliminar
            if (Test-Path $wtDir) {
                Remove-Item $wtDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            Write-Host ">> Worktree eliminado. Se creará uno nuevo desde origin/main." -ForegroundColor Green
        } catch {
            Write-Host ">> WARN: No se pudo eliminar worktree anterior: $_" -ForegroundColor Yellow
            Write-Host ">> Continuando con worktree existente (puede estar desactualizado)." -ForegroundColor DarkGray
        } finally {
            Pop-Location
        }
        # Marcar como no-existente para que el bloque de creación lo recree
        if (-not (Test-Path $wtDir)) { $wtExists = $false }
    }

    if ($wtExists -and -not $Force) {
        Write-Host ">> Reutilizando worktree existente: $wtDir" -ForegroundColor Yellow
    }

    # Bug 1: Verificar si ya hay un proceso claude activo para este agente (#1345)
    # Si el worktree existe y el PID anterior sigue vivo, no relanzar para evitar
    # conflictos de archivos bloqueados al intentar copiar .claude/
    if ($wtExists) {
        $pidsFile = Join-Path $PSScriptRoot "sprint-pids.json"
        if (Test-Path $pidsFile) {
            try {
                $pidsData = Get-Content $pidsFile -Raw | ConvertFrom-Json
                $existingPid = $pidsData."agente_$($Agente.numero)"
                if ($existingPid) {
                    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
                    if ($proc) {
                        Write-Host ">> WARN: Agente $($Agente.numero) (PID $existingPid) ya esta activo en $wtDir — skip" -ForegroundColor Yellow
                        Write-Host ">> Para forzar relanzamiento, terminar el proceso primero." -ForegroundColor DarkGray
                        return
                    }
                }
            } catch {
                Write-Host ">> INFO: No se pudo verificar PIDs previos (fail-open): $_" -ForegroundColor DarkGray
            }
        }
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

    # Pre-registrar confianza del worktree para evitar dialogo interactivo de trust
    PreRegister-Trust -AbsPath "$wtDirResolved"

    # Verificar integridad de .claude/ en el repo principal antes de copiar
    $claudeSrc = Join-Path $MainRepo ".claude"
    $settingsCheck = Join-Path $claudeSrc "settings.json"
    $skillsCheck = Join-Path $claudeSrc "skills"
    if (-not (Test-Path $settingsCheck) -or -not (Test-Path $skillsCheck)) {
        Write-Host ">> ADVERTENCIA: .claude/ danado en repo principal. Restaurando desde git..." -ForegroundColor Red
        Push-Location $MainRepo
        git checkout HEAD -- .claude/ 2>$null
        Pop-Location
        Write-Host ">> .claude/ restaurado." -ForegroundColor Green
    }

    # Copiar .claude/ del repo principal (NO junction/symlink — seguro contra rm -rf)
    $claudeDst = Join-Path $wtDirResolved ".claude"
    if (Test-Path $claudeSrc) {
        if (Test-Path $claudeDst) {
            $item = Get-Item $claudeDst -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                # Legacy: junction de ejecucion anterior — desvincular primero
                cmd /c rmdir "$claudeDst" 2>$null
            } else {
                # Directorio real de git checkout — eliminar para reemplazar con copia fresca
                # Bug 1: usar try/catch para no crashear si hay archivos bloqueados (#1345)
                try {
                    Remove-Item $claudeDst -Recurse -Force
                } catch {
                    Write-Host ">> WARN: No se pudo eliminar $claudeDst — archivos bloqueados: $_" -ForegroundColor Yellow
                    Write-Host ">> Abortando relanzamiento para evitar estado parcial." -ForegroundColor Yellow
                    return
                }
            }
        }
        Copy-Item -Path $claudeSrc -Destination $claudeDst -Recurse -Force
        Write-Host ">> .claude/ copiado (sin junction)"
    }

    # Pre-crear trust directory para que Claude no muestre el dialogo interactivo
    # Claude Code almacena confianza en ~/.claude/projects/<path-mangled>/
    # Path mangling: C:/Workspaces/Intrale/platform.agent-123-slug → C--Workspaces-Intrale-platform.agent-123-slug
    $wtAbsPath = (Resolve-Path $wtDirResolved).Path -replace '\\', '/'
    $mangledPath = ($wtAbsPath -replace '^/', '' -replace '/', '-' -replace ':', '-')
    $trustDir = Join-Path $env:USERPROFILE ".claude\projects\$mangledPath"
    if (-not (Test-Path $trustDir)) {
        New-Item -ItemType Directory -Path $trustDir -Force | Out-Null
        Write-Host ">> Trust pre-registrado: $mangledPath"
    }

    # Abrir nueva terminal PowerShell con claude ejecutando
    # La terminal se cierra automaticamente al terminar claude (sin -NoExit)
    # Output se loguea a scripts/logs/agente_N.log via stream-json parsing (#1541)
    $logDir = Join-Path $PSScriptRoot 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logFile = Join-Path $logDir "agente_$($Agente.numero).log"

    # Escribir prompt a archivo para evitar que newlines/caracteres especiales
    # rompan el parsing de -Command en Start-Process
    $promptFile = Join-Path $logDir "prompt_$($Agente.numero).txt"
    Set-Content -Path $promptFile -Value $prompt -Encoding UTF8 -NoNewline

    # #1541: Lanzar Run-AgentStream.ps1 como script separado.
    # Evita el infierno de escaping de PowerShell al construir $command inline.
    # Run-AgentStream.ps1 parsea stream-json y muestra actividad en tiempo real.
    $streamScript = Join-Path $PSScriptRoot "Run-AgentStream.ps1"

    Write-Host ">> Abriendo terminal con claude..."
    $proc = Start-Process powershell -ArgumentList (
        "-ExecutionPolicy", "Bypass",
        "-File", $streamScript,
        "-WorkDir", $wtDirResolved,
        "-PromptFile", $promptFile,
        "-LogFile", $logFile,
        "-AgentNum", $Agente.numero,
        "-Issue", $issue,
        "-Slug", $slug,
        "-Branch", $branch
    ) -PassThru

    # Guardar PID en sprint-pids.json
    $pidsFile = Join-Path $PSScriptRoot "sprint-pids.json"
    $pidsData = if (Test-Path $pidsFile) {
        Get-Content $pidsFile -Raw | ConvertFrom-Json
    } else {
        [PSCustomObject]@{}
    }
    $pidsData | Add-Member -NotePropertyName "agente_$($Agente.numero)" -NotePropertyValue $proc.Id -Force
    $pidsData | ConvertTo-Json | Set-Content $pidsFile

    # #1522: Escribir _pid, _launched_at y status=active en sprint-plan.json
    # Esto confirma que el agente realmente se lanzó (reconciliación atómica)
    try {
        $freshPlan = Get-Content $PlanFile -Raw | ConvertFrom-Json
        $targetAgent = $freshPlan.agentes | Where-Object { $_.issue -eq $issue }
        if ($targetAgent) {
            # Actualizar campos de liveness
            if ($targetAgent.PSObject.Properties.Match('status').Count) {
                $targetAgent.status = 'active'
            } else {
                $targetAgent | Add-Member -NotePropertyName 'status' -NotePropertyValue 'active' -Force
            }
            if ($targetAgent.PSObject.Properties.Match('_pid').Count) {
                $targetAgent._pid = $proc.Id
            } else {
                $targetAgent | Add-Member -NotePropertyName '_pid' -NotePropertyValue $proc.Id -Force
            }
            $launchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            if ($targetAgent.PSObject.Properties.Match('_launched_at').Count) {
                $targetAgent._launched_at = $launchedAt
            } else {
                $targetAgent | Add-Member -NotePropertyName '_launched_at' -NotePropertyValue $launchedAt -Force
            }
            $freshPlan | ConvertTo-Json -Depth 10 | Set-Content $PlanFile
            Write-Host ">> sprint-plan.json actualizado: status=active, _pid=$($proc.Id)" -ForegroundColor Green
        } else {
            Write-Host ">> WARN: Agente issue #$issue no encontrado en sprint-plan.json para actualizar _pid" -ForegroundColor Yellow
        }
    } catch {
        Write-Host ">> WARN: No se pudo actualizar sprint-plan.json con _pid: $_" -ForegroundColor Yellow
    }

    Write-Host ">> Agente $($Agente.numero) lanzado en nueva terminal (PID $($proc.Id))" -ForegroundColor Green
}

# --- Ejecutar ---
# Nota: El dashboard terminal (dashboard.js) fue deprecado en #1180.
# El dashboard web (dashboard-server.js en :3100) se auto-arranca via activity-logger.js,
# pero SOLO desde el repo principal — los worktrees de agentes NO lanzan su propia instancia (#1429).
# activity-logger.js detecta worktrees chequeando si .git es archivo (worktree) o directorio (repo principal).
# Para snapshot on-demand: usar /monitor. Para web: http://localhost:3100
if ($Numero -eq "all") {
    Write-Host ">> Lanzando TODOS los agentes del plan ($($Plan.agentes.Count))..." -ForegroundColor Magenta
    foreach ($agente in $Plan.agentes) {
        Start-UnAgente -Agente $agente
    }
    Write-Host ""
    Write-Host ">> Todos los agentes lanzados." -ForegroundColor Green
    Write-Host ">> Dashboard web auto-disponible en http://localhost:3100 (via activity-logger.js)" -ForegroundColor Cyan
    Write-Host ">> Monitoreo delegado a telegram-commander.js (agent-monitor integrado)." -ForegroundColor Cyan
    Write-Host ">> Reporte post-sprint se generará automáticamente cuando terminen." -ForegroundColor Cyan

    # Agent Watcher DESHABILITADO — destruye agentes al evaluar PRs demasiado rápido (#1551)
    # TODO: reimplementar con grace period mínimo de 10 min antes de evaluar
    Write-Host ">> Agent Watcher deshabilitado (bug #1551 — evalúa PRs antes de que los agentes trabajen)" -ForegroundColor DarkGray
}
else {
    $num = [int]$Numero
    $agente = $Plan.agentes | Where-Object { $_.numero -eq $num }

    if (-not $agente) {
        Write-Error "Agente $num no encontrado en el plan. Agentes disponibles: $($Plan.agentes | ForEach-Object { $_.numero } | Join-String -Separator ', ')"
        exit 1
    }

    Start-UnAgente -Agente $agente
    Write-Host ">> Dashboard web auto-disponible en http://localhost:3100 (via activity-logger.js)" -ForegroundColor Cyan
}
