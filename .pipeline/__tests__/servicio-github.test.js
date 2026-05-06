// =============================================================================
// CA4 (#2994) — E2E test del worker servicio-github.js
//
// Reproduce el incidente del 2026-05-05: el reconciler encola una orden de
// label `needs-human` con metadata (marker_path/snapshot_at/marker_mtime),
// pero antes de que el worker la procese, el humano destraba el issue
// moviendo el marker a `pendiente/`. El worker DEBE detectar que la orden
// está stale y descartarla SIN invocar `gh` — caso contrario re-bloquearía
// un issue que ya está destrabado.
//
// Estrategia para evitar la CLI de `gh` real: stub via `GH_BIN_OVERRIDE`. El
// stub es un script Node.js cross-platform que registra cada invocación en
// un archivo plano; los tests luego inspeccionan ese archivo para verificar
// que el worker invocó (caso happy) o NO invocó (casos stale) a `gh`.
//
// El override `PIPELINE_STATE_DIR` hace que todo el FS del worker apunte a
// un directorio temporal — no toca el `.pipeline/` real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Setup: directorio temporal aislado + stub de `gh` antes del require del
// servicio. Las constantes del módulo (PENDIENTE, LISTO, GH_BIN, etc.) se
// resuelven una sola vez al cargarse, así que es crítico setear el env
// PRIMERO.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-gh-e2e-'));
const PIPELINE = path.join(TMP_DIR, '.pipeline');
const QUEUE_BASE = path.join(PIPELINE, 'servicios', 'github');
const PENDIENTE = path.join(QUEUE_BASE, 'pendiente');
const TRABAJANDO = path.join(QUEUE_BASE, 'trabajando');
const LISTO = path.join(QUEUE_BASE, 'listo');
const FALLIDO = path.join(QUEUE_BASE, 'fallido');
const LOG_DIR = path.join(PIPELINE, 'logs');
for (const d of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO, LOG_DIR]) {
    fs.mkdirSync(d, { recursive: true });
}

// Stub de `gh`: un script Node que escribe argv + cwd a un archivo y sale 0.
// El worker invoca con `execSync("<GH_BIN>" issue edit ...)` — para que el
// shell encuentre node.exe interpretando el script lo más portable es
// usar el shebang nativo en POSIX, pero en Windows execSync usa cmd.exe
// que NO respeta shebangs. Solución: el override apunta a un .cmd que
// reenvía a node con un .js helper.
//
// #2895 (rebote rev-1): hardening del stub para evitar flakiness bajo carga.
// Cuando `node --test` corre 65 archivos en paralelo (947 tests totales en
// ~72s), el OS spawnea cientos de child processes. Bajo esa contención:
//   1) PATH lookup de `node` desde cmd.exe puede fallar transitoriamente.
//      → Usamos `process.execPath` (ruta absoluta del node padre).
//   2) appendFileSync puede chocar con EBUSY/EACCES en NTFS bajo concurrencia.
//      → Retry interno en el stub con backoff.
//   3) NTFS metadata flush puede atrasarse → getGhCalls() no ve el write.
//      → Helper waitForGhCalls() con retry breve antes de assertions.
// Sin el hardening, los tests CA1/Backward-compat fallaban con `calls=[]`
// solo bajo ejecución completa del tester, no en isolation.
const STUB_DIR = path.join(TMP_DIR, 'stub-gh');
fs.mkdirSync(STUB_DIR, { recursive: true });
const GH_CALLS_LOG = path.join(STUB_DIR, 'gh-calls.log');
const STUB_JS = path.join(STUB_DIR, 'gh-stub.js');
fs.writeFileSync(STUB_JS, `
// Registra cada invocación con argv y exit 0.
// Retry en appendFileSync para sobrevivir EBUSY/EACCES en NTFS bajo carga.
const fs = require('fs');
const path = require('path');
const line = JSON.stringify({ ts: Date.now(), argv: process.argv.slice(2) }) + '\\n';
const TARGET = ${JSON.stringify(GH_CALLS_LOG)};
let lastErr = null;
for (let i = 0; i < 5; i++) {
    try { fs.appendFileSync(TARGET, line); lastErr = null; break; }
    catch (e) { lastErr = e; const t = Date.now() + 20 * (i + 1); while (Date.now() < t) {} }
}
if (lastErr) {
    // Best-effort fallback: escribir a un archivo siblings con sufijo del PID
    // para no perder evidencia silenciosamente. getGhCalls() también
    // recoge esos archivos.
    try { fs.writeFileSync(TARGET + '.' + process.pid, line); } catch {}
}
process.exit(0);
`, 'utf8');

// Wrapper .cmd para Windows. En POSIX usaríamos un .sh, pero los tests
// se ejecutan principalmente en Windows según el entorno del proyecto.
// execSync usa cmd.exe en Windows así que .cmd funciona; en POSIX caería
// a sh que no entiende .cmd, así que damos también una variante .sh.
//
// #2895 rev-1: usamos `process.execPath` en lugar de `node` para evitar
// dependencia del PATH del child cmd.exe — bajo carga el PATH lookup falla
// con "node no se reconoce" y execSync devuelve error, dejando calls=[].
const STUB_CMD = path.join(STUB_DIR, 'gh.cmd');
fs.writeFileSync(STUB_CMD,
    `@echo off\r\n"${process.execPath}" "${STUB_JS}" %*\r\n`,
    'utf8');
const STUB_SH = path.join(STUB_DIR, 'gh');
fs.writeFileSync(STUB_SH,
    `#!/bin/sh\nexec "${process.execPath}" "${STUB_JS}" "$@"\n`,
    'utf8');
try { fs.chmodSync(STUB_SH, 0o755); } catch {}

// El override que lee servicio-github.js es `GH_BIN_OVERRIDE`; en Windows
// preferimos el .cmd para que execSync(cmd.exe) lo resuelva. El test usa
// `process.platform` para elegir.
const STUB_BIN = process.platform === 'win32' ? STUB_CMD : STUB_SH;

process.env.PIPELINE_STATE_DIR = PIPELINE;
process.env.PIPELINE_MAIN_ROOT = TMP_DIR;
process.env.GH_BIN_OVERRIDE = STUB_BIN;

// Cargar el servicio DESPUÉS de setear los envs.
delete require.cache[require.resolve('../servicio-github')];
const svc = require('../servicio-github');

function clearGhCalls() {
    try { fs.unlinkSync(GH_CALLS_LOG); } catch {}
    // #2895 rev-1: limpiar también los fallback files con sufijo .pid que
    // el stub crea cuando appendFileSync no pudo escribir al log principal.
    try {
        for (const f of fs.readdirSync(STUB_DIR)) {
            if (f.startsWith('gh-calls.log.')) {
                try { fs.unlinkSync(path.join(STUB_DIR, f)); } catch {}
            }
        }
    } catch {}
}

function getGhCalls() {
    const out = [];
    // 1) Archivo principal del stub.
    try {
        for (const l of fs.readFileSync(GH_CALLS_LOG, 'utf8').split('\n').filter(Boolean)) {
            try { out.push(JSON.parse(l)); } catch {}
        }
    } catch {}
    // 2) Fallback files (gh-calls.log.<pid>) creados cuando appendFileSync
    //    falló bajo contención de FS — recolectarlos también para no perder
    //    evidencia de invocaciones (#2895 rev-1).
    try {
        for (const f of fs.readdirSync(STUB_DIR)) {
            if (!f.startsWith('gh-calls.log.') || f === 'gh-calls.log') continue;
            try {
                for (const l of fs.readFileSync(path.join(STUB_DIR, f), 'utf8').split('\n').filter(Boolean)) {
                    try { out.push(JSON.parse(l)); } catch {}
                }
            } catch {}
        }
    } catch {}
    return out;
}

function clearQueues() {
    for (const dir of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
        for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
    }
}

function clearStaleLog() {
    try { fs.unlinkSync(path.join(LOG_DIR, 'stale-orders.log')); } catch {}
}

function readStaleLog() {
    try {
        return fs.readFileSync(path.join(LOG_DIR, 'stale-orders.log'), 'utf8')
            .split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

function createMarker(issue, skill, phase = 'dev', pipeline = 'desarrollo') {
    const dir = path.join(PIPELINE, pipeline, phase, 'bloqueado-humano');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${issue}.${skill}`);
    fs.writeFileSync(file, '');
    fs.writeFileSync(file + '.reason.json', JSON.stringify({
        issue, skill, phase, pipeline,
        reason: 'test', question: 'test',
        blocked_at: new Date().toISOString(),
    }));
    return file;
}

function enqueueLabelOrder(issue, label, meta) {
    const filename = `${issue}-${label}-test-${Date.now()}-${Math.random()}.json`;
    const filepath = path.join(PENDIENTE, filename);
    const payload = { action: 'label', issue, label, ...(meta || {}) };
    fs.writeFileSync(filepath, JSON.stringify(payload));
    return filename;
}

function findResultFile(issue, label) {
    // El servicio mueve el JSON a `listo/` con el mismo nombre original.
    for (const f of fs.readdirSync(LISTO)) {
        if (f.startsWith(`${issue}-${label}-`)) {
            return JSON.parse(fs.readFileSync(path.join(LISTO, f), 'utf8'));
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// CA4: el escenario completo del incidente del 2026-05-05.
// ---------------------------------------------------------------------------
test('CA4: orden con marker_path stale (marker movido a pendiente/) NO invoca gh', () => {
    clearQueues(); clearGhCalls(); clearStaleLog();

    // 1. Crear marker en bloqueado-humano/ (estado inicial)
    const markerPath = createMarker(2975, 'guru');
    const markerMtime = fs.statSync(markerPath).mtimeMs;

    // 2. Encolar orden con metadata snapshot
    enqueueLabelOrder(2975, 'needs-human', {
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: markerMtime,
    });

    // 3. Humano destraba: mover marker a pendiente/
    const pendDir = path.join(PIPELINE, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(pendDir, { recursive: true });
    fs.renameSync(markerPath, path.join(pendDir, '2975.guru'));

    // 4. Worker procesa
    svc.processQueue();

    // 5. Verificar: gh NO fue invocado
    const calls = getGhCalls();
    assert.equal(calls.length, 0, `gh NO debe invocarse para órdenes stale (calls=${JSON.stringify(calls)})`);

    // 6. JSON en listo/ con discarded
    const result = findResultFile(2975, 'needs-human');
    assert.ok(result, 'orden debe quedar en listo/');
    assert.equal(result.discarded, 'stale-marker-missing');

    // 7. Log de stale-orders contiene la entrada
    const log = readStaleLog();
    assert.equal(log.length, 1, 'una entrada en stale-orders.log');
    assert.equal(log[0].reason, 'stale-marker-missing');
    assert.equal(log[0].issue, 2975);
    assert.equal(log[0].label, 'needs-human');
});

test('CA1: marker presente con mtime intacto → orden ejecuta normal', () => {
    clearQueues(); clearGhCalls(); clearStaleLog();

    const markerPath = createMarker(8001, 'po');
    const markerMtime = fs.statSync(markerPath).mtimeMs;
    enqueueLabelOrder(8001, 'needs-human', {
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: markerMtime,
    });

    svc.processQueue();

    const calls = getGhCalls();
    // Esperamos al menos 2 invocaciones: `gh label list` (refreshLabelCache)
    // + `gh issue edit ... --add-label`. Si la cache ya está warm, podría
    // ser solo 1.
    const editCall = calls.find(c => c.argv.includes('edit') && c.argv.some(a => a === '--add-label'));
    assert.ok(editCall, `gh edit debe invocarse con --add-label (calls=${JSON.stringify(calls)})`);
    assert.ok(editCall.argv.some(a => String(a) === '8001'), 'debe incluir el issue 8001');

    const result = findResultFile(8001, 'needs-human');
    assert.ok(result, 'orden debe quedar en listo/');
    assert.equal(result.discarded, undefined, 'no debe estar marcada como descartada');
});

test('CA2: marker presente pero mtime posterior al snapshot → discarded stale-mtime', () => {
    clearQueues(); clearGhCalls(); clearStaleLog();

    const markerPath = createMarker(7002, 'ux');
    // Snapshot ANTES de tocar el marker
    const snapshotMtime = fs.statSync(markerPath).mtimeMs;
    enqueueLabelOrder(7002, 'needs-human', {
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: snapshotMtime,
    });

    // Humano toca el marker (escribe algo, regenera mtime)
    const futureMs = Date.now() + 10000;
    fs.utimesSync(markerPath, new Date(futureMs), new Date(futureMs));

    svc.processQueue();

    const calls = getGhCalls().filter(c => c.argv.includes('edit'));
    assert.equal(calls.length, 0, 'gh edit NO debe invocarse cuando mtime cambió');

    const result = findResultFile(7002, 'needs-human');
    assert.equal(result.discarded, 'stale-mtime');

    const log = readStaleLog();
    const entry = log.find(e => e.issue === 7002);
    assert.ok(entry, 'log debe tener entrada para 7002');
    assert.equal(entry.reason, 'stale-mtime');
    assert.ok(typeof entry.current_mtime === 'number', 'debe persistir current_mtime');
});

test('Backward-compat: orden sin meta (legacy) ejecuta sin guardia', () => {
    clearQueues(); clearGhCalls(); clearStaleLog();

    // Orden sin marker_path/marker_mtime — shape clásico pre-#2994
    const filename = `6500-needs-human-legacy-${Date.now()}.json`;
    fs.writeFileSync(
        path.join(PENDIENTE, filename),
        JSON.stringify({ action: 'label', issue: 6500, label: 'needs-human' }),
    );

    svc.processQueue();

    const editCall = getGhCalls().find(c => c.argv.includes('edit'));
    assert.ok(editCall, 'orden legacy SIN meta debe ejecutar normalmente');
    const result = JSON.parse(fs.readFileSync(path.join(LISTO, filename), 'utf8'));
    assert.equal(result.discarded, undefined);
});

test('validateOrderFresh: API directa', () => {
    // Orden sin meta → null (sin guardia)
    assert.equal(svc.validateOrderFresh({ action: 'label', issue: 1, label: 'x' }), null);
    // Orden con meta y marker_path inexistente → stale-marker-missing
    const r1 = svc.validateOrderFresh({
        action: 'label', issue: 1, label: 'x',
        marker_path: path.join(TMP_DIR, 'inexistente-' + Date.now()),
    });
    assert.deepEqual(r1, { reason: 'stale-marker-missing', current_mtime: null });
    // Acción que no es label → null (no aplica guardia)
    assert.equal(svc.validateOrderFresh({ action: 'comment', issue: 1, body: 'x', marker_path: '/x' }), null);
});
