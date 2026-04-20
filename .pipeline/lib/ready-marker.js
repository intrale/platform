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

function ensureDir() {
  if (!fs.existsSync(READY_DIR)) fs.mkdirSync(READY_DIR, { recursive: true });
}

function markerPath(name) {
  return path.join(READY_DIR, `${name}.ready`);
}

// Llamado desde cada componente cuando completó init.
// `name` debe coincidir con el name usado en restart.js COMPONENTS.
function signalReady(name, meta = {}) {
  try {
    ensureDir();
    const data = {
      name,
      pid: process.pid,
      startedAt: process.env.__INTRALE_PROCESS_START || new Date().toISOString(),
      readyAt: new Date().toISOString(),
      meta,
    };
    fs.writeFileSync(markerPath(name), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
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

// Estado por componente: ready/booting/stale/missing.
//   ready    → marker existe y PID está vivo
//   stale    → marker existe pero el PID murió (crash o no-arrancó)
//   missing  → no hay marker (aún no señalizó ready)
function componentState(name) {
  const m = readMarker(name);
  if (!m) return { state: 'missing', marker: null };
  if (!pidAlive(m.pid)) return { state: 'stale', marker: m };
  return { state: 'ready', marker: m };
}

// Polling helper: espera hasta que todos los componentes estén ready,
// o hasta que se agote el timeout. Retorna detalle por componente.
// Si `timeoutMs` se agota con alguno aún en `missing`, ese se reporta
// como tal (no como fail duro) — el caller decide qué hacer.
async function waitForMarkers(names, timeoutMs = 60000, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = {};
    let allReady = true;
    for (const name of names) {
      const st = componentState(name);
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
  readMarker,
  clearAllMarkers,
  clearMarker,
  componentState,
  waitForMarkers,
  pidAlive,
  READY_DIR,
};
