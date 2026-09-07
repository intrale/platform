// =============================================================================
// credential-auth-retry.test.js — #5794
//
// Qué se afirma acá, en el orden de los criterios de aceptación:
//   1. Presupuesto — un rechazo tipado causa EXACTAMENTE una invalidación, una
//      re-resolución y como máximo un segundo intento.
//   2. Fallo cerrado — un segundo rechazo no genera tercer intento.
//   3. Operación raíz — el presupuesto se comparte por toda la operación
//      (incluida la cadena de fallbacks) y no vive en un caché global.
//   4. Tabla negativa — lo que NO es `authentication_rejected` falla sin
//      invalidar y sin consumir el retry.
//   5. Auditoría — eventos con correlación, campos allowlisted y sin secretos.
//   6. Concurrencia — dos caminos en vuelo de la misma operación no se llevan
//      dos retries.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const retry = require('../credential-auth-retry');
const {
    runWithCredentialRetry, createOperation, consumeRetry, isOperation,
    scopeForDestination, buildEvent, defaultClassify,
    RETRY_EVENTS, CLOSE_REASONS, RETRY_ERROR_CODES, EVENT_FIELDS,
    CredentialRetryError,
} = retry;

const { AUTH_REJECTED_CLASS } = require('../agent-launcher/dispatch-with-fallback');

// -----------------------------------------------------------------------------
// Andamiaje. Todo inyectado: la suite no toca el vault, ni `process.env`, ni el
// filesystem, así que corre igual con el vault deshabilitado.
// -----------------------------------------------------------------------------

const SCOPES_INVALIDABLES = ['google_drive', 'providers', 'telegram'];
const CATALOGO = { 'agent-child': { scopes: ['providers'] }, 'commander': { scopes: ['providers'] } };

/** Proyección de rechazo con la misma forma que emite el dispatcher (#5795). */
function rechazoTipado({ code = 'authentication_error', status = 401, source = 'cli-stream-json', type = null } = {}) {
    return Object.freeze({
        kind: AUTH_REJECTED_CLASS,
        provider: 'anthropic',
        operationId: 'op-1',
        path: 'primary',
        attempt: 1,
        signal: Object.freeze({ source, code, status, type }),
    });
}

/** Veredicto de `onSpawnExit` sin rechazo de credencial (el caso normal). */
function veredictoOk(extra = {}) {
    return { errorClass: 'unknown', authenticationRejection: null, ...extra };
}

function veredictoRechazado(extra = {}) {
    return { errorClass: 'auth', authenticationRejection: rechazoTipado(), ...extra };
}

/** Arma el set de dependencias inyectadas con contadores observables. */
function armar({ ejecuciones = [], invalidateImpl, createSnapshotImpl } = {}) {
    const llamadas = { execute: [], invalidate: [], createSnapshot: [], eventos: [] };
    let i = 0;

    const execute = async (ctx) => {
        llamadas.execute.push({ attempt: ctx.attempt, provider: ctx.provider, snapshot: ctx.snapshot });
        const paso = ejecuciones[i] !== undefined ? ejecuciones[i] : ejecuciones[ejecuciones.length - 1];
        i += 1;
        if (typeof paso === 'function') return paso(ctx);
        if (paso instanceof Error) throw paso;
        return paso;
    };

    const createSnapshot = createSnapshotImpl || (async (ctx) => {
        llamadas.createSnapshot.push({ attempt: ctx.attempt, scope: ctx.scope, provider: ctx.provider });
        // Identidad DISTINTA por intento (A-1 de #5799).
        return { keys: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: `valor-${ctx.attempt}` }, marca: ctx.attempt };
    });

    const invalidate = invalidateImpl || (async (scope) => {
        llamadas.invalidate.push(scope);
        return { scope, invalidadas: 2 };
    });

    const emit = (ev) => { llamadas.eventos.push(ev); };

    return { llamadas, execute, createSnapshot, invalidate, emit };
}

function correr(dep, extra = {}) {
    return runWithCredentialRetry({
        execute: dep.execute,
        createSnapshot: dep.createSnapshot,
        invalidate: dep.invalidate,
        emit: dep.emit,
        destination: 'agent-child',
        provider: 'anthropic',
        path: 'primary',
        invalidableScopes: SCOPES_INVALIDABLES,
        destinationsCatalog: CATALOGO,
        now: () => 1756900000000,
        ...extra,
    });
}

// -----------------------------------------------------------------------------
// 1. Presupuesto y cardinalidad
// -----------------------------------------------------------------------------

test('un rechazo tipado causa exactamente una invalidacion, una re-resolucion y un segundo intento', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoRechazado(), veredictoOk({ pid: 42 })] });

    const res = await correr(dep, { operation: op });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(res.retryUsed, true);
    assert.strictEqual(dep.llamadas.execute.length, 2, 'exactamente dos ejecuciones');
    assert.deepStrictEqual(dep.llamadas.invalidate, ['providers'], 'una sola invalidacion, acotada');
    assert.strictEqual(dep.llamadas.createSnapshot.length, 2, 'snapshot inicial + una re-resolucion');
    assert.strictEqual(op.invalidations, 1);
    assert.strictEqual(op.reresolutions, 1);
    assert.strictEqual(op.retryConsumed, true);
});

test('el reintento corre con un snapshot NUEVO, no con el que fue rechazado', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });

    await correr(dep, { operation: op });

    const [primero, segundo] = dep.llamadas.execute;
    assert.notStrictEqual(primero.snapshot, segundo.snapshot, 'identidad distinta por intento');
    assert.strictEqual(primero.snapshot.marca, 1);
    assert.strictEqual(segundo.snapshot.marca, 2);
});

test('un exito en el primer intento no invalida, no re-resuelve y no consume el retry', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoOk({ pid: 7 })] });

    const res = await correr(dep, { operation: op });

    assert.strictEqual(res.attempts, 1);
    assert.strictEqual(res.retryUsed, false);
    assert.deepStrictEqual(dep.llamadas.invalidate, []);
    assert.strictEqual(dep.llamadas.createSnapshot.length, 1);
    assert.strictEqual(op.retryConsumed, false, 'el presupuesto queda intacto para un rechazo real posterior');
    assert.deepStrictEqual(dep.llamadas.eventos, [], 'sin eventos de credencial');
});

// -----------------------------------------------------------------------------
// 2. Fallo cerrado
// -----------------------------------------------------------------------------

test('un segundo rechazo falla cerrado y no hay tercer intento', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoRechazado(), veredictoRechazado()] });

    await assert.rejects(
        () => correr(dep, { operation: op }),
        (e) => {
            assert.ok(e instanceof CredentialRetryError);
            assert.strictEqual(e.code, RETRY_ERROR_CODES.CLOSED);
            assert.strictEqual(e.reason, CLOSE_REASONS.SECOND_REJECTION);
            assert.strictEqual(e.attempt, 2);
            return true;
        },
    );

    assert.strictEqual(dep.llamadas.execute.length, 2, 'NO hay tercer intento');
    assert.strictEqual(dep.llamadas.invalidate.length, 1, 'no hay segunda invalidacion');
    assert.strictEqual(op.invalidations, 1);
    assert.strictEqual(op.reresolutions, 1);

    const cierre = dep.llamadas.eventos.at(-1);
    assert.strictEqual(cierre.event, RETRY_EVENTS.RETRY_CLOSED);
    assert.strictEqual(cierre.reason, CLOSE_REASONS.SECOND_REJECTION);
});

test('N rechazos consecutivos en la misma operacion causan UNA invalidacion y UNA re-resolucion', async () => {
    const op = createOperation({ operationId: 'op-1' });
    // Cinco caminos (primario + cuatro fallbacks), todos rechazados.
    let invalidaciones = 0;
    let snapshots = 0;

    for (let n = 0; n < 5; n += 1) {
        const dep = armar({
            ejecuciones: [veredictoRechazado(), veredictoRechazado()],
            invalidateImpl: async (s) => { invalidaciones += 1; return { scope: s, invalidadas: 1 }; },
            createSnapshotImpl: async (ctx) => { snapshots += 1; return { keys: [], env: {}, marca: ctx.attempt }; },
        });
        await assert.rejects(() => correr(dep, { operation: op, provider: `prov-${n}`, path: `fallback:${n}` }));
    }

    assert.strictEqual(invalidaciones, 1, 'ningun fallback reinicia el presupuesto');
    assert.strictEqual(op.invalidations, 1);
    assert.strictEqual(op.reresolutions, 1);
    // 2 del primer camino (inicial + re-resolucion) + 1 inicial por cada uno de
    // los 4 caminos siguientes, que cierran antes de re-resolver.
    assert.strictEqual(snapshots, 6);
});

test('un fallback con el presupuesto ya gastado cierra sin invalidar de nuevo', async () => {
    const op = createOperation({ operationId: 'op-1' });
    op.retryConsumed = true;   // como si otro camino ya se lo hubiera llevado

    const dep = armar({ ejecuciones: [veredictoRechazado()] });

    await assert.rejects(
        () => correr(dep, { operation: op, path: 'fallback:cerebras' }),
        (e) => {
            assert.strictEqual(e.code, RETRY_ERROR_CODES.CLOSED);
            assert.strictEqual(e.reason, CLOSE_REASONS.BUDGET_EXHAUSTED);
            return true;
        },
    );

    assert.deepStrictEqual(dep.llamadas.invalidate, [], 'no invalida con el presupuesto agotado');
    assert.strictEqual(dep.llamadas.execute.length, 1, 'no reintenta');
    assert.strictEqual(dep.llamadas.eventos.length, 1);
    assert.strictEqual(dep.llamadas.eventos[0].reason, CLOSE_REASONS.BUDGET_EXHAUSTED);
});

// -----------------------------------------------------------------------------
// 3. El presupuesto pertenece a la operación, no a un caché global
// -----------------------------------------------------------------------------

test('dos operaciones distintas tienen presupuestos independientes', async () => {
    const opA = createOperation({ operationId: 'op-A' });
    const opB = createOperation({ operationId: 'op-B' });

    const depA = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });
    const depB = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });

    await correr(depA, { operation: opA });
    await correr(depB, { operation: opB });

    assert.strictEqual(opA.invalidations, 1);
    assert.strictEqual(opB.invalidations, 1, 'la operacion B no hereda el presupuesto gastado de A');
    assert.strictEqual(depB.llamadas.execute.length, 2);
});

test('el modulo no guarda estado entre operaciones (re-require sin memoria)', async () => {
    // Si el presupuesto viviera en un caché global del módulo, la segunda
    // operación con el MISMO operationId heredaría `retryConsumed`.
    const op1 = createOperation({ operationId: 'misma-id' });
    const dep1 = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });
    await correr(dep1, { operation: op1 });

    const op2 = createOperation({ operationId: 'misma-id' });
    assert.strictEqual(op2.retryConsumed, false);
    const dep2 = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });
    const res2 = await correr(dep2, { operation: op2 });
    assert.strictEqual(res2.retryUsed, true);
    assert.strictEqual(op2.invalidations, 1);
});

// -----------------------------------------------------------------------------
// 4. Tabla negativa — lo que NO activa el retry
// -----------------------------------------------------------------------------

const NEGATIVOS = [
    ['timeout', () => veredictoOk({ errorClass: 'timeout', timedOut: true })],
    ['5xx del provider', () => veredictoOk({ errorClass: 'server_error', exitCode: 1 })],
    ['403 generico sin token documentado', () => veredictoOk({ errorClass: 'auth', status: 403 })],
    ['cuota agotada', () => veredictoOk({ errorClass: 'quota', flagSet: true })],
    ['config faltante', () => veredictoOk({ errorClass: 'config' })],
    ['permisos / autorizacion', () => veredictoOk({ errorClass: 'authz' })],
    ['kind ajeno con signal valida', () => ({
        authenticationRejection: { kind: 'quota_exhausted', signal: { source: 'api-json', code: 'x' } },
    })],
    ['proyeccion sin signal', () => ({ authenticationRejection: { kind: AUTH_REJECTED_CLASS } })],
    ['proyeccion nula', () => ({ authenticationRejection: null })],
    ['resultado no-objeto', () => 'texto suelto'],
];

for (const [nombre, hacer] of NEGATIVOS) {
    test(`no invalida ni consume el retry ante: ${nombre}`, async () => {
        const op = createOperation({ operationId: 'op-1' });
        const dep = armar({ ejecuciones: [hacer()] });

        const res = await correr(dep, { operation: op });

        assert.strictEqual(res.ok, true, 'el veredicto se devuelve tal cual, sin juzgarlo');
        assert.strictEqual(res.attempts, 1);
        assert.deepStrictEqual(dep.llamadas.invalidate, []);
        assert.strictEqual(op.retryConsumed, false);
        assert.deepStrictEqual(dep.llamadas.eventos, []);
    });
}

test('un error tirado por execute que no es de credencial se propaga tal cual', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const boom = new Error('ETIMEDOUT');
    boom.code = 'ETIMEDOUT';
    const dep = armar({ ejecuciones: [boom] });

    await assert.rejects(() => correr(dep, { operation: op }), (e) => {
        assert.strictEqual(e, boom, 'mismo error, sin envolver');
        return true;
    });

    assert.deepStrictEqual(dep.llamadas.invalidate, []);
    assert.strictEqual(op.retryConsumed, false);
    assert.deepStrictEqual(dep.llamadas.eventos, []);
});

test('un error NO auth en el segundo intento se propaga sin cerrar por credencial', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const boom = new Error('ECONNRESET');
    const dep = armar({ ejecuciones: [veredictoRechazado(), boom] });

    await assert.rejects(() => correr(dep, { operation: op }), (e) => {
        assert.strictEqual(e, boom);
        return true;
    });
    assert.strictEqual(op.invalidations, 1, 'la invalidacion del primer rechazo si ocurrio');
    const eventos = dep.llamadas.eventos.map((e) => e.event);
    assert.deepStrictEqual(eventos, [RETRY_EVENTS.INVALIDATED, RETRY_EVENTS.RERESOLVED]);
});

test('un error de credencial tirado como excepcion tambien clasifica', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const err = new Error('rechazo');
    err.authRejection = rechazoTipado();
    const dep = armar({ ejecuciones: [err, veredictoOk()] });

    const res = await correr(dep, { operation: op });
    assert.strictEqual(res.retryUsed, true);
    assert.strictEqual(op.invalidations, 1);
});

// -----------------------------------------------------------------------------
// 5. Fallos del propio camino de recuperación → fallo cerrado
// -----------------------------------------------------------------------------

test('si la invalidacion falla, se cierra sin reintentar', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({
        ejecuciones: [veredictoRechazado(), veredictoOk()],
        invalidateImpl: async () => { const e = new Error('vault caido'); e.code = 'VAULT_RESET_RACE'; throw e; },
    });

    await assert.rejects(() => correr(dep, { operation: op }), (e) => {
        assert.strictEqual(e.code, RETRY_ERROR_CODES.INVALIDATION_FAILED);
        assert.strictEqual(e.reason, CLOSE_REASONS.INVALIDATION_FAILED);
        return true;
    });
    assert.strictEqual(dep.llamadas.execute.length, 1, 'no reintenta con material posiblemente rancio');
    assert.strictEqual(op.invalidations, 0);
});

test('si la re-resolucion falla, se cierra sin reintentar con el snapshot viejo', async () => {
    const op = createOperation({ operationId: 'op-1' });
    let n = 0;
    const dep = armar({
        ejecuciones: [veredictoRechazado(), veredictoOk()],
        createSnapshotImpl: async (ctx) => {
            n += 1;
            if (ctx.attempt === 2) { const e = new Error('sin vault'); e.code = 'SNAPSHOT_VAULT_DISABLED'; throw e; }
            return { keys: [], env: {}, marca: n };
        },
    });

    await assert.rejects(() => correr(dep, { operation: op }), (e) => {
        assert.strictEqual(e.code, RETRY_ERROR_CODES.RERESOLUTION_FAILED);
        return true;
    });
    assert.strictEqual(dep.llamadas.execute.length, 1);
    assert.strictEqual(op.reresolutions, 0);
});

test('si el snapshot INICIAL falla, el coordinador no interviene y el error sale tal cual', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const boom = new Error('fail-closed pre-spawn');
    boom.code = 'ATTEMPT_SNAPSHOT_UNAVAILABLE';
    const dep = armar({
        ejecuciones: [veredictoOk()],
        createSnapshotImpl: async () => { throw boom; },
    });

    await assert.rejects(() => correr(dep, { operation: op }), (e) => {
        assert.strictEqual(e, boom);
        return true;
    });
    assert.strictEqual(dep.llamadas.execute.length, 0);
    assert.strictEqual(op.retryConsumed, false, 'un snapshot que no se pudo emitir no gasta el retry');
});

// -----------------------------------------------------------------------------
// 6. Scope — derivación y fail-closed
// -----------------------------------------------------------------------------

test('el scope se deriva del catalogo de destinos, no de una lista literal', () => {
    assert.strictEqual(scopeForDestination('agent-child', { destinationsCatalog: CATALOGO }), 'providers');
    assert.strictEqual(scopeForDestination('commander', { destinationsCatalog: CATALOGO }), 'providers');
    assert.strictEqual(scopeForDestination('inexistente', { destinationsCatalog: CATALOGO }), null);
    assert.strictEqual(scopeForDestination('', { destinationsCatalog: CATALOGO }), null);
    assert.strictEqual(scopeForDestination(null, { destinationsCatalog: CATALOGO }), null);
});

test('un destino con mas de un scope no se deriva solo (fail-closed)', () => {
    const ambiguo = { multi: { scopes: ['providers', 'telegram'] } };
    assert.strictEqual(scopeForDestination('multi', { destinationsCatalog: ambiguo }), null);
});

test('el scope se resuelve contra el catalogo REAL de credentials.js', () => {
    // Sin catálogo inyectado: se lee `SNAPSHOT_DESTINATIONS` de verdad. Si el
    // catálogo cambiara de forma, este test lo caza antes que producción.
    assert.strictEqual(scopeForDestination('agent-child'), 'providers');
    const invalidables = require('../credentials').scopesInvalidables();
    assert.ok(invalidables.includes('providers'), 'el scope derivado tiene que ser invalidable');
});

test('sin scope ni destino la operacion se aborta antes del primer intento', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoOk()] });

    await assert.rejects(
        () => correr(dep, { operation: op, destination: undefined }),
        (e) => {
            assert.strictEqual(e.code, RETRY_ERROR_CODES.SCOPE_UNRESOLVED);
            return true;
        },
    );
    assert.strictEqual(dep.llamadas.execute.length, 0, 'no se gasta un spawn para descubrir el error de cableado');
});

test('un scope que no es invalidable se rechaza antes del primer intento', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoOk()] });

    await assert.rejects(
        () => correr(dep, { operation: op, scope: 'inventado' }),
        (e) => {
            assert.strictEqual(e.code, RETRY_ERROR_CODES.SCOPE_NOT_INVALIDABLE);
            return true;
        },
    );
    assert.strictEqual(dep.llamadas.execute.length, 0);
});

test('el comodin no se acepta como scope', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoOk()] });
    await assert.rejects(() => correr(dep, { operation: op, scope: '*' }),
        (e) => e.code === RETRY_ERROR_CODES.SCOPE_NOT_INVALIDABLE);
});

// -----------------------------------------------------------------------------
// 7. Validación de argumentos
// -----------------------------------------------------------------------------

test('createOperation exige un operationId utilizable', () => {
    for (const malo of [undefined, null, '', '   ', {}, [], NaN, Infinity, 'con espacio', 'x'.repeat(200), '\n', 'comillas"']) {
        assert.throws(() => createOperation({ operationId: malo }),
            (e) => e.code === RETRY_ERROR_CODES.OPERATION_INVALID,
            `deberia rechazar: ${JSON.stringify(malo)}`);
    }
    assert.strictEqual(createOperation({ operationId: '5794:dev:1727384' }).operationId, '5794:dev:1727384');
});

test('un operationId numerico finito se normaliza a string (el numero de issue es un id valido)', () => {
    // Comportamiento heredado del normalizador COMPARTIDO con el dispatcher: no
    // se duplica la regla acá, así que se afirma explícitamente para que un
    // endurecimiento futuro de esa allowlist no pase inadvertido.
    assert.strictEqual(createOperation({ operationId: 5794 }).operationId, '5794');
});

test('isOperation y consumeRetry fallan cerrado ante objetos ajenos', () => {
    for (const malo of [null, undefined, {}, { operationId: '' }, { operationId: 'x' }, 'op-1', 7]) {
        assert.strictEqual(isOperation(malo), false, `isOperation(${JSON.stringify(malo)})`);
        assert.strictEqual(consumeRetry(malo), false, 'un objeto ajeno nunca se lleva el retry');
    }
});

test('run exige operation, execute y createSnapshot', async () => {
    const dep = armar({ ejecuciones: [veredictoOk()] });
    const op = createOperation({ operationId: 'op-1' });

    await assert.rejects(() => runWithCredentialRetry({ execute: dep.execute, createSnapshot: dep.createSnapshot }),
        (e) => e.code === RETRY_ERROR_CODES.OPERATION_INVALID);
    await assert.rejects(() => runWithCredentialRetry({ operation: op, createSnapshot: dep.createSnapshot }),
        (e) => e.code === RETRY_ERROR_CODES.EXECUTE_REQUIRED);
    await assert.rejects(() => runWithCredentialRetry({ operation: op, execute: dep.execute }),
        (e) => e.code === RETRY_ERROR_CODES.SNAPSHOT_REQUIRED);
    await assert.rejects(() => runWithCredentialRetry(),
        (e) => e.code === RETRY_ERROR_CODES.OPERATION_INVALID);
});

// -----------------------------------------------------------------------------
// 8. Concurrencia por operación
// -----------------------------------------------------------------------------

test('dos caminos concurrentes de la misma operacion no se llevan dos retries', async () => {
    const op = createOperation({ operationId: 'op-1' });
    let invalidaciones = 0;
    let reresoluciones = 0;

    const hacerDep = (etiqueta) => armar({
        ejecuciones: [
            // Cede el turno al event loop ANTES de devolver el rechazo, así los
            // dos caminos llegan a la sección crítica intercalados.
            async () => { await new Promise((r) => setImmediate(r)); return veredictoRechazado(); },
            veredictoOk({ etiqueta }),
        ],
        invalidateImpl: async (s) => { invalidaciones += 1; return { scope: s, invalidadas: 1 }; },
        createSnapshotImpl: async (ctx) => {
            if (ctx.attempt === 2) reresoluciones += 1;
            return { keys: [], env: {}, marca: `${etiqueta}-${ctx.attempt}` };
        },
    });

    const depA = hacerDep('A');
    const depB = hacerDep('B');

    const resultados = await Promise.allSettled([
        correr(depA, { operation: op, path: 'primary' }),
        correr(depB, { operation: op, path: 'fallback:1' }),
    ]);

    const cumplidos = resultados.filter((r) => r.status === 'fulfilled');
    const rechazados = resultados.filter((r) => r.status === 'rejected');

    assert.strictEqual(cumplidos.length, 1, 'exactamente uno se lleva el retry');
    assert.strictEqual(rechazados.length, 1, 'el otro cierra por presupuesto agotado');
    assert.strictEqual(rechazados[0].reason.reason, CLOSE_REASONS.BUDGET_EXHAUSTED);
    assert.strictEqual(invalidaciones, 1);
    assert.strictEqual(reresoluciones, 1);
    assert.strictEqual(op.invalidations, 1);
    assert.strictEqual(op.reresolutions, 1);
});

test('operaciones concurrentes DISTINTAS no se interfieren', async () => {
    const ops = [1, 2, 3, 4].map((n) => createOperation({ operationId: `op-${n}` }));
    let invalidaciones = 0;

    await Promise.all(ops.map((op, n) => {
        const dep = armar({
            ejecuciones: [
                async () => { await new Promise((r) => setImmediate(r)); return veredictoRechazado(); },
                veredictoOk(),
            ],
            invalidateImpl: async (s) => { invalidaciones += 1; return { scope: s, invalidadas: 1 }; },
        });
        return correr(dep, { operation: op, provider: `prov-${n}` });
    }));

    assert.strictEqual(invalidaciones, 4, 'una invalidacion por operacion, ni mas ni menos');
    for (const op of ops) {
        assert.strictEqual(op.invalidations, 1);
        assert.strictEqual(op.reresolutions, 1);
    }
});

// -----------------------------------------------------------------------------
// 9. Eventos: correlación, allowlist y redacción
// -----------------------------------------------------------------------------

test('los eventos llevan correlacion completa y solo campos allowlisted', async () => {
    const op = createOperation({ operationId: 'op-corr' });
    const dep = armar({ ejecuciones: [veredictoRechazado(), veredictoRechazado()] });

    await assert.rejects(() => correr(dep, { operation: op, path: 'fallback:2' }));

    const nombres = dep.llamadas.eventos.map((e) => e.event);
    assert.deepStrictEqual(nombres, [
        RETRY_EVENTS.INVALIDATED,
        RETRY_EVENTS.RERESOLVED,
        RETRY_EVENTS.RETRY_CLOSED,
    ]);

    for (const ev of dep.llamadas.eventos) {
        assert.deepStrictEqual(Object.keys(ev).sort(), [...EVENT_FIELDS].sort(),
            'ninguna clave fuera de la allowlist');
        assert.ok(Object.isFrozen(ev), 'el evento se entrega congelado');
        assert.strictEqual(ev.operation_id, 'op-corr');
        assert.strictEqual(ev.provider, 'anthropic');
        assert.strictEqual(ev.path, 'fallback:2');
        assert.strictEqual(ev.scope, 'providers');
        assert.strictEqual(ev.destination, 'agent-child');
        assert.strictEqual(ev.signal_source, 'cli-stream-json');
        assert.strictEqual(ev.signal_status, 401);
        assert.strictEqual(ev.ts, new Date(1756900000000).toISOString());
    }

    const invalidado = dep.llamadas.eventos[0];
    assert.strictEqual(invalidado.invalidated_entries, 2);
    assert.strictEqual(dep.llamadas.eventos[1].snapshot_keys, 1, 'solo la CANTIDAD de claves');
});

test('los eventos no transportan valores, env, ni serializacion del snapshot', async () => {
    const CANARIO = 'sk-ant-canario-NO-DEBE-APARECER-0123456789';
    const op = createOperation({ operationId: 'op-1' });

    const dep = armar({
        ejecuciones: [
            () => {
                // El veredicto trae el canario en TODOS los campos de prosa que
                // un provider real podría contaminar.
                const v = veredictoRechazado();
                v.raw = `stderr con ${CANARIO}`;
                v.evidence = CANARIO;
                v.message = CANARIO;
                return v;
            },
            () => { const e = new Error(`fallo con ${CANARIO}`); e.stderr = CANARIO; e.authRejection = rechazoTipado(); throw e; },
        ],
        createSnapshotImpl: async (ctx) => ({
            keys: ['ANTHROPIC_API_KEY'],
            env: { ANTHROPIC_API_KEY: CANARIO },
            marca: ctx.attempt,
        }),
        invalidateImpl: async (s) => ({ scope: s, invalidadas: 1, detalle: CANARIO }),
    });

    let capturado = null;
    await assert.rejects(() => correr(dep, { operation: op }), (e) => { capturado = e; return true; });

    const serializado = JSON.stringify(dep.llamadas.eventos);
    assert.ok(!serializado.includes(CANARIO), 'ningun evento contiene el secreto canario');
    assert.ok(!serializado.includes('ANTHROPIC_API_KEY'), 'ni siquiera el nombre de la variable viaja');
    assert.ok(!serializado.includes('stderr'), 'no viaja stderr');

    // Y tampoco la excepción que se propaga al caller.
    const errSerializado = JSON.stringify({
        message: capturado.message, code: capturado.code, provider: capturado.provider,
        path: capturado.path, scope: capturado.scope, reason: capturado.reason,
        operationId: capturado.operationId, cause: capturado.cause || null,
    });
    assert.ok(!errSerializado.includes(CANARIO), 'la excepcion cerrada no arrastra el canario');
    assert.strictEqual(capturado.cause, undefined, 'no se encadena el error original');
});

test('buildEvent descarta enteros los valores que no calzan en la allowlist', () => {
    const ev = buildEvent({
        event: RETRY_EVENTS.INVALIDATED,
        operationId: 'con espacios y "comillas"',
        provider: { objeto: true },
        path: 'x'.repeat(500),
        destination: 'agent-child',
        scope: 'providers',
        attempt: 1,
        reason: 'motivo-inventado',
        invalidatedEntries: -5,
        snapshotKeys: 3.7,
        rejection: { signal: { source: 'api-json', code: 'invalid_api_key', status: 99999, type: null } },
        ts: 12345,
    });

    assert.strictEqual(ev.operation_id, null, 'no se recorta: se descarta entero');
    assert.strictEqual(ev.provider, null);
    assert.strictEqual(ev.path, null);
    assert.strictEqual(ev.reason, null, 'un motivo fuera de la tabla cerrada no viaja');
    assert.strictEqual(ev.invalidated_entries, null);
    assert.strictEqual(ev.snapshot_keys, null);
    assert.strictEqual(ev.signal_status, null, 'status fuera de rango HTTP');
    assert.strictEqual(ev.ts, null, 'ts no-string no viaja');
    assert.strictEqual(ev.destination, 'agent-child');
    assert.strictEqual(ev.signal_code, 'invalid_api_key');
    assert.deepStrictEqual(Object.keys(ev).sort(), [...EVENT_FIELDS].sort());
});

test('un emit que tira no rompe el flujo', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [veredictoRechazado(), veredictoOk()] });

    const res = await correr(dep, {
        operation: op,
        emit: () => { throw new Error('sink de auditoria caido'); },
    });

    assert.strictEqual(res.ok, true, 'el lanzamiento sobrevive a un sink roto');
    assert.strictEqual(res.retryUsed, true);
    assert.strictEqual(res.events.length, 2, 'los eventos se devuelven igual al caller');
});

// -----------------------------------------------------------------------------
// 10. defaultClassify
// -----------------------------------------------------------------------------

test('defaultClassify solo acepta la clase canonica con signal estructurada', () => {
    assert.strictEqual(defaultClassify(null), null);
    assert.strictEqual(defaultClassify('texto'), null);
    assert.strictEqual(defaultClassify({}), null);
    assert.strictEqual(defaultClassify({ authenticationRejection: {} }), null);
    assert.strictEqual(defaultClassify({ authenticationRejection: { kind: 'otra_cosa', signal: {} } }), null);
    assert.strictEqual(defaultClassify({ authenticationRejection: { kind: AUTH_REJECTED_CLASS } }), null);

    const bueno = rechazoTipado();
    assert.strictEqual(defaultClassify({ authenticationRejection: bueno }), bueno);
    assert.strictEqual(defaultClassify({ authRejection: bueno }), bueno);
});

test('un classify inyectado reemplaza al default sin cambiar el resto del flujo', async () => {
    const op = createOperation({ operationId: 'op-1' });
    const dep = armar({ ejecuciones: [{ propio: 'rechazo' }, { propio: 'ok' }] });

    const res = await correr(dep, {
        operation: op,
        classify: (c) => (c && c.propio === 'rechazo' ? rechazoTipado() : null),
    });

    assert.strictEqual(res.retryUsed, true);
    assert.strictEqual(op.invalidations, 1);
});
