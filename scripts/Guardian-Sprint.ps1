<#
.SYNOPSIS
    Daemon que detecta inactividad de agentes y relanza /planner sprint.

.DESCRIPTION
    Corre continuamente en background. Cada 5 minutos verifica si hay agentes
    Claude activos. Si no detecta ninguno, lanza automaticamente /planner sprint
    para reiniciar el ciclo de trabajo autonomo.

    Condiciones de inactividad (TODAS deben cumplirse):
    - No hay procesos claude corriendo
    - No hay worktrees codex/* activos
    - No hay Watch-Agentes.ps1 corriendo

    Cooldown de 10 minutos entre relanzamientos para evitar loops.

.PARAMETER PollInterval
    Intervalo de polling en segundos (default: 300 = 5 minutos).

.PARAMETER CooldownMinutes
    Minutos de cooldown entre relanzamientos (default: 10).

.EXAMPLE
    .\Guardian-Sprint.ps1
    .\Guardian-Sprint.ps1 -PollInterval 120
    .\Guardian-Sprint.ps1 -PollInterval 60 -CooldownMinutes 5
#>
param(
    [int]$PollInterval = 300,
    [int]$CooldownMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# --- Paths ---
$MainRepo = "C:\Workspaces\Intrale\platform"
$LogFile  = Join-Path (Join-Path $MainRepo ".claude") "guardian.log"

# --- Helpers ---
$P = '>>'

function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $Msg"
    Write-Host "$P $line" -ForegroundColor $Color
    try {
        Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    } catch {}
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

# --- Deteccion de actividad ---

function Test-ClaudeRunning {
    $procs = Get-Process -Name 'claude' -ErrorAction SilentlyContinue
    return ($procs -and @($procs).Count -gt 0)
}

function Test-CodexWorktrees {
    Push-Location $MainRepo
    try {
        $wtOutput = git worktree list --porcelain 2>$null
        $codexBranches = $wtOutput | Select-String 'branch refs/heads/codex/'
        return ($codexBranches -and @($codexBranches).Count -gt 0)
    }
    catch { return $false }
    finally { Pop-Location }
}

function Test-WatcherRunning {
    $psProcs = Get-Process -Name 'powershell' -ErrorAction SilentlyContinue
    if (-not $psProcs) { return $false }
    foreach ($p in $psProcs) {
        try {
            if ($p.CommandLine -match 'Watch-Agentes') { return $true }
        } catch {}
    }
    return $false
}

function Test-IsActive {
    $claude   = Test-ClaudeRunning
    $worktrees = Test-CodexWorktrees
    $watcher  = Test-WatcherRunning

    return @{
        Claude    = $claude
        Worktrees = $worktrees
        Watcher   = $watcher
        Active    = ($claude -or $worktrees -or $watcher)
    }
}

# --- Banner ---
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Guardian-Sprint -- Keepalive Autonomo'      -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Log ('Intervalo de polling: {0}s ({1} min)' -f $PollInterval, [math]::Round($PollInterval/60,1)) 'Cyan'
Write-Log ('Cooldown entre relanzamientos: {0} min' -f $CooldownMinutes) 'Cyan'
Write-Host ''

Send-TelegramMessage "🛡️ <b>Guardian-Sprint iniciado</b>`nPolling cada $([math]::Round($PollInterval/60,1)) min | Cooldown $CooldownMinutes min"

# --- Loop principal ---
$lastLaunchTime = [DateTime]::MinValue
$cycleCount = 0

while ($true) {
    $cycleCount++
    $state = Test-IsActive

    $stateStr = 'claude={0} worktrees={1} watcher={2}' -f $state.Claude, $state.Worktrees, $state.Watcher

    if ($state.Active) {
        Write-Log ('Ciclo {0}: activo [{1}]' -f $cycleCount, $stateStr)
    }
    else {
        Write-Log ('Ciclo {0}: INACTIVO [{1}]' -f $cycleCount, $stateStr) 'Yellow'

        # Verificar cooldown
        $elapsed = (Get-Date) - $lastLaunchTime
        if ($elapsed.TotalMinutes -lt $CooldownMinutes) {
            $remaining = [math]::Round($CooldownMinutes - $elapsed.TotalMinutes, 1)
            Write-Log ('Cooldown activo: {0} min restantes. Esperando...' -f $remaining) 'Yellow'
        }
        else {
            # Relanzar sprint
            Write-Log 'Inactividad detectada. Relanzando ciclo...' 'Magenta'
            Send-TelegramMessage "🛡️ <b>Guardian: inactividad detectada</b>`nNo hay agentes, worktrees ni watcher activos.`nRelanzando <code>/planner sprint</code>..."

            # Actualizar main
            Push-Location $MainRepo
            try {
                git fetch origin main --quiet 2>$null
                git pull origin main --quiet 2>$null
                Write-Log 'Main actualizado.' 'Green'
            }
            catch {
                Write-Log ('Error actualizando main: {0}' -f $_.Exception.Message) 'Red'
            }
            finally { Pop-Location }

            # Lanzar nueva terminal con /planner sprint
            $command = "Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue; " +
                       "Set-Location '$MainRepo'; " +
                       "Write-Host ''; " +
                       "Write-Host '  Guardian-Sprint -- Nuevo ciclo automatico' -ForegroundColor Green; " +
                       "Write-Host ''; " +
                       "claude '/planner sprint'"

            Start-Process powershell -ArgumentList "-NoExit", "-Command", $command
            $lastLaunchTime = Get-Date

            Write-Log 'Nuevo ciclo lanzado en terminal independiente.' 'Green'
            Send-TelegramMessage "🛡️ <b>Guardian: sprint relanzado</b>`nNueva terminal abierta con <code>/planner sprint</code>"
        }
    }

    Start-Sleep -Seconds $PollInterval
}
