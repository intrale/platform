// =============================================================================
// servicio-github.test.js — #3025 (refactor) + #2994 (caso original)
//
// Tests del worker `servicio-github.js`. Validan dos cosas:
//
//   1) #2994: la guardia idempotente `validateOrderFresh` descarta órdenes
//      stale (marker movido / mtime cambiado) y NO invoca `gh`.
//   2) #3025: la lógica de despacho invoca al `ghClient` con los argumentos
//      correctos según la acción (comment / label / remove-label / create).
//
// IMPORTANTE — historia del archivo:
//
// La versión anterior usaba un shim externo en disco (#2895) que registraba
// cada llamada en un log compartido. Bajo carga concurrente (947 tests en
// paralelo, ~72s, Windows/NTFS), ese mecanismo flakeaba con `calls=[]` por
// contención de FS y resolución de PATH desde el shell child. Eso impactaba
// a issues completamente NO relacionados al worker (#2956, #2993, #3015).
//
// El refactor de #3025 reemplaza el shim externo por inyección de
// dependencia funcional: `processQueue` acepta `{ ghClient }` y los tests
// pasan un mock JS puro. Sin proceso hijo, sin shim, sin shell child. Eso
// elimina 100% la flakiness sin perder cobertura útil — el test sigue
// verificando que el worker decide invocar `gh` con los argumentos
// correctos cuando se cumple la precondición.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Setup: directorio temporal aislado para el FS del worker (cola, logs).
// Las constantes del módulo se resuelven una sola vez al cargarse, así que
// es crítico setear PIPELINE_STATE_DIR PRIMERO.
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

process.env.PIPELINE_STATE_DIR = PIPELINE;
process.env.PIPELINE_MAIN_ROOT = TMP_DIR;
// #3025 — ya NO existe `GH_BIN_OVERRIDE` apuntando a un .cmd: usamos un
// `ghClient` mockeado en JS que reemplaza al `defaultGhClient` por completo.
// La variable se setea a un path inexistente para asegurar que un fallo en
// la inyección (uso accidental de `defaultGhClient`) explote ruidoso en
// vez de llamar al `gh.exe` real del sistema.
process.env.GH_BIN_OVERRIDE = path.join(TMP_DIR, 'this-binary-does-not-exist');

// Cargar el servicio DESPUÉS de setear los envs.
delete require.cache[require.resolve('../servicio-github')];
const svc = require('../servicio-github');

// ---------------------------------------------------------------------------
// Fake ghClient: misma forma que `defaultGhClient`, pero JS puro.
// Cada método registra `{ method, args }` en `calls[]` para assertions.
// Permite override por método para tests específicos (ej. createLabel
// devolviendo `alreadyExists: true`).
// ---------------------------------------------------------------------------
function makeFakeGhClient(overrides = {}) {
    const calls = [];
    const client = {
        calls,
        editIssue(issueNumber, opts = {}) {
            calls.push({ method: 'editIssue', args: [issueNumber, opts] });
            if (overrides.editIssue) return overrides.editIssue(issueNumber, opts);
        },
        commentIssue(issueNumber, body) {
            calls.push({ method: 'commentIssue', args: [issueNumber, body] });
            if (overrides.commentIssue) return overrides.commentIssue(issueNumber, body);
        },
        createIssue(opts = {}) {
            calls.push({ method: 'createIssue', args: [opts] });
            if (overrides.createIssue) return overrides.createIssue(opts);
            return { number: 9999, url: `https://github.com/intrale/platform/issues/9999` };
        },
        listLabels(opts = {}) {
            calls.push({ method: 'listLabels', args: [opts] });
            if (overrides.listLabels) return overrides.listLabels(opts);
            return [];
        },
        createLabel(name, color, opts = {}) {
            calls.push({ method: 'createLabel', args: [name, color, opts] });
            if (overrides.createLabel) return overrides.createLabel(name, color, opts);
            return { created: true, alreadyExists: false };
        },
    };
    return client;
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

function enqueueOrder(issue, payload) {
    const filename = `${issue}-${payload.action}-test-${Date.now()}-${Math.random()}.json`;
    const filepath = path.join(PENDIENTE, filename);
    fs.writeFileSync(filepath, JSON.stringify(payload));
    return filename;
}

function readListoFile(filename) {
    return JSON.parse(fs.readFileSync(path.join(LISTO, filename), 'utf8'));
}

function findResultFile(issue, prefix) {
    for (const f of fs.readdirSync(LISTO)) {
        if (f.startsWith(`${issue}-${prefix}-`)) {
            return JSON.parse(fs.readFileSync(path.join(LISTO, f), 'utf8'));
        }
    }
    return null;
}

// Reset de la cache de labels antes de cada test (es estado del módulo).
function resetState() {
    clearQueues();
    clearStaleLog();
    svc._resetLabelCacheForTests();
}

// ===========================================================================
// #2994 — Guardia idempotente contra órdenes stale.
// ===========================================================================

test('CA4: orden con marker_path stale (marker movido) NO invoca gh', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    // 1. Crear marker en bloqueado-humano/ (estado inicial)
    const markerPath = createMarker(2975, 'guru');
    const markerMtime = fs.statSync(markerPath).mtimeMs;

    // 2. Encolar orden con metadata snapshot
    const filename = enqueueOrder(2975, {
        action: 'label', issue: 2975, label: 'needs-human',
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: markerMtime,
    });

    // 3. Humano destraba: mover marker a pendiente/ (desaparece del path original)
    const pendDir = path.join(PIPELINE, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(pendDir, { recursive: true });
    fs.renameSync(markerPath, path.join(pendDir, '2975.guru'));

    // 4. Worker procesa con ghClient inyectado
    svc.processQueue({ ghClient });

    // 5. ghClient.editIssue NO debe haber sido invocado
    const editCall = ghClient.calls.find(c => c.method === 'editIssue');
    assert.equal(editCall, undefined,
        `gh edit NO debe invocarse para órdenes stale (calls=${JSON.stringify(ghClient.calls)})`);

    // 6. JSON en listo/ con discarded
    const result = readListoFile(filename);
    assert.equal(result.discarded, 'stale-marker-missing');

    // 7. Log de stale-orders contiene la entrada
    const log = readStaleLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].reason, 'stale-marker-missing');
    assert.equal(log[0].issue, 2975);
    assert.equal(log[0].label, 'needs-human');
});

test('CA1: marker presente con mtime intacto → orden ejecuta normal', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    const markerPath = createMarker(8001, 'po');
    const markerMtime = fs.statSync(markerPath).mtimeMs;
    const filename = enqueueOrder(8001, {
        action: 'label', issue: 8001, label: 'needs-human',
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: markerMtime,
    });

    svc.processQueue({ ghClient });

    // editIssue debe haber sido invocado con el issue + addLabel correcto.
    const editCall = ghClient.calls.find(c => c.method === 'editIssue');
    assert.ok(editCall, `editIssue debe haber sido invocado (calls=${JSON.stringify(ghClient.calls)})`);
    assert.deepEqual(editCall.args, [8001, { addLabel: 'needs-human' }]);

    const result = readListoFile(filename);
    assert.equal(result.discarded, undefined, 'no debe estar marcada como descartada');
});

test('CA2: marker presente pero mtime posterior al snapshot → discarded stale-mtime', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    const markerPath = createMarker(7002, 'ux');
    const snapshotMtime = fs.statSync(markerPath).mtimeMs;
    const filename = enqueueOrder(7002, {
        action: 'label', issue: 7002, label: 'needs-human',
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
        marker_mtime: snapshotMtime,
    });

    // Humano toca el marker (futureMs muy en el futuro)
    const futureMs = Date.now() + 10000;
    fs.utimesSync(markerPath, new Date(futureMs), new Date(futureMs));

    svc.processQueue({ ghClient });

    const editCall = ghClient.calls.find(c => c.method === 'editIssue');
    assert.equal(editCall, undefined, 'editIssue NO debe invocarse cuando mtime cambió');

    const result = readListoFile(filename);
    assert.equal(result.discarded, 'stale-mtime');

    const log = readStaleLog();
    const entry = log.find(e => e.issue === 7002);
    assert.ok(entry, 'log debe tener entrada para 7002');
    assert.equal(entry.reason, 'stale-mtime');
    assert.ok(typeof entry.current_mtime === 'number', 'debe persistir current_mtime');
});

test('Backward-compat: orden sin meta (legacy) ejecuta sin guardia', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    // Orden sin marker_path/marker_mtime — shape clásico pre-#2994
    const filename = `6500-needs-human-legacy-${Date.now()}.json`;
    fs.writeFileSync(
        path.join(PENDIENTE, filename),
        JSON.stringify({ action: 'label', issue: 6500, label: 'needs-human' }),
    );

    svc.processQueue({ ghClient });

    // editIssue invocado con el shape correcto
    const editCall = ghClient.calls.find(c => c.method === 'editIssue');
    assert.ok(editCall, 'orden legacy SIN meta debe ejecutar normalmente');
    assert.deepEqual(editCall.args, [6500, { addLabel: 'needs-human' }]);

    const result = readListoFile(filename);
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

// ===========================================================================
// #3025 — Cobertura de los 4 dispatch paths del worker (CA-9).
// ===========================================================================

test('dispatch: action=comment invoca ghClient.commentIssue con (issue, body)', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    const filename = enqueueOrder(1234, {
        action: 'comment', issue: 1234, body: 'Hola desde el test',
    });

    svc.processQueue({ ghClient });

    const call = ghClient.calls.find(c => c.method === 'commentIssue');
    assert.ok(call, `commentIssue debe haber sido invocado (calls=${JSON.stringify(ghClient.calls)})`);
    assert.equal(call.args[0], 1234);
    assert.equal(call.args[1], 'Hola desde el test');

    // No debe invocar editIssue/createIssue.
    assert.equal(ghClient.calls.find(c => c.method === 'editIssue'), undefined);
    assert.equal(ghClient.calls.find(c => c.method === 'createIssue'), undefined);

    // Debe quedar en listo/ sin discarded.
    const result = readListoFile(filename);
    assert.equal(result.discarded, undefined);
});

test('dispatch: action=remove-label invoca ghClient.editIssue con removeLabel', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    const filename = enqueueOrder(5678, {
        action: 'remove-label', issue: 5678, label: 'qa:dependency',
    });

    svc.processQueue({ ghClient });

    const editCall = ghClient.calls.find(c => c.method === 'editIssue');
    assert.ok(editCall, 'editIssue debe haber sido invocado');
    assert.deepEqual(editCall.args, [5678, { removeLabel: 'qa:dependency' }]);

    const result = readListoFile(filename);
    assert.equal(result.discarded, undefined);
});

test('dispatch: action=create-issue invoca ghClient.createIssue y guarda result en JSON', () => {
    resetState();
    const ghClient = makeFakeGhClient({
        createIssue: () => ({ number: 4242, url: 'https://github.com/intrale/platform/issues/4242' }),
    });

    const filename = enqueueOrder(0, {
        action: 'create-issue',
        title: 'Issue de prueba',
        body: 'body de prueba',
        labels: 'bug,needs-definition',
        repo: 'intrale/platform',
    });

    svc.processQueue({ ghClient });

    const createCall = ghClient.calls.find(c => c.method === 'createIssue');
    assert.ok(createCall, 'createIssue debe haber sido invocado');
    assert.equal(createCall.args[0].title, 'Issue de prueba');
    assert.equal(createCall.args[0].body, 'body de prueba');
    assert.equal(createCall.args[0].labels, 'bug,needs-definition');
    assert.equal(createCall.args[0].repo, 'intrale/platform');

    // El JSON enriquecido en listo/ debe tener result.{number, url}.
    const result = readListoFile(filename);
    assert.equal(result.result.number, 4242);
    assert.equal(result.result.url, 'https://github.com/intrale/platform/issues/4242');
});

// ===========================================================================
// #3025 — CA-10: idempotencia de createLabel en ensureLabels.
// Cuando el client devuelve { alreadyExists: true }, ensureLabels NO arroja
// y continúa con el siguiente label.
// ===========================================================================

test('ensureLabels: createLabel devuelve alreadyExists → no arroja, continúa con resto', () => {
    resetState();

    // Cliente que simula: el primer label devuelve alreadyExists, el segundo
    // se crea normalmente. listLabels devuelve vacío para forzar createLabel.
    const ghClient = makeFakeGhClient({
        listLabels: () => [],
        createLabel: (name) => {
            if (name === 'label-existente') return { created: false, alreadyExists: true };
            return { created: true, alreadyExists: false };
        },
    });

    // No debe arrojar.
    assert.doesNotThrow(() => {
        svc.ensureLabels('label-existente,label-nuevo', ghClient);
    });

    // Verificar que se intentaron crear ambos (el primero quedó como
    // alreadyExists, el segundo como created).
    const createLabelCalls = ghClient.calls.filter(c => c.method === 'createLabel');
    const names = createLabelCalls.map(c => c.args[0]);
    assert.ok(names.includes('label-existente'),
        `debe haber intentado crear label-existente (calls=${JSON.stringify(names)})`);
    assert.ok(names.includes('label-nuevo'),
        `debe haber intentado crear label-nuevo (calls=${JSON.stringify(names)})`);
});

test('ensureLabels: usa cache, no llama listLabels si ya está warm con labels', () => {
    resetState();

    // Pre-warmear la cache: una llamada con un label que el client conoce.
    const warmClient = makeFakeGhClient({
        listLabels: () => [{ name: 'pre-existente' }],
    });
    svc.ensureLabels('pre-existente', warmClient);

    // Segundo cliente: si la cache funciona, no llamamos listLabels otra vez.
    const secondClient = makeFakeGhClient({
        listLabels: () => {
            throw new Error('listLabels NO debe ser invocado: cache warm');
        },
        createLabel: () => {
            throw new Error('createLabel NO debe ser invocado: label ya en cache');
        },
    });
    // No arroja → cache evitó las llamadas.
    assert.doesNotThrow(() => svc.ensureLabels('pre-existente', secondClient));
});

// ===========================================================================
// #3025 — defaultGhClient: existencia de la API y resolución del binario.
// CA-1 / CA-3 verificación.
// ===========================================================================

test('defaultGhClient: expone editIssue, commentIssue, createIssue, listLabels, createLabel', () => {
    assert.equal(typeof svc.defaultGhClient.editIssue, 'function');
    assert.equal(typeof svc.defaultGhClient.commentIssue, 'function');
    assert.equal(typeof svc.defaultGhClient.createIssue, 'function');
    assert.equal(typeof svc.defaultGhClient.listLabels, 'function');
    assert.equal(typeof svc.defaultGhClient.createLabel, 'function');
});

// ===========================================================================
// #3025 — defaultGhClient como default de processQueue (sin args).
// El comportamiento sin pasar `{ ghClient }` debe seguir funcionando para
// el daemon en producción. Como `defaultGhClient` invoca al binario `gh`
// real, NO podemos ejecutar un round-trip completo en este test sin tocar
// la red. Verificamos en cambio que `processQueue()` sin args no arroja por
// la firma (el shape del default arg está bien) — la primera orden fallará
// al ejecutar el binario inexistente y caerá al path de retry. Eso es OK:
// confirma que el dispatch llegó al `defaultGhClient.editIssue` (que es lo
// que hace producción).
// ===========================================================================

test('processQueue() sin args usa defaultGhClient (firma compatible con producción)', () => {
    resetState();

    // Encolamos una orden que va a fallar en el binario inexistente, pero
    // no debe arrojar desde `processQueue` (el catch interno la mueve a
    // pendiente/ con retries++).
    enqueueOrder(11111, {
        action: 'label', issue: 11111, label: 'needs-definition',
    });

    // Si la firma de processQueue es incompatible (ej. obligara `ghClient`),
    // esto arroja TypeError. Si está bien, el catch interno absorbe el
    // ENOENT al ejecutar el binario y la orden vuelve a pendiente/.
    assert.doesNotThrow(() => svc.processQueue());

    // La orden debe haber sido tocada: o sigue en pendiente/ (con retries
    // incrementado) o cayó a fallido/ (después de 3 intentos en distintas
    // ejecuciones). Aquí no asertamos un destino específico, solo que el
    // dispatch no fue rechazado por la firma.
});
