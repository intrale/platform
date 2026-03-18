<#
.SYNOPSIS
    Ejecuta claude en modo stream-json y muestra actividad en tiempo real.
.DESCRIPTION
    Script auxiliar lanzado por Start-Agente.ps1 en cada terminal de agente.
    Parsea el stream JSON de claude y muestra tool calls, mensajes y resultado
    con colores diferenciados, mientras loguea todo al archivo de log.
.PARAMETER WorkDir
    Directorio de trabajo (worktree del agente).
.PARAMETER PromptFile
    Ruta al archivo con el prompt para claude.
.PARAMETER LogFile
    Ruta al archivo de log.
.PARAMETER AgentNum
    Numero del agente (1, 2, 3...).
.PARAMETER Issue
    Numero del issue de GitHub.
.PARAMETER Slug
    Slug del agente (ej: onboarding-negocio).
.PARAMETER Branch
    Nombre de la rama git.
#>
param(
    [Parameter(Mandatory)] [string]$WorkDir,
    [Parameter(Mandatory)] [string]$PromptFile,
    [Parameter(Mandatory)] [string]$LogFile,
    [Parameter(Mandatory)] [int]$AgentNum,
    [Parameter(Mandatory)] [int]$Issue,
    [Parameter(Mandatory)] [string]$Slug,
    [Parameter(Mandatory)] [string]$Branch,
    [string]$Model = "sonnet"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Titulo de ventana identificable
$host.UI.RawUI.WindowTitle = "Agente $AgentNum - #$Issue ($Slug)"

# Limpiar variable que interfiere con claude
Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue

# Posicionarse en el worktree
Set-Location $WorkDir

# Header
$header = @(
    "",
    "  Agente $AgentNum - issue #$Issue ($Slug)",
    "  Branch: $Branch",
    "  Log: $LogFile",
    ""
) -join [Environment]::NewLine
Write-Host $header -ForegroundColor Cyan

# Inicializar log
$header | Out-File -FilePath $LogFile -Encoding utf8 -Force

try {
    # Detectar pipeline_mode desde sprint-plan.json
    $pipelineMode = "skills"  # default: backward compat
    $planPath = Join-Path (Split-Path $WorkDir -Parent) "platform\scripts\sprint-plan.json"
    if (-not (Test-Path $planPath)) { $planPath = Join-Path $PSScriptRoot "sprint-plan.json" }
    if (Test-Path $planPath) {
        try {
            $plan = Get-Content $planPath -Raw | ConvertFrom-Json
            if ($plan.pipeline_mode) { $pipelineMode = $plan.pipeline_mode }
        } catch { }
    }

    # Siempre usar scripts del repo principal (no del worktree) para tener la version mas reciente
    $mainRepoScripts = "C:\Workspaces\Intrale\platform\scripts"
    $agentRunnerPath = Join-Path $mainRepoScripts "pipeline\agent-runner.js"
    $useRunner = ($pipelineMode -ne "skills") -and (Test-Path $agentRunnerPath)

    if ($useRunner) {
        # ─── Pipeline mode: agent-runner.js orquesta pre/post-Claude ───
        Write-Host "  Pipeline mode: $pipelineMode (agent-runner.js)" -ForegroundColor Magenta

        $runnerArgs = @(
            $agentRunnerPath,
            "--workdir", $WorkDir,
            "--prompt-file", $PromptFile,
            "--model", $Model,
            "--issue", $Issue,
            "--agent-num", $AgentNum,
            "--slug", $Slug,
            "--branch", $Branch,
            "--log-file", $LogFile
        )

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = "node"
        $process.StartInfo.Arguments = ($runnerArgs -join " ")
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.CreateNoWindow = $false
        $process.StartInfo.WorkingDirectory = $WorkDir
        $process.StartInfo.EnvironmentVariables["CLAUDE_PROJECT_DIR"] = $WorkDir

        # Propagar GH_TOKEN para que auto-delivery.js pueda crear/mergear PRs
        $ghToken = $env:GH_TOKEN
        if (-not $ghToken -or $ghToken.Length -lt 10) {
            try {
                $credInput = "protocol=https`nhost=github.com`n"
                $credLines = ($credInput | & git credential fill 2>$null)
                $pwdLine = @($credLines) | Where-Object { $_ -match '^password=' }
                if ($pwdLine) { $ghToken = (($pwdLine | Select-Object -First 1) -replace '^password=', '').Trim() }
            } catch { }
        }
        if (-not $ghToken -or $ghToken.Length -lt 10) {
            try {
                $ghToken = (& "C:\Workspaces\gh-cli\bin\gh.exe" auth token 2>$null | Out-String).Trim()
            } catch { }
        }
        if ($ghToken -and $ghToken.Length -gt 10) {
            $process.StartInfo.EnvironmentVariables["GH_TOKEN"] = $ghToken
            Write-Host "  GH_TOKEN obtenido y propagado al runner" -ForegroundColor DarkGreen
        } else {
            Write-Host "  WARN: No se pudo obtener GH_TOKEN — auto-delivery puede fallar" -ForegroundColor DarkYellow
        }

        $process.Start() | Out-Null

        # Leer output del runner (incluye output de Claude proxied)
        while (-not $process.StandardOutput.EndOfStream) {
            $line = $process.StandardOutput.ReadLine()
            if (-not $line) { continue }
            $line | Out-File -FilePath $LogFile -Encoding utf8 -Append
            Write-Host "  $line" -ForegroundColor Gray
        }

        $stderrOutput = $process.StandardError.ReadToEnd()
        if ($stderrOutput) {
            $stderrOutput | Out-File -FilePath $LogFile -Encoding utf8 -Append
        }

        $process.WaitForExit()
        $exitCode = $process.ExitCode

    } else {
        # ─── Skills mode: lanzar Claude directamente (backward compat) ───
        Write-Host "  Pipeline mode: skills (claude directo)" -ForegroundColor Yellow

        # Leer prompt
        $promptContent = Get-Content $PromptFile -Raw

        # Crear proceso claude con stream-json
        # System.Diagnostics.Process no resuelve .ps1 wrappers del PATH — usar .cmd
        $claudePath = Join-Path $env:APPDATA "npm\claude.cmd"
        if (-not (Test-Path $claudePath)) {
            # Fallback: buscar en PATH
            $claudePath = (Get-Command claude -ErrorAction SilentlyContinue).Source
            if (-not $claudePath) { throw "claude no encontrado en PATH ni en npm global" }
        }
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = $claudePath
        $process.StartInfo.Arguments = "-p --model $Model --dangerously-skip-permissions --output-format stream-json --verbose"
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.CreateNoWindow = $false
        $process.StartInfo.WorkingDirectory = $WorkDir
        $process.Start() | Out-Null

        # Enviar prompt y cerrar stdin
        $process.StandardInput.Write($promptContent)
        $process.StandardInput.Close()

        $toolCount = 0
        $msgCount = 0

        # Leer stream linea por linea
        while (-not $process.StandardOutput.EndOfStream) {
            $line = $process.StandardOutput.ReadLine()
            if (-not $line) { continue }

            # Loguear linea cruda
            $line | Out-File -FilePath $LogFile -Encoding utf8 -Append

            try {
                $evt = $line | ConvertFrom-Json -ErrorAction Stop

                if ($evt.type -eq "assistant" -and $evt.message -and $evt.message.content) {
                    foreach ($block in @($evt.message.content)) {
                        if ($block.type -eq "tool_use") {
                            $toolCount++
                            $toolName = $block.name
                            $snippet = ""

                            if ($block.input.command) {
                                $snippet = $block.input.command
                                if ($snippet.Length -gt 80) { $snippet = $snippet.Substring(0, 80) }
                            }
                            elseif ($block.input.pattern) { $snippet = $block.input.pattern }
                            elseif ($block.input.file_path) { $snippet = $block.input.file_path }
                            elseif ($block.input.description) {
                                $snippet = $block.input.description
                                if ($snippet.Length -gt 80) { $snippet = $snippet.Substring(0, 80) }
                            }

                            $label = "  [$toolCount] $toolName"
                            if ($snippet) { $label += ": $snippet" }
                            Write-Host $label -ForegroundColor Yellow
                        }
                        elseif ($block.type -eq "text" -and $block.text) {
                            $msgCount++
                            $preview = $block.text
                            if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 120) + "..." }
                            Write-Host "  > $preview" -ForegroundColor Gray
                        }
                    }
                }
                elseif ($evt.type -eq "result") {
                    Write-Host ""
                    Write-Host "  === RESULTADO ===" -ForegroundColor Green
                    if ($evt.result) {
                        $lines = $evt.result -split [Environment]::NewLine
                        $maxLines = [Math]::Min(19, $lines.Count - 1)
                        foreach ($l in $lines[0..$maxLines]) {
                            Write-Host "  $l" -ForegroundColor White
                        }
                        if ($lines.Count -gt 20) {
                            Write-Host "  ... (truncado)" -ForegroundColor DarkGray
                        }
                    }
                }
            }
            catch {
                # Linea no es JSON valido — ignorar
            }
        }

        # Leer stderr
        $stderrOutput = $process.StandardError.ReadToEnd()
        if ($stderrOutput) {
            $stderrOutput | Out-File -FilePath $LogFile -Encoding utf8 -Append
            Write-Host "  STDERR: $stderrOutput" -ForegroundColor DarkYellow
        }

        $process.WaitForExit()
        $exitCode = $process.ExitCode
    }

    # Diagnostico de muerte: registrar causa en el log
    $diagToolCalls = $(if ($useRunner) { -1 } else { $toolCount })
    $diagMessages = $(if ($useRunner) { -1 } else { $msgCount })
    $deathDiag = @{
        timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        agent = $AgentNum
        issue = $Issue
        slug = $Slug
        model = $Model
        exitCode = $exitCode
        pipelineMode = $pipelineMode
        toolCalls = $diagToolCalls
        messages = $diagMessages
        hasStderr = [bool]$stderrOutput
    }
    $diagJson = $deathDiag | ConvertTo-Json -Compress
    "DEATH_DIAG: $diagJson" | Out-File -FilePath $LogFile -Encoding utf8 -Append

    Write-Host ""
    if ($useRunner) {
        Write-Host "  Resumen: pipeline=$pipelineMode, modelo=$Model" -ForegroundColor Cyan
    } else {
        Write-Host "  Resumen: $toolCount tool calls, $msgCount mensajes, modelo: $Model" -ForegroundColor Cyan
    }

    if ($exitCode -ne 0) {
        Write-Host "  ERROR: finalizo con exit code $exitCode" -ForegroundColor Red
        Write-Host "  La terminal se cerrara en 30 segundos..." -ForegroundColor Yellow
        Start-Sleep -Seconds 30
    }
    else {
        Write-Host "  Finalizo OK (exit $exitCode)" -ForegroundColor Yellow
        Start-Sleep -Seconds 3
    }
}
catch {
    # Diagnostico de excepcion
    $errorDiag = @{
        timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        agent = $AgentNum
        issue = $Issue
        type = "EXCEPTION"
        message = $_.Exception.Message
    }
    ($errorDiag | ConvertTo-Json -Compress) | Out-File -FilePath $LogFile -Encoding utf8 -Append
    $_ | Out-String | Out-File -FilePath $LogFile -Encoding utf8 -Append
    Write-Host "  EXCEPTION: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  La terminal se cerrara en 30 segundos..." -ForegroundColor Yellow
    Start-Sleep -Seconds 30
}
