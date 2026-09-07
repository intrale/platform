// =============================================================================
// credential-retry-orphan-guard-5796.test.js — #5796 (fix rev-4)
//
// QUÉ PRUEBA — Y POR QUÉ ASÍ
// --------------------------
// El rechazo rev-3 encontró un TERCER actor sobre la corrida cerrada por
// credencial vencida: el barrido de huérfanos (`brazoHuerfanos` de `pulpo.js`).
// Mientras el replay está en vuelo, el dropfile sigue en `trabajando/` y la
// entrada de `activeProcesses` sigue viva con un PID muerto, así que los dos
// guards del barrido dan luz verde:
//
//   * `isProcessAlive(info.pid)` → false, el proceso murió (por eso corre el
//     brazo de credential-death);
//   * `fileAgeMinutes` mide el MTIME, y `moveFile` es `fs.renameSync`, que lo
//     preserva a través de la cola: un issue que esperó en `pendiente/` más que
//     `orphan_timeout_minutes` nace vencido para el barrido (en el pipeline vivo
//     se midieron dropfiles de 58.612 min).
//
// El daño: el barrido devolvía el dropfile a `pendiente/`, consumía un
// `orphanRetries` sobre código sano, ponía cooldown con `registerFastFail` y
// llamaba `forgetOperation()` sobre la operación EN VUELO, borrando el
// presupuesto único — el próximo lanzamiento veía `canRetry: true` con un
// `operation_id` nuevo, o sea un retry por vuelta contra el vault. Es
// exactamente lo que CA-2 prohíbe.
//
// POR QUÉ NO ALCANZA UNA RÉPLICA DEL BLOQUE
// -----------------------------------------
// El test que ya existía sobre este brazo replicaba su lógica a mano, así que
// era ciego a lo que hace el barrido REAL. Acá el cuerpo de `brazoHuerfanos` se
// EXTRAE del fuente vigente de `pulpo.js` y se MONTA con dependencias dobles:
// si alguien saca el guard, o lo pone después de un efecto, estos tests fallan.
// Los módulos de credencial que se inyectan son los REALES —`forgetOperation`
// y `getOrCreateOperation` operan sobre el registro real del wiring—; lo único
// falso es el estado de proceso (filesystem, PIDs, Telegram) y el reloj.
//
// Ejecución: `node --test .pipeline/tests/credential-retry-orphan-guard-5796.test.js`
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settlement = require('../lib/credential-retry-settlement');
const wiring = require('../lib/credential-retry-wiring');

const PULPO_PATH = path.join(__dirname, '..', 'pulpo.js');
const PULPO_SRC = fs.readFileSync(PULPO_PATH, 'utf8');

const GATE_ABIERTO = { pipeline: { credential_retry_enabled: true } };

// -----------------------------------------------------------------------------
// Montaje del brazo REAL.
// -----------------------------------------------------------------------------

/**
 * Extrae el fuente de una función top-level de `pulpo.js`.
 *
 * El corte se ancla en el primer `\n}` a nivel de columna 0 después del inicio:
 * dentro de la función TODO está indentado, así que ese es su cierre. Evita
 * balancear llaves a mano (que se rompe con templates y comentarios).
 */
function fuenteDeFuncion(nombre) {
    const firma = `function ${nombre}(`;
    const inicio = PULPO_SRC.indexOf(firma);
    assert.ok(inicio > 0, `No se encontró \`${firma}\` en pulpo.js — el barrido cambió de nombre.`);
    const m = /\r?\n\}\r?\n/.exec(PULPO_SRC.slice(inicio));
    assert.ok(m, `No se encontró el cierre de \`${nombre}\`.`);
    return PULPO_SRC.slice(inicio, inicio + m.index + m[0].length);
}

const FUENTE_BRAZO = fuenteDeFuncion('brazoHuerfanos');
const FUENTE_PROCESS_KEY = fuenteDeFuncion('processKey');
const FUENTE_SYNTHESIZE = fuenteDeFuncion('synthesizeOrphanExhaustion');

/** `processKey` real del Pulpo: la clave con la que los dos actores se hablan. */
const processKey = new Function(`${FUENTE_PROCESS_KEY}\nreturn processKey;`)();

/**
 * Monta `brazoHuerfanos` con sus dependencias inyectadas.
 * @param {Record<string, any>} deps
 */
function montarBrazoHuerfanos(deps) {
    const nombres = Object.keys(deps);
    const valores = nombres.map((n) => deps[n]);
    const fabrica = new Function(
        ...nombres,
        `${FUENTE_SYNTHESIZE}\n${FUENTE_BRAZO}\nreturn brazoHuerfanos;`,
    );
    return fabrica(...valores);
}

const PIPELINE_NAME = 'desarrollo';
const FASE = 'dev';
const SKILL = 'pipeline-dev';
const ISSUE = '5796';
const DROPFILE = `${ISSUE}.${SKILL}`;

/**
 * Banco de pruebas del barrido: un único dropfile en `trabajando/`, con el
 * proceso muerto y un mtime viejísimo — el escenario exacto que el rechazo midió
 * en el pipeline vivo.
 *
 * @param {object} [opts]
 * @param {any} [opts.registroDeSettlements] Registro que verá el barrido.
 */
function bancoDeBarrido({ registroDeSettlements } = {}) {
    const efectos = {
        movimientos: [],       // moveFile(dropfile -> destino)
        telegramas: [],
        fastFails: [],
        logs: [],
        yamlsEscritos: [],
    };

    const claveDeProceso = processKey(SKILL, ISSUE);
    const activeProcesses = new Map([[claveDeProceso, { pid: 999999 }]]);
    const orphanRetries = new Map();

    const trabajandoDir = path.join('/fake', PIPELINE_NAME, FASE, 'trabajando');
    const rutaDelDropfile = path.join(trabajandoDir, DROPFILE);

    // El módulo real, con el registro de settlements que pide el caso. La
    // fábrica es la de producción: sólo cambia el reloj.
    const settlementInyectado = registroDeSettlements
        ? Object.assign(Object.create(settlement), settlement, { corridasEnSettlement: registroDeSettlements })
        : settlement;

    const brazo = montarBrazoHuerfanos({
        path,
        PIPELINE: '/fake/.pipeline',
        fasePath: (p, f) => path.join('/fake', p, f),
        listWorkFiles: (dir) => (dir === trabajandoDir ? [{ name: DROPFILE, path: rutaDelDropfile }] : []),
        skillFromFile: () => SKILL,
        issueFromFile: () => ISSUE,
        processKey,
        // 58.612 min: el mtime real medido en el pipeline vivo. Con
        // `orphan_timeout_minutes: 10`, el guard de edad no protege nada.
        fileAgeMinutes: () => 58612,
        activeProcesses,
        isProcessAlive: () => false,
        orphanRetries,
        MAX_ORPHAN_RETRIES: 3,
        credentialRetrySettlement: settlementInyectado,
        credentialRetryWiring: wiring, // el REAL: toca el registro real de operaciones
        log: (canal, msg) => efectos.logs.push(`${canal}: ${msg}`),
        moveFile: (origen, destino) => efectos.movimientos.push({ origen, destino }),
        sendTelegram: (msg) => efectos.telegramas.push(msg),
        registerFastFail: (skill, issue) => {
            efectos.fastFails.push(`${skill}:${issue}`);
            return { failures: 1, delayMin: 5 };
        },
        readYamlSafe: () => ({ issue: ISSUE, fase: FASE }),
        writeYaml: (ruta, data) => efectos.yamlsEscritos.push({ ruta, data }),
        require: (mod) => {
            if (String(mod).includes('spawn-failure-state')) {
                return { consumeSpawnFailureAnyProvider: () => null };
            }
            if (String(mod).includes('provider-disabled')) {
                return { setProviderDisabled: () => {} };
            }
            throw new Error(`require inesperado en el barrido: ${mod}`);
        },
    });

    const config = {
        timeouts: { orphan_timeout_minutes: 10 },
        pipelines: { [PIPELINE_NAME]: { fases: [FASE] } },
    };

    return { brazo, config, efectos, activeProcesses, orphanRetries, claveDeProceso, rutaDelDropfile };
}

/** Coordinador real con efectos contados (los mismos del brazo de credential-death). */
function coordinadorDePrueba({ alCerrar } = {}) {
    const efectos = { cierres: [], reencolados: [] };
    const coordinador = settlement.crearCoordinadorDeCierreDeCorrida({
        cerrar: (nota) => efectos.cierres.push(nota),
        reencolar: () => efectos.reencolados.push('reencolado'),
        etiqueta: `${SKILL}:#${ISSUE}`,
        alCerrar,
    });
    return { coordinador, efectos };
}

/** Clave de la operación de credencial, con el helper compartido. */
function claveDeOperacion() {
    return wiring.operationKeyFor({ pipeline: PIPELINE_NAME, fase: FASE, skill: SKILL, issue: ISSUE });
}

/** Deja una operación con su presupuesto YA consumido en el registro real. */
function operacionConPresupuestoConsumido() {
    const key = claveDeOperacion();
    wiring.forgetOperation({ key }); // arranque limpio entre tests
    const op = wiring.getOrCreateOperation({
        key, config: GATE_ABIERTO, kind: 'agent', skill: SKILL, issue: ISSUE,
    });
    op.retryConsumed = true;
    assert.equal(wiring.canRetry(op), false, 'precondición: el presupuesto está consumido');
    return { key, op };
}

// -----------------------------------------------------------------------------
// 1. El defecto del rechazo rev-3, montado sobre el barrido REAL.
// -----------------------------------------------------------------------------

test('con el cierre del retry EN VUELO, el barrido no ejecuta NINGÚN efecto sobre la corrida', () => {
    const { key, op } = operacionConPresupuestoConsumido();

    const registro = settlement.crearRegistroDeCorridasEnSettlement();
    const { coordinador, efectos: efectosDelCoordinador } = coordinadorDePrueba();
    const banco = bancoDeBarrido({ registroDeSettlements: registro });

    // Lo que hace el brazo de credential-death, sincrónicamente, antes de soltar
    // el control al event loop.
    registro.marcar({
        clave: banco.claveDeProceso,
        coordinador,
        presupuestoMs: 60_000,
        etiqueta: `${SKILL}:#${ISSUE}`,
    });

    banco.brazo(banco.config);

    // Ninguno de los efectos que el rechazo enumeró.
    assert.deepEqual(banco.efectos.movimientos, [], 'no le arranca el dropfile al replay');
    assert.deepEqual(banco.efectos.fastFails, [], 'no le pone cooldown al skill');
    assert.deepEqual(banco.efectos.telegramas, [], 'no avisa nada al operador');
    assert.equal(banco.orphanRetries.size, 0, 'no le consume un retry a código sano');
    assert.equal(banco.activeProcesses.has(banco.claveDeProceso), true,
        'no libera el slot: el cierre es del coordinador, no del barrido');
    assert.deepEqual(efectosDelCoordinador.cierres, [], 'el barrido no dispara los efectos del coordinador');

    // CA-2: la operación EN VUELO conserva su identidad y su presupuesto.
    const fresca = wiring.getOrCreateOperation({
        key, config: GATE_ABIERTO, kind: 'agent', skill: SKILL, issue: ISSUE,
    });
    assert.equal(fresca, op, 'la operación raíz sigue siendo la MISMA (no fue olvidada)');
    assert.equal(fresca.operationId, op.operationId, 'conserva el operation_id');
    assert.equal(wiring.canRetry(fresca), false,
        'CA-2: el presupuesto ya consumido NO se regenera — sin esto habría un retry por vuelta');

    // Y deja traza para el operador.
    assert.ok(banco.efectos.logs.some((l) => /cierre del retry de credencial en vuelo/.test(l)),
        'el barrido explica por qué salteó');
});

// -----------------------------------------------------------------------------
// 2. Sin cierre en vuelo, el barrido sigue haciendo su trabajo de siempre.
// -----------------------------------------------------------------------------

test('sin cierre en vuelo, el barrido conserva su comportamiento (devuelve a pendiente y libera el presupuesto)', () => {
    const { key } = operacionConPresupuestoConsumido();

    const registro = settlement.crearRegistroDeCorridasEnSettlement(); // vacío
    const banco = bancoDeBarrido({ registroDeSettlements: registro });

    banco.brazo(banco.config);

    assert.equal(banco.efectos.movimientos.length, 1, 'el huérfano vuelve a la cola');
    assert.match(banco.efectos.movimientos[0].destino, /pendiente$/);
    assert.deepEqual(banco.efectos.fastFails, [`${SKILL}:${ISSUE}`], 'cooldown de siempre');
    assert.equal(banco.orphanRetries.size, 1, 'consume un retry de huérfano');
    assert.equal(banco.activeProcesses.has(banco.claveDeProceso), false, 'libera el slot');

    // #5796 (fix rev-2, defecto 1): el issue se relanza, así que el presupuesto
    // se libera. Sin cierre en vuelo esto sigue siendo lo correcto.
    const fresca = wiring.getOrCreateOperation({
        key, config: GATE_ABIERTO, kind: 'agent', skill: SKILL, issue: ISSUE,
    });
    assert.equal(wiring.canRetry(fresca), true,
        'la operación se olvidó: el relanzamiento arranca con presupuesto propio');
});

// -----------------------------------------------------------------------------
// 3. Fail-SAFE: un cierre colgado no secuestra el slot para siempre.
// -----------------------------------------------------------------------------

test('si el cierre se pasa de su presupuesto, el barrido recupera el slot Y le arranca el turno al coordinador', () => {
    operacionConPresupuestoConsumido();

    let ahora = 1_000_000;
    const registro = settlement.crearRegistroDeCorridasEnSettlement({ now: () => ahora, margenMs: 30_000 });
    const { coordinador, efectos: efectosDelCoordinador } = coordinadorDePrueba();
    const banco = bancoDeBarrido({ registroDeSettlements: registro });

    registro.marcar({ clave: banco.claveDeProceso, coordinador, presupuestoMs: 60_000 });

    // Dentro del presupuesto + margen: intocable.
    ahora += 80_000;
    banco.brazo(banco.config);
    assert.deepEqual(banco.efectos.movimientos, [], 'a los 80s todavía es del coordinador');

    // Pasado el presupuesto + margen: el coordinador se colgó más allá de todo
    // timeout, el barrido recupera la capacidad del pipeline.
    ahora += 60_000;
    banco.brazo(banco.config);
    assert.equal(banco.efectos.movimientos.length, 1, 'el slot se recupera');
    assert.equal(banco.activeProcesses.has(banco.claveDeProceso), false);

    // Y el replay tardío ya no puede duplicar efectos: el turno está tomado.
    assert.equal(coordinador.cerrada, true, 'el barrido tomó el turno del coordinador');
    assert.equal(coordinador.ganador, 'barrido-huerfanos');
    assert.equal(coordinador.reencolarPorReintento(), false,
        'el settlement tardío encuentra la corrida cerrada');
    assert.deepEqual(efectosDelCoordinador.reencolados, [],
        'no le arranca el dropfile al agente que el barrido acaba de relanzar');
    assert.deepEqual(efectosDelCoordinador.cierres, [],
        'el barrido cerró por su cuenta: no duplica los efectos del coordinador');
});

// -----------------------------------------------------------------------------
// 4. Los dos actores, juntos, sobre la misma corrida.
// -----------------------------------------------------------------------------

test('replay en vuelo + barrido concurrente: la corrida se cierra UNA sola vez', async () => {
    operacionConPresupuestoConsumido();

    const registro = settlement.crearRegistroDeCorridasEnSettlement();
    const clave = processKey(SKILL, ISSUE);
    const { coordinador, efectos: efectosDelCoordinador } = coordinadorDePrueba({
        alCerrar: () => registro.olvidar(clave),
    });
    const banco = bancoDeBarrido({ registroDeSettlements: registro });

    // Replay más lento que su presupuesto: el timeout es quien cierra.
    const replay = new Promise((resolver) => setTimeout(resolver, 120));
    registro.marcar({ clave, coordinador, presupuestoMs: 30 });

    const cerrado = settlement.correrReplayAcotado({
        replay, coordinador, timeoutMs: 30, log: () => {},
    });

    // El barrido pasa mientras el replay está en vuelo: no toca nada.
    banco.brazo(banco.config);
    assert.deepEqual(banco.efectos.movimientos, [], 'barrido durante el replay: no toca la corrida');

    await cerrado;

    // El coordinador cerró: un solo cierre, y el registro quedó liberado.
    assert.equal(efectosDelCoordinador.cierres.length, 1, 'la corrida se cierra exactamente una vez');
    assert.match(efectosDelCoordinador.cierres[0], /timeout/);
    assert.equal(registro.tamanio, 0, 'el `alCerrar` liberó la entrada en el mismo tick del turno');

    // Y ahora el barrido vuelve a estar habilitado para el próximo huérfano de
    // esa clave (no queda bloqueado por un residuo del registro).
    assert.equal(registro.hayCierreEnVuelo(clave), false);

    // El replay settlea tarde: no puede duplicar efectos (barrera del rev-2).
    await replay;
    assert.equal(coordinador.reencolarPorReintento(), false);
    assert.deepEqual(efectosDelCoordinador.reencolados, []);
});

// -----------------------------------------------------------------------------
// 5. El cableado de producción: el barrido y el brazo miran el MISMO registro.
// -----------------------------------------------------------------------------

test('el brazo de credential-death y el barrido comparten la instancia real del registro', () => {
    // El sandbox de arriba inyecta un registro propio para poder controlar el
    // reloj; en producción los dos call-sites usan el singleton del módulo, que
    // el `require` cacheado hace único por proceso.
    assert.equal(typeof settlement.corridasEnSettlement.hayCierreEnVuelo, 'function');
    assert.equal(typeof settlement.corridasEnSettlement.marcar, 'function');
    assert.equal(settlement.corridasEnSettlement, require('../lib/credential-retry-settlement').corridasEnSettlement,
        'el singleton es el mismo objeto en cada require');

    const marca = 'credentialRetrySettlement.corridasEnSettlement.marcar({';
    const consulta = 'credentialRetrySettlement.corridasEnSettlement.hayCierreEnVuelo(key)';
    assert.ok(PULPO_SRC.includes(marca), 'el brazo de credential-death marca la corrida');
    assert.ok(PULPO_SRC.includes(consulta), 'el barrido de huérfanos consulta el registro');

    // La marca va ANTES de arrancar el replay: si quedara después, habría un
    // tick en el que el barrido ve la corrida sin marcar.
    const iMarca = PULPO_SRC.indexOf(marca);
    const iReplay = PULPO_SRC.indexOf('credentialRetryWiring.runReplayAttempt({');
    assert.ok(iMarca > 0 && iReplay > iMarca,
        'la marca es sincrónica y previa al replay');

    // Y la consulta va antes de TODO efecto del barrido (el primero es el
    // consumo one-shot del marker de spawn-failure).
    const iConsulta = PULPO_SRC.indexOf(consulta);
    const iPrimerEfecto = PULPO_SRC.indexOf('consumeSpawnFailureAnyProvider({', iConsulta - 4000);
    assert.ok(iConsulta > 0 && iPrimerEfecto > iConsulta,
        'el guard va antes del primer efecto del barrido');
});
