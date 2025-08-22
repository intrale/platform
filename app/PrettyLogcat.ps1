<#---------------------------------------------------------------------------
 PrettyLogcat.ps1 — Logcat lindo en Windows/PowerShell (con colores)

 ✔ Filtra por tu app (package) + muestra AndroidRuntime (E/F) de cualquier proceso
 ✔ Colores por nivel y sangrado de continuaciones (stacktraces)
 ✔ Lanza la app si no está corriendo (adb shell monkey)
 ✔ -MinLevel para subir el piso (p.ej. I = muestra I/W/E/F)
 ✔ **Oculta por defecto tags ruidosas del emulador/sistema** en niveles V/D/I
    (se siguen mostrando si son W/E/F)

 NOISY TAGS (ocultas por defecto en V/D/I; patrones con comodín *):
   EGL_emulation, OpenGLRenderer*, Choreographer*, HostConnection*,
   Gralloc*, Adreno*, libEGL*, libGLES*, RenderThread*, BLASTBufferQueue*,
   BufferQueue*, Surface*, ViewRootImpl*, Layer*, HwBlobCache*, HwBinder*

 ▶ Cómo verlas igualmente:
    - Usar `-ShowNoisy` para ignorar el ocultamiento
    - O subir el mínimo: `-MinLevel I` (oculta D/V de todo)
 ▶ Cómo agregar más:
    - `-ExtraHiddenTags "MyTag*","OtroTag"`

 USO
   .\PrettyLogcat.ps1                          # usa ar.com.intrale, oculta noisy V/D/I
   .\PrettyLogcat.ps1 -MinLevel I              # menos ruido (sigue ocultando noisy V/D/I)
   .\PrettyLogcat.ps1 -ShowNoisy               # muestra también las noisy
   .\PrettyLogcat.ps1 -ExtraHiddenTags "Foo*","Bar"
   .\PrettyLogcat.ps1 -Package ar.com.otraapp  # otro package

 TIP acentos:
   chcp 65001 | Out-Null
---------------------------------------------------------------------------#>

[CmdletBinding()]
param(
  [string]$Package = "ar.com.intrale",
  [ValidateSet('V','D','I','W','E','F')]
  [string]$MinLevel = 'V',
  [switch]$ShowNoisy,
  [string[]]$ExtraHiddenTags = @()
)

# --- Config ---
$LevelRank = @{ V=0; D=1; I=2; W=3; E=4; F=5 }
$DefaultHiddenPatterns = @(
  'EGL_emulation',
  'OpenGLRenderer*','Choreographer*','HostConnection*',
  'Gralloc*','Adreno*',
  'libEGL*','libGLES*',
  'RenderThread*','BLASTBufferQueue*','BufferQueue*','Surface*','ViewRootImpl*','Layer*',
  'HwBlobCache*','HwBinder*'
)
$HiddenPatterns = $DefaultHiddenPatterns + $ExtraHiddenTags

# --- Utils ---
function Get-AppPids([string]$pkg) {
  $raw = (& adb shell "pidof $pkg") 2>$null | Out-String
  if ($raw) {
    $raw = $raw.Trim()
    if ($raw.Length -gt 0) { return ($raw -split '\s+') }
  }
  $lines = (& adb shell "ps -A | grep $pkg") 2>$null | Out-String
  if ($lines) {
    $pids = @()
    foreach ($ln in ($lines -split "`n")) {
      if (-not $ln.Trim()) { continue }
      $parts = $ln -split '\s+'
      $pid = $parts | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
      if ($pid) { $pids += $pid }
    }
    if ($pids.Count -gt 0) { return $pids | Select-Object -Unique }
  }
  return @()
}

function Ensure-AppRunning([string]$pkg) {
  $p = Get-AppPids $pkg
  if ($p.Count -gt 0) { return $p }
  Write-Host "No se encontraron PIDs. Intentando lanzar $pkg..." -ForegroundColor Yellow
  & adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 > $null 2>&1
  Start-Sleep -Seconds 2
  return (Get-AppPids $pkg)
}

function LevelColor([string]$lvl) {
  switch ($lvl) {
    'V' { 'DarkGray' }
    'D' { 'Cyan' }
    'I' { 'Green' }
    'W' { 'Yellow' }
    'E' { 'Red' }
    'F' { 'Magenta' }
    default { 'White' }
  }
}

function IsNoisyTag([string]$tag, [string[]]$patterns) {
  foreach ($pat in $patterns) {
    if ($tag -like $pat) { return $true }
  }
  return $false
}

# --- Main ---
$pids = Ensure-AppRunning $Package
if (-not $pids -or $pids.Count -eq 0) {
  Write-Host "No se encontró PID para $Package. ¿Está instalada y abierta?" -ForegroundColor Yellow
  Write-Host "Abrí la app y volvé a ejecutar el script." -ForegroundColor Yellow
  exit 1
}

Write-Host ("Mostrando logs de {0} (PIDs: {1}) + AndroidRuntime:E/F (cualquier proceso). MinLevel={2}" -f $Package, ($pids -join ', '), $MinLevel) -ForegroundColor Cyan
Write-Host "Ctrl+C para salir.`n" -ForegroundColor Cyan

$pattern = '^(?<date>\d{2}-\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}\.\d{3})\s+(?<ppid>\d+)\s+(?<tid>\d+)\s+(?<lvl>[VDIWEF])\s+(?<tag>[^\s:]+):\s?(?<msg>.*)$'
$showContinuation = $false
$minRank = $LevelRank[$MinLevel]

& adb logcat -v threadtime | ForEach-Object {
  $line = $_
  if ($line -match $pattern) {
    $m = @{} + $Matches
    $isMine     = $pids -contains $m.ppid
    $isARCrash  = ($m.tag -eq 'AndroidRuntime') -and ($m.lvl -in @('E','F'))
    $passesLvl  = ($LevelRank[$m.lvl] -ge $minRank)
    $isNoisy    = IsNoisyTag $m.tag $HiddenPatterns

    # Mostrar:
    #  - Mi app y pasa nivel mínimo
    #  - O AndroidRuntime E/F
    $show = (($isMine -and $passesLvl) -or $isARCrash)

    # Ocultar noisy solo si es V/D/I y no se pidió mostrarlas
    if (-not $ShowNoisy -and $isNoisy -and ($LevelRank[$m.lvl] -le $LevelRank['I'])) {
      $show = $false
    }

    $showContinuation = $show
    if ($show) {
      $txt = "{0} {1} {2,5}/{3,-5} {4} {5,-24} {6}" -f $m.date, $m.time, $m.ppid, $m.tid, $m.lvl, $m.tag, $m.msg
      Write-Host $txt -ForegroundColor (LevelColor $m.lvl)
    }
  }
  elseif ($showContinuation) {
    Write-Host (" " * 48 + $line) -ForegroundColor DarkGray
  }
}
