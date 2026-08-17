# Watchdog V2 — Vigila servicios del pipeline
# Se ejecuta cada 2 minutos via Windows Task Scheduler
# Todo corre desde platform/ (repo principal, siempre en main)
#
# Fuente de verdad: el SO (Get-CimInstance Win32_Process filtrando por
# CommandLine). NO leemos archivos .pid — pueden estar desincronizados de
# la realidad (proceso muerto pero archivo intacto, o viceversa).
# Eso provocaba re-spawns mientras un restart estaba en curso → EADDRINUSE
# en el puerto 3200.

$RepoRoot = 'C:\Workspaces\Intrale\platform'
$PipelineDir = "$RepoRoot\.pipeline"
$LogDir = "$PipelineDir\logs"
$LogFile = "$LogDir\watchdog.log"
# #4077 — Heartbeat propio del watchdog. Lo lee el supervisor externo
# (watchdog-supervisor.ps1) para detectar si el watchdog dejó de correr.
$HeartbeatFile = "$LogDir\watchdog.heartbeat"

if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

function Write-Log($Message) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] $Message" | Out-File -Append -FilePath $LogFile -Encoding utf8
}

# #4077 (SEC-1) — Heartbeat atómico. Contiene el PID del proceso powershell que
# ejecuta ESTE ciclo + timestamp ISO8601, para que el supervisor pueda cruzar
# contra el SO (no decidir sólo por mtime/contenido). Escritura tmp +
# Move-Item -Force: el supervisor nunca lee un archivo a medio escribir.
function Write-Heartbeat {
    try {
        $payload = @{ pid = $PID; ts = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
        $tmp = "$HeartbeatFile.tmp"
        $payload | Out-File -FilePath $tmp -Encoding utf8 -NoNewline
        Move-Item -Path $tmp -Destination $HeartbeatFile -Force
    } catch {
        Write-Log "WARN no se pudo escribir heartbeat: $_"
    }
}

# Emitir el heartbeat lo antes posible: es señal de "el watchdog corrió este
# ciclo", no de "actué". Se escribe incluso en ciclos de stand-by (restart
# reciente) y antes del scan de servicios, de modo que un fallo posterior de
# Get-CimInstance no suprima la señal de vida.
Write-Heartbeat

# Si hay un restart en curso (lock o last-restart.json muy reciente), no
# tocar nada — el restart mata todo y relanza, y un spawn nuestro acá
# genera la carrera "watchdog respawnea el mismo puerto que restart va a usar".
$LastRestartFile = "$PipelineDir\last-restart.json"
if (Test-Path $LastRestartFile) {
    $mtime = (Get-Item $LastRestartFile).LastWriteTime
    $ageSeconds = (Get-Date) - $mtime
    if ($ageSeconds.TotalSeconds -lt 90) {
        Write-Log "Restart reciente ($([int]$ageSeconds.TotalSeconds)s) — watchdog en stand-by"
        exit 0
    }
}

# Servicios críticos: nombre del componente → script file que lo identifica
# en la command line del proceso node.exe.
$Services = @(
    @{ Name = 'pulpo';         Script = 'pulpo.js' },
    @{ Name = 'listener';      Script = 'listener-telegram.js' },
    @{ Name = 'svc-telegram';  Script = 'servicio-telegram.js' },
    @{ Name = 'svc-github';    Script = 'servicio-github.js' },
    @{ Name = 'svc-drive';     Script = 'servicio-drive.js' },
    @{ Name = 'dashboard';     Script = 'dashboard.js' }
)

# #5646 (CA-4) — Registro CANONICO de componentes: union de `restart.js:COMPONENTS`
# (8, con dashboard, sin outbox-drain) y `dashboard.js:COMPONENTS` (8, con
# outbox-drain, sin dashboard) = 9. Es el unico mapa nombre -> script que este
# ejecutor acepta (allowlist estatica, REQ-SEC-5646-2): ningun nombre que venga
# del JSON del helper se usa si no esta aca.
# Se declara ANTES del loop de servicios caidos porque tambien lo consume el
# restart selectivo del final. Hay un test que lo compara contra las dos listas
# de Node y falla si divergen (`lib/stale-services.test.js`).
$ScriptMap = @{
    'pulpo'          = 'pulpo.js'
    'listener'       = 'listener-telegram.js'
    'svc-telegram'   = 'servicio-telegram.js'
    'svc-github'     = 'servicio-github.js'
    'svc-drive'      = 'servicio-drive.js'
    'svc-emulador'   = 'servicio-emulador.js'
    'svc-reconciler' = 'servicio-reconciler.js'
    'outbox-drain'   = 'outbox-drain.js'
    'dashboard'      = 'dashboard.js'
}

# #5646 — Helper compartido y guard anti crash-loop del restart selectivo.
$StaleHelper = "$PipelineDir\lib\stale-services.js"
$StaleGuardFile = "$PipelineDir\last-selective-restart.json"
# Ventana del guard: mismo molde que `last-restart.json` (90s). Como el watchdog
# corre cada 2 min, permite a lo sumo una ronda de restart selectivo por ciclo.
$StaleGuardWindowSeconds = 90
# Cota de componentes por ronda: casi todo merge del pipeline toca
# `.pipeline/lib/**`, asi que la regla conservadora marca casi todo. Espaciar el
# relanzamiento en varias rondas evita la tormenta (CA-6). Lo que no entra en
# esta ronda sigue pendiente en disco y lo toma el ciclo siguiente.
$StaleMaxPerRound = 4

# Un único scan del SO, reutilizado para todos los componentes.
try {
    $allNodeProcs = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
} catch {
    Write-Log "ERROR al listar procesos node.exe: $_"
    exit 1
}

function Test-ServiceAlive($Script) {
    foreach ($p in $allNodeProcs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$Script*") {
            # Validar que el proceso siga vivo (Win32_Process puede tener entradas stale
            # dentro de la misma ventana de query, aunque raro).
            try {
                $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') { return $true }
            } catch {}
        }
    }
    return $false
}

# #4154 — Devuelve el ProcessId del proceso node que corre $Script, o $null.
# Reusa el mismo scan SO ($allNodeProcs) que Test-ServiceAlive. Es la única
# fuente de verdad del PID a matar (SEC-1: nunca matamos por el PID del JSON).
function Get-ServicePid($Script) {
    foreach ($p in $allNodeProcs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$Script*") {
            try {
                $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') { return [int]$p.ProcessId }
            } catch {}
        }
    }
    return $null
}

# #5646 — HEAD actual del repo principal, validado como hex 7-40. Devuelve ''
# si git no responde o la salida no es un SHA. Se captura ANTES de cada
# `reset --hard` para saber contra que comparar el diff.
function Get-RepoHead {
    try {
        $out = & git -C $RepoRoot rev-parse HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return '' }
        $sha = ([string]$out).Trim()
        if ($sha -match '^[0-9a-f]{7,40}$') { return $sha }
    } catch {}
    return ''
}

# #5646 (CA-3) — Tras un `reset --hard`, MARCA que servicios vivos quedaron con
# codigo viejo. No reinicia nada aca: marcar y ejecutar son pasos separados, y el
# ejecutor unico es el loop del final de este mismo script.
#
# Frontera Node -> PowerShell (REQ-SEC-5646-3): el helper devuelve JSON valido en
# stdout con exit 0, o stdout vacio con exit != 0. Se parsea con ConvertFrom-Json,
# NUNCA con Invoke-Expression, y nada del JSON se interpola en una command line.
function Invoke-StaleMark($PrevSha) {
    if (-not (Test-Path $StaleHelper)) { return }
    if (-not $PrevSha) {
        # Sin referencia previa confiable no marcamos: el mismo git que fallo al
        # resolver HEAD es el que tendria que haber hecho el reset. Queda
        # registrado para que el operador lo vea (nunca silencioso).
        Write-Log "  restart selectivo: no se pudo leer el HEAD previo al reset — no se marco nada"
        return
    }
    try {
        $env:NODE_PATH = "$RepoRoot\node_modules"
        $raw = & node $StaleHelper --mark --prev $PrevSha 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) {
            Write-Log "  restart selectivo: el marcador no devolvio datos, skip"
            return
        }
        $parsed = $raw | ConvertFrom-Json
        if (-not $parsed) { return }
        $marcados = @($parsed.marked)
        if ($marcados.Count -eq 0) {
            # CA-2 / UX G-1: el caso "no afecto a nadie" tambien deja una linea.
            # Sin ella, un log silencioso es indistinguible de un watchdog que no corrio.
            Write-Log "  restart selectivo: sin componentes afectados por el reset"
            return
        }
        foreach ($r in @($parsed.reasons)) {
            if (-not $r) { continue }
            if ($marcados -notcontains $r.component) { continue }
            Write-Log ("  restart selectivo: " + $r.component + " quedo con codigo viejo - cambio en " + $r.path)
        }
    } catch {
        Write-Log "  restart selectivo: ERROR al marcar - $_"
    }
}

# #5646 (CA-5) — Baja UN componente del registro de pendientes. Se invoca SOLO
# tras spawn CONFIRMADO: si el relanzamiento fallo, el componente sigue pendiente
# el ciclo siguiente en vez de desaparecer en silencio (fail-open de REQ-SEC-5646-7).
function Invoke-StaleClear($Name) {
    if (-not (Test-Path $StaleHelper)) { return }
    if (-not $ScriptMap.ContainsKey($Name)) { return }
    try {
        $env:NODE_PATH = "$RepoRoot\node_modules"
        & node $StaleHelper --clear $Name 2>$null | Out-Null
    } catch {
        Write-Log "  restart selectivo: no se pudo limpiar el pendiente de $Name - $_"
    }
}

# #4154 — Liveness real del Pulpo (detección de zombi).
# El chequeo de existencia de proceso (Test-ServiceAlive) da por sano a un Pulpo
# zombi: proceso vivo pero loop colgado. Acá, SÓLO para el pulpo y SÓLO si su
# proceso existe, validamos que su heartbeat (last-tick.json) sea reciente.
# La decisión vive en Node (lib/pulpo-liveness.js, testeado); PowerShell sólo
# recolecta hechos del SO y, si Node devuelve kill-respawn, mata el PID del scan
# SO (no el del JSON) y respawnea. Va DESPUÉS del guard de last-restart (CA-3.2).
function Invoke-PulpoLivenessCheck {
    $soPid = Get-ServicePid 'pulpo.js'
    if (-not $soPid) {
        # Proceso ausente: lo cubre el path normal de spawn más abajo. No es zombi.
        return
    }

    $tickFile = "$PipelineDir\last-tick.json"
    $hbExists = '0'
    $hbAgeMs = ''
    $hbContent = ''
    if (Test-Path $tickFile) {
        $hbExists = '1'
        try {
            $age = (Get-Date) - (Get-Item $tickFile).LastWriteTime
            $hbAgeMs = [string][int]$age.TotalMilliseconds
        } catch {}
        try {
            # Contenido crudo: el runner Node lo parsea defensivo (SEC-2) y sólo
            # usa el pid como cross-check contra $soPid. Nunca derivamos kill de acá.
            $hbContent = Get-Content -Path $tickFile -Raw -ErrorAction Stop
        } catch {}
    }

    # #5821 CA-4 — Senal secundaria de progreso: el Pulpo toca `last-progress`
    # DURANTE la iteracion, no solo al cerrarla. Su mtime distingue un ciclo
    # lento (heartbeat viejo + progreso fresco) de un cuelgue real (ambos
    # viejos). Solo se recolecta el mtime: el contenido nunca se lee ni se pasa.
    # Si el archivo no existe (Pulpo viejo, sin la instrumentacion), se manda ''
    # y el runner decide por umbral — la senal ausente NUNCA inhibe un kill.
    $progressAgeMs = ''
    $progressFile = "$PipelineDir\last-progress"
    if (Test-Path $progressFile) {
        try {
            $pAge = (Get-Date) - (Get-Item $progressFile).LastWriteTime
            $progressAgeMs = [string][int]$pAge.TotalMilliseconds
        } catch {}
    }

    $runner = "$PipelineDir\pulpo-liveness-run.js"
    if (-not (Test-Path $runner)) { return }

    $env:NODE_PATH = "$RepoRoot\node_modules"
    $env:PLV_HB_EXISTS = $hbExists
    $env:PLV_HB_AGE_MS = $hbAgeMs
    $env:PLV_HB_CONTENT = $hbContent
    $env:PLV_SO_PID = [string]$soPid
    $env:PLV_PROGRESS_AGE_MS = $progressAgeMs

    $action = ''
    try {
        $out = & node $runner 2>$null
        if ($out) { $action = ($out | Select-String -Pattern '^ACTION:(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1) }
    } catch {
        Write-Log "  pulpo-liveness : ERROR ejecutando runner - $_"
        return
    } finally {
        Remove-Item Env:\PLV_HB_EXISTS, Env:\PLV_HB_AGE_MS, Env:\PLV_HB_CONTENT, Env:\PLV_SO_PID, Env:\PLV_PROGRESS_AGE_MS -ErrorAction SilentlyContinue
    }

    # #5821 CA-7 — Freno anti-bucle. El runner ya alcanzo el cap de reinicios en
    # la ventana y escalo a needs-human (alerta por Telegram). NO se reinicia
    # otra vez: en el incidente del 2026-08-11 hubo 77 kills en 3 horas, y si
    # matar N veces no arreglo nada la N+1 tampoco lo va a hacer.
    if ($action -eq 'escalate') {
        Write-Log "  pulpo-liveness : cap de reinicios alcanzado — escalado a needs-human, NO se reinicia (ver logs\pulpo-liveness.log)"
        return
    }

    if ($action -ne 'kill-respawn') {
        # 'skip' (sano / sin heartbeat / discrepancia de PID / ciclo lento): no tocar nada.
        return
    }

    # Zombi confirmado: matar SOLO el PID del scan SO (SEC-1) y respawnear.
    # CA-3.3: auditar el kill-zombi con (ts implícito del log, pid, lag).
    Write-Log "  pulpo-liveness : ZOMBI detectado (pid $soPid, lag ${hbAgeMs}ms > umbral) — matando y respawneando"
    try {
        Stop-Process -Id $soPid -Force -ErrorAction Stop
        Write-Log "  pulpo-liveness : proceso zombi $soPid terminado"
    } catch {
        # #5821 (rebote rev-1) — El kill FALLO (p. ej. "Acceso denegado", que en
        # este host pasa seguido). Se sale SIN contabilizarlo: el cap de
        # reinicios cuenta terminaciones efectivas, no intentos. Contar este
        # intento agotaria el cap contra un Pulpo que sigue vivo y colgado, y
        # dejaria al watchdog sin siquiera intentar matarlo por el resto de la
        # ventana — peor que no tener cap.
        Write-Log "  pulpo-liveness : ERROR al matar pid $soPid - $_ (NO se contabiliza contra el cap)"
        return
    }

    # #5821 (rebote rev-1) — Terminacion CONFIRMADA por el SO: recien ahora se
    # contabiliza contra el cap de la ventana. Fail-soft: si esto falla, el
    # respawn de abajo igual sigue.
    try {
        $env:PLV_CONFIRM_KILL = '1'
        & node $runner 2>&1 | Out-Null
    } catch {
        Write-Log "  pulpo-liveness : WARN no se pudo contabilizar el kill confirmado - $_"
    } finally {
        Remove-Item Env:\PLV_CONFIRM_KILL -ErrorAction SilentlyContinue
    }

    # Sincronizar con main antes de relanzar (scripts actualizados), igual que
    # el path de proceso ausente.
    # #5646 — El reset actualiza el codigo EN DISCO de TODOS los servicios, pero
    # aca solo se respawnea el pulpo: los demas siguen vivos con el codigo viejo
    # en su require-cache. Capturamos el HEAD previo para poder marcarlos.
    $prevHead = Get-RepoHead
    try {
        git -C $RepoRoot fetch origin main 2>$null
        git -C $RepoRoot reset --hard FETCH_HEAD 2>$null
    } catch {}
    Invoke-StaleMark $prevHead

    $env:NODE_PATH = "$RepoRoot\node_modules"
    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList @("$PipelineDir\pulpo.js") -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
        Write-Log "  pulpo-liveness : pulpo respawneado PID $($proc.Id)"
        # El pulpo acaba de arrancar con el codigo de disco: ya no tiene codigo
        # viejo, aunque el reset de recien lo hubiera marcado.
        Invoke-StaleClear 'pulpo'
    } catch {
        Write-Log "  pulpo-liveness : ERROR al respawnear pulpo - $($_.Exception.Message)"
    }
}

Invoke-PulpoLivenessCheck

$dead = @()
foreach ($svc in $Services) {
    if (-not (Test-ServiceAlive $svc.Script)) {
        $dead += $svc.Name
    }
}

$NodeModules = "$RepoRoot\node_modules"
$env:NODE_PATH = $NodeModules

if ($dead.Count -gt 0) {
    $deadList = $dead -join ', '
    Write-Log "Servicios caidos detectados: $deadList"

    # Sincronizar con main antes de levantar (para tener scripts actualizados)
    # #5646 — Este reset tambien avanza el codigo de los servicios que estan
    # VIVOS y que este loop no toca: quedan con el codigo viejo en memoria. Por
    # eso capturamos el HEAD previo y marcamos los afectados; el relanzamiento
    # real lo hace el bloque de restart selectivo del final.
    $prevHeadDead = Get-RepoHead
    try {
        git -C $RepoRoot fetch origin main 2>$null
        git -C $RepoRoot reset --hard FETCH_HEAD 2>$null
    } catch {}
    Invoke-StaleMark $prevHeadDead

    foreach ($svcName in $dead) {
        $script = $ScriptMap[$svcName]
        if (-not $script) { continue }
        $scriptPath = "$PipelineDir\$script"
        if (-not (Test-Path $scriptPath)) {
            Write-Log "  $svcName : script no encontrado ($scriptPath)"
            continue
        }

        # Double-check justo antes de spawnear: el primer scan podria ser stale
        # de 1-2s y el servicio puede haber arrancado en ese interin (por ejemplo,
        # restart.js que largo los procesos entre que hicimos el scan y ahora).
        if (Test-ServiceAlive $script) {
            Write-Log "  $svcName : ya arranco entre el scan y el spawn, skip"
            continue
        }

        try {
            $proc = Start-Process -FilePath 'node' -ArgumentList @($scriptPath) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
            Write-Log ("  " + $svcName + " : levantado PID " + $proc.Id)
            # Arranco con el codigo de disco: si estaba marcado, ya no aplica.
            Invoke-StaleClear $svcName
        } catch {
            $errMsg = $_.Exception.Message
            Write-Log ("  " + $svcName + " : ERROR al levantar - " + $errMsg)
        }
    }
}

# =============================================================================
# #5646 — RESTART SELECTIVO de servicios con codigo viejo.
# -----------------------------------------------------------------------------
# Este bloque es el UNICO EJECUTOR del restart de servicios stale (REQ-SEC-5646-5):
# el dashboard no puede matarse a si mismo y no queremos inventar un relanzador
# generico que acepte paths o command lines. Corre SIEMPRE (haya o no servicios
# caidos) porque el pendiente pudo haberlo dejado marcado `restart.js` o el
# endpoint `/api/ops/restart-operativo`, no solo este script.
#
# Precondiciones ya garantizadas arriba: el guard de `last-restart.json` (90s)
# corta el script antes de llegar aca si hay un restart.js en curso.
# =============================================================================
function Get-FreshServicePid($Script) {
    try {
        $procs = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    } catch {
        return $null
    }
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like "*$Script*") {
            try {
                $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') { return [int]$p.ProcessId }
            } catch {}
        }
    }
    return $null
}

function Invoke-StaleRestarts {
    if (-not (Test-Path $StaleHelper)) { return }

    # Cota anti crash-loop (CA-6): molde del guard de `last-restart.json`.
    if (Test-Path $StaleGuardFile) {
        try {
            $age = (Get-Date) - (Get-Item $StaleGuardFile).LastWriteTime
            if ($age.TotalSeconds -lt $StaleGuardWindowSeconds) {
                Write-Log "  restart selectivo: ronda reciente ($([int]$age.TotalSeconds)s) — en stand-by"
                return
            }
        } catch {}
    }

    $pendientes = @()
    $motivos = @{}
    try {
        $env:NODE_PATH = "$RepoRoot\node_modules"
        $raw = & node $StaleHelper --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) {
            Write-Log "  restart selectivo: sin datos del marcador, skip"
            return
        }
        # Parseo declarativo: nada del JSON se evalua como codigo ni se
        # interpola en una command line (ver contrato al inicio del archivo).
        $parsed = $raw | ConvertFrom-Json
        if (-not $parsed) { return }
        $pendientes = @($parsed.components)
        foreach ($r in @($parsed.reasons)) {
            if ($r -and $r.component) { $motivos[[string]$r.component] = [string]$r.path }
        }
    } catch {
        Write-Log "  restart selectivo: ERROR al leer pendientes - $_"
        return
    }

    if ($pendientes.Count -eq 0) { return }

    $hechos = 0
    foreach ($name in $pendientes) {
        if ($hechos -ge $StaleMaxPerRound) {
            Write-Log "  restart selectivo: cota de $StaleMaxPerRound por ronda alcanzada — el resto sigue pendiente"
            break
        }
        # Allowlist estatica: un nombre que no este en el mapa NO se ejecuta
        # (REQ-SEC-5646-2/3). El script a spawnear sale SIEMPRE de aca, jamas
        # del JSON ni del diff.
        if (-not $ScriptMap.ContainsKey($name)) {
            Write-Log "  restart selectivo: '$name' fuera de la allowlist, descartado"
            continue
        }
        $script = $ScriptMap[$name]
        $scriptPath = "$PipelineDir\$script"
        if (-not (Test-Path $scriptPath)) {
            Write-Log "  restart selectivo: $name — script no encontrado, sigue pendiente"
            continue
        }

        $motivo = $motivos[[string]$name]
        if (-not $motivo) { $motivo = '(sin path)' }

        # 1. Matar la instancia vieja (PID del scan del SO, nunca de un archivo).
        #    Si el componente NO esta corriendo, no hay nada stale: un proceso
        #    que no existe no tiene codigo viejo en memoria, y cuando arranque
        #    va a leer el disco actual. Se baja el pendiente y NO se spawnea:
        #    levantar un servicio que estaba deliberadamente apagado no es
        #    trabajo de este bloque (de eso se ocupa el loop de caidos, con su
        #    propia lista de servicios criticos).
        $viejoPid = Get-FreshServicePid $script
        if (-not $viejoPid) {
            Write-Log "  restart selectivo: $name no esta corriendo — nada que reiniciar, pendiente dado de baja"
            Invoke-StaleClear $name
            continue
        }
        try {
            Stop-Process -Id $viejoPid -Force -ErrorAction Stop
            try { Wait-Process -Id $viejoPid -Timeout 10 -ErrorAction SilentlyContinue } catch {}
        } catch {
            Write-Log "  restart selectivo: $name — no se pudo terminar el PID $viejoPid, sigue pendiente"
            continue
        }
        # Dar aire a que el SO libere puerto/handles antes de relanzar.
        Start-Sleep -Milliseconds 1500

        # 2. Double-check pre-spawn (molde de la linea del loop de caidos): si
        #    quedo o volvio a arrancar una instancia, NO spawneamos una segunda.
        if (Get-FreshServicePid $script) {
            Write-Log "  restart selectivo: $name — sigue habiendo una instancia viva, no se spawnea otra"
            continue
        }

        # 3. Relanzar con el contrato de spawn existente.
        try {
            $proc = Start-Process -FilePath 'node' -ArgumentList @($scriptPath) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
            Write-Log ("restart selectivo: " + $name + " reiniciado — cambio en " + $motivo + " (PID " + $proc.Id + ")")
            $hechos++
            # 4. Recien con el spawn CONFIRMADO se baja el pendiente (CA-5).
            Invoke-StaleClear $name
        } catch {
            Write-Log ("  restart selectivo: " + $name + " — ERROR al relanzar, sigue pendiente - " + $_.Exception.Message)
        }
    }

    if ($hechos -gt 0) {
        try {
            $g = @{ ts = (Get-Date).ToString('o'); count = $hechos } | ConvertTo-Json -Compress
            $tmp = "$StaleGuardFile.tmp"
            $g | Out-File -FilePath $tmp -Encoding utf8 -NoNewline
            Move-Item -Path $tmp -Destination $StaleGuardFile -Force
        } catch {
            Write-Log "  restart selectivo: WARN no se pudo escribir el guard de ronda: $_"
        }
    }
}

Invoke-StaleRestarts
