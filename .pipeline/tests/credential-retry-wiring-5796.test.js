// =============================================================================
// credential-retry-wiring-5796.test.js — #5796
//
// QUÉ PRUEBA
// ----------
// Que el coordinador de retry de credencial (#5794) esté REALMENTE cableado en
// los cuatro caminos de lanzamiento del Pulpo —agente normal, Commander,
// intento primario y cada eslabón de fallback— compartiendo UNA operación raíz,
// UN presupuesto y UNA frontera de env.
//
// La suite tiene dos mitades deliberadamente distintas:
//
//   1. FUNCIONAL sobre `lib/credential-retry-wiring.js`: paridad con el gate
//      cerrado, presupuesto único cross-provider, concurrencia, no-mutación de
//      `process.env`, casos negativos y redacción del audit. Todo inyectado: no
//      toca el vault, ni el filesystem real, ni `process.env`.
//
//   2. BARRIDO DE FUENTE sobre `pulpo.js`: que los call-sites existan y estén
//      cableados. Es la mitad incómoda pero necesaria — `pulpo.js` tiene 26k
//      líneas y sus tres sitios de env están a miles de líneas uno de otro, así
//      que "cablear dos y olvidar el tercero" es el modo de falla realista de
//      este issue, y ningún test funcional del módulo lo detecta.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wiring = require('../lib/credential-retry-wiring');
const credentialRetry = require('../lib/credential-auth-retry');
const { AUTH_REJECTED_CLASS } = require('../lib/agent-launcher/dispatch-with-fallback');

const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8');

const GATE_ABIERTO = { pipeline: { credential_retry_enabled: true } };
const GATE_CERRADO = { pipeline: { credential_retry_enabled: false } };
const SCOPES_INVALIDABLES = ['google_drive', 'providers', 'telegram'];
const CATALOGO = { 'agent-child': { scopes: ['providers'] }, commander: { scopes: ['providers'] } };

/** Proyección tipada de rechazo, con la forma que emite `projectAuthRejection`. */
function rechazoTipado({ provider = 'anthropic', operationId = 'op-1', path: p = 'primary', attempt = 1 } = {}) {
    return Object.freeze({
        kind: AUTH_REJECTED_CLASS,
        provider, operationId, path: p, attempt,
        signal: Object.freeze({
            source: 'cli-stream-json', code: 'authentication_error', status: 401, type: null,
        }),
    });
}

/** Veredicto de `onSpawnExit` con y sin rechazo de credencial. */
const veredictoOk = () => ({ errorClass: 'unknown', authenticationRejection: null });
const veredictoRechazado = (extra = {}) => ({
    errorClass: 'authentication_rejected', authenticationRejection: rechazoTipado(extra),
});

/** Corre un camino completo y devuelve todo lo observable de esa corrida. */
async function correrCamino({
    operation, provider, path: camino, destination, desenlaces, invalidar, eventos,
}) {
    const llamadas = { snapshots: [], ejecuciones: [] };
    let i = 0;
    const r = { ok: false, error: null, resultado: null };
    try {
        const salida = await wiring.runAttempt({
            operation, provider, path: camino, destination,
            invalidableScopes: SCOPES_INVALIDABLES,
            destinationsCatalog: CATALOGO,
            invalidate: invalidar || (async () => { throw new Error('no debería invalidar'); }),
            emit: (e) => eventos.push(e),
            createSnapshot: async (ctx) => {
                llamadas.snapshots.push({ attempt: ctx.attempt, provider: ctx.provider, scope: ctx.scope });
                // Identidad DISTINTA por intento: dos intentos jamás comparten
                // el objeto de credenciales (invariante de #5798/#5799).
                return { keys: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: `k-${camino}-${ctx.attempt}` } };
            },
            execute: async (ctx) => {
                llamadas.ejecuciones.push({ attempt: ctx.attempt, provider: ctx.provider, path: ctx.path, snapshot: ctx.snapshot });
                const paso = desenlaces[i] !== undefined ? desenlaces[i] : desenlaces[desenlaces.length - 1];
                i += 1;
                return typeof paso === 'function' ? paso(ctx) : paso;
            },
        });
        r.ok = true;
        r.resultado = salida;
    } catch (e) {
        r.error = e;
    }
    return { ...r, llamadas };
}

// -----------------------------------------------------------------------------
// 1. Gate — el rollout no puede cambiar nada estando apagado.
// -----------------------------------------------------------------------------

test('el gate es fail-closed: sólo el booleano true exacto abre el retry', () => {
    assert.strictEqual(wiring.isRetryEnabled(GATE_ABIERTO), true);
    for (const valor of [false, 'true', 1, 'yes', null, undefined, {}, []]) {
        assert.strictEqual(
            wiring.isRetryEnabled({ pipeline: { credential_retry_enabled: valor } }), false,
            `El valor ${JSON.stringify(valor)} NO puede abrir el gate (fail-closed).`,
        );
    }
    assert.strictEqual(wiring.isRetryEnabled({}), false);
    assert.strictEqual(wiring.isRetryEnabled(null), false);
});

test('el gate del retry es PROPIO y no reusa el del snapshot', () => {
    assert.strictEqual(
        wiring.isRetryEnabled({ pipeline: { credential_snapshot_enabled: true } }), false,
        'Abrir el snapshot no puede encender el retry: son dos features distintas.',
    );
    assert.match(CONFIG_SRC, /credential_retry_enabled:\s*false/,
        'config.yaml debe declarar el gate propio, apagado por default.');
    assert.match(CONFIG_SRC, /credential_snapshot_enabled:\s*false/,
        'El gate de snapshot sigue siendo independiente y también apagado.');
});

test('con el gate cerrado el camino es no-op bit a bit: un snapshot, un execute, cero eventos', async () => {
    const eventos = [];
    const operation = wiring.getOrCreateOperation({
        key: 'k', config: GATE_CERRADO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    assert.strictEqual(operation, null, 'Con el gate cerrado no se crea operación.');

    const r = await correrCamino({
        operation, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        // Aunque el desenlace sea un rechazo REAL de credencial, con el gate
        // cerrado no se invalida, no se re-resuelve y no se reintenta.
        desenlaces: [veredictoRechazado()], eventos,
    });

    assert.strictEqual(r.ok, true, 'El camino no-op nunca falla cerrado.');
    assert.strictEqual(r.llamadas.snapshots.length, 1, 'Exactamente un snapshot.');
    assert.strictEqual(r.llamadas.ejecuciones.length, 1, 'Exactamente un execute (= un spawn).');
    assert.strictEqual(eventos.length, 0, 'Cero eventos de auditoría: el rollout apagado es silencioso.');
    assert.strictEqual(r.resultado.retryUsed, false);
    assert.strictEqual(r.resultado.attempts, 1);
});

// -----------------------------------------------------------------------------
// 2. La tabla de caminos — CA-1 y CA-2.
// -----------------------------------------------------------------------------

const CAMINOS = [
    { nombre: 'agente normal (primario)', provider: 'anthropic', path: 'primary', destination: 'agent-child' },
    { nombre: 'agente (fallback)', provider: 'openai-codex', path: 'fallback:1:openai-codex', destination: 'agent-child' },
    { nombre: 'Commander (primario)', provider: 'anthropic', path: 'primary', destination: 'commander' },
    { nombre: 'Commander (fallback)', provider: 'cerebras', path: 'fallback:0:cerebras', destination: 'commander' },
];

for (const camino of CAMINOS) {
    test(`camino "${camino.nombre}": pasa por el coordinador con snapshot propio y operation_id no nulo`, async () => {
        const eventos = [];
        const registry = new Map();
        const operation = wiring.getOrCreateOperation({
            key: 'turno', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 5796, registry,
        });
        const r = await correrCamino({
            operation, provider: camino.provider, path: camino.path, destination: camino.destination,
            desenlaces: [veredictoRechazado(), veredictoOk()],
            invalidar: async () => ({ invalidadas: 2 }),
            eventos,
        });

        assert.strictEqual(r.ok, true, 'Tras invalidar y re-resolver, el reintento cierra bien.');
        assert.strictEqual(r.resultado.attempts, 2);
        assert.strictEqual(r.resultado.retryUsed, true);

        // Snapshot INDEPENDIENTE por intento: ni el mismo objeto ni el mismo valor.
        assert.strictEqual(r.llamadas.snapshots.length, 2);
        assert.notStrictEqual(
            r.llamadas.ejecuciones[0].snapshot, r.llamadas.ejecuciones[1].snapshot,
            'El reintento no puede recibir el mismo objeto de snapshot que el intento rechazado.',
        );
        assert.notStrictEqual(
            r.llamadas.ejecuciones[0].snapshot.env.ANTHROPIC_API_KEY,
            r.llamadas.ejecuciones[1].snapshot.env.ANTHROPIC_API_KEY,
            'El reintento tiene que correr con material RE-RESUELTO, no con el rechazado.',
        );

        // El scope sale del catálogo, no de un literal del call-site.
        assert.strictEqual(r.llamadas.snapshots[0].scope, 'providers');

        // CA: `operation_id` NO puede quedar en null en silencio en NINGÚN evento.
        assert.ok(eventos.length >= 2, 'Invalidación y re-resolución quedan auditadas.');
        for (const e of eventos) {
            assert.strictEqual(e.operation_id, operation.operationId,
                'Un operation_id nulo deja al operador sin correlación y sin aviso.');
            assert.strictEqual(e.path, camino.path);
            assert.strictEqual(e.provider, camino.provider);
            assert.strictEqual(e.scope, 'providers');
        }
    });
}

test('un cambio de provider conserva el operation_id y el presupuesto ya consumido', async () => {
    const eventos = [];
    const registry = new Map();
    const clave = 'desarrollo/dev/guru:5796';
    const config = GATE_ABIERTO;

    // Primer camino: el primario se lleva el único retry de la operación.
    const op1 = wiring.getOrCreateOperation({ key: clave, config, kind: 'agent', skill: 'guru', issue: 5796, registry });
    const primario = await correrCamino({
        operation: op1, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        desenlaces: [veredictoRechazado(), veredictoOk()],
        invalidar: async () => ({ invalidadas: 1 }),
        eventos,
    });
    assert.strictEqual(primario.ok, true);

    // Segundo camino: OTRO provider, OTRO lanzamiento — pero la misma operación
    // raíz, porque es el mismo lanzamiento lógico dentro del TTL.
    const op2 = wiring.getOrCreateOperation({ key: clave, config, kind: 'agent', skill: 'guru', issue: 5796, registry });
    assert.strictEqual(op2, op1, 'El cambio de camino NO puede crear una operación nueva.');

    const fallback = await correrCamino({
        operation: op2, provider: 'openai-codex', path: 'fallback:1:openai-codex', destination: 'agent-child',
        desenlaces: [veredictoRechazado()],
        invalidar: async () => { throw new Error('el fallback NO puede invalidar de nuevo'); },
        eventos,
    });

    assert.strictEqual(fallback.ok, false, 'Con el presupuesto gastado se falla CERRADO.');
    assert.strictEqual(fallback.error.code, credentialRetry.RETRY_ERROR_CODES.CLOSED);
    assert.strictEqual(fallback.error.reason, credentialRetry.CLOSE_REASONS.BUDGET_EXHAUSTED);
    assert.strictEqual(fallback.llamadas.ejecuciones.length, 1, 'Sin segundo spawn en el fallback.');

    // Cardinalidad: UN operation_id y UNA sola invalidación en toda la cascada.
    const ids = new Set(eventos.map((e) => e.operation_id));
    assert.strictEqual(ids.size, 1, `Se esperaba exactamente 1 operation_id, hubo ${ids.size}.`);
    assert.strictEqual(op1.invalidations, 1, 'Exactamente una invalidación para toda la operación.');
    assert.strictEqual(op1.reresolutions, 1, 'Exactamente una re-resolución.');
    assert.strictEqual(
        eventos.filter((e) => e.event === credentialRetry.RETRY_EVENTS.INVALIDATED).length, 1,
        'Dos invalidaciones serían una estampida contra el vault por cada caída de credencial.',
    );
});

test('un segundo rechazo cierra sin tercer intento', async () => {
    const eventos = [];
    const op = wiring.getOrCreateOperation({
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    const r = await correrCamino({
        operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        desenlaces: [veredictoRechazado(), veredictoRechazado()],
        invalidar: async () => ({ invalidadas: 1 }),
        eventos,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.reason, credentialRetry.CLOSE_REASONS.SECOND_REJECTION);
    assert.strictEqual(r.llamadas.ejecuciones.length, 2, 'Dos intentos como máximo: nunca un tercero.');
});

// -----------------------------------------------------------------------------
// 3. Casos negativos — qué NO puede consumir el retry de credencial.
// -----------------------------------------------------------------------------

const NO_SON_RECHAZO_DE_CREDENCIAL = [
    ['timeout', { errorClass: 'timeout', authenticationRejection: null }],
    ['5xx del provider', { errorClass: 'server_error', authenticationRejection: null }],
    ['429 / cuota', { errorClass: 'quota_exhausted', authenticationRejection: null }],
    ['permisos', { errorClass: 'permission_denied', authenticationRejection: null }],
    ['401/403 genérico sin señal tipada', { errorClass: 'unknown', authenticationRejection: null }],
    ['configuración faltante', { errorClass: 'config_error', authenticationRejection: null }],
    ['texto libre que "parece" auth', { errorClass: 'unknown', stderr: 'invalid api key: authentication_error 401' }],
    ['proyección de otra clase', { authenticationRejection: { kind: 'quota_exhausted', signal: { code: 'x' } } }],
    ['proyección sin signal', { authenticationRejection: { kind: AUTH_REJECTED_CLASS } }],
];

for (const [nombre, desenlace] of NO_SON_RECHAZO_DE_CREDENCIAL) {
    test(`"${nombre}" NO consume el retry ni invalida nada`, async () => {
        const eventos = [];
        const op = wiring.getOrCreateOperation({
            key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
        });
        const r = await correrCamino({
            operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
            desenlaces: [desenlace], eventos,
        });
        assert.strictEqual(r.ok, true, 'Un error común sale por el camino de siempre.');
        assert.strictEqual(op.retryConsumed, false, 'El presupuesto queda intacto para el rechazo REAL.');
        assert.strictEqual(op.invalidations, 0);
        assert.strictEqual(eventos.length, 0);
        assert.strictEqual(r.llamadas.ejecuciones.length, 1);
    });
}

test('isAuthRejection usa el mismo criterio que el coordinador, no una heurística de texto', () => {
    assert.strictEqual(wiring.isAuthRejection(veredictoRechazado()), true);
    assert.strictEqual(wiring.isAuthRejection(veredictoOk()), false);
    assert.strictEqual(wiring.isAuthRejection({ stderr: 'authentication_error 401 invalid_api_key' }), false);
    assert.strictEqual(wiring.isAuthRejection(null), false);
    assert.strictEqual(wiring.isAuthRejection('authentication_rejected'), false);
});

// -----------------------------------------------------------------------------
// 4. `operationId` — construcción, fail-closed y correlación.
// -----------------------------------------------------------------------------

test('el operationId se construye sólo con tokens del pipeline y pasa el validador del dispatcher', () => {
    const id = wiring.buildOperationId({ kind: 'agent', skill: 'pipeline-dev', issue: 5796, nonce: 'ab12cd34' });
    assert.strictEqual(id, 'agent:pipeline-dev:5796:ab12cd34');
    assert.match(id, /^[A-Za-z0-9_.:@/#-]{1,128}$/, 'Debe pasar `normalizeContextToken` o la correlación se pierde en silencio.');

    // Dos lanzamientos del mismo skill/issue no comparten id: el nonce es criptográfico.
    const a = wiring.buildOperationId({ kind: 'agent', skill: 's', issue: 1 });
    const b = wiring.buildOperationId({ kind: 'agent', skill: 's', issue: 1 });
    assert.notStrictEqual(a, b);
});

test('un operationId con material hostil se sanea y sigue siendo un token válido', () => {
    // El skill y el issue son tokens del PIPELINE, pero igual se normalizan: un
    // salto de línea o una comilla descartarían el id ENTERO en el validador del
    // dispatcher, y el rechazo viajaría al audit sin correlación y sin aviso.
    const id = wiring.buildOperationId({
        kind: 'agent',
        skill: 'gu ru\n--inject "x"',
        issue: '57 96',
        nonce: 'n\u0000once',
    });
    assert.ok(id, 'El id se sanea, no se descarta.');
    assert.match(id, /^[A-Za-z0-9_.:@/#-]{1,128}$/);
    assert.ok(!/\s|"|'/.test(id), 'Nada de espacios, saltos de línea ni comillas en el id.');
});

test('el operationId nunca excede el límite del validador, por largos que sean los tokens', () => {
    // `normalizeContextToken` DESCARTA (no recorta) cualquier token de más de
    // 128 chars: un skill con nombre largo tiraría la correlación en silencio.
    // Por eso cada segmento se acota antes de unir.
    const id = wiring.buildOperationId({
        kind: 'agent', skill: 'x'.repeat(400), issue: '9'.repeat(200), nonce: 'z'.repeat(200),
    });
    assert.ok(id, 'El id se acota, no se descarta.');
    assert.ok(id.length <= 128, `El id mide ${id.length} chars y el validador corta en 128.`);
    assert.match(id, /^[A-Za-z0-9_.:@/#-]{1,128}$/);
});

test('createRootOperation falla CERRADO si no puede construir una identidad raíz', () => {
    // Sin `kind` no hay identidad de operación: se devuelve `null` y el
    // lanzamiento sigue SIN retry, en vez de inventar un id.
    const avisos = [];
    const op = wiring.createRootOperation({
        config: GATE_ABIERTO, kind: '', skill: 'guru', issue: 1, logger: (m) => avisos.push(m),
    });
    assert.strictEqual(op, null);
    assert.strictEqual(avisos.length, 1, 'El degradado no puede ser silencioso.');
    assert.match(avisos[0], /SIN retry de credencial/);
});

test('el registro de operaciones respeta el TTL y no arrastra un presupuesto gastado para siempre', () => {
    const registry = new Map();
    let ahora = 1_000_000;
    const now = () => ahora;
    const args = { key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry, now, ttlMs: 1000 };

    const a = wiring.getOrCreateOperation(args);
    a.retryConsumed = true;
    assert.strictEqual(wiring.getOrCreateOperation(args), a, 'Dentro del TTL se reusa (presupuesto compartido).');

    ahora += 5000;
    const b = wiring.getOrCreateOperation(args);
    assert.notStrictEqual(b, a, 'Pasado el TTL, el issue vuelve a tener presupuesto propio.');
    assert.strictEqual(b.retryConsumed, false);
});

test('forgetOperation libera el presupuesto cuando la corrida cerró por otra causa', () => {
    const registry = new Map();
    const args = { key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry };
    const a = wiring.getOrCreateOperation(args);
    a.retryConsumed = true;
    assert.strictEqual(wiring.forgetOperation({ key: 'k', registry }), true);
    assert.strictEqual(wiring.forgetOperation({ key: 'k', registry }), false, 'Idempotente.');
    const b = wiring.getOrCreateOperation(args);
    assert.notStrictEqual(b, a);
    assert.strictEqual(b.retryConsumed, false);
});

// -----------------------------------------------------------------------------
// 5. Concurrencia y no-mutación de `process.env`.
// -----------------------------------------------------------------------------

test('dos lanzamientos concurrentes no comparten snapshot ni se roban el presupuesto', async () => {
    const registry = new Map();
    const eventos = [];
    const opA = wiring.getOrCreateOperation({ key: 'A', config: GATE_ABIERTO, kind: 'agent', skill: 'a', issue: 1, registry });
    const opB = wiring.getOrCreateOperation({ key: 'B', config: GATE_ABIERTO, kind: 'agent', skill: 'b', issue: 2, registry });
    assert.notStrictEqual(opA.operationId, opB.operationId);

    const [a, b] = await Promise.all([
        correrCamino({
            operation: opA, provider: 'anthropic', path: 'primary', destination: 'agent-child',
            desenlaces: [veredictoRechazado(), veredictoOk()], invalidar: async () => ({ invalidadas: 1 }), eventos,
        }),
        correrCamino({
            operation: opB, provider: 'cerebras', path: 'primary', destination: 'commander',
            desenlaces: [veredictoRechazado(), veredictoOk()], invalidar: async () => ({ invalidadas: 1 }), eventos,
        }),
    ]);

    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    // Cada operación gastó SU retry: ninguna se comió el de la otra.
    assert.strictEqual(opA.retryConsumed, true);
    assert.strictEqual(opB.retryConsumed, true);
    assert.strictEqual(opA.invalidations, 1);
    assert.strictEqual(opB.invalidations, 1);

    // Sin referencias compartidas entre snapshots de lanzamientos distintos:
    // mutar uno no puede alterar el otro.
    const envA = a.llamadas.ejecuciones[0].snapshot.env;
    const envB = b.llamadas.ejecuciones[0].snapshot.env;
    assert.notStrictEqual(envA, envB);
    envA.ANTHROPIC_API_KEY = 'mutado';
    assert.notStrictEqual(envB.ANTHROPIC_API_KEY, 'mutado');
});

test('el coordinador no muta process.env (comparación profunda antes/después)', async () => {
    const antes = JSON.stringify(Object.entries(process.env).sort());
    const eventos = [];
    const op = wiring.getOrCreateOperation({
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    await correrCamino({
        operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        desenlaces: [veredictoRechazado(), veredictoOk()], invalidar: async () => ({ invalidadas: 1 }), eventos,
    });
    const despues = JSON.stringify(Object.entries(process.env).sort());
    assert.strictEqual(despues, antes, 'La rehidratación es local al intento: `process.env` NO se toca.');
});

// -----------------------------------------------------------------------------
// 6. Redacción — nada del provider puede llegar al audit.
// -----------------------------------------------------------------------------

test('los eventos persistidos no transportan secretos ni texto del provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-wiring-5796-'));
    try {
        const emisor = wiring.makeAuditEmitter({ pipelineDir: dir });
        const eventos = [];
        const op = wiring.getOrCreateOperation({
            key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
        });
        // Canario SINTETICO, no es una credencial: el test verifica justamente
        // que este valor NO aparezca en el audit. Se declara como falso positivo
        // por linea (el escape que define el propio scanner) en vez de exceptuar
        // el path entero en el allowlist.
        const CANARIO = 'sk-ant-CANARIO-COMPLETO-0123456789'; // secret-scan:ignore
        await wiring.runAttempt({
            operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
            invalidableScopes: SCOPES_INVALIDABLES, destinationsCatalog: CATALOGO,
            invalidate: async () => ({ invalidadas: 1 }),
            createSnapshot: async () => ({ keys: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: CANARIO } }),
            execute: async (ctx) => (ctx.attempt === 1
                ? {
                    ...veredictoRechazado(),
                    // Superficies por las que un secreto intentaría colarse.
                    message: `401 invalid key ${CANARIO}`,
                    stderr: `x-api-key: ${CANARIO}`,
                    headers: { authorization: `Bearer ${CANARIO}` },
                    payload: { token: CANARIO },
                }
                : veredictoOk()),
            emit: (e) => { eventos.push(e); emisor(e); },
        });

        const jsonl = fs.readdirSync(path.join(dir, 'logs'))
            .map((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('');
        assert.ok(jsonl.length > 0, 'El audit se escribió.');
        assert.ok(!jsonl.includes(CANARIO), 'El canario COMPLETO no puede estar en el audit.');
        assert.ok(!jsonl.includes('CANARIO'), 'Tampoco una porción reconocible del canario.');
        assert.ok(!jsonl.includes('Bearer'), 'Ni headers de autorización.');
        assert.ok(!/invalid key/.test(jsonl), 'Ni el mensaje crudo del provider.');

        // Del snapshot sólo puede viajar la CANTIDAD de claves, nunca sus valores.
        const reresuelto = eventos.find((e) => e.event === credentialRetry.RETRY_EVENTS.RERESOLVED);
        assert.strictEqual(reresuelto.snapshot_keys, 1);
        for (const e of eventos) {
            assert.deepStrictEqual(Object.keys(e), credentialRetry.EVENT_FIELDS,
                'El evento no puede tener una sola clave fuera de la allowlist.');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('un sink de auditoría roto no tumba el camino caliente del spawn', async () => {
    const emisor = wiring.makeAuditEmitter({
        pipelineDir: '/ruta/inexistente/imposible',
        fsImpl: { mkdirSync() { throw new Error('EACCES'); }, appendFileSync() { throw new Error('ENOSPC'); } },
    });
    assert.doesNotThrow(() => emisor({ event: 'credential_invalidated' }));

    const op = wiring.getOrCreateOperation({
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    const r = await correrCamino({
        operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        desenlaces: [veredictoRechazado(), veredictoOk()],
        invalidar: async () => ({ invalidadas: 1 }),
        eventos: { push() { throw new Error('sink roto'); } },
    });
    assert.strictEqual(r.ok, true, 'El spawn sigue aunque la auditoría falle: es best-effort por diseño.');
});

// -----------------------------------------------------------------------------
// 7. Replay — la adaptación al lifecycle fire-and-forget del agente.
// -----------------------------------------------------------------------------

test('runReplayAttempt no vuelve a pedir credencial para el intento que ya ocurrió', async () => {
    const eventos = [];
    const op = wiring.getOrCreateOperation({
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    const pedidos = [];
    const envDelIntento1 = { ANTHROPIC_API_KEY: 'el-que-ya-corrio' };
    const reintentos = [];

    const r = await wiring.runReplayAttempt({
        operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        invalidableScopes: SCOPES_INVALIDABLES, destinationsCatalog: CATALOGO,
        firstSnapshot: envDelIntento1,
        firstOutcome: veredictoRechazado(),
        invalidate: async () => ({ invalidadas: 3 }),
        createSnapshot: async (ctx) => { pedidos.push(ctx.attempt); return { keys: ['K'], env: { K: 'fresco' } }; },
        retryExecute: async (ctx) => { reintentos.push(ctx.attempt); return { credentialRetryQueued: true }; },
        emit: (e) => eventos.push(e),
    });

    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(pedidos, [2], 'Sólo se re-resuelve para el intento 2: el 1 ya corrió.');
    assert.deepStrictEqual(reintentos, [2], 'El reintento se ejecuta exactamente una vez.');
    assert.strictEqual(op.invalidations, 1);
    assert.strictEqual(op.reresolutions, 1);
    assert.strictEqual(op.retryConsumed, true);
});

test('runReplayAttempt no reintenta si el desenlace no era un rechazo de credencial', async () => {
    const op = wiring.getOrCreateOperation({
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1, registry: new Map(),
    });
    let reintentos = 0;
    const r = await wiring.runReplayAttempt({
        operation: op, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        invalidableScopes: SCOPES_INVALIDABLES, destinationsCatalog: CATALOGO,
        firstSnapshot: {}, firstOutcome: { errorClass: 'timeout', authenticationRejection: null },
        invalidate: async () => { throw new Error('no debería invalidar'); },
        createSnapshot: async () => { throw new Error('no debería re-resolver'); },
        retryExecute: async () => { reintentos += 1; return {}; },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(reintentos, 0);
    assert.strictEqual(op.retryConsumed, false);
});

// -----------------------------------------------------------------------------
// 8. Barrido de fuente sobre pulpo.js — que el cableado exista de verdad.
// -----------------------------------------------------------------------------

test('pulpo.js requiere el cableado y NO reimplementa la política del coordinador', () => {
    assert.match(PULPO_SRC, /require\('\.\/lib\/credential-retry-wiring'\)/,
        'El Pulpo tiene que consumir el cableado: sin este require el coordinador queda huérfano.');
    // La política vive en el coordinador. Un `consumeRetry` o un `resetVaultCache`
    // escritos a mano en pulpo.js serían un segundo dueño del presupuesto.
    assert.ok(!/consumeRetry\(/.test(PULPO_SRC),
        'pulpo.js no puede consumir el presupuesto por su cuenta: eso es del coordinador.');
    assert.ok(!/resetVaultCache\(/.test(PULPO_SRC),
        'pulpo.js no puede invalidar la caché del vault por su cuenta.');
});

test('los tres onSpawnExit del Pulpo propagan el contexto de la operación raíz', () => {
    const llamadas = PULPO_SRC.split('onSpawnExit({').slice(1);
    assert.strictEqual(llamadas.length, 3,
        `Se esperaban 3 llamadas a onSpawnExit (agente generalizado, agente legacy, Commander), hay ${llamadas.length}. ` +
        'Si se agregó un cuarto camino, tiene que propagar operationId/path/attempt como los otros tres.');
    for (const [i, cruda] of llamadas.entries()) {
        const bloque = cruda.slice(0, 1600);
        for (const campo of ['operationId:', 'path:', 'attempt:']) {
            assert.ok(bloque.includes(campo),
                `La llamada #${i + 1} a onSpawnExit no pasa \`${campo}\`. Sin los tres campos, ` +
                '`projectAuthRejection` los deja en null y el audit no puede correlacionar.');
        }
    }
});

test('la operación raíz del agente se crea ANTES de resolver el provider', () => {
    const iOperacion = PULPO_SRC.indexOf('credentialRetryWiring.getOrCreateOperation({');
    const iResolver = PULPO_SRC.indexOf('dispatchResolution = resolveSpawnWithFallback({');
    assert.ok(iOperacion > 0 && iResolver > 0, 'Ambos sitios tienen que existir.');
    assert.ok(iOperacion < iResolver,
        'Si la operación naciera después del resolver, un lanzamiento cascadeado sería "otra" ' +
        'operación y cada provider se ganaría un retry propio.');
});

test('el Commander crea su operación del turno y la comparte con el fallback', () => {
    assert.match(PULPO_SRC, /commanderCredentialOperation = credentialRetryWiring\.getOrCreateOperation\(\{/);
    // El eslabón de fallback y el primario referencian la MISMA variable.
    const usos = (PULPO_SRC.match(/operation: commanderCredentialOperation,/g) || []).length;
    assert.ok(usos >= 2,
        `El primario y el fallback del Commander tienen que compartir la operación del turno (usos=${usos}).`);
});

test('la frontera de env sigue siendo la última operación de la rama (no la movió el retry)', () => {
    // #5799 — invariante heredada: `stripReservedChildSecrets` es lo último que
    // toca el env, y nada se spreadea después. El cableado del retry no puede
    // haber colado un merge posterior.
    const despuesDelStrip = PULPO_SRC.split('stripReservedChildSecrets(').slice(1)
        .map((s) => s.slice(0, 400));
    for (const tramo of despuesDelStrip) {
        assert.ok(!/\.\.\.process\.env/.test(tramo),
            'Nada puede spreadear process.env después del filtro de salida.');
    }
});

// -----------------------------------------------------------------------------
// 9. El brazo de credential-death del agente — sin efectos duplicados.
//
// Éste es el riesgo real del cableado: el primer intento ya ejecutó efectos
// observables (mover el dropfile, avisar al operador, apagar el provider) antes
// de que el coordinador decida reintentar. Se barre el fuente porque el bloque
// vive dentro de un `child.on('exit')` de 600 líneas que no se puede instanciar
// en un test sin levantar medio Pulpo.
// -----------------------------------------------------------------------------

/** El cuerpo del brazo `credential-death`, desde su `if` hasta el `return`. */
function brazoCredentialDeath() {
    const i = PULPO_SRC.indexOf("if (!hasVerdict && deathKind === 'credential-death') {");
    assert.ok(i > 0, 'El brazo de credential-death tiene que seguir existiendo.');
    const j = PULPO_SRC.indexOf("if (!hasVerdict && deathKind === 'provider-death') {", i);
    assert.ok(j > i, 'No se encontró el fin del brazo (el brazo de provider-death lo sigue).');
    return PULPO_SRC.slice(i, j);
}

test('el cierre por credencial vencida es idempotente (un solo aviso, un solo movimiento)', () => {
    const brazo = brazoCredentialDeath();
    // #5796 (fix rev-3) — la idempotencia dejó de ser una bandera suelta en el
    // brazo (que `retryExecute` escribía sin leer nunca, el bug del rechazo
    // rev-2) y pasó a ser una barrera dura encapsulada en el coordinador de
    // cierre. El COMPORTAMIENTO lo cubre `credential-retry-settlement-5796.test.js`
    // contando efectos; acá sólo se fija que el brazo real esté cableado a ella.
    assert.match(brazo, /credentialRetrySettlement\.crearCoordinadorDeCierreDeCorrida\(\{/,
        'Sin la barrera del coordinador, un camino inesperado duplicaría el aviso al operador.');
    assert.match(brazo, /cerrar: efectosDelCierrePorCredencial/,
        'Los efectos del cierre entran al coordinador: no puede haber un segundo dueño.');
    assert.match(brazo, /reencolar: efectosDelReencoladoPorReintento/,
        'Los efectos del re-encolado entran al MISMO coordinador: es lo que los hace excluyentes.');
    assert.ok(!/efectosDeCierreEjecutados/.test(brazo),
        'La bandera suelta no puede volver: cualquiera la marcaba sin ejecutar el cierre.');
    // Los efectos observables viven en UNA sola función, no repartidos.
    const cierres = (brazo.match(/sendCredentialDeathNotif\(/g) || []).length;
    assert.strictEqual(cierres, 1,
        `El aviso de reautenticación tiene que estar en un solo sitio del brazo (hay ${cierres}).`);
    const apagados = (brazo.match(/recordProviderSpawnDeath\(/g) || []).length;
    assert.strictEqual(apagados, 1,
        `El apagado del provider tiene que estar en un solo sitio del brazo (hay ${apagados}).`);
});

test('el reintento del agente NO apaga el provider ni avisa al operador', () => {
    const brazo = brazoCredentialDeath();

    // Los efectos del re-encolado viven en su propia función, separados de los
    // del cierre: es lo que permite que el coordinador los haga excluyentes.
    const iEfectos = brazo.indexOf('const efectosDelReencoladoPorReintento = () => {');
    assert.ok(iEfectos > 0, 'El brazo tiene que declarar los efectos del re-encolado.');
    const cuerpoDeLosEfectos = brazo.slice(iEfectos, brazo.indexOf('crearCoordinadorDeCierreDeCorrida', iEfectos));
    assert.ok(!/recordProviderSpawnDeath/.test(cuerpoDeLosEfectos),
        'Apagar el provider 60 minutos mientras todavía queda un reintento legítimo es la regresión que este issue viene a cerrar.');
    assert.ok(!/sendCredentialDeathNotif/.test(cuerpoDeLosEfectos),
        'El operador no puede recibir un aviso de reautenticación por un intento que todavía no falló.');

    // #5796 (fix rev-3, defecto 3) — BARRERA DE ENTRADA, no marca de salida.
    const i = brazo.indexOf('retryExecute: () => {');
    assert.ok(i > 0, 'El brazo tiene que declarar el reintento del coordinador.');
    const cuerpoDelReintento = brazo.slice(i, brazo.indexOf('emit: emitirEventoDeRetry', i));
    const iGuard = cuerpoDelReintento.indexOf('if (!coordinadorDeCierre.reencolarPorReintento())');
    assert.ok(iGuard > 0,
        'El retryExecute tiene que CONSULTAR la barrera: en el rev-2 sólo la escribía, y un replay '
        + 'que settleaba tarde le arrancaba el dropfile a un agente ya relanzado.');
    assert.ok(!/moveFile\(trabajandoPath/.test(cuerpoDelReintento),
        'Ningún efecto suelto en el retryExecute: todos viven detrás de la barrera, dentro de `reencolar`.');
    assert.ok(!/activeProcesses\.delete/.test(cuerpoDelReintento),
        'Liberar el slot fuera de la barrera habilita un segundo proceso claude sobre el mismo issue.');
});

test('el brazo de credential-death consulta el presupuesto ANTES de ejecutar los efectos', () => {
    const brazo = brazoCredentialDeath();
    const iPeek = brazo.indexOf('credentialRetryWiring.canRetry(credentialOperation)');
    assert.ok(iPeek > 0, 'Tiene que consultarse el presupuesto de la operación raíz.');
    assert.ok(iPeek < brazo.indexOf('runReplayAttempt'),
        'El peek va antes de invocar al coordinador.');
    assert.match(brazo, /credentialRetryWiring\.isAuthRejection\(veredictoDeAutenticacion\)/,
        'La decisión se toma con la señal TIPADA de #5795, nunca con el texto del log.');
    // Todo desenlace del brazo termina en el MISMO cierre idempotente: la rama
    // sin presupuesto y cada salida del replay (timeout, error tipado, resolución
    // sin reintento y red de última instancia). La cuenta exacta no es el punto
    // —agregar un desenlace nuevo es legítimo— pero ninguno puede quedar sin
    // cierre, que es lo que dejaría el dropfile huérfano en `trabajando/`.
    const invocacionesDelCierre = (brazo.match(/cerrarPorCredencialVencida\(/g) || []).length;
    assert.ok(invocacionesDelCierre >= 2,
        'La rama sin presupuesto y los desenlaces del replay tienen que cerrar la corrida ' +
        `(hay ${invocacionesDelCierre} invocaciones).`);
});

// -----------------------------------------------------------------------------
// 6-bis. Regresiones del rechazo rev-2 (los tres defectos del review).
// -----------------------------------------------------------------------------

test('DEFECTO 1 — el presupuesto se libera en TODOS los cierres que devuelven el dropfile a la cola', () => {
    // `provider-death` y `fast-fail` mueven el dropfile a `pendiente/`, o sea
    // relanzan el issue. Si no olvidaran la operación, un issue que gastó su
    // retry y después rebota por cualquiera de esas dos causas arrastraría
    // `retryConsumed: true` y, cuando cayera una credencial de verdad, se
    // cerraría con "presupuesto ya consumido" sin haber reintentado nunca.
    assert.match(PULPO_SRC, /const olvidarOperacionDeCredencial = \(\) => \{/,
        'La liberación del presupuesto vive en un helper único del lanzamiento.');

    const brazoDe = (inicio, fin) => {
        const i = PULPO_SRC.indexOf(inicio);
        assert.ok(i > 0, `No se encontró el brazo: ${inicio}`);
        const j = PULPO_SRC.indexOf(fin, i);
        assert.ok(j > i, `No se encontró el fin del brazo: ${fin}`);
        return PULPO_SRC.slice(i, j);
    };

    const providerDeath = brazoDe(
        "if (!hasVerdict && deathKind === 'provider-death') {",
        'if (!hasVerdict) {',
    );
    assert.match(providerDeath, /olvidarOperacionDeCredencial\(\);/,
        'El cierre por provider-death relanza el issue: tiene que liberar el presupuesto.');
    assert.ok(providerDeath.indexOf('olvidarOperacionDeCredencial();') < providerDeath.indexOf('return;'),
        'La liberación va ANTES del return, no después (el bug del rechazo rev-2).');

    const fastFail = brazoDe('if (!hasVerdict) {', 'Hay veredicto: tratamos como terminación normal');
    assert.match(fastFail, /olvidarOperacionDeCredencial\(\);/,
        'El fast-fail es el cierre más frecuente que devuelve el dropfile a la cola.');
    assert.ok(fastFail.indexOf('olvidarOperacionDeCredencial();') < fastFail.indexOf('return;'),
        'La liberación va ANTES del return del fast-fail.');
});

test('DEFECTO 1 — el barrido de huérfanos también libera el presupuesto, con la MISMA clave', () => {
    // Si el proceso murió sin que corriera su handler de `exit`, ningún cierre
    // del lanzamiento pudo olvidar la operación. El barrido de huérfanos devuelve
    // el dropfile a `pendiente/` (relanza el issue), así que es el último camino
    // que tiene que liberar el presupuesto.
    const i = PULPO_SRC.indexOf("log('huerfanos', `${archivo.name} lleva ");
    assert.ok(i > 0, 'El barrido de huérfanos tiene que seguir devolviendo el dropfile a pendiente/.');
    const brazo = PULPO_SRC.slice(i, i + 1400);
    assert.match(brazo, /credentialRetryWiring\.forgetOperation\(\{/,
        'El huérfano relanza el issue: tiene que liberar la operación raíz.');
    assert.match(brazo, /credentialRetryWiring\.operationKeyFor\(\{ pipeline: pipelineName, fase, skill, issue \}\)/,
        'La clave se construye con el helper compartido, no con un template literal a mano.');

    // Y el lanzamiento usa EXACTAMENTE el mismo helper: dos strings escritos a
    // mano en sitios distintos se desincronizan y la liberación no borra nada.
    assert.match(PULPO_SRC, /const credentialOperationKey = credentialRetryWiring\.operationKeyFor\(\{ pipeline, fase, skill, issue \}\);/,
        'El lanzamiento no puede construir la clave por su cuenta.');

    // Contrato del helper: forma estable y consistente entre ambos call-sites.
    assert.strictEqual(
        wiring.operationKeyFor({ pipeline: 'desarrollo', fase: 'dev', skill: 'pipeline-dev', issue: 5796 }),
        'desarrollo/dev/pipeline-dev:5796',
    );
});

test('DEFECTO 1 — el TTL de la operación NO se refresca en cada acceso', async () => {
    // El refresco por acceso volvía el TTL inalcanzable justo en el caso que
    // tiene que cubrir: un issue que rebota toca la clave en cada vuelta, así
    // que la ventana se corría para siempre y un presupuesto consumido quedaba
    // pegado hasta el próximo restart del Pulpo.
    const registry = new Map();
    let ahora = 1_000_000;
    const args = {
        key: 'k', config: GATE_ABIERTO, kind: 'agent', skill: 'guru', issue: 1,
        registry, now: () => ahora, ttlMs: 1000,
    };

    const a = wiring.getOrCreateOperation(args);
    a.retryConsumed = true;

    // Accesos repetidos DENTRO de la ventana (los relanzamientos del issue).
    for (let i = 0; i < 5; i += 1) {
        ahora += 150;
        assert.strictEqual(wiring.getOrCreateOperation(args), a,
            'Dentro de la ventana original se reusa la misma operación.');
    }

    // Total transcurrido: 1000ms desde la CREACIÓN. Con el refresco por acceso
    // la ventana habría quedado en `ahora + 1000` y esta operación seguiría viva.
    ahora += 250;
    const b = wiring.getOrCreateOperation(args);
    assert.notStrictEqual(b, a,
        'El TTL se ancla a la creación: los accesos no pueden extender la ventana indefinidamente.');
    assert.strictEqual(b.retryConsumed, false, 'La operación nueva estrena presupuesto.');
});

test('DEFECTO 2 — con el turno ya reclamado no se clasifica rechazo, así que no hay segundo spawn', async () => {
    // El fallback in-flight del Commander (#4309) reclama el turno leyendo el
    // MISMO frame que llena la proyección del rechazo. Sin este guard, el
    // coordinador spawnearía un segundo `claude` concurrente con el secundario
    // que ya está respondiendo: dos turnos ejecutando tool calls reales.
    let turnoReclamado = false;
    const classify = wiring.makeClaimAwareClassify(() => turnoReclamado);
    const rechazo = { authenticationRejection: rechazoTipado() };

    assert.ok(classify(rechazo), 'Con el turno libre, la clasificación tipada sigue intacta.');
    turnoReclamado = true;
    assert.strictEqual(classify(rechazo), null,
        'Con el turno reclamado no hay retry legítimo que disparar.');

    // Y el efecto de punta a punta: cero segundos intentos, cero invalidaciones,
    // presupuesto INTACTO para el turno siguiente.
    const eventos = [];
    const operation = credentialRetry.createOperation({ operationId: 'commander:req:abc' });
    const spawns = [];
    const salida = await wiring.runAttempt({
        operation, provider: 'anthropic', path: 'primary', destination: 'commander',
        invalidableScopes: SCOPES_INVALIDABLES,
        destinationsCatalog: CATALOGO,
        classify,
        invalidate: async () => { throw new Error('no debería invalidar un turno reclamado'); },
        emit: (e) => eventos.push(e),
        createSnapshot: async (ctx) => ({ keys: [], env: {}, attempt: ctx.attempt }),
        execute: async (ctx) => { spawns.push(ctx.attempt); return rechazo; },
    });

    assert.strictEqual(spawns.length, 1, `Un solo spawn (hubo ${spawns.length}).`);
    assert.strictEqual(salida.retryUsed, false);
    assert.strictEqual(operation.retryConsumed, false,
        'El presupuesto queda intacto: el turno no se cerró por credencial.');
    assert.strictEqual(operation.invalidations, 0);
    assert.strictEqual(eventos.length, 0, 'Sin retry no hay eventos de credencial.');
});

test('DEFECTO 2 — el execute del Commander tiene guard de entrada antes de spawnear', () => {
    const i = PULPO_SRC.indexOf('const corrida = await credentialRetryWiring.runAttempt({');
    assert.ok(i > 0, 'El intento primario del Commander tiene que correr bajo el coordinador.');
    const bloque = PULPO_SRC.slice(i, PULPO_SRC.indexOf('emit: emitirEventoDeRetryCommander', i));

    assert.match(bloque, /classify: credentialRetryWiring\.makeClaimAwareClassify\(\(\) => inflightFallbackClaimed\)/,
        'El clasificador tiene que desactivarse cuando el turno ya tiene dueño.');

    const iGuard = bloque.indexOf('if (inflightFallbackClaimed) {');
    const iSpawn = bloque.indexOf('await attemptAnthropicSpawn({');
    assert.ok(iGuard > 0, 'Falta el guard de entrada del execute.');
    assert.ok(iGuard < iSpawn,
        'El guard va ANTES del spawn: lo que protege es un proceso, no un log (bug del rechazo rev-2).');
});

test('DEFECTO 3 — el replay del agente tiene settlement garantizado y no puede settlear dos veces', () => {
    const brazo = brazoCredentialDeath();

    // #5796 (fix rev-3) — el race salió del brazo y vive en
    // `lib/credential-retry-settlement.js`, que es un módulo PURO: por eso el
    // settlement ahora se prueba por COMPORTAMIENTO (contando movimientos de
    // dropfile y `activeProcesses.delete` con un vault más lento que el
    // timeout) en `credential-retry-settlement-5796.test.js`. El rechazo rev-2
    // fue explícito: un assert de regex sobre el fuente verifica que el race
    // EXISTE, no qué pasa cuando settlea tarde — que era justo el bug.
    //
    // Acá queda sólo lo que ese test no puede ver: que el brazo real esté
    // cableado al módulo y no se haya quedado con una copia propia del race.
    assert.match(brazo, /credentialRetrySettlement\.correrReplayAcotado\(\{/,
        'El replay del agente tiene que correr acotado por el módulo de settlement.');
    assert.match(brazo, /correrReplayAcotado\(\{[\s\S]{0,300}coordinador: coordinadorDeCierre/,
        'El cierre pasa SIEMPRE por el coordinador: es lo que hace imposible el efecto duplicado.');
    assert.match(brazo, /timeoutMs: credentialRetrySettlement\.resolveReplayTimeoutMs\(\)/,
        'El timeout se resuelve por el módulo (inyectable por env), no hardcodeado en el brazo.');

    // Ninguna copia local del race: dos dueños del settlement es cómo volvería
    // a aparecer un desenlace sin cierre.
    assert.ok(!/Promise\.race\(\[/.test(brazo),
        'El brazo no puede reimplementar el race: el settlement tiene un solo dueño.');
    assert.ok(!/const REPLAY_TIMEOUT_MS = /.test(brazo),
        'El presupuesto del replay vive en el módulo, no duplicado en pulpo.js.');

    assert.match(PULPO_SRC, /require\('\.\/lib\/credential-retry-settlement'\)/,
        'Sin este require el módulo queda huérfano y el brazo real pierde la barrera.');
});

test('DEFECTO 3 — todo desenlace del replay cierra la corrida (ningún camino deja el dropfile huérfano)', async () => {
    // Contraparte de comportamiento del assert estructural de arriba, sobre el
    // MISMO módulo que consume el brazo: los cuatro desenlaces posibles del
    // replay —timeout, fallo tipado, OK sin reintento y excepción inesperada—
    // terminan con la corrida cerrada. Un desenlace sin cierre deja el dropfile
    // en `trabajando/`, el slot ocupado y los daemons vivos hasta el restart.
    const settlement = require('../lib/credential-retry-settlement');

    // Las promesas se crean PEREZOSAS: una `Promise.reject` construida de
    // antemano dispara `unhandledRejection` antes de que el módulo la adopte.
    const casos = [
        ['timeout (vault colgado)', () => new Promise(() => {}), /timeout/],
        ['fallo tipado del coordinador',
            () => Promise.reject(Object.assign(new Error('x'), { reason: 'budget_exhausted' })),
            /budget_exhausted/],
        ['OK sin reintento', () => Promise.resolve({ ok: true }), /sin reintentar/],
    ];
    for (const [nombre, hacerReplay, esperado] of casos) {
        const cierres = [];
        const coordinador = {
            cerrada: false,
            cerrarPorCredencialVencida(nota) {
                if (this.cerrada) return false;
                this.cerrada = true; cierres.push(nota); return true;
            },
        };
        await settlement.correrReplayAcotado({ replay: hacerReplay(), coordinador, timeoutMs: 20 });
        assert.strictEqual(cierres.length, 1, `${nombre}: exactamente un cierre (hubo ${cierres.length}).`);
        assert.match(String(cierres[0]), esperado, `${nombre}: la nota dice por qué cerró.`);
    }
});

test('el gate del retry no puede quedar cableado al booleano del snapshot', () => {
    assert.ok(!/credential_snapshot_enabled[\s\S]{0,200}credential_retry/.test(PULPO_SRC),
        'El Pulpo no puede derivar el gate de retry del gate de snapshot.');
    // La LECTURA del gate (la comparación estricta) vive en un solo sitio: el
    // módulo de cableado. En `pulpo.js` el nombre sólo puede aparecer en prosa.
    assert.ok(!/credential_retry_enabled\s*===/.test(PULPO_SRC),
        'La lectura del gate vive en el módulo de cableado (un solo sitio), no inline en pulpo.js.');
    assert.ok(!/config\.pipeline\.credential_retry_enabled/.test(PULPO_SRC),
        'pulpo.js no puede leer el gate por su cuenta: se desincronizaría del criterio fail-closed.');
});
