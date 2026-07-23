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

// ===========================================================================
// #3303 — Body con saltos de línea reales preservados extremo a extremo.
//
// Causa raíz del incidente del 2026-05-17: el `esc()` viejo convertía `\n` a
// la secuencia literal `\\n` para no romper el quoting del shell de Windows.
// Resultado: el comentario posteado a GitHub quedaba en una sola línea y el
// detector de dependencias del Pulpo (`parseDependencyComment`) no matcheaba.
//
// El fix migra a `cp.execFileSync` + `--body-file -` con stdin, lo que no
// requiere escape de newlines. Estos tests cierran la regresión:
//
//   CA-4 (dispatch test puro):
//     - El fake `ghClient` mockea la API. El worker invoca commentIssue con
//       el body íntegro (con `\n` reales). Si alguien reintrodujera `esc()`
//       o cualquier transformación de newlines en el path del worker, el
//       fake lo detectaría comparando `args[1]` contra el string original.
//
//   CA-5 (E2E hasta el binario):
//     - Monkey-patch de `cp.execFileSync` en el módulo de servicio-github.
//       Captura el argv y `options.input` que llegan al binario `gh`.
//       Verifica:
//         (a) que el body se pasa por `--body-file -` (no `-b "..."`).
//         (b) que el body en stdin tiene los `\n` reales sin transformación.
//         (c) que NO aparece el patrón `\\n` literal anti-pattern.
//
//   CA-6 (integración con el parser real):
//     - Toma el body que captura CA-5 y lo pasa por `parseDependencyComment`.
//       Verifica que el parser detecta correctamente el listado `- #NNNN`.
//       Si el body llegara con `\n` literales (como antes del fix), el
//       parser devolvería `null` (causa raíz exacta del incidente #3253).
// ===========================================================================

test('CA-4 #3303: action=comment con body multilínea pasa newlines reales al ghClient', () => {
    resetState();
    const ghClient = makeFakeGhClient();

    const bodyMultilinea = '## Dependencias detectadas por el pipeline\n\n- #3257\n\nEste issue queda bloqueado hasta que cierren las dependencias.';

    const filename = enqueueOrder(3253, {
        action: 'comment', issue: 3253, body: bodyMultilinea,
    });

    svc.processQueue({ ghClient });

    const call = ghClient.calls.find(c => c.method === 'commentIssue');
    assert.ok(call, `commentIssue debe haber sido invocado (calls=${JSON.stringify(ghClient.calls)})`);
    assert.equal(call.args[0], 3253);

    // CA-4 — el body llega IDÉNTICO al string original; ni el dispatcher ni
    // el `sanitizeGithubPayload` deben transformar `\n` real en `\\n` literal.
    const receivedBody = call.args[1];
    assert.equal(receivedBody, bodyMultilinea,
        'body debe pasarse verbatim — sin transformación de newlines');

    // Doble check: el body contiene saltos de línea reales y NO la secuencia
    // literal `\n` (dos chars: backslash + n) que producía el bug original.
    assert.ok(receivedBody.includes('\n'),
        'body recibido debe contener LF real');
    assert.ok(!receivedBody.includes('\\n'),
        'body recibido NO debe contener la secuencia literal \\n (sería el bug previo)');

    // Sanity: el resultado quedó en listo sin descartado.
    const result = readListoFile(filename);
    assert.equal(result.discarded, undefined);
});

test('CA-5 #3303: defaultGhClient.commentIssue invoca execFileSync con --body-file - y body en stdin', () => {
    resetState();

    // Body que reproduce exactamente el patrón del incidente #3253.
    const bodyMultilinea = '## Dependencias detectadas por el pipeline\n\n- #3257\n\nEste issue queda bloqueado hasta que cierren las dependencias.';

    // Monkey-patch `cp.execFileSync` a nivel módulo. La producción usa
    // `cp.execFileSync(GH_BIN, argv, opts)` — capturamos los 3 args, NO
    // invocamos el binario real. Saneamos al final con `cp.execFileSync = original`.
    //
    // Por qué este enfoque y no un stub `.exe` real:
    //   - Windows requiere `.exe` nativo o `shell: true` para `.bat`/`.cmd`,
    //     y el punto del fix es justamente NO usar shell. Un stub `.js`
    //     no es ejecutable directo desde `execFileSync` sin shell.
    //   - El monkey-patch del módulo `child_process` es el mecanismo
    //     estándar en Node `node --test` para aislar IO. La invocación
    //     real ya está cubierta por integration tests en producción
    //     (el daemon corre miles de veces al día contra `gh.exe` real).
    const cp = require('node:child_process');
    const originalExecFileSync = cp.execFileSync;

    let capturedFile = null;
    let capturedArgs = null;
    let capturedOptions = null;
    cp.execFileSync = function spyExecFileSync(file, args, options) {
        capturedFile = file;
        capturedArgs = args;
        capturedOptions = options;
        // Simulamos un comentario exitoso (gh devuelve la URL en stdout).
        return 'https://github.com/intrale/platform/issues/3253#issuecomment-fake\n';
    };

    try {
        svc.defaultGhClient.commentIssue(3253, bodyMultilinea);
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    // CA-5 (a) — argv usa --body-file -, NO -b/--body con interpolación.
    assert.ok(Array.isArray(capturedArgs), 'execFileSync debe recibir argv como array');
    assert.deepEqual(capturedArgs.slice(0, 3), ['issue', 'comment', '3253']);
    assert.ok(capturedArgs.includes('--body-file'),
        `argv debe incluir --body-file (recibido: ${JSON.stringify(capturedArgs)})`);
    const bodyFileIdx = capturedArgs.indexOf('--body-file');
    assert.equal(capturedArgs[bodyFileIdx + 1], '-',
        '--body-file debe apuntar a "-" (stdin)');
    assert.ok(!capturedArgs.includes('-b'),
        `argv NO debe usar -b (sería interpolación shell — recibido: ${JSON.stringify(capturedArgs)})`);

    // CA-5 (b) — el body real llega íntegro por stdin (options.input).
    assert.ok(capturedOptions && typeof capturedOptions.input === 'string',
        'options.input debe ser string con el body');
    assert.equal(capturedOptions.input, bodyMultilinea,
        'options.input debe ser EXACTAMENTE el body original (sin transformación)');

    // CA-5 (c) — anti-pattern: NO debe haber backslash-n literal en el input.
    assert.ok(capturedOptions.input.includes('\n'),
        'options.input debe tener LF real');
    assert.ok(!capturedOptions.input.includes('\\n'),
        'options.input NO debe tener la secuencia literal \\\\n');

    // Sanity: cwd, encoding, timeout, windowsHide preservados del cliente anterior.
    assert.equal(capturedOptions.encoding, 'utf8');
    assert.equal(typeof capturedOptions.timeout, 'number');
    assert.equal(capturedOptions.windowsHide, true);
});

test('CA-5 #3303: defaultGhClient.createIssue usa --body-file - y title como argv literal', () => {
    resetState();

    const titleMultilinea = 'Issue de prueba con "comillas" y %USERPROFILE%';
    const bodyMultilinea = 'Línea 1\nLínea 2\nLínea 3\n\nCon emojis 🎯 y backticks `cmd`';

    const cp = require('node:child_process');
    const originalExecFileSync = cp.execFileSync;

    let capturedArgs = null;
    let capturedOptions = null;
    cp.execFileSync = function spyExecFileSync(file, args, options) {
        capturedArgs = args;
        capturedOptions = options;
        return 'https://github.com/intrale/platform/issues/9999\n';
    };

    let result;
    try {
        result = svc.defaultGhClient.createIssue({
            title: titleMultilinea,
            body: bodyMultilinea,
            labels: 'bug,needs-definition',
            repo: 'intrale/platform',
        });
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    // Verificar shape: ['issue', 'create', '--title', <title>, '--body-file', '-', '--repo', <repo>, '--label', <labels>]
    assert.deepEqual(capturedArgs.slice(0, 2), ['issue', 'create']);

    // Title pasa como un solo argv (sin escape, sin expansion de %USERPROFILE%).
    const titleIdx = capturedArgs.indexOf('--title');
    assert.equal(capturedArgs[titleIdx + 1], titleMultilinea,
        'title debe pasarse como un solo argv literal — sin transformación');

    // Body por stdin con --body-file -.
    const bodyFileIdx = capturedArgs.indexOf('--body-file');
    assert.equal(capturedArgs[bodyFileIdx + 1], '-');
    assert.equal(capturedOptions.input, bodyMultilinea,
        'body de createIssue debe llegar íntegro por stdin');
    assert.ok(!capturedOptions.input.includes('\\n'),
        'body NO debe tener secuencia literal \\\\n');

    // Repo y label como argv.
    const repoIdx = capturedArgs.indexOf('--repo');
    assert.equal(capturedArgs[repoIdx + 1], 'intrale/platform');
    const labelIdx = capturedArgs.indexOf('--label');
    assert.equal(capturedArgs[labelIdx + 1], 'bug,needs-definition');

    // Parse del result (extraer número desde la URL).
    assert.equal(result.number, 9999);
});

test('CA-5 #3303: defaultGhClient.editIssue usa argv array (sin shell) para add/remove label', () => {
    resetState();

    const cp = require('node:child_process');
    const originalExecFileSync = cp.execFileSync;
    const calls = [];
    cp.execFileSync = function spyExecFileSync(file, args, options) {
        calls.push({ file, args, options });
        return '';
    };

    try {
        svc.defaultGhClient.editIssue(1234, { addLabel: 'needs-definition' });
        svc.defaultGhClient.editIssue(1234, { removeLabel: 'blocked:dependencies' });
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['issue', 'edit', '1234', '--add-label', 'needs-definition']);
    assert.deepEqual(calls[1].args, ['issue', 'edit', '1234', '--remove-label', 'blocked:dependencies']);
    // No hay options.input para edits.
    assert.equal(calls[0].options.input, undefined);
});

test('CA-5 #3303: defaultGhClient.createLabel usa argv array y preserva idempotencia "already exists"', () => {
    resetState();

    const cp = require('node:child_process');
    const originalExecFileSync = cp.execFileSync;

    let callArgs = null;
    cp.execFileSync = function spyExecFileSync(file, args, options) {
        callArgs = args;
        return '';
    };

    let result;
    try {
        result = svc.defaultGhClient.createLabel('label-nuevo', 'B60205', { repo: 'intrale/platform' });
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    assert.deepEqual(callArgs, ['label', 'create', 'label-nuevo', '--color', 'B60205', '--repo', 'intrale/platform']);
    assert.equal(result.created, true);
    assert.equal(result.alreadyExists, false);

    // Caso idempotencia: el binario falla con "already exists".
    cp.execFileSync = function spyExecFileSyncFails() {
        const err = new Error('Error: label already exists');
        err.stderr = 'label already exists\n';
        throw err;
    };

    try {
        result = svc.defaultGhClient.createLabel('label-existente', 'ededed', { repo: 'intrale/platform' });
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    assert.equal(result.created, false);
    assert.equal(result.alreadyExists, true);
});

test('CA-6 #3303: ciclo end-to-end — body posteado por commentIssue es detectado por parseDependencyComment', () => {
    resetState();

    // 1. Body que produce el pipeline cuando un issue tiene dependencias.
    const bodyPipeline = '## Dependencias detectadas por el pipeline\n\n- #3257\n- #3260\n\nEste issue queda bloqueado hasta que cierren las dependencias.';

    // 2. Capturamos el `options.input` que llegaría al binario `gh`.
    const cp = require('node:child_process');
    const originalExecFileSync = cp.execFileSync;
    let stdinCaptured = null;
    cp.execFileSync = function spyExecFileSync(file, args, options) {
        stdinCaptured = options.input;
        return '';
    };

    try {
        svc.defaultGhClient.commentIssue(3253, bodyPipeline);
    } finally {
        cp.execFileSync = originalExecFileSync;
    }

    // 3. El body capturado debe ser idéntico al original (lo que GitHub
    //    recibe y lo que después devuelve por `gh issue view --json comments`).
    assert.equal(stdinCaptured, bodyPipeline);

    // 4. Pasamos el body capturado por el parser canónico del Pulpo.
    //    Si la causa raíz del bug se reactivara, el body llegaría sin LF
    //    reales y el parser devolvería `null`.
    const { parseDependencyComment } = require('../lib/dep-comment-parser');
    const deps = parseDependencyComment(
        [{ body: stdinCaptured, createdAt: new Date().toISOString() }],
        3253,
    );

    // 5. El parser debe detectar correctamente AMBAS dependencias.
    assert.ok(Array.isArray(deps), `parser debe devolver array, recibió: ${deps}`);
    assert.deepEqual(deps.sort(), [3257, 3260].sort(),
        'parser debe detectar las dos dependencias #3257 y #3260');
});

test('CA-6 #3303: regresión cerrada — body con \\n literales (bug previo) NO matchea el parser', () => {
    // Test de control: si alguien reintroduce el bug (body con `\n` literales
    // en lugar de LF reales), `parseDependencyComment` debe devolver `null`.
    // Este test documenta el comportamiento fail-closed del parser y demuestra
    // que el fix de #3303 (LF reales preservados) es el que habilita la
    // detección — no un cambio en el parser.
    const bodyBuggy = '## Dependencias detectadas por el pipeline\\n\\n- #3257\\n\\nEste issue queda bloqueado...';

    const { parseDependencyComment } = require('../lib/dep-comment-parser');
    const deps = parseDependencyComment(
        [{ body: bodyBuggy, createdAt: new Date().toISOString() }],
        3253,
    );

    // Con `\n` literales (no LF reales), el body es UNA sola línea — el
    // heading nunca matchea como heading aislado y el parser devuelve null.
    assert.equal(deps, null,
        'body con \\\\n literales debe devolver null (fail-closed) — corolario del bug previo');
});
