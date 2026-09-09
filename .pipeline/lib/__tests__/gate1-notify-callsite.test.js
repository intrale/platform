'use strict';

// =============================================================================
// gate1-notify-callsite.test.js — El CALL-SITE de GATE 1 en `pulpo.js` (#6192).
//
// POR QUÉ EXISTE ESTA SUITE
// -------------------------
// La primera pasada de este issue tenía 25 tests en verde con el camino real
// devolviendo `null` en todos los barridos: el helper del test REPLICABA el
// call-site ("arma el teclado igual que pulpo.js") en vez de invocarlo. Un test
// que copia el código que verifica no verifica nada — sólo cementa la copia.
//
// Acá el fuente se EXTRAE de `.pipeline/pulpo.js` y se evalúa: si alguien cambia
// el orden (sondear → redactar → registrar), rompe el log o pierde el
// fail-closed, esta suite se entera. Es la misma técnica que ya usa el test del
// brazo de huérfanos (#5796): el monolito no se puede `require`, pero sus
// funciones sí se pueden ejecutar con las dependencias inyectadas.
//
// TODO efecto está en un sandbox: el estado del dedupe va a un `tmpdir` y el
// transporte de Telegram es un doble que captura. Esta suite NO puede escribir
// en el pipeline productivo ni mandar un mensaje real.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const dedupMod = require('../gate1-notify-dedup');

const PULPO = path.resolve(__dirname, '..', '..', 'pulpo.js');
const FUENTE = fs.readFileSync(PULPO, 'utf8').split(/\r?\n/);

/** Extrae una función de nivel superior del fuente REAL de `pulpo.js`. */
function extraer(nombre) {
    const desde = FUENTE.findIndex((l) => l.startsWith(`function ${nombre}(`));
    assert.ok(desde >= 0, `no encontré function ${nombre}() en pulpo.js`);
    for (let i = desde + 1; i < FUENTE.length; i++) {
        if (FUENTE[i] === '}') return FUENTE.slice(desde, i + 1).join('\n');
    }
    throw new Error(`no encontré el cierre de ${nombre}() en pulpo.js`);
}

/**
 * Monta el call-site real con dependencias dobles.
 *
 * @param {object} opts
 * @param {object} opts.probe    respuesta del sondeo de capability.
 * @param {object} opts.registro respuesta del registro de los botones.
 */
function montarCallSite(opts = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-callsite-'));
    const dedupe = dedupMod.createGate1NotifyDedup({
        stateFile: path.join(tmp, 'gate1-notify-state.json'),
    });

    const enviados = [];
    const crudos = [];
    const logs = [];
    const pulpoRequire = Module.createRequire(PULPO);

    const ctx = {
        require: (id) => (id === './lib/gate1-notify-dedup'
            ? { getDefault: () => dedupe }
            : pulpoRequire(id)),
        // El módulo de los botones se dobla entero: el real resuelve su material
        // desde el vault y en test no hay vault (ni tiene que haberlo).
        gate1Keyboard: {
            probeGate1SignatureCapability: () => opts.probe || { ok: true },
            buildGate1SignatureKeyboard: () => opts.registro
                || { ok: true, keyboard: { inline_keyboard: [[{ text: 'Aprobar', callback_data: 'a'.repeat(16) }]] } },
        },
        sendTelegramWithMarkup: (texto, keyboard, o) => enviados.push({ texto, keyboard, opts: o }),
        sendTelegramPlain: (texto) => crudos.push(texto),
        log: (comp, m) => logs.push(`[${comp}] ${m}`),
        Date,
        Number,
        process,
        console,
        JSON,
    };
    vm.createContext(ctx);
    vm.runInContext(
        [extraer('fechaCortaLocal'), extraer('buildGate1SignatureKeyboard'), extraer('notifyGate1Retention')].join('\n\n'),
        ctx,
    );

    return {
        notificar: (input) => ctx.notifyGate1Retention(input),
        // Rompe el sondeo en caliente, para el escenario fail-closed.
        probeQueRevienta: () => {
            ctx.gate1Keyboard.probeGate1SignatureCapability = () => {
                throw new Error('boom: el sondeo reventó');
            };
        },
        enviados,
        crudos,
        logs,
        dedupe,
        tmp,
    };
}

const RETENCION = {
    issue: 6192,
    titulo: 'Gate de firma: ficha de decision y botones autorizados',
    reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
    caso: 'block',
    firmantesAutorizados: 1,
    criteriaHash: 'abc123',
};

test('con la capability disponible el aviso sale CON teclado y el log lo dice', () => {
    const cs = montarCallSite();
    cs.notificar(RETENCION);

    assert.strictEqual(cs.enviados.length, 1, 'tiene que salir exactamente un aviso');
    const [envio] = cs.enviados;
    assert.ok(envio.keyboard, 'el teclado tiene que llegar al transporte');
    assert.strictEqual(envio.opts.plain, true, 'contrato anti-#5421: texto plano explícito');
    assert.match(cs.logs.join('\n'), /aviso emitido \(firma, con botones\)/);
});

test('sin capability el aviso sale sin teclado, como indeterminado, y el log NO promete botones', () => {
    const cs = montarCallSite({ probe: { ok: false, code: 'VAULT_DISABLED' } });
    cs.notificar(RETENCION);

    assert.strictEqual(cs.enviados.length, 1);
    const [envio] = cs.enviados;
    assert.strictEqual(envio.keyboard, null, 'no se manda un teclado que no se pudo registrar');
    assert.ok(!/con botones/.test(cs.logs.join('\n')), 'el log no puede decir que salieron botones');
    assert.match(cs.logs.join('\n'), /la firma por botón no está disponible \(VAULT_DISABLED\)/i,
        'el código acotado se loguea; el error crudo no');
    // CA-1: el aviso reclasificado conserva los HECHOS.
    assert.match(envio.texto, /#6192/);
    assert.match(envio.texto, /¿Aprobás el alcance de #6192/);
    assert.ok(envio.texto.includes('/unblock 6192 aprobar'));
    assert.ok(!/no supe clasificar|no las puedo justificar/i.test(envio.texto));
});

test('si la capability se cae ENTRE el sondeo y el registro, el texto se rearma y el log no miente', () => {
    // Éste es el defecto que reportó QA: convivían en la misma corrida "no pude
    // registrar los botones de firma" y "aviso emitido (firma, con botones)",
    // porque el detalle se armaba con la INTENCIÓN (`aviso.ofreceBotones`).
    const cs = montarCallSite({ registro: { ok: false, code: 'VAULT_DISABLED' } });
    cs.notificar(RETENCION);

    assert.strictEqual(cs.enviados.length, 1);
    const [envio] = cs.enviados;
    assert.strictEqual(envio.keyboard, null);
    assert.ok(!/¿Aprobás el alcance[\s\S]*Opciones:/.test(envio.texto),
        'el texto no puede quedar ofreciendo opciones que no tienen botón');
    assert.match(envio.texto, /firma por botón no está disponible/i);

    const log = cs.logs.join('\n');
    assert.ok(!/con botones/.test(log), 'el log reporta el teclado que salió, no el que se pensaba mandar');
    assert.match(log, /reclasificado/);
});

test('el dedupe no repite el aviso en el barrido siguiente si nada cambió', () => {
    const cs = montarCallSite();
    cs.notificar(RETENCION);
    cs.notificar(RETENCION);
    assert.strictEqual(cs.enviados.length, 1, 'R-GATE: un solo aviso por estado firmable');
    assert.match(cs.logs.join('\n'), /aviso NO emitido \(ya-notificado\)/);

    cs.notificar({ ...RETENCION, criteriaHash: 'otro-hash' });
    assert.strictEqual(cs.enviados.length, 2, 'si cambia lo que hay que firmar, vuelve a avisar');
});

test('el estado persistido del dedupe guarda el hash y NUNCA el body', () => {
    const cs = montarCallSite();
    cs.notificar({ ...RETENCION, titulo: 'MARCADOR_QUE_NO_DEBE_PERSISTIRSE_6192' });

    const crudo = fs.readFileSync(cs.dedupe.stateFile, 'utf8');
    assert.ok(!crudo.includes('MARCADOR_QUE_NO_DEBE_PERSISTIRSE_6192'), 'el body no entra al estado');
    assert.ok(!crudo.includes('GATE 1 retuvo'), 'el motivo tampoco');
    for (const entrada of Object.values(JSON.parse(crudo))) {
        assert.deepStrictEqual(Object.keys(entrada).sort(), ['hash', 'ts']);
    }
});

test('fail-closed: si el armado del aviso revienta, sale el aviso crudo y el issue sigue retenido', () => {
    // Se rompe el sondeo, que es lo primero que toca el call-site: cualquier
    // excepción tiene que terminar en el aviso crudo, nunca en silencio ni en
    // una retención levantada.
    const cs = montarCallSite();
    cs.probeQueRevienta();
    cs.notificar(RETENCION);
    const todo = cs.logs.join('\n');
    assert.strictEqual(cs.enviados.length, 0, 'no sale la ficha: el armado falló');
    assert.strictEqual(cs.crudos.length, 1, 'sale el aviso crudo: el operador se entera igual');
    assert.match(cs.crudos[0], /#6192 sigue retenido/);
    assert.match(todo, /fallo armando\/emitiendo/);
    assert.ok(!/aviso emitido \([^)]*con botones/.test(todo),
        'nunca se promete un botón cuando el armado falló');
});
