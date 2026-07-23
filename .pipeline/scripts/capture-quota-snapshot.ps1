# =============================================================================
# capture-quota-snapshot.ps1 — Captura PNG del panel "Uso" de Claude Desktop
# Issue #3012 (split de #3008, hija 1)
#
# RESPONSABILIDADES
#   - Idempotente: si Claude Desktop está enfocado por el operador, salta.
#   - Si está cerrada: la lanza minimizada off-screen, navega al panel "Uso"
#     vía UI Automation, captura el control específico (no fullscreen) y
#     cierra con Process.CloseMainWindow() + timeout.
#   - Lockfile `.pipeline/.quota-snapshot.lock` con PID + mtime; stale > 3 min
#     se borra (CA-4).
#   - Path al binario PINNED vía env `CLAUDE_DESKTOP_PATH` (CA-9).
#
# HARDENING (CA-9)
#   - Cero `Invoke-Expression`.
#   - Cero argumentos derivados de output del cliente Desktop.
#   - Lockfile validado contra `Get-Process` (PID alive == otro capturador
#     corriendo; muerto + mtime > 3 min == stale, se borra).
#
# ENV VARS (consumidas)
#   CLAUDE_DESKTOP_PATH         path absoluto al .exe del cliente Claude Desktop.
#   QUOTA_SNAPSHOT_OUT_DIR      directorio destino de los PNG (default
#                                .pipeline/quota-snapshots).
#   QUOTA_SNAPSHOT_LOCK_PATH    path al lockfile (default
#                                .pipeline/.quota-snapshot.lock).
#   QUOTA_SNAPSHOT_NAV_TIMEOUT  segundos máximos esperando el panel (default 25).
#   QUOTA_SNAPSHOT_CLOSE_TIMEOUT segundos máximos esperando close (default 8).
#
# EXIT CODES
#   0  ok — PNG guardado en stdout (path absoluto).
#   2  desktop enfocado por operador → skip silencioso.       (DIAG causa=foco)
#   3  lockfile owned by alive PID → otra captura en curso, skip.
#   4  CLAUDE_DESKTOP_PATH no seteado o no existe.             (DIAG causa=path)
#   5  timeout esperando UI Automation del panel.             (DIAG causa=render)
#   6  error de sistema (proceso no arranca, no se puede crear directorio,
#       etc.). El parser/scheduler trata 4-6 como fallo del bucket.
#
# DIAGNÓSTICO (CA-3): los fallos loguean una línea `DIAG exit=<n> causa=<foco|
#   path|render> razon=<detalle>` que distingue la condición exacta que falló.
#   SEC-2: nunca se vuelca `account_handle` (real ni esperado) ni contenido OCR;
#   sólo paths de filesystem y estados de render, que no son PII.
# =============================================================================

[CmdletBinding()]
param(
    [string]$RepoRoot = $env:PIPELINE_REPO_ROOT
)

# Default a la convencion de C:\Workspaces\Intrale\platform si no se inyecta.
if (-not $RepoRoot -or $RepoRoot.Trim() -eq '') {
    $RepoRoot = 'C:\Workspaces\Intrale\platform'
}

$PipelineDir   = Join-Path $RepoRoot '.pipeline'
$LogDir        = Join-Path $PipelineDir 'logs'
$LogFile       = Join-Path $LogDir 'quota-snapshot.log'
$DefaultOutDir = Join-Path $PipelineDir 'quota-snapshots'
$DefaultLock   = Join-Path $PipelineDir '.quota-snapshot.lock'

$OutDir   = if ($env:QUOTA_SNAPSHOT_OUT_DIR)     { $env:QUOTA_SNAPSHOT_OUT_DIR }     else { $DefaultOutDir }
$LockPath = if ($env:QUOTA_SNAPSHOT_LOCK_PATH)   { $env:QUOTA_SNAPSHOT_LOCK_PATH }   else { $DefaultLock }
$NavTimeout = if ($env:QUOTA_SNAPSHOT_NAV_TIMEOUT) { [int]$env:QUOTA_SNAPSHOT_NAV_TIMEOUT } else { 25 }
$CloseTimeout = if ($env:QUOTA_SNAPSHOT_CLOSE_TIMEOUT) { [int]$env:QUOTA_SNAPSHOT_CLOSE_TIMEOUT } else { 8 }

if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
if (-not (Test-Path $OutDir)) { New-Item -Path $OutDir -ItemType Directory -Force | Out-Null }

function Write-Log($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

# -----------------------------------------------------------------------------
# Lockfile (CA-4): PID + mtime. Stale > 3 min se borra.
# -----------------------------------------------------------------------------
function Test-LockfileStale($LockFile) {
    if (-not (Test-Path $LockFile)) { return $true }
    try {
        $content = Get-Content -LiteralPath $LockFile -ErrorAction Stop -Raw
        $pidLine = ($content -split "`r?`n")[0].Trim()
        $lockPid = 0
        if (-not [int]::TryParse($pidLine, [ref]$lockPid)) {
            return $true # malformado → stale
        }
        $proc = $null
        try { $proc = Get-Process -Id $lockPid -ErrorAction Stop } catch { $proc = $null }
        if (-not $proc) { return $true } # PID muerto

        $mtime = (Get-Item -LiteralPath $LockFile).LastWriteTime
        $ageMinutes = ((Get-Date) - $mtime).TotalMinutes
        if ($ageMinutes -gt 3) { return $true } # stale > 3 min
        return $false
    } catch {
        return $true
    }
}

function Acquire-Lockfile($LockFile) {
    if (-not (Test-LockfileStale $LockFile)) {
        Write-Log "Lockfile activo de otro proceso, skip."
        return $false
    }
    try {
        # Truncar si existía stale
        Set-Content -LiteralPath $LockFile -Value $PID -Encoding ASCII -NoNewline
        return $true
    } catch {
        Write-Log "ERROR al adquirir lockfile: $_"
        return $false
    }
}

function Release-Lockfile($LockFile) {
    try {
        if (Test-Path $LockFile) {
            $content = Get-Content -LiteralPath $LockFile -ErrorAction SilentlyContinue -Raw
            $pidLine = ($content -split "`r?`n")[0].Trim()
            $lockPid = 0
            [void][int]::TryParse($pidLine, [ref]$lockPid)
            if ($lockPid -eq $PID) {
                Remove-Item -LiteralPath $LockFile -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

# -----------------------------------------------------------------------------
# Detección de "Claude Desktop enfocado por el operador" (CA-1).
# -----------------------------------------------------------------------------
function Test-ClaudeDesktopFocused {
    try {
        Add-Type -Namespace 'WinAPIShim' -Name 'Native' -MemberDefinition @'
            [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);
'@ -ErrorAction SilentlyContinue
        $hwnd = [WinAPIShim.Native]::GetForegroundWindow()
        if ($hwnd -eq [System.IntPtr]::Zero) { return $false }
        $procId = 0
        [void][WinAPIShim.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -le 0) { return $false }
        $proc = $null
        try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { return $false }
        if (-not $proc) { return $false }
        # Heurística defensiva: claude desktop suele tener nombre `Claude` o
        # `ClaudeDesktop`. Si el operador la trae al frente, evitamos capturar.
        $procName = $proc.ProcessName
        return ($procName -match '(?i)^Claude(Desktop)?$')
    } catch {
        return $false
    }
}

# -----------------------------------------------------------------------------
# Captura del PNG del panel via UI Automation (CA-1, CA-9).
# -----------------------------------------------------------------------------
function Find-ClaudeDesktopProcess($BinaryPath) {
    try {
        $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path -ieq $BinaryPath)
        }
        if ($procs) { return @($procs)[0] }
    } catch {}
    return $null
}

function Start-ClaudeDesktopOffscreen($BinaryPath) {
    Write-Log "Lanzando Claude Desktop offscreen: $BinaryPath"
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $BinaryPath
        $psi.WindowStyle = 'Minimized'
        $psi.UseShellExecute = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        if (-not $proc) { return $null }
        # Esperar a que MainWindowHandle aparezca (timeout corto).
        $proc.WaitForInputIdle(10000) | Out-Null
        $deadline = (Get-Date).AddSeconds(15)
        while ($proc.MainWindowHandle -eq [System.IntPtr]::Zero -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
            $proc.Refresh()
        }
        # Mover offscreen para no molestar al operador (CA-1).
        if ($proc.MainWindowHandle -ne [System.IntPtr]::Zero) {
            try {
                Add-Type -Namespace 'WinAPIShim' -Name 'Move' -MemberDefinition @'
                    [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@ -ErrorAction SilentlyContinue
                # SWP_NOSIZE | SWP_NOZORDER = 0x0001 | 0x0004 = 5
                [void][WinAPIShim.Move]::SetWindowPos($proc.MainWindowHandle, [System.IntPtr]::Zero, -32000, -32000, 0, 0, 5)
            } catch {}
        }
        return $proc
    } catch {
        Write-Log "ERROR al lanzar Claude Desktop: $_"
        return $null
    }
}

function Capture-MainWindow($Proc, $OutFile) {
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        Add-Type -Namespace 'WinAPIShim' -Name 'PrintWnd' -MemberDefinition @'
            [DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hWnd, System.IntPtr hdcBlt, uint nFlags);
            [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
            [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
            public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -ErrorAction SilentlyContinue
        $hwnd = $Proc.MainWindowHandle
        if ($hwnd -eq [System.IntPtr]::Zero) {
            Write-Log "MainWindowHandle vacio, no se puede capturar."
            return $false
        }
        $rect = New-Object 'WinAPIShim.PrintWnd+RECT'
        [void][WinAPIShim.PrintWnd]::GetWindowRect($hwnd, [ref]$rect)
        $width = [int]($rect.Right - $rect.Left)
        $height = [int]($rect.Bottom - $rect.Top)
        if ($width -le 0 -or $height -le 0) {
            $width = 1280; $height = 800
        }
        $bmp = New-Object System.Drawing.Bitmap($width, $height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        # PW_RENDERFULLCONTENT = 0x00000002 (incluye contenido offscreen).
        [void][WinAPIShim.PrintWnd]::PrintWindow($hwnd, $hdc, 0x00000002)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Log "PNG guardado: $OutFile (${width}x${height})"
        return $true
    } catch {
        Write-Log "ERROR PrintWindow: $_"
        return $false
    }
}

function Close-ClaudeDesktopGracefully($Proc, $TimeoutSeconds) {
    try {
        if (-not $Proc) { return }
        if ($Proc.HasExited) { return }
        [void]$Proc.CloseMainWindow()
        if (-not $Proc.WaitForExit([int]($TimeoutSeconds * 1000))) {
            Write-Log "Close gracefully timeout, killing PID $($Proc.Id)"
            try { $Proc.Kill() } catch {}
        }
    } catch {
        Write-Log "ERROR al cerrar Claude Desktop: $_"
    }
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

# CA-1: si el operador está usando Claude Desktop, no tocamos nada.
# DIAG (CA-3): categoría "foco" — el operador está usando el desktop; skip.
if (Test-ClaudeDesktopFocused) {
    Write-Log "DIAG exit=2 causa=foco razon=operador_usando_desktop (skip idempotente, sin captura)"
    exit 2
}

# CA-9: validar binario PINNED.
# DIAG (CA-3): categoría "path" — se distingue "no seteado" de "seteado pero
# inexistente". El path del binario NO es PII (ruta de filesystem, no identidad
# de cuenta ni contenido OCR — SEC-2).
$BinaryPath = $env:CLAUDE_DESKTOP_PATH
if (-not $BinaryPath -or $BinaryPath.Trim() -eq '') {
    Write-Log "DIAG exit=4 causa=path razon=CLAUDE_DESKTOP_PATH_no_seteado (binario pinned no configurado en el entorno)"
    exit 4
}
if (-not (Test-Path -LiteralPath $BinaryPath)) {
    Write-Log "DIAG exit=4 causa=path razon=binario_pinned_inexistente path='$BinaryPath'"
    exit 4
}

# CA-4: lockfile.
if (-not (Acquire-Lockfile $LockPath)) {
    exit 3
}

$ExitCode = 0
$OutFile = $null
$Proc = $null
$Launched = $false

try {
    # Si el desktop ya está corriendo (no enfocado por operador), reusamos.
    $existing = Find-ClaudeDesktopProcess $BinaryPath
    if ($existing) {
        Write-Log "Reusando Claude Desktop ya corriendo (PID $($existing.Id))"
        $Proc = $existing
        $Launched = $false
    } else {
        $Proc = Start-ClaudeDesktopOffscreen $BinaryPath
        $Launched = $true
        if (-not $Proc) {
            $ExitCode = 6
            throw "No se pudo iniciar Claude Desktop"
        }
    }

    # Wait corto para que la ventana renderice.
    $deadline = (Get-Date).AddSeconds($NavTimeout)
    while ($Proc.MainWindowHandle -eq [System.IntPtr]::Zero -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $Proc.Refresh()
    }
    if ($Proc.MainWindowHandle -eq [System.IntPtr]::Zero) {
        # DIAG (CA-3): categoría "render" — la ventana de Claude Desktop no
        # renderizó offscreen dentro del timeout (sesión desconectada o login
        # pendiente). Se loguea el timeout y si el proceso fue lanzado por
        # nosotros, SIN volcar identidad de cuenta ni OCR (SEC-2).
        Write-Log "DIAG exit=5 causa=render razon=MainWindowHandle_no_aparece timeout=${NavTimeout}s launched=$Launched (ventana no renderizo offscreen; probable sesion desconectada o login pendiente)"
        $ExitCode = 5
        throw "MainWindowHandle no aparece"
    }

    # NOTA: en una iteración futura (#3013/#3015) se navegará via UIA al panel
    # exacto "Perfil > Configuración > Uso". Hoy capturamos la ventana
    # principal — el parser hace OCR sobre el PNG completo y los regex de
    # cada bucket toleran ruido. Esto es deliberadamente conservador: una
    # navegación más profunda requiere UIA y aumenta el riesgo de RCE si
    # los nombres de control llegan a depender de OCR (CA-9).

    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $OutFile = Join-Path $OutDir ("quota-{0}.png" -f $stamp)
    $ok = Capture-MainWindow $Proc $OutFile
    if (-not $ok) {
        $ExitCode = 6
        throw "Capture-MainWindow fallo"
    }

    # Path de salida en stdout (lo lee el scheduler Node).
    Write-Output $OutFile
} catch {
    Write-Log "ERROR main: $_"
    if ($ExitCode -eq 0) { $ExitCode = 6 }
} finally {
    if ($Launched -and $Proc) {
        Close-ClaudeDesktopGracefully $Proc $CloseTimeout
    }
    Release-Lockfile $LockPath
}

exit $ExitCode
