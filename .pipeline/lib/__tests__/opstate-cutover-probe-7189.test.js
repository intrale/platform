'use strict';

// =============================================================================
// opstate-cutover-probe-7189.test.js — Sondas del cutover del estado operativo
// (#7189, CA-1…CA-7). Todo contra `fixtures/fake-sync-dynamo-driver.js`: cero
// AWS, cero red. Cada `[FALLA]` de la sonda (cada causa de `CAUSAS` que la sonda
// puede emitir) tiene su test negativo acá (CA-7).
//
// Aislamiento: tmpdir propio + `withEnv` (#6258) + backend recargado por test
// (tiene estado de módulo: driver cacheado, sink de degradación).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withEnv } = require('../test-helpers/with-env');
const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
const coord = require('../kernel-coordination-store');
const migrate = require('../kernel-store-migrate');

const probe = require('../../scripts/opstate-cutover-probe');

const BACKEND_PATH = require.resolve('../operational-state-backend');
const PROJECT_ID = 'intrale-platform';
const AHORA = Date.parse('2026-09-14T00:00:00Z');

function freshBackend() {
    delete require.cache[BACKEND_PATH];
    // eslint-disable-next-line global-require
    return require('../operational-state-backend');
}

/** tmpdir + env aislado; `fn(dir)` puede ser async. */
function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-probe-7189-'));
    const limpiar = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    let out;
    try {
        out = withEnv({ PIPELINE_DIR_OVERRIDE: dir, PIPELINE_OPSTATE_DURABLE: undefined, PARTIAL_PAUSE_STRICT_AUTH: undefined, ...env }, () => fn(dir));
    } catch (e) { limpiar(); throw e; }
    if (out && typeof out.then === 'function') return out.finally(limpiar);
    limpiar();
    return out;
}

// ─── Fixtures de estado ─────────────────────────────────────────────────────

function wavesConContenido() {
    return {
        version: '1.0',
        meta: { created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-13T00:00:00Z', updated_by: 'test', source: 'fixture' },
        active_wave: { id: 'ola-1', title: 'Ola de prueba', issues: [7189] },
        planned_waves: [{ id: 'ola-2', title: 'Siguiente', issues: [7194] }],
        archived_waves: [],
        dependencies: [],
    };
}

function wavesVacio() {
    return { ...wavesConContenido(), active_wave: null, planned_waves: [], archived_waves: [] };
}

function allowlistConContenido() {
    return { allowed_issues: [7189, 7194, 7195], created_at: '2026-09-13T00:00:00Z', source: 'fixture' };
}

function allowlistVacia() {
    return { allowed_issues: [], created_at: '2026-09-13T00:00:00Z', source: 'fixture' };
}

/** Siembra un ítem crudo del store con el envelope canónico compartido. */
function seed(driver, key, value, version = 1, projectId = PROJECT_ID) {
    driver._seed(coord.buildCoordinationEnvelope({ projectId, key, value, version, instanceId: projectId, updatedAt: AHORA }));
}

/** Backend fresco en modo remoto sobre un fake con `kind` configurable. */
function remoteBackend({ kind = 'fake-sync', atomicUpdate = true, driver } = {}) {
    const backend = freshBackend();
    const drv = driver || createFakeSyncDynamoDriver();
    if (kind !== 'fake-sync') drv.kind = kind;
    backend._setDriverForTests({
        driver: drv,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate,
    });
    return { backend, driver: drv };
}

/** Camino B "crudo" para tests: lee el MISMO fake por afuera del backend. */
function consistentReadFrom(driver) {
    return ({ pk, sk }) => ({ ok: true, item: driver._raw(pk, sk) ? JSON.parse(JSON.stringify(driver._raw(pk, sk))) : null });
}

const CFG = Object.freeze({
    kernel: {
        tableName: 'intrale-kernel-state',
        coordinationTableName: 'tabla-fake',
        region: 'us-east-2',
        runtimePrincipal: 'intrale-kernel-runtime',
        runtimeProfile: 'kernel-runtime',
        durable: false,
        cutover_window: false,
    },
    operational_state: { durable: false, namespaced: { enabled: false } },
});

const identidadOk = () => ({ ok: true, principal: 'intrale-kernel-runtime', arn: 'arn:aws:iam::<ACCT>:user/intrale-kernel-runtime' });
const identidadMal = () => ({ ok: false, code: 'identidad_inesperada', error: 'identidad_inesperada: el principal efectivo es "admin" pero config declara "intrale-kernel-runtime".' });

const TEST_KINDS = Object.freeze(['aws-cli', 'aws-cli-sync', 'fake-sync']);

function causasDe(result) {
    return result.checks.filter((c) => !c.ok && !c.informativo).map((c) => c.causa);
}

// =============================================================================
// CA-1 · --preconditions
// =============================================================================

function depsPreconditions(dir, backend, over = {}) {
    const auditFile = path.join(dir, 'audit.jsonl');
    if (!fs.existsSync(auditFile)) fs.writeFileSync(auditFile, '');
    return {
        config: CFG,
        readServiceAuth: () => ({ ok: true, strict: true, pid: 123 }),
        backend,
        verifyRuntimeIdentity: identidadOk,
        namespaceStatus: () => ({ projectId: PROJECT_ID, migrated: true, stateDir: dir, flatLayoutItems: [] }),
        projectContext: { namespaceEnabled: () => true, stateDir: () => dir, currentProjectIdOrNull: () => PROJECT_ID },
        auditFile,
        now: () => AHORA,
        allowedDriverKinds: TEST_KINDS,
        ...over,
    };
}

test('CA-1 verde: las cuatro precondiciones en verde ⇒ VERDE, exit 0, D-9 y modo informativos', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend) });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.checks.filter((c) => !c.informativo).map((c) => c.id), ['CA-B1', 'CA-B2', 'CA-B3', 'CA-B5']);
    const d9 = r.checks.find((c) => c.id === 'D-9');
    assert.equal(d9.informativo, true);
    assert.match(d9.detalle, /kernel\.durable = false \(boolean\)/);
    const modo = r.checks.find((c) => c.id === 'modo');
    assert.match(modo.detalle, /mode: fs · source: config/);
}));

test('CA-1 · CA-B1 rojo: strict apagado ⇒ strict_auth_apagado y exit ≠ 0', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { readServiceAuth: () => ({ ok: true, strict: false, pid: 123 }) }) });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(causasDe(r), ['strict_auth_apagado']);
    const b1 = r.checks.find((c) => c.id === 'CA-B1');
    assert.match(b1.siguiente, /H0 paso 0/);
    assert.match(b1.detalle, /servicio: PID 123/);
}));

test('CA-1 · CA-B1 rojo: una entrada gate_grace:true dentro de los 30 días ⇒ gate_grace_reciente', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const auditFile = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(auditFile, [
        JSON.stringify({ timestamp: '2026-08-01T00:00:00Z', action: 'write', gate_grace: true }),   // 44 días: fuera
        JSON.stringify({ timestamp: '2026-09-10T00:00:00Z', action: 'write', gate_grace: true }),   // 4 días: dentro
        JSON.stringify({ timestamp: '2026-09-12T00:00:00Z', action: 'write' }),
    ].join('\n') + '\n');
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { auditFile }) });
    assert.deepEqual(causasDe(r), ['gate_grace_reciente']);
    assert.equal(r.checks.find((c) => c.id === 'CA-B1').datos.gateGrace30d, 1);
}));

test('CA-1 · CA-B1: un gate_grace de hace más de 30 días NO cuenta (la ventana es de 30 días)', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const auditFile = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(auditFile, JSON.stringify({ timestamp: '2026-08-13T18:16:22.173Z', action: 'write', gate_grace: true }) + '\n');
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { auditFile }) });
    assert.equal(r.ok, true, JSON.stringify(causasDe(r)));
    assert.equal(r.checks.find((c) => c.id === 'CA-B1').datos.lastGateGrace, '2026-08-13T18:16:22.173Z');
}));

test('CA-1 · CA-B1 rojo: una línea del audit que no parsea ⇒ audit_ilegible (no se ignora en silencio)', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const auditFile = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(auditFile, '{"timestamp":"2026-09-12T00:00:00Z"}\n{esto no es json\n');
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { auditFile }) });
    assert.deepEqual(causasDe(r), ['audit_ilegible']);
}));

test('CA-1 · CA-B2 rojo: el driver resuelto NO declara atomicUpdate:true ⇒ atomic_update_falso', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync', atomicUpdate: false });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend) });
    assert.deepEqual(causasDe(r), ['atomic_update_falso']);
}));

test('CA-1 · CA-B2 rojo: driver in-memory ⇒ driver_no_aws_cli aunque el test amplíe la lista (trampa §2.5)', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'in-memory' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { allowedDriverKinds: ['aws-cli', 'aws-cli-sync', 'fake-sync', 'in-memory'] }) });
    assert.deepEqual(causasDe(r), ['driver_no_aws_cli']);
}));

test('CA-1 · CA-B2 rojo: el backend no puede construir el driver (config/credenciales) ⇒ driver_no_resuelto', () => enTmp({}, async (dir) => {
    const backend = freshBackend(); // sin driver inyectado y sin config ⇒ resolveDriver lanza
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend) });
    assert.deepEqual(causasDe(r), ['driver_no_resuelto']);
    assert.match(r.checks.find((c) => c.id === 'CA-B2').detalle, /NO RESUELTO/);
}));

test('CA-1 · CA-B3 rojo: identidad efectiva distinta del principal declarado ⇒ identidad_inesperada', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { verifyRuntimeIdentity: identidadMal }) });
    assert.deepEqual(causasDe(r), ['identidad_inesperada']);
}));

test('CA-1 · CA-B3 rojo: falta kernel.runtimePrincipal ⇒ runtime_principal_ausente (pass-through de la sonda del kernel)', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { verifyRuntimeIdentity: () => ({ ok: false, code: 'runtime_principal_ausente', error: 'runtime_principal_ausente: falta `kernel.runtimePrincipal`' }) }) });
    assert.deepEqual(causasDe(r), ['runtime_principal_ausente']);
}));

test('CA-1 · CA-B3 rojo: la AWS CLI falla ⇒ aws_cli_failed, y un código desconocido cae a aws_cli_failed', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r1 = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { verifyRuntimeIdentity: () => ({ ok: false, code: 'aws_cli_failed', error: 'aws_cli_failed: exit 255' }) }) });
    assert.deepEqual(causasDe(r1), ['aws_cli_failed']);
    const r2 = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { verifyRuntimeIdentity: () => ({ ok: false, code: 'algo_raro', error: 'x' }) }) });
    assert.deepEqual(causasDe(r2), ['aws_cli_failed']);
}));

test('CA-1 · CA-B5 rojo (el caso esperado HOY): namespaceado apagado + migrated:false ⇒ namespaceado_apagado, exit ≠ 0', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, {
        namespaceStatus: () => ({ projectId: PROJECT_ID, migrated: false, stateDir: path.join(dir, 'projects', PROJECT_ID), flatLayoutItems: ['waves.json', '.partial-pause.json'] }),
        projectContext: { namespaceEnabled: () => false, stateDir: () => dir, currentProjectIdOrNull: () => PROJECT_ID },
    }) });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(causasDe(r), ['namespaceado_apagado']);
    const b5 = r.checks.find((c) => c.id === 'CA-B5');
    assert.equal(b5.datos.migrated, false);
    assert.match(b5.siguiente, /H0 paso 1/);
}));

test('CA-1 · CA-B5 rojo: namespaceado encendido pero layout sin migrar ⇒ layout_no_migrado', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, {
        namespaceStatus: () => ({ projectId: PROJECT_ID, migrated: false, stateDir: dir, flatLayoutItems: ['waves.json'] }),
    }) });
    assert.deepEqual(causasDe(r), ['layout_no_migrado']);
}));

test('CA-1 · CA-B5 rojo: `--status` y `project-context.stateDir()` divergen ⇒ state_dir_divergente (trampa §2.4)', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, {
        namespaceStatus: () => ({ projectId: PROJECT_ID, migrated: true, stateDir: path.join(dir, 'otro-lado'), flatLayoutItems: [] }),
    }) });
    assert.deepEqual(causasDe(r), ['state_dir_divergente']);
}));

test('CA-1 · CA-B5 rojo: `--status` no devuelve JSON ⇒ status_ilegible', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { namespaceStatus: () => { throw new Error('salida no JSON'); } }) });
    assert.deepEqual(causasDe(r), ['status_ilegible']);
}));

test('CA-1 · D-9: kernel.durable se REPORTA con su tipo y no cambia el veredicto', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const cfg = { ...CFG, kernel: { ...CFG.kernel, durable: 'true' } };
    const r = await probe.runPreconditions({ deps: depsPreconditions(dir, backend, { config: cfg }) });
    assert.equal(r.ok, true);
    assert.match(r.checks.find((c) => c.id === 'D-9').detalle, /kernel\.durable = "true" \(string\)/);
}));

// =============================================================================
// CA-2 · --cas-probe
// =============================================================================

function depsCas(driver, over = {}) {
    return {
        config: CFG,
        verifyRuntimeIdentity: identidadOk,
        projectId: PROJECT_ID,
        driver,
        getItemConsistent: consistentReadFrom(driver),
        allowedDriverKinds: TEST_KINDS,
        ...over,
    };
}

test('CA-2 verde: dos escrituras con la misma expectedVersion — la 2ª vuelve conflict:true; readback crudo coincide', async () => {
    const driver = createFakeSyncDynamoDriver();
    const r = await probe.runCasProbe({ deps: depsCas(driver) });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    const c1 = r.checks.find((c) => c.id === 'cas-1');
    const c2 = r.checks.find((c) => c.id === 'cas-2');
    assert.equal(c1.datos.result.version, 1);
    assert.equal(c2.datos.result.conflict, true);
    assert.equal(c2.datos.result.ok, false);
    // La clave de sonda quedó en la partición correcta y con la versión 1.
    const raw = driver._raw(PROJECT_ID, `coord#${probe.PROBE_KEY}`);
    assert.equal(raw.body.version, 1);
    assert.equal(raw.body.value.attempt, 1, 'la 2ª escritura NO debe haber pisado a la 1ª');
});

test('CA-2 idempotente: una segunda corrida parte de la versión vigente y vuelve a demostrar el conflicto', async () => {
    const driver = createFakeSyncDynamoDriver();
    await probe.runCasProbe({ deps: depsCas(driver) });
    const r = await probe.runCasProbe({ deps: depsCas(driver) });
    assert.equal(r.ok, true);
    assert.equal(r.checks.find((c) => c.id === 'cas-1').datos.expectedVersion, 1);
    assert.equal(driver._raw(PROJECT_ID, `coord#${probe.PROBE_KEY}`).body.version, 2);
});

test('CA-2 rojo (SEC-2): identidad distinta del runtime ⇒ identidad_inesperada y NO se escribe nada', async () => {
    const driver = createFakeSyncDynamoDriver();
    const r = await probe.runCasProbe({ deps: depsCas(driver, { verifyRuntimeIdentity: identidadMal }) });
    assert.equal(r.ok, false);
    assert.deepEqual(causasDe(r), ['identidad_inesperada']);
    assert.equal(driver._calls.length, 0, 'ninguna llamada al driver con la identidad equivocada');
});

test('CA-2 rojo: driver.kind in-memory ⇒ driver_no_aws_cli (trampa §2.5), sin escribir', async () => {
    const driver = createFakeSyncDynamoDriver();
    driver.kind = 'in-memory';
    const r = await probe.runCasProbe({ deps: depsCas(driver) });
    assert.deepEqual(causasDe(r), ['driver_no_aws_cli']);
    assert.equal(driver._calls.length, 0);
});

test('CA-2 rojo: fuera de tests `fake-sync` tampoco pasa — sólo aws-cli / aws-cli-sync', async () => {
    const driver = createFakeSyncDynamoDriver();
    const r = await probe.runCasProbe({ deps: depsCas(driver, { allowedDriverKinds: undefined }) });
    assert.deepEqual(causasDe(r), ['driver_no_aws_cli']);
    assert.equal(probe.driverKindAllowed('aws-cli', {}), true);
    assert.equal(probe.driverKindAllowed('aws-cli-sync', {}), true);
    assert.equal(probe.driverKindAllowed('fake-sync', {}), false);
    assert.equal(probe.driverKindAllowed('in-memory', {}), false);
    assert.equal(probe.driverKindAllowed(undefined, {}), false);
});

test('CA-2 rojo: un store que acepta la 2ª escritura con la MISMA expectedVersion ⇒ cas_sin_conflicto', async () => {
    const driver = createFakeSyncDynamoDriver();
    let v = 0;
    const storeSinCas = {
        getState: async () => null,
        compareAndSet: async () => ({ ok: true, version: ++v }),
    };
    const r = await probe.runCasProbe({ deps: depsCas(driver, { createStore: () => storeSinCas, getItemConsistent: () => ({ ok: true, item: null }) }) });
    assert.ok(causasDe(r).includes('cas_sin_conflicto'), JSON.stringify(causasDe(r)));
});

test('CA-2 rojo: la 1ª escritura falla (permisos) ⇒ cas_primera_escritura_fallida', async () => {
    const driver = createFakeSyncDynamoDriver({ failWith: new Error('AccessDeniedException: not authorized to PutItem') });
    const r = await probe.runCasProbe({ deps: depsCas(driver) });
    assert.deepEqual(causasDe(r), ['cas_primera_escritura_fallida']);
});

test('CA-2 rojo: el readback crudo no coincide con lo escrito ⇒ readback_distinto; ausente ⇒ item_ausente_camino_b', async () => {
    const driver = createFakeSyncDynamoDriver();
    const r1 = await probe.runCasProbe({ deps: depsCas(driver, { getItemConsistent: () => ({ ok: true, item: { PK: PROJECT_ID, SK: `coord#${probe.PROBE_KEY}`, body: { version: 1, value: { otra: 'cosa' } } } }) }) });
    assert.deepEqual(causasDe(r1), ['readback_distinto']);
    const driver2 = createFakeSyncDynamoDriver();
    const r2 = await probe.runCasProbe({ deps: depsCas(driver2, { getItemConsistent: () => ({ ok: true, item: null }) }) });
    assert.deepEqual(causasDe(r2), ['item_ausente_camino_b']);
});

test('CA-2: la única escritura es la clave de sonda por compareAndSet — coord#waves y coord#partial-pause intactas', async () => {
    const driver = createFakeSyncDynamoDriver();
    await probe.runCasProbe({ deps: depsCas(driver) });
    assert.equal(driver._raw(PROJECT_ID, 'coord#waves'), undefined);
    assert.equal(driver._raw(PROJECT_ID, 'coord#partial-pause'), undefined);
    const puts = driver._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 1, 'un solo putItem: la 2ª escritura muere en el CAS antes de tocar el driver');
    assert.equal(puts[0].condOpts.conditionExpression, 'attribute_not_exists(#pk)');
});

// =============================================================================
// CA-3 · --positive
// =============================================================================

function depsPositive(backend, driver, over = {}) {
    return { config: CFG, backend, getItemConsistent: consistentReadFrom(driver), allowedDriverKinds: TEST_KINDS, ...over };
}

test('CA-3 verde: estado sembrado NO vacío, version ≥ 1 y sha256 idéntico por los dos caminos', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 3);
    seed(driver, 'partial-pause', allowlistConContenido(), 5);
    const r = await probe.runPositive({ deps: depsPositive(backend, driver) });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.equal(r.conteos, 'olas: 2 · allowlist: 3');
    assert.deepEqual(r.checks.map((c) => c.id), ['driver', 'A:waves', 'B:waves', 'A=B:waves', 'A:partial-pause', 'B:partial-pause', 'A=B:partial-pause']);
    assert.equal(r.checks.find((c) => c.id === 'A:waves').datos.version, 3);
}));

test('CA-3 rojo (fail-closed sobre vacío): store sin coord#waves ni coord#partial-pause ⇒ estado_vacio por los dos caminos, ningún verde', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    const r = await probe.runPositive({ deps: depsPositive(backend, driver) });
    assert.equal(r.ok, false);
    assert.deepEqual(causasDe(r), ['estado_vacio', 'estado_vacio', 'estado_vacio', 'estado_vacio']);
    assert.equal(r.checks.filter((c) => c.id.startsWith('A=B')).length, 0, 'sin contenido no hay comparación que pueda dar verde');
    assert.equal(r.conteos, 'olas: 0 · allowlist: 0');
}));

test('CA-3 rojo: 0 olas y allowlist vacía NO cierran la sonda (presente pero vacío ⇒ estado_vacio)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesVacio(), 1);
    seed(driver, 'partial-pause', allowlistVacia(), 1);
    const r = await probe.runPositive({ deps: depsPositive(backend, driver) });
    assert.equal(r.ok, false);
    assert.ok(causasDe(r).every((c) => c === 'estado_vacio'));
    assert.equal(causasDe(r).length, 4);
}));

test('CA-3 rojo: hash distinto por camino ⇒ hash_distinto_por_camino', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 2);
    seed(driver, 'partial-pause', allowlistConContenido(), 2);
    const otro = { ...allowlistConContenido(), allowed_issues: [1, 2, 3] };
    const caminoB = ({ pk, sk }) => (sk === 'coord#partial-pause'
        ? { ok: true, item: coord.buildCoordinationEnvelope({ projectId: PROJECT_ID, key: 'partial-pause', value: otro, version: 2, instanceId: PROJECT_ID, updatedAt: AHORA }) }
        : consistentReadFrom(driver)({ pk, sk }));
    const r = await probe.runPositive({ deps: depsPositive(backend, driver, { getItemConsistent: caminoB }) });
    assert.deepEqual(causasDe(r), ['hash_distinto_por_camino']);
}));

test('CA-3 rojo: driver.kind in-memory ⇒ driver_no_aws_cli antes de leer nada (trampa §2.5)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend({ kind: 'in-memory' });
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const r = await probe.runPositive({ deps: depsPositive(backend, driver) });
    assert.deepEqual(causasDe(r), ['driver_no_aws_cli']);
    assert.equal(driver._calls.length, 0);
}));

test('CA-3 rojo: el store degrada ⇒ lectura_degradada (nunca fallback a filesystem)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const { backend, driver } = remoteBackend();
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(wavesConContenido()));
    driver._setFailure(new Error('ETIMEDOUT'));
    const r = await probe.runPositive({ deps: depsPositive(backend, driver, { getItemConsistent: () => ({ ok: true, item: null }) }) });
    assert.ok(causasDe(r).includes('lectura_degradada'));
    assert.match(r.checks.find((c) => c.id === 'A:waves').detalle, /olas=0/);
}));

test('CA-3 rojo: ítem crudo de otra partición ⇒ clave_distinta; versión no entera ⇒ version_invalida; backend en fs ⇒ modo_no_remoto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const ajeno = ({ pk, sk }) => {
        const it = consistentReadFrom(driver)({ pk, sk }).item;
        if (sk === 'coord#waves') it.PK = 'otro-proyecto';
        if (sk === 'coord#partial-pause') it.body.version = '1';
        return { ok: true, item: it };
    };
    const r = await probe.runPositive({ deps: depsPositive(backend, driver, { getItemConsistent: ajeno }) });
    assert.deepEqual(causasDe(r), ['clave_distinta', 'version_invalida']);

    const fsBackend = withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => freshBackend());
    const r2 = await withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => probe.runPositive({ deps: depsPositive(fsBackend, driver) }));
    assert.deepEqual(causasDe(r2), ['modo_no_remoto']);
}));

test('CA-3 rojo: la lectura cruda falla (CLI) ⇒ aws_cli_failed', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async () => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const r = await probe.runPositive({ deps: depsPositive(backend, driver, { getItemConsistent: () => ({ ok: false, code: 'aws_cli_failed', error: 'exit 255' }) }) });
    assert.deepEqual(causasDe(r), ['aws_cli_failed', 'aws_cli_failed']);
}));

// =============================================================================
// CA-4 · --migration-dry-run (+ apply SÓLO contra fake)
// =============================================================================

function escribirFuentes(dir, { waves = wavesConContenido(), allowlist = allowlistConContenido() } = {}) {
    if (waves) fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(waves, null, 2));
    if (allowlist) fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(allowlist, null, 2));
}

const SOURCES_OPSTATE = migrate.SOURCES.filter((s) => s.key === 'waves' || s.key === 'partial-pause');

test('CA-4 verde: dry-run contra las fuentes con backup verificado contra su manifest y conteos `olas: n · allowlist: m`', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    const backupRoot = path.join(dir, 'backup');
    const r = await probe.runMigrationDryRun({ sourceDir: dir, backupRoot, deps: { projectContext: { namespaceEnabled: () => false, stateDir: () => dir }, now: () => AHORA } });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.equal(r.conteos, 'olas: 2 · allowlist: 3');
    assert.ok(fs.existsSync(path.join(r.backupDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(r.backupDir, 'waves.json')));
    assert.ok(fs.existsSync(path.join(r.backupDir, '.partial-pause.json')));
    assert.match(r.reporteMigrador, /\[DRY-RUN\]/);
    assert.equal(r.checksums.waves.checksum, migrate.sha256Canonical(wavesConContenido()));
}));

test('CA-4 rojo: falta una fuente ⇒ fuentes_ausentes y NO se crea backup', () => enTmp({}, async (dir) => {
    escribirFuentes(dir, { allowlist: null });
    const backupRoot = path.join(dir, 'backup');
    const r = await probe.runMigrationDryRun({ sourceDir: dir, backupRoot, deps: { projectContext: { namespaceEnabled: () => false, stateDir: () => dir } } });
    assert.deepEqual(causasDe(r), ['fuentes_ausentes']);
    assert.equal(fs.existsSync(backupRoot), false);
}));

test('CA-4 rojo: un backup alterado NO coincide con su manifest ⇒ backup_no_verificado', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    const backupRoot = path.join(dir, 'backup');
    const r = await probe.runMigrationDryRun({ sourceDir: dir, backupRoot, deps: { projectContext: { namespaceEnabled: () => false, stateDir: () => dir } } });
    assert.equal(r.ok, true);
    const alterado = { ...wavesConContenido(), planned_waves: [] };
    fs.writeFileSync(path.join(r.backupDir, 'waves.json'), JSON.stringify(alterado));
    const v = probe.verifyBackupAgainstManifest(r.backupDir);
    assert.equal(v.ok, false);
    assert.equal(v.files.find((f) => f.file === 'waves.json').ok, false);
    assert.equal(v.files.find((f) => f.file === '.partial-pause.json').ok, true);
    assert.equal(probe.verifyBackupAgainstManifest(path.join(dir, 'no-existe')).ok, false);
}));

test('CA-4 rojo: namespaceado ON con sourceDir distinto del de `--status` ⇒ state_dir_divergente (trampa §2.4)', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    const r = await probe.runMigrationDryRun({ backupRoot: path.join(dir, 'backup'), deps: {
        projectContext: { namespaceEnabled: () => true, stateDir: () => dir },
        namespaceStatus: () => ({ migrated: true, stateDir: path.join(dir, 'projects', 'otro') }),
    } });
    assert.deepEqual(causasDe(r), ['state_dir_divergente']);
}));

test('CA-4 rojo: el migrador devuelve error ⇒ dry_run_fallido', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    // backupRoot apuntando a un ARCHIVO ⇒ mkdir falla ⇒ backup_mkdir_failed.
    const backupRoot = path.join(dir, 'archivo-no-dir');
    fs.writeFileSync(backupRoot, 'x');
    const r = await probe.runMigrationDryRun({ sourceDir: dir, backupRoot, deps: { projectContext: { namespaceEnabled: () => false, stateDir: () => dir } } });
    assert.deepEqual(causasDe(r), ['dry_run_fallido']);
}));

test('CA-4 (apply SÓLO en test): migrateState({apply:true, store}) contra el fake con paridad sha256 + conteo', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    const driver = createFakeSyncDynamoDriver();
    const store = coord.createCoordinationStore({ driver, contextProjectId: PROJECT_ID, config: { kernel: { coordinationTableName: 'tabla-fake' } }, knownKeys: migrate.MIGRATION_KNOWN_KEYS });
    const r = await migrate.migrateState({ apply: true, store, sourceDir: dir, backupRoot: path.join(dir, 'backup'), sources: SOURCES_OPSTATE });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.actions, { waves: 'created', 'partial-pause': 'created' });
    assert.deepEqual(r.after.waves, r.before.waves);
    assert.deepEqual(r.after['partial-pause'], r.before['partial-pause']);
    // Lo escrito es legible por el backend síncrono con el MISMO fake.
    const { backend } = await withEnv({ PIPELINE_OPSTATE_DURABLE: '1' }, () => remoteBackend({ driver }));
    const leido = withEnv({ PIPELINE_OPSTATE_DURABLE: '1' }, () => backend.readKeyWithVersion('waves'));
    assert.equal(migrate.sha256Canonical(leido.value), r.before.waves.checksum);
    assert.equal(leido.version, 1);
    // Idempotente: una segunda pasada no reescribe.
    const r2 = await migrate.migrateState({ apply: true, store, sourceDir: dir, backupRoot: path.join(dir, 'backup'), sources: SOURCES_OPSTATE, now: AHORA + 1000 });
    assert.deepEqual(r2.actions, { waves: 'noop', 'partial-pause': 'noop' });
}));

test('CA-4 (apply SÓLO en test): integrity_mismatch aborta con el rollback a mano', () => enTmp({}, async (dir) => {
    escribirFuentes(dir);
    const driver = createFakeSyncDynamoDriver();
    const real = coord.createCoordinationStore({ driver, contextProjectId: PROJECT_ID, config: { kernel: { coordinationTableName: 'tabla-fake' } }, knownKeys: migrate.MIGRATION_KNOWN_KEYS });
    let escrito = false;
    const storeQueMiente = {
        ...real,
        initState: async (k, v) => { const res = await real.initState(k, v); escrito = true; return res; },
        getState: async (k) => {
            const st = await real.getState(k);
            if (st && escrito && k === 'waves') return { ...st, value: { ...st.value, planned_waves: [] } };
            return st;
        },
    };
    const r = await migrate.migrateState({ apply: true, store: storeQueMiente, sourceDir: dir, backupRoot: path.join(dir, 'backup'), sources: SOURCES_OPSTATE });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'integrity_mismatch');
    assert.ok(r.mismatches.some((m) => m.key === 'waves'));
    assert.match(r.rollbackCmd, /--rollback --from/);
}));

// =============================================================================
// CA-5 · --export-to-fs
// =============================================================================

test('CA-5 rojo: sin `.paused` el export se NIEGA (freno_ausente) y no lee ni escribe nada', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const r = await probe.runExportToFs({ deps: { backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir } } });
    assert.equal(r.ok, false);
    assert.deepEqual(causasDe(r), ['freno_ausente']);
    assert.match(r.checks[0].siguiente, /\/pausar/);
    assert.equal(driver._calls.length, 0, 'sin freno no se toca el store');
    assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.partial-pause.json')), false);
}));

test('CA-5 verde: con `.paused` presente reintegra olas + allowlist al stateDir, conteos correctos, sha256 del FS = del store, R8 con avance perdido 0', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 4);
    seed(driver, 'partial-pause', allowlistConContenido(), 9);
    fs.writeFileSync(path.join(dir, '.paused'), JSON.stringify({ source: 'manual', ts: '2026-09-14T00:00:00Z' }));
    const r = await probe.runExportToFs({ deps: { backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir } } });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.equal(r.conteos, 'olas: 2 · allowlist: 3 · avance perdido: 0');
    assert.match(r.r8, /^R8 \(tramo export\) · olas: 2 · allowlist: 3 · avance perdido: 0/);
    const wavesFs = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    const allowFs = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
    assert.equal(migrate.sha256Canonical(wavesFs), migrate.sha256Canonical(wavesConContenido()));
    assert.equal(migrate.sha256Canonical(allowFs), migrate.sha256Canonical(allowlistConContenido()));
    // `.paused` sigue ahí: el export no levanta el freno.
    assert.ok(fs.existsSync(path.join(dir, '.paused')));
}));

test('CA-5 rojo: store sin contenido para una clave ⇒ estado_vacio y NO se escribe NINGÚN archivo (nada a medias)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    fs.writeFileSync(path.join(dir, '.paused'), '{"source":"manual"}');
    const r = await probe.runExportToFs({ deps: { backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir } } });
    assert.deepEqual(causasDe(r), ['estado_vacio']);
    assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
}));

test('CA-5 rojo: store degradado ⇒ lectura_degradada; driver in-memory ⇒ driver_no_aws_cli; backend en fs ⇒ modo_no_remoto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    fs.writeFileSync(path.join(dir, '.paused'), '{"source":"manual"}');
    const a = remoteBackend();
    a.driver._setFailure(new Error('ETIMEDOUT'));
    const r1 = await probe.runExportToFs({ deps: { backend: a.backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir } } });
    assert.deepEqual(causasDe(r1), ['lectura_degradada', 'lectura_degradada']);

    const b = remoteBackend({ kind: 'in-memory' });
    const r2 = await probe.runExportToFs({ deps: { backend: b.backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir } } });
    assert.deepEqual(causasDe(r2), ['driver_no_aws_cli']);

    const c = withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => freshBackend());
    const r3 = await withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => probe.runExportToFs({ deps: { backend: c, projectContext: { stateDir: () => dir } } }));
    assert.deepEqual(causasDe(r3), ['modo_no_remoto']);
}));

test('CA-5 rojo: el archivo escrito no coincide con el store ⇒ export_hash_distinto y avance perdido > 0; fallo de escritura ⇒ export_escritura_fallida', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    fs.writeFileSync(path.join(dir, '.paused'), '{"source":"manual"}');
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const escribeMal = (file, data) => fs.writeFileSync(file, file.endsWith('waves.json') ? JSON.stringify(wavesVacio()) : data);
    const r1 = await probe.runExportToFs({ deps: { backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir }, writeFile: escribeMal } });
    assert.deepEqual(causasDe(r1), ['export_hash_distinto']);
    assert.equal(r1.conteos, 'olas: 2 · allowlist: 3 · avance perdido: 1');

    const r2 = await probe.runExportToFs({ deps: { backend, allowedDriverKinds: TEST_KINDS, projectContext: { stateDir: () => dir }, writeFile: () => { throw new Error('EACCES'); } } });
    assert.deepEqual(causasDe(r2), ['export_escritura_fallida', 'export_escritura_fallida']);
}));

// =============================================================================
// CA-6 · --abort-drill
// =============================================================================

test('CA-6 verde: sink real + halt inyectado + cutover_window:true (booleano) ⇒ `.paused` en disco; sin exit, sin throw, sin fallback', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const backend = freshBackend();
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    const r = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend, config: CFG } });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    const marker = JSON.parse(fs.readFileSync(path.join(sandbox, '.paused'), 'utf8'));
    assert.equal(marker.source, 'kernel-cutover-degraded-halt');
    assert.equal(marker.cause, 'red');
    assert.equal(r.sink.aborted, true);
    assert.deepEqual(r.sink.causes, ['red']);
    assert.equal(r.telegramNoEnviado.length, 1, 'el sink formateó la alerta pero NO la envió a ningún lado');
    assert.match(r.telegramNoEnviado[0], /PIPELINE PAUSADO/);
    assert.equal(fs.existsSync(path.join(dir, '.paused')), false, 'el `.pipeline/.paused` del pipeline NO se toca');
}));

for (const [literal, etiqueta] of [['true', '"true" (string)'], [1, '1 (number)'], [undefined, 'ausente']]) {
    test(`CA-6 rojo (SEC-4): cutover_window = ${etiqueta} ⇒ ventana_cerrada, sin \`.paused\`, literal y tipo en el detalle`, () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
        const backend = freshBackend();
        const sandbox = path.join(dir, 'sandbox');
        fs.mkdirSync(sandbox);
        const r = await probe.runAbortDrill({ dir: sandbox, window: literal, deps: { backend, config: CFG } });
        assert.equal(r.ok, false);
        assert.deepEqual(causasDe(r), ['ventana_cerrada']);
        assert.equal(fs.existsSync(path.join(sandbox, '.paused')), false);
        const ventana = r.checks.find((c) => c.id === 'ventana');
        assert.ok(ventana.detalle.includes(etiqueta), ventana.detalle);
        assert.equal(r.checks.find((c) => c.id === 'sec-4').ok, true);
        assert.equal(r.sink.aborted, false);
        // El backend igual denegó: value null + degraded (best-effort fuera de la ventana, §6).
        assert.equal(r.checks.find((c) => c.id === 'sin-fallback').ok, true);
    }));
}

test('CA-6: sin --window el drill usa el valor EFECTIVO del config (hoy false ⇒ ventana_cerrada)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const backend = freshBackend();
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    const r = await probe.runAbortDrill({ dir: sandbox, deps: { backend, config: CFG } });
    assert.deepEqual(causasDe(r), ['ventana_cerrada']);
    assert.match(r.checks.find((c) => c.id === 'ventana').detalle, /false \(boolean\).*config efectivo/);
}));

test('CA-6 rojo: el backend en modo filesystem no ejercita el sink ⇒ modo_no_remoto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, async (dir) => {
    const backend = freshBackend();
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    const r = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend, config: CFG } });
    assert.deepEqual(causasDe(r), ['modo_no_remoto']);
}));

test('CA-6 rojo: una pausa preexistente en el sandbox no se pisa ⇒ paused_no_escrito (el halt reporta preexisting)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const backend = freshBackend();
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    fs.writeFileSync(path.join(sandbox, '.paused'), JSON.stringify({ source: 'telegram', ts: '2026-09-14T00:00:00Z' }));
    const r = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend, config: CFG } });
    assert.deepEqual(causasDe(r), ['paused_no_escrito']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox, '.paused'), 'utf8')).source, 'telegram', 'la pausa de otro origen gana');
}));

test('CA-6 rojo: un backend que propaga la excepción del store ⇒ throw_propagado; uno que devuelve contenido ⇒ fallback_a_filesystem; uno que llama process.exit ⇒ process_exit_llamado', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    const base = () => ({ KEYS: { PARTIAL_PAUSE: 'partial-pause' }, isRemote: () => true, describeMode: () => ({}), setDegradationSink() {}, _setDriverForTests() {}, invalidateConfigCache() {} });

    const lanza = { ...base(), readKeyWithVersion() { throw new Error('boom'); } };
    const r1 = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend: lanza, config: CFG } });
    assert.ok(causasDe(r1).includes('throw_propagado'));

    const conFallback = { ...base(), readKeyWithVersion: () => ({ value: { allowed_issues: [1] }, version: '2026', remote: false, degraded: false, error: null }) };
    const r2 = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend: conFallback, config: CFG } });
    assert.ok(causasDe(r2).includes('fallback_a_filesystem'));

    const sale = { ...base(), readKeyWithVersion() { process.exit(3); } };
    const r3 = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend: sale, config: CFG } });
    assert.ok(causasDe(r3).includes('process_exit_llamado'));
    assert.equal(typeof process.exit, 'function', 'process.exit restaurado tras el drill');
}));

test('CA-6 rojo: un sink que no marca aborted con la ventana abierta ⇒ sink_no_aborto (cableado roto se detecta)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, async (dir) => {
    // Un backend que NO llama al sink (ni escribe `.paused`) simula el cableado roto.
    const sandbox = path.join(dir, 'sandbox');
    fs.mkdirSync(sandbox);
    const mudo = { KEYS: { PARTIAL_PAUSE: 'partial-pause' }, isRemote: () => true, describeMode: () => ({}), setDegradationSink() {}, _setDriverForTests() {}, invalidateConfigCache() {}, readKeyWithVersion: () => ({ value: null, version: null, remote: true, degraded: true, error: new Error('x') }) };
    const r = await probe.runAbortDrill({ dir: sandbox, window: true, deps: { backend: mudo, config: CFG } });
    assert.deepEqual(causasDe(r), ['sink_no_aborto', 'paused_no_escrito']);
}));

// =============================================================================
// CA-7 · CLI, render, redacción y evidencia
// =============================================================================

test('CLI: un solo subcomando por invocación, argumento desconocido ⇒ exit 2 con uso; --help ⇒ exit 0', async () => {
    const r1 = await probe.run(['--preconditions', '--positive']);
    assert.equal(r1.exitCode, 2);
    assert.match(r1.text, /un solo subcomando/);
    const r2 = await probe.run(['--preconditions', '--lo-que-sea']);
    assert.equal(r2.exitCode, 2);
    const r3 = await probe.run([]);
    assert.equal(r3.exitCode, 2);
    const r4 = await probe.run(['--help']);
    assert.equal(r4.exitCode, 0);
    assert.match(r4.text, /--abort-drill/);
});

test('CLI: --window parsea el literal como JSON y `absent` lo omite (SEC-4)', () => {
    assert.equal(probe.parseArgs(['--abort-drill', '--window', 'true']).args.window, true);
    assert.equal(probe.parseArgs(['--abort-drill', '--window', '"true"']).args.window, 'true');
    assert.equal(probe.parseArgs(['--abort-drill', '--window', '1']).args.window, 1);
    const ausente = probe.parseArgs(['--abort-drill', '--window', 'absent']).args;
    assert.equal(ausente.window, undefined);
    assert.equal(ausente.windowGiven, true);
    assert.equal(probe.literalWithType(true), 'true (boolean)');
    assert.equal(probe.literalWithType('true'), '"true" (string)');
    assert.equal(probe.literalWithType(1), '1 (number)');
    assert.equal(probe.literalWithType(undefined), 'ausente');
});

test('CLI: exit code coherente con el VEREDICTO por run() y --json termina en salto de línea', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const deps = depsPreconditions(dir, backend, { readServiceAuth: () => ({ ok: true, strict: false, pid: 123 }) }); // strict apagado ⇒ ROJO
    const r = await withEnv({ PIPELINE_OPSTATE_DURABLE: undefined }, () => probe.run(['--preconditions', '--json'], deps));
    assert.equal(r.exitCode, 1);
    assert.ok(r.text.endsWith('\n'));
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.veredicto, 'ROJO');
    assert.deepEqual(parsed.causas, ['strict_auth_apagado']);
    const txt = await withEnv({ PIPELINE_OPSTATE_DURABLE: undefined }, () => probe.run(['--preconditions'], deps));
    assert.match(txt.text, /^===== SONDA DEL ESTADO OPERATIVO · --preconditions =====/);
    assert.match(txt.text, /naturaleza: sonda de sólo lectura/);
    assert.match(txt.text, /\[FALLA\] CA-B1/);
    assert.match(txt.text, /VEREDICTO: ROJO/);
}));

test('CLI: --positive / --export-to-fs / --abort-drill fijan PIPELINE_OPSTATE_DURABLE=1 sólo en este proceso y el config no se toca', () => enTmp({}, async (dir) => {
    const { backend, driver } = remoteBackend();
    seed(driver, 'waves', wavesConContenido(), 1);
    seed(driver, 'partial-pause', allowlistConContenido(), 1);
    const r = await withEnv({ PIPELINE_OPSTATE_DURABLE: undefined }, async () => {
        const out = await probe.run(['--positive', '--json'], depsPositive(backend, driver));
        assert.equal(process.env.PIPELINE_OPSTATE_DURABLE, '1');
        return out;
    });
    assert.equal(process.env.PIPELINE_OPSTATE_DURABLE, undefined, 'withEnv restauró el entorno: el override vive sólo en la invocación');
    assert.equal(r.exitCode, 0, r.text);
}));

test('Redacción: account-ids de 12 dígitos y secretos NO llegan ni al texto ni al JSON', () => enTmp({}, async (dir) => {
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const deps = depsPreconditions(dir, backend, {
        verifyRuntimeIdentity: () => ({ ok: false, code: 'identidad_inesperada', error: 'identidad_inesperada: arn:aws:iam::123456789012:user/admin con AKIAABCDEFGHIJKLMNOP' }), // secret-scan:ignore — access key FALSA (AKIA + letras): es el veneno que el test verifica que la sonda redacta
    });
    const r = await probe.runPreconditions({ deps });
    const txt = probe.renderReport(r);
    const json = probe.renderJson(r);
    for (const out of [txt, json]) {
        assert.ok(!/123456789012/.test(out), 'account-id filtrado');
        assert.ok(!/AKIAABCDEFGHIJKLMNOP/.test(out), 'access key filtrada'); // secret-scan:ignore — misma clave falsa del veneno
        assert.ok(/<ACCT>/.test(out));
        assert.ok(/\[REDACTED\]/.test(out));
    }
}));

test('CA-7 / SEC-7: la evidencia commiteada en docs/pipeline/evidence/7189/ no contiene account-ids, ARNs ni claves', () => {
    const dir = path.resolve(__dirname, '..', '..', '..', 'docs', 'pipeline', 'evidence', '7189');
    assert.ok(fs.existsSync(dir), `falta ${dir}`);
    const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    assert.ok(files.length >= 6, `evidencia incompleta: ${files.join(', ')}`);
    const re = /[0-9]{12}|arn:aws:|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/;
    const hallazgos = [];
    for (const f of files) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
        lines.forEach((l, i) => { if (re.test(l)) hallazgos.push(`${f}:${i + 1}: ${l.slice(0, 120)}`); });
    }
    assert.deepEqual(hallazgos, []);
    for (const esperado of ['README.md', 'preconditions.json', 'cas-probe.json', 'positive-probe.json', 'migration-dry-run.txt', 'abort-drill.txt', 'redaction-check.txt']) {
        assert.ok(files.includes(esperado), `falta ${esperado}`);
    }
});

test('Conteos: `countOperational` cuenta olas (activa + planificadas + archivadas) y la allowlist; el formato es único', () => {
    assert.deepEqual(probe.countOperational('waves', wavesConContenido()), { label: 'olas', count: 2 });
    assert.deepEqual(probe.countOperational('waves', wavesVacio()), { label: 'olas', count: 0 });
    assert.deepEqual(probe.countOperational('waves', null), { label: 'olas', count: 0 });
    assert.deepEqual(probe.countOperational('partial-pause', allowlistConContenido()), { label: 'allowlist', count: 3 });
    assert.deepEqual(probe.countOperational('partial-pause', {}), { label: 'allowlist', count: 0 });
    assert.equal(probe.formatCounts({ olas: 12, allowlist: 54 }), 'olas: 12 · allowlist: 54');
    assert.equal(probe.formatCounts({ olas: 12, allowlist: 54, avancePerdido: 0 }), 'olas: 12 · allowlist: 54 · avance perdido: 0');
});

test('Contrato: toda causa que emite la sonda existe en CAUSAS con su línea "→", y `_describeDriver` del backend nunca devuelve el driver', () => {
    for (const [causa, siguiente] of Object.entries(probe.CAUSAS)) {
        assert.ok(typeof siguiente === 'string' && siguiente.length > 20, causa);
    }
    const { backend } = remoteBackend({ kind: 'aws-cli-sync' });
    const d = backend._describeDriver();
    assert.deepEqual(Object.keys(d).sort(), ['atomicUpdate', 'kind', 'projectId', 'tableName']);
    assert.equal(d.kind, 'aws-cli-sync');
    assert.equal(d.atomicUpdate, true);
});
