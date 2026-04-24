// ready-marker.js — marcadores de "componente listo"
//
// Diseño: cada componente del pipeline (pulpo, dashboard, listener,
// servicios) escribe un archivo `.ready` cuando termina su fase de
// inicialización y entra en loop principal. El smoke-test y el restart
// leen esos marcadores en vez de escanear el SO con wmic.
//
// Ventajas vs. el modelo anterior (scan de OS + match por commandLine):
//   - No depende de wmic (quoting frágil en cmd.exe/bash).
//   - Cada componente declara explícitamente su estado "ready" desde
//     adentro, no se infiere desde afuera.
//   - Distingue "arrancando" (sin marker) de "vivo" (marker + pid alive).
//   - El marker incluye pid, timestamp y metadata útil para debugging.
//
// Estructura de un marker:
//   .pipeline/ready/<name>.ready → JSON
//     { name, pid, startedAt, readyAt, meta }

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const READY_DIR = path.join(PIPELINE_DIR, 'ready');

// Intervalo de re-escritura del marker (heartbeat). 30s da 4x margen frente
// al umbral de staleness del smoke-test (120s) sin ser agresivo con el FS.
// Se puede override con PIPELINE_HEARTBEAT_MS para tests.
const HEARTBEAT_MS = parseInt(process.env.PIPELINE_HEARTBEAT_MS || '30000', 10);

// Un marker se considera "stale por heartbeat" si su readyAt es más viejo
// que este umbral. 120s = 4x HEARTBEAT_MS por default — tolera un par de
// ciclos perdidos por GC / carga antes de levantar alarma.
const HEARTBEAT_STALE_MS = parseInt(process.env.PIPELINE_HEARTBEAT_STALE_MS || '120000', 10);

function ensureDir() {
  if (!fs.existsSync(READY_DIR)) fs.mkdirSync(READY_DIR, { recursive: true });
}

function markerPath(name) {
  return path.join(READY_DIR, `${name}.ready`);
}

// Escribe el marker con timestamp actual. Si `startedAt` no viene, se lee
// del marker previo (si existe) para mantener la marca original del boot;
// si no hay previo, se usa el tiempo actual como arranque.
function writeMarker(name, meta = {}, startedAtOverride = null) {
  ensureDir();
  const now = new Date().toISOString();
  let startedAt = startedAtOverride
    || process.env.__INTRALE_PROCESS_START
    || null;
  if (!startedAt) {
    // Preservar startedAt del marker previo si coincide el PID — así el
    // heartbeat no reescribe cada vez un startedAt nuevo.
    try {
      const prev = JSON.parse(fs.readFileSync(markerPath(name), 'utf8'));
      if (prev && prev.pid === process.pid && prev.startedAt) startedAt = prev.startedAt;
    } catch {}
  }
  if (!startedAt) startedAt = now;
  const data = {
    name,
    pid: process.pid,
    startedAt,
    readyAt: now,
    meta,
  };
  fs.writeFileSync(markerPath(name), JSON.stringify(data, null, 2));
  return data;
}

// Llamado desde cada componente cuando completó init.
// `name` debe coincidir con el name usado en restart.js COMPONENTS.
function signalReady(name, meta = {}) {
  try {
    writeMarker(name, meta);
    return true;
  } catch {
    return false;
  }
}

// Arranca un heartbeat que re-escribe el marker cada HEARTBEAT_MS para
// mantenerlo "fresh". Tiene dos objetivos (ver issue #2450):
//   1. Si el marker quedó huérfano (ej: restart manual, singleton-abort
//      de un respawn spurious, crash+restart del SO), la instancia viva
//      lo regenera sola en el próximo ciclo.
//   2. smoke-test puede chequear freshness del readyAt en lugar de solo
//      existencia — si un servicio está colgado sin procesar, su marker
//      envejece y el chequeo lo detecta.
//
// Retorna un handle con `stop()` para uso en tests. En producción se deja
// correr hasta que el proceso muere; el Timer no unref'ea para que el
// mainLoop siga con event loop activo (aunque los servicios ya tienen
// otros handles — esto es defensivo).
function startHeartbeat(name, meta = {}) {
  // Primera escritura inmediata (equivalente a signalReady).
  try { writeMarker(name, meta); } catch {}

  const timer = setInterval(() => {
    try { writeMarker(name, meta); } catch {}
  }, HEARTBEAT_MS);
  // unref: que el heartbeat no mantenga vivo el event loop por sí solo.
  // Los servicios ya tienen otros handles (listeners, intervals del mainLoop)
  // y no queremos que un servicio que terminó todo su trabajo quede colgado
  // por este timer.
  if (typeof timer.unref === 'function') timer.unref();

  // Limpieza: borrar marker al salir para que un restart inmediato no vea
  // un marker viejo de un PID que acaba de morir.
  const cleanup = () => {
    try { clearInterval(timer); } catch {}
    try { fs.unlinkSync(markerPath(name)); } catch {}
  };
  process.once('exit', cleanup);

  return {
    stop() {
      try { clearInterval(timer); } catch {}
      try { process.removeListener('exit', cleanup); } catch {}
    },
    refresh(newMeta) {
      try { writeMarker(name, newMeta || meta); } catch {}
    },
  };
}

// Lee marker si existe. Retorna null si no existe o es inválido.
function readMarker(name) {
  try {
    const raw = fs.readFileSync(markerPath(name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Verifica si un PID está vivo (portable).
function pidAlive(pid) {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Borra todos los markers. Llamado por restart.js antes del launchAll
// para evitar leer markers viejos del ciclo anterior.
function clearAllMarkers() {
  try {
    if (!fs.existsSync(READY_DIR)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(READY_DIR)) {
      if (f.endsWith('.ready')) {
        try { fs.unlinkSync(path.join(READY_DIR, f)); n++; } catch {}
      }
    }
    return n;
  } catch {
    return 0;
  }
}

// Borra el marker de un componente puntual.
function clearMarker(name) {
  try { fs.unlinkSync(markerPath(name)); return true; } catch { return false; }
}

// Estado por componente: ready/booting/stale/stale-heartbeat/missing.
//   ready           → marker existe, PID vivo, readyAt fresco
//   stale           → marker existe pero el PID murió (crash o no-arrancó)
//   stale-heartbeat → marker existe, PID vivo, pero readyAt está obsoleto
//                     (servicio colgado o sin heartbeat — ver issue #2450)
//   missing         → no hay marker (aún no señalizó ready)
//
// `now` es inyectable para tests. `staleMs` permite override del umbral
// por caller (ej: smoke-test en arranque lento podría dar más margen).
function componentState(name, opts = {}) {
  const now = opts.now || Date.now();
  const staleMs = opts.staleMs != null ? opts.staleMs : HEARTBEAT_STALE_MS;
  const m = readMarker(name);
  if (!m) return { state: 'missing', marker: null };
  if (!pidAlive(m.pid)) return { state: 'stale', marker: m };
  // Freshness del heartbeat. Si readyAt es inválido o viejo, marcar
  // stale-heartbeat. staleMs <= 0 desactiva el chequeo.
  if (staleMs > 0) {
    const readyMs = Date.parse(m.readyAt);
    if (!Number.isFinite(readyMs) || (now - readyMs) > staleMs) {
      return { state: 'stale-heartbeat', marker: m, ageMs: Number.isFinite(readyMs) ? now - readyMs : null };
    }
  }
  return { state: 'ready', marker: m };
}

// Polling helper: espera hasta que todos los componentes estén ready,
// o hasta que se agote el timeout. Retorna detalle por componente.
// Si `timeoutMs` se agota con alguno aún en `missing`, ese se reporta
// como tal (no como fail duro) — el caller decide qué hacer.
//
// `opts.staleMs` se pasa a componentState. Default: durante el bootstrap
// no queremos marcar stale-heartbeat (el servicio acaba de arrancar),
// así que el caller puede pasar `staleMs: 0` para deshabilitar el chequeo
// de freshness durante el wait inicial.
async function waitForMarkers(names, timeoutMs = 60000, pollMs = 1000, opts = {}) {
  const deadline = Date.now() + timeoutMs;
  const stateOpts = { staleMs: opts.staleMs };
  let last = {};
  while (Date.now() < deadline) {
    last = {};
    let allReady = true;
    for (const name of names) {
      const st = componentState(name, stateOpts);
      last[name] = st;
      if (st.state !== 'ready') allReady = false;
    }
    if (allReady) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()), results: last };
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { ok: false, waitedMs: timeoutMs, results: last };
}

module.exports = {
  signalReady,
  startHeartbeat,
  readMarker,
  clearAllMarkers,
  clearMarker,
  componentState,
  waitForMarkers,
  pidAlive,
  READY_DIR,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
};
