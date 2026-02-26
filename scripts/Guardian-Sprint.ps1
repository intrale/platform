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
    # Claude Code corre como node.exe ejecutando cli.js, no como "claude"
    # Usar Get-CimInstance porque Get-Process no expone CommandLine en PS 5.1
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    if (-not $nodeProcs) { return $false }
    foreach ($p in $nodeProcs) {
        if ($p.CommandLine -match 'claude-code[/\\]cli\.js') { return $true }
    }
    return $false
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
    # Usar Get-CimInstance porque Get-Process no expone CommandLine en PS 5.1
    $psProcs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue
    if (-not $psProcs) { return $false }
    foreach ($p in $psProcs) {
        if ($p.CommandLine -match 'Watch-Agentes') { return $true }
    }
    return $false
}

function Get-ClaudeAgentPids {
    # Retorna hashtable PID → UserModeTime de agentes Claude (bypassPermissions)
    $result = @{}
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    if (-not $procs) { return $result }
    foreach ($p in $procs) {
        if ($p.CommandLine -match 'claude-code[/\\]cli\.js' -and $p.CommandLine -match 'bypassPermissions') {
            $result[[int]$p.ProcessId] = [long]$p.UserModeTime
        }
    }
    return $result
}

function Find-ZombieAgents {
    param([hashtable]$PrevSnapshot, [hashtable]$CurrSnapshot)
    # Zombie = PID presente en ambos snapshots con CPU identico
    $zombies = @()
    foreach ($pid in $CurrSnapshot.Keys) {
        if ($PrevSnapshot.ContainsKey($pid) -and $CurrSnapshot[$pid] -eq $PrevSnapshot[$pid]) {
            $zombies += $pid
        }
    }
    return $zombies
}

function Stop-ZombieAgents {
    param([int[]]$Pids)
    foreach ($pid in $Pids) {
        try {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Write-Log ('Zombie eliminado: PID {0}' -f $pid) 'Red'
        } catch {}
    }
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
$prevCpuSnapshot = @{}

while ($true) {
    $cycleCount++
    $state = Test-IsActive

    # Deteccion de zombies: comparar CPU entre ciclos
    $currCpuSnapshot = Get-ClaudeAgentPids
    if ($prevCpuSnapshot.Count -gt 0 -and $currCpuSnapshot.Count -gt 0) {
        $zombies = Find-ZombieAgents -PrevSnapshot $prevCpuSnapshot -CurrSnapshot $currCpuSnapshot
        if ($zombies.Count -gt 0) {
            $zombieStr = ($zombies | ForEach-Object { $_.ToString() }) -join ', '
            Write-Log ('ZOMBIE detectado: PID {0} (CPU=0 entre ciclos). Eliminando...' -f $zombieStr) 'Red'
            Send-TelegramMessage "🛡️ <b>Guardian: zombie(s) detectado(s)</b>`nPID: $zombieStr — CPU inactiva entre ciclos.`nEliminando procesos..."
            Stop-ZombieAgents -Pids $zombies
        }
    }
    $prevCpuSnapshot = $currCpuSnapshot

    $stateStr = 'claude={0} worktrees={1} watcher={2}' -f $state.Claude, $state.Worktrees, $state.Watcher
    $agentCount = $currCpuSnapshot.Count
    if ($agentCount -gt 0) { $stateStr += ' agents={0}' -f $agentCount }

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
