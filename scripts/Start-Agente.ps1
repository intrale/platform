<#
.SYNOPSIS
    Lanza agentes Claude en worktrees aislados consumiendo el plan del Oraculo.

.DESCRIPTION
    Lee sprint-plan.json y crea worktrees para los agentes indicados.
    Enlaza .claude/ del repo principal via symlink y abre nueva terminal PowerShell con claude ejecutando.

.PARAMETER Numero
    Numero de agente (1, 2, 3...) o "all" para lanzar todos en paralelo.

.PARAMETER SkipMerge
    Si se indica, se pasa -SkipMerge al Watch-Agentes (PRs sin merge automatico).

.EXAMPLE
    .\Start-Agente.ps1 1
    .\Start-Agente.ps1 all
    .\Start-Agente.ps1 all -SkipMerge
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Numero,
    [switch]$SkipMerge
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

    # Pre-registrar confianza del worktree para evitar dialogo interactivo de trust
    PreRegister-Trust -AbsPath "$wtDirResolved"

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

    # Pre-crear trust directory para que Claude no muestre el dialogo interactivo
    # Claude Code almacena confianza en ~/.claude/projects/<path-mangled>/
    # Path mangling: C:/Workspaces/Intrale/platform.codex-123-slug → C--Workspaces-Intrale-platform.codex-123-slug
    $wtAbsPath = (Resolve-Path $wtDirResolved).Path -replace '\\', '/'
    $mangledPath = ($wtAbsPath -replace '^/', '' -replace '/', '-' -replace ':', '-')
    $trustDir = Join-Path $env:USERPROFILE ".claude\projects\$mangledPath"
    if (-not (Test-Path $trustDir)) {
        New-Item -ItemType Directory -Path $trustDir -Force | Out-Null
        Write-Host ">> Trust pre-registrado: $mangledPath"
    }

    # Abrir nueva terminal PowerShell con claude ejecutando
    # La terminal se cierra automaticamente al terminar claude (sin -NoExit)
    # Output se loguea a scripts/logs/agente_N.log via Start-Transcript
    $logDir = Join-Path $PSScriptRoot 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logFile = Join-Path $logDir "agente_$($Agente.numero).log"

    # Escribir prompt a archivo para evitar que newlines/caracteres especiales
    # rompan el parsing de -Command en Start-Process
    $promptFile = Join-Path $logDir "prompt_$($Agente.numero).txt"
    Set-Content -Path $promptFile -Value $prompt -Encoding UTF8 -NoNewline

    $command = "Start-Transcript -Path '$logFile' -Force | Out-Null; " +
               "Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue; " +
               "Set-Location '$wtDirResolved'; " +
               "Write-Host ''; " +
               "Write-Host '  Agente $($Agente.numero) - issue #$issue ($slug)' -ForegroundColor Cyan; " +
               "Write-Host '  Branch: $branch' -ForegroundColor Cyan; " +
               "Write-Host '  Log: $logFile' -ForegroundColor DarkGray; " +
               "Write-Host ''; " +
               "Get-Content '$promptFile' -Raw | claude -p --dangerously-skip-permissions; " +
               "Write-Host ''; " +
               "Write-Host ('  claude finalizo (exit ' + `$LASTEXITCODE + ')') -ForegroundColor Yellow; " +
               "Stop-Transcript | Out-Null; " +
               "Start-Sleep -Seconds 3"

    Write-Host ">> Abriendo terminal con claude..."
    $proc = Start-Process powershell -ArgumentList "-Command", $command -PassThru

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
    try {
        $monitorProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'dashboard\.js' }

        if ($monitorProcs) {
            Write-Host ">> Monitor ya activo (PID: $($monitorProcs.ProcessId)) - reutilizando." -ForegroundColor Yellow
            return
        }
    }
    catch {
        # StrictMode puede fallar en Get-CimInstance si no hay procesos node - ignorar
    }

    $dashboardPath = Join-Path $MainRepo ".claude\dashboard.js"
    if (-not (Test-Path $dashboardPath)) {
        Write-Host ">> dashboard.js no encontrado en: $dashboardPath - omitiendo monitor." -ForegroundColor Yellow
        return
    }

    $command = "Set-Location '$MainRepo'; " +
               "Write-Host '  Monitor Live - Dashboard multi-sesion' -ForegroundColor Cyan; " +
               "node '$dashboardPath'"
    Start-Process powershell -ArgumentList "-Command", $command
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

    # Lanzar Watch-Agentes en background para ciclo continuo
    $watchScript = Join-Path $PSScriptRoot 'Watch-Agentes.ps1'
    if (Test-Path $watchScript) {
        $watchArgs = @('-NonInteractive', '-File', $watchScript)
        if ($SkipMerge) { $watchArgs += '-SkipMerge' }
        Start-Process powershell -ArgumentList $watchArgs
        Write-Host ">> Watch-Agentes lanzado en background (ciclo continuo)." -ForegroundColor Magenta
    }
    else {
        Write-Host ">> Watch-Agentes.ps1 no encontrado, omitiendo watcher." -ForegroundColor Yellow
    }

    # Lanzar Guardian-Sprint automaticamente (siempre con 'all')
    $guardianScript = Join-Path $PSScriptRoot 'Guardian-Sprint.ps1'
    if (Test-Path $guardianScript) {
        # Verificar si ya hay un guardian corriendo
        $guardianRunning = $null
        try {
            $guardianRunning = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'Guardian-Sprint' }
        } catch {}
        if ($guardianRunning) {
            Write-Host ">> Guardian-Sprint ya esta corriendo (PID: $($guardianRunning.ProcessId)). Reutilizando." -ForegroundColor Yellow
        }
        else {
            Start-Process powershell -ArgumentList '-NonInteractive', '-File', $guardianScript
            Write-Host ">> Guardian-Sprint lanzado en background (keepalive autonomo)." -ForegroundColor Green
        }
    }
    else {
        Write-Host ">> Guardian-Sprint.ps1 no encontrado, omitiendo guardian." -ForegroundColor Yellow
    }
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
