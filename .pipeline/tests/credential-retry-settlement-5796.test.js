// =============================================================================
// credential-retry-settlement-5796.test.js — #5796 (fix rev-3, defecto 3)
//
// QUÉ PRUEBA — Y POR QUÉ ASÍ
// --------------------------
// El rechazo rev-2 encontró un settlement TARDÍO: el `Promise.race` que acota
// el replay no cancela el trabajo en vuelo, así que el `retryExecute` del
// coordinador podía correr DESPUÉS de que el timeout ya había devuelto el issue
// a la cola. Para entonces —con `poll_interval_seconds: 30`— el Pulpo ya podía
// haber relanzado el issue sobre el MISMO `trabajando/<issue>.<skill>` y la
// MISMA clave de `activeProcesses`, así que los efectos tardíos le arrancaban
// el dropfile al agente vivo y liberaban un slot ocupado: dos procesos `claude`
// sobre el mismo issue y el mismo worktree.
//
// La suite del defecto 3 no lo vio porque era ESTRUCTURAL —`assert.match` con
// regex sobre el fuente de `pulpo.js`: verificaba que el race EXISTÍA, no qué
// pasaba cuando settleaba tarde.
//
// Estos tests son de COMPORTAMIENTO: ejercitan el módulo real
// (`lib/credential-retry-settlement.js`) cableado al coordinador real
// (`lib/credential-retry-wiring.js`) con un `createSnapshot` deliberadamente
// más lento que el timeout, y CUENTAN los efectos observables —movimientos de
// dropfile, `activeProcesses.delete`, avisos al operador— con dobles que
// registran cada llamada. Sin regex, sin filesystem, sin esperar 60s reales.
//
// Ejecución: `node --test .pipeline/tests/credential-retry-settlement-5796.test.js`
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const settlement = require('../lib/credential-retry-settlement');
const wiring = require('../lib/credential-retry-wiring');
const { AUTH_REJECTED_CLASS } = require('../lib/agent-launcher/dispatch-with-fallback');

const GATE_ABIERTO = { pipeline: { credential_retry_enabled: true } };
const SCOPES_INVALIDABLES = ['google_drive', 'providers', 'telegram'];
const CATALOGO = { 'agent-child': { scopes: ['providers'] }, commander: { scopes: ['providers'] } };

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Proyección tipada de rechazo, con la forma que emite `projectAuthRejection`. */
function rechazoTipado() {
    return Object.freeze({
        kind: AUTH_REJECTED_CLASS,
        provider: 'anthropic', operationId: 'op-1', path: 'primary', attempt: 1,
        signal: Object.freeze({ source: 'cli-stream-json', code: 'authentication_error', status: 401, type: null }),
    });
}

/**
 * Doble del estado de proceso que toca el brazo de credential-death en el Pulpo.
 * Cuenta EXACTAMENTE los efectos que el rechazo señaló como duplicables.
 */
function estadoDeProceso() {
    const efectos = {
        movimientosDeDropfile: [],   // moveFile(trabajandoPath -> pendiente/)
        slotsLiberados: [],          // activeProcesses.delete(processKey(skill, issue))
        salidasDeCanal: 0,           // leaveChannelByType(...)
        avisosAlOperador: 0,         // sendCredentialDeathNotif(...)
        providersApagados: 0,        // recordProviderSpawnDeath(...)
        logs: [],
    };
    return {
        efectos,
        /** Efectos del cierre por credencial vencida (apaga el provider + avisa). */
        cerrar(nota) {
            efectos.providersApagados += 1;
            efectos.avisosAlOperador += 1;
            efectos.movimientosDeDropfile.push({ por: 'cierre', nota: nota || null });
            efectos.slotsLiberados.push('cierre');
            efectos.salidasDeCanal += 1;
        },
        /** Efectos del re-encolado por reintento (NO apaga nada, NO avisa). */
        reencolar() {
            efectos.movimientosDeDropfile.push({ por: 'reintento', nota: null });
            efectos.slotsLiberados.push('reintento');
            efectos.salidasDeCanal += 1;
        },
        log: (m) => efectos.logs.push(m),
    };
}

/**
 * Réplica del cableado real de `pulpo.js`: coordinador de cierre + replay
 * acotado, con el `runReplayAttempt` REAL del wiring por dentro.
 *
 * @param {object} opts
 * @param {number} opts.demoraDelVaultMs  Cuánto tarda `createSnapshot` (el vault).
 * @param {number} opts.timeoutMs         Presupuesto del replay.
 */
async function correrBrazoDeCredencial({ demoraDelVaultMs, timeoutMs, invalidateFalla = false }) {
    const proceso = estadoDeProceso();
    const operation = wiring.getOrCreateOperation({
        key: 'agent:guru:5796', config: GATE_ABIERTO, kind: 'agent',
        skill: 'guru', issue: 5796, registry: new Map(),
    });

    const coordinador = settlement.crearCoordinadorDeCierreDeCorrida({
        cerrar: proceso.cerrar,
        reencolar: proceso.reencolar,
        etiqueta: 'guru:#5796',
        log: proceso.log,
    });

    const reintentos = [];
    const replay = wiring.runReplayAttempt({
        operation, provider: 'anthropic', path: 'primary', destination: 'agent-child',
        invalidableScopes: SCOPES_INVALIDABLES, destinationsCatalog: CATALOGO,
        firstSnapshot: { ANTHROPIC_API_KEY: 'la-que-ya-corrio' },
        firstOutcome: { errorClass: 'authentication_rejected', authenticationRejection: rechazoTipado() },
        invalidate: async () => {
            if (invalidateFalla) {
                const e = new Error('vault caído');
                e.reason = 'invalidation_failed';
                throw e;
            }
            return { invalidadas: 3 };
        },
        // EL VAULT LENTO: es exactamente el escenario para el que se agregó el
        // timeout — una credencial se cae, el vault no responde a tiempo.
        createSnapshot: async (ctx) => {
            await dormir(demoraDelVaultMs);
            return { keys: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: 'fresca' }, attempt: ctx.attempt };
        },
        retryExecute: (ctx) => {
            reintentos.push(ctx.attempt);
            // Idéntico al call-site de pulpo.js: barrera dura ANTES de efectos.
            if (!coordinador.reencolarPorReintento()) return { credentialRetryQueued: false };
            return { credentialRetryQueued: true };
        },
        emit: () => {},
    });

    await settlement.correrReplayAcotado({
        replay, coordinador, timeoutMs, log: proceso.log,
    });

    // El replay sigue en vuelo cuando ganó el timeout: se lo espera para
    // observar los efectos TARDÍOS, que es justo lo que el rechazo denunció.
    await replay.catch(() => {});
    await dormir(demoraDelVaultMs + 30);

    return { ...proceso.efectos, reintentos, coordinador, operation };
}

// -----------------------------------------------------------------------------
// EL DEFECTO DEL RECHAZO rev-2 — settlement tardío después del cierre
// -----------------------------------------------------------------------------

test('SETTLEMENT TARDÍO — el vault responde después del timeout: UN solo movimiento de dropfile', async () => {
    // Vault 300ms, presupuesto 60ms → el timeout gana y el replay settlea tarde.
    const r = await correrBrazoDeCredencial({ demoraDelVaultMs: 300, timeoutMs: 60 });

    assert.deepStrictEqual(r.reintentos, [2],
        'El coordinador SÍ llegó a invocar el retryExecute tardío: el escenario del rechazo está reproducido.');

    assert.strictEqual(r.movimientosDeDropfile.length, 1,
        `CA del issue: dos intentos ⇒ UN solo movimiento de dropfile (hubo ${r.movimientosDeDropfile.length}: `
        + `${r.movimientosDeDropfile.map((m) => m.por).join(' + ')}).`);
    assert.strictEqual(r.movimientosDeDropfile[0].por, 'cierre',
        'El movimiento es el del cierre por timeout, que fue quien ganó la carrera.');
    assert.match(r.movimientosDeDropfile[0].nota, /timeout/,
        'La nota del operador dice que cerró por timeout del reintento.');

    assert.strictEqual(r.slotsLiberados.length, 1,
        `UN solo activeProcesses.delete: liberar dos veces habilita un segundo proceso claude `
        + `sobre el mismo issue (hubo ${r.slotsLiberados.length}).`);
    assert.strictEqual(r.salidasDeCanal, 1, 'Una sola salida del canal de contexto.');
    assert.strictEqual(r.coordinador.ganador, 'cierre');

    assert.ok(r.logs.some((l) => /settleó después del cierre/.test(l)),
        'El replay tardío tiene que dejar traza: se descartó, no se perdió en silencio.');
});

test('SETTLEMENT TARDÍO — el reintento descartado no vuelve a avisarle al operador', async () => {
    const r = await correrBrazoDeCredencial({ demoraDelVaultMs: 300, timeoutMs: 60 });
    assert.strictEqual(r.avisosAlOperador, 1, 'Un solo Telegram por corrida.');
    assert.strictEqual(r.providersApagados, 1, 'Un solo apagado de provider.');
});

// -----------------------------------------------------------------------------
// CAMINO FELIZ — el replay gana la carrera
// -----------------------------------------------------------------------------

test('CAMINO FELIZ — el vault responde a tiempo: re-encola UNA vez y NO apaga el provider', async () => {
    // Vault 20ms, presupuesto 2000ms → gana el replay.
    const r = await correrBrazoDeCredencial({ demoraDelVaultMs: 20, timeoutMs: 2000 });

    assert.strictEqual(r.movimientosDeDropfile.length, 1,
        `UN solo movimiento de dropfile (hubo ${r.movimientosDeDropfile.length}).`);
    assert.strictEqual(r.movimientosDeDropfile[0].por, 'reintento');
    assert.strictEqual(r.slotsLiberados.length, 1, 'Un solo slot liberado.');
    assert.strictEqual(r.coordinador.ganador, 'reintento');

    assert.strictEqual(r.providersApagados, 0,
        'El motor NO se apaga: todavía no está probado que la credencial esté rota.');
    assert.strictEqual(r.avisosAlOperador, 0,
        'Sin aviso de reautenticación: el issue vuelve a la cola con credencial fresca.');
    assert.strictEqual(r.operation.retryConsumed, true, 'El presupuesto único quedó consumido.');
});

test('FALLO TIPADO — el coordinador tira: cierra UNA vez con el motivo del catálogo', async () => {
    const r = await correrBrazoDeCredencial({ demoraDelVaultMs: 5, timeoutMs: 2000, invalidateFalla: true });

    assert.deepStrictEqual(r.reintentos, [], 'Si la invalidación falla no hay reintento.');
    assert.strictEqual(r.movimientosDeDropfile.length, 1);
    assert.strictEqual(r.movimientosDeDropfile[0].por, 'cierre');
    assert.match(r.movimientosDeDropfile[0].nota, /no se reintentó \(invalidation_failed\)/,
        'El motivo es el TIPADO del catálogo, nunca texto libre ni el stack.');
});

// -----------------------------------------------------------------------------
// La barrera, aislada — invariantes del coordinador de cierre
// -----------------------------------------------------------------------------

test('los dos caminos de cierre son mutuamente excluyentes y corren UNA vez en total', () => {
    for (const orden of [['cerrar', 'reencolar'], ['reencolar', 'cerrar']]) {
        const p = estadoDeProceso();
        const c = settlement.crearCoordinadorDeCierreDeCorrida({
            cerrar: p.cerrar, reencolar: p.reencolar, etiqueta: 'guru:#5796', log: p.log,
        });
        const ejecutar = (nombre) => (nombre === 'cerrar'
            ? c.cerrarPorCredencialVencida('nota')
            : c.reencolarPorReintento());

        assert.strictEqual(ejecutar(orden[0]), true, `El primero (${orden[0]}) ejecuta.`);
        assert.strictEqual(ejecutar(orden[1]), false, `El segundo (${orden[1]}) NO ejecuta.`);
        // Y aunque insista.
        assert.strictEqual(ejecutar(orden[0]), false);
        assert.strictEqual(ejecutar(orden[1]), false);

        assert.strictEqual(p.efectos.movimientosDeDropfile.length, 1,
            `Orden ${orden.join('→')}: un solo movimiento de dropfile.`);
        assert.strictEqual(p.efectos.slotsLiberados.length, 1,
            `Orden ${orden.join('→')}: un solo slot liberado.`);
        assert.strictEqual(c.ganador, orden[0] === 'cerrar' ? 'cierre' : 'reintento');
    }
});

test('la bandera de cierre no se puede marcar sin ejecutar los efectos', () => {
    const p = estadoDeProceso();
    const c = settlement.crearCoordinadorDeCierreDeCorrida({ cerrar: p.cerrar, reencolar: p.reencolar });

    assert.strictEqual(c.cerrada, false);
    // El modo de falla del rev-2 era una bandera que se ESCRIBÍA desde afuera.
    // Acá `cerrada` es de sólo lectura: no hay forma de marcarla sin cerrar.
    try { c.cerrada = true; } catch { /* strict mode: setter ausente */ }
    assert.strictEqual(c.cerrada, false, 'No hay setter público de la bandera.');
    assert.strictEqual(c.ganador, null);

    c.cerrarPorCredencialVencida(null);
    assert.strictEqual(c.cerrada, true);
});

test('el coordinador exige los dos efectos como funciones (fail-fast en el cableado)', () => {
    assert.throws(() => settlement.crearCoordinadorDeCierreDeCorrida({ cerrar: () => {} }), /TypeError|requieren/);
    assert.throws(() => settlement.crearCoordinadorDeCierreDeCorrida({ reencolar: () => {} }), /TypeError|requieren/);
});

// -----------------------------------------------------------------------------
// El temporizador — no puede sostener vivo el Pulpo ni quedar colgado
// -----------------------------------------------------------------------------

test('el temporizador del replay va unref y se limpia siempre, settlee por donde settlee', async () => {
    const casos = [
        ['replay OK', Promise.resolve({ ok: true })],
        ['replay rechazado', Promise.reject(Object.assign(new Error('x'), { reason: 'budget_exhausted' }))],
    ];
    for (const [nombre, replay] of casos) {
        const p = estadoDeProceso();
        const c = settlement.crearCoordinadorDeCierreDeCorrida({ cerrar: p.cerrar, reencolar: p.reencolar });
        const creados = [];
        const limpiados = [];
        await settlement.correrReplayAcotado({
            replay, coordinador: c, timeoutMs: 5000, log: p.log,
            timers: {
                setTimeout: (fn, ms) => {
                    const h = { fn, ms, unrefeado: false, unref() { this.unrefeado = true; return this; } };
                    creados.push(h);
                    return h;
                },
                clearTimeout: (h) => limpiados.push(h),
            },
        });
        assert.strictEqual(creados.length, 1, `${nombre}: un solo temporizador.`);
        assert.strictEqual(creados[0].unrefeado, true,
            `${nombre}: el temporizador va unref o sostiene vivo el event loop del Pulpo.`);
        assert.deepStrictEqual(limpiados, creados, `${nombre}: el temporizador se limpia siempre.`);
        assert.strictEqual(c.cerrada, true, `${nombre}: la corrida SIEMPRE queda cerrada.`);
    }
});

test('un error dentro del cierre no deja el dropfile huérfano — la red de última instancia cierra igual', async () => {
    let intentos = 0;
    const c = {
        cerrada: false,
        cerrarPorCredencialVencida(nota) {
            intentos += 1;
            if (intentos === 1) throw new Error('el cierre explotó');
            this.cerrada = true;
            this.ultimaNota = nota;
            return true;
        },
    };
    const logs = [];
    await settlement.correrReplayAcotado({
        replay: Promise.resolve({ ok: true }), coordinador: c, timeoutMs: 5000, log: (m) => logs.push(m),
    });
    assert.strictEqual(intentos, 2, 'El catch reintenta el cierre.');
    assert.strictEqual(c.cerrada, true);
    assert.ok(logs.some((l) => /el cierre del replay falló/.test(l)));
});

// -----------------------------------------------------------------------------
// El timeout, inyectable — para no depender de 60s reales en los tests
// -----------------------------------------------------------------------------

test('el timeout del replay es inyectable por env, con fail-safe al default de 60s', () => {
    assert.strictEqual(settlement.REPLAY_TIMEOUT_MS_DEFAULT, 60 * 1000);
    assert.strictEqual(settlement.resolveReplayTimeoutMs({}), 60 * 1000);
    assert.strictEqual(
        settlement.resolveReplayTimeoutMs({ PIPELINE_CREDENTIAL_REPLAY_TIMEOUT_MS: '250' }), 250);
    for (const basura of ['0', '-1', 'abc', '', undefined]) {
        assert.strictEqual(
            settlement.resolveReplayTimeoutMs({ PIPELINE_CREDENTIAL_REPLAY_TIMEOUT_MS: basura }), 60 * 1000,
            `Valor inválido (${JSON.stringify(basura)}) cae al default, nunca a un timeout de 0.`);
    }
});

test('`correrReplayAcotado` exige un coordinador válido', async () => {
    await assert.rejects(
        async () => settlement.correrReplayAcotado({ replay: Promise.resolve(), coordinador: null }),
        /coordinador/,
    );
});

// -----------------------------------------------------------------------------
// El cableado en pulpo.js — que el brazo real use ESTE módulo
// -----------------------------------------------------------------------------

test('el brazo de credential-death de pulpo.js consume el módulo y no reimplementa la barrera', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');

    assert.match(PULPO_SRC, /require\('\.\/lib\/credential-retry-settlement'\)/,
        'Sin este require el módulo queda huérfano y el brazo real vuelve a la barrera de mentira.');

    const i = PULPO_SRC.indexOf('crearCoordinadorDeCierreDeCorrida({');
    assert.ok(i > 0, 'El brazo tiene que construir el coordinador de cierre.');
    const brazo = PULPO_SRC.slice(i, PULPO_SRC.indexOf('correrReplayAcotado({', i) + 600);

    const iGuard = brazo.indexOf('if (!coordinadorDeCierre.reencolarPorReintento())');
    assert.ok(iGuard > 0,
        'El retryExecute tiene que CONSULTAR la barrera, no sólo marcarla (bug del rechazo rev-2).');
    assert.ok(brazo.indexOf('moveFile(trabajandoPath', iGuard) === -1,
        'Después del guard no puede quedar un moveFile suelto: los efectos viven dentro de `reencolar`.');

    assert.match(brazo, /correrReplayAcotado\(\{[\s\S]{0,300}coordinador: coordinadorDeCierre/,
        'El cierre del race pasa SIEMPRE por el coordinador: es lo que hace imposible el efecto duplicado.');

    // La bandera del rev-2 no puede volver: si vive suelta en pulpo.js, cualquiera
    // la escribe sin ejecutar el cierre — exactamente el modo de falla del rechazo.
    assert.ok(!/efectosDeCierreEjecutados/.test(PULPO_SRC),
        'La bandera de cierre vive encapsulada en el coordinador, no suelta en pulpo.js.');
});
