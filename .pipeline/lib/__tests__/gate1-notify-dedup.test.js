'use strict';

// =============================================================================
// Tests del dedupe persistente del aviso de GATE 1 (#6192).
//
// Lo que se cementa acá es el CA "no se repite en el barrido siguiente si nada
// cambió; si cambian los criterios firmables, vuelve a avisar" y la garantía de
// que el archivo de estado NUNCA contiene el body del issue.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dedupModule = require('../gate1-notify-dedup');

function tmpState(nombre) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate1-dedup-${nombre}-`));
    return path.join(dir, 'gate1-notify-state.json');
}

/** Instancia hermética con reloj fijo y estado en un tmpdir propio. */
function crear(nombre, ms = Date.parse('2026-09-09T12:00:00Z'), opts = {}) {
    let ahora = ms;
    const dedup = dedupModule.createGate1NotifyDedup({
        stateFile: tmpState(nombre),
        now: () => ahora,
        ...opts,
    });
    return { dedup, avanzar: (delta) => { ahora += delta; } };
}

const BODY_V1 = '## Criterios\n- [ ] Uno\n- [ ] Dos';
const BODY_V2 = '## Criterios\n- [ ] Uno\n- [ ] Dos\n- [ ] Tres (agregado después)';

test('dos barridos con el mismo body emiten un solo aviso', () => {
    const { dedup } = crear('mismo-body');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;

    const primero = dedup.notifyOnce({ issue: 6192, hash, emit: () => { emitidos += 1; } });
    const segundo = dedup.notifyOnce({ issue: 6192, hash, emit: () => { emitidos += 1; } });

    assert.strictEqual(emitidos, 1, 'el segundo barrido no debe volver a avisar');
    assert.strictEqual(primero.notified, true);
    assert.strictEqual(primero.sealed, true);
    assert.strictEqual(segundo.notified, false);
    assert.strictEqual(segundo.reason, 'ya-notificado');
});

test('si cambian los criterios firmables el aviso vuelve a salir', () => {
    const { dedup } = crear('body-cambiado');
    let emitidos = 0;
    const emit = () => { emitidos += 1; };

    dedup.notifyOnce({ issue: 6192, hash: dedup.computeHash(['block', 'firma', BODY_V1]), emit });
    dedup.notifyOnce({ issue: 6192, hash: dedup.computeHash(['block', 'firma', BODY_V1]), emit });
    dedup.notifyOnce({ issue: 6192, hash: dedup.computeHash(['block', 'firma', BODY_V2]), emit });

    assert.strictEqual(emitidos, 2, 'el body nuevo tiene que volver a avisar');
});

test('el dedupe es por issue: otro issue con el mismo hash igual avisa', () => {
    const { dedup } = crear('por-issue');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;
    const emit = () => { emitidos += 1; };

    dedup.notifyOnce({ issue: 6192, hash, emit });
    dedup.notifyOnce({ issue: 6193, hash, emit });

    assert.strictEqual(emitidos, 2);
});

test('el archivo de estado guarda SÓLO el hash y el ts, nunca el body', () => {
    const { dedup } = crear('sin-body');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    dedup.notifyOnce({ issue: 6192, hash, emit: () => {} });

    const crudo = fs.readFileSync(dedup.stateFile, 'utf8');
    const estado = JSON.parse(crudo);

    assert.deepStrictEqual(Object.keys(estado), ['6192']);
    assert.deepStrictEqual(Object.keys(estado['6192']).sort(), ['hash', 'ts']);
    assert.match(estado['6192'].hash, /^[a-f0-9]{64}$/);
    assert.strictEqual(estado['6192'].ts, '2026-09-09T12:00:00.000Z');

    // Ni el body entero ni un fragmento reconocible pueden aparecer en el JSON.
    assert.ok(!crudo.includes(BODY_V1), 'el body no puede quedar persistido');
    assert.ok(!crudo.includes('Criterios'), 'ni un fragmento del body');
    assert.ok(!crudo.includes('Uno'), 'ni un fragmento del body');
});

test('el emisor se invoca ANTES de sellar: si falla, el aviso no queda sellado', () => {
    const { dedup } = crear('emisor-falla');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);

    const fallo = dedup.notifyOnce({
        issue: 6192,
        hash,
        emit: () => { throw new Error('telegram caído'); },
    });

    assert.strictEqual(fallo.notified, false);
    assert.strictEqual(fallo.reason, 'emisor-fallo');
    assert.match(fallo.error, /telegram caído/);
    assert.strictEqual(dedup.shouldNotify(6192, hash), true,
        'un envío fallido no puede silenciar el próximo barrido');

    let emitidos = 0;
    const reintento = dedup.notifyOnce({ issue: 6192, hash, emit: () => { emitidos += 1; } });
    assert.strictEqual(emitidos, 1);
    assert.strictEqual(reintento.notified, true);
});

test('forget hace que el aviso vuelva a salir si el issue se retiene de nuevo', () => {
    const { dedup } = crear('forget');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;
    const emit = () => { emitidos += 1; };

    dedup.notifyOnce({ issue: 6192, hash, emit });
    assert.strictEqual(dedup.forget(6192), true);
    dedup.notifyOnce({ issue: 6192, hash, emit });

    assert.strictEqual(emitidos, 2);
    assert.strictEqual(dedup.forget(6192), true);
    // Idempotente: olvidar dos veces no reescribe ni rompe.
    assert.strictEqual(dedup.forget(6192), false);
});

test('estado corrupto o ausente hace que se avise (fail-safe hacia el operador)', () => {
    const { dedup } = crear('corrupto');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);

    // Ausente.
    assert.strictEqual(dedup.shouldNotify(6192, hash), true);

    // Corrupto.
    fs.mkdirSync(path.dirname(dedup.stateFile), { recursive: true });
    fs.writeFileSync(dedup.stateFile, '{esto no es json', 'utf8');
    assert.strictEqual(dedup.shouldNotify(6192, hash), true);
    assert.deepStrictEqual(dedup.read(), {});

    // Forma inesperada (array en vez de objeto, entrada sin hash usable).
    fs.writeFileSync(dedup.stateFile, '[]', 'utf8');
    assert.strictEqual(dedup.shouldNotify(6192, hash), true);
    fs.writeFileSync(dedup.stateFile, JSON.stringify({ 6192: { hash: 'no-es-un-sha256' } }), 'utf8');
    assert.strictEqual(dedup.shouldNotify(6192, hash), true);

    // Y sobre estado corrupto se puede volver a sellar sin lanzar.
    assert.strictEqual(dedup.record(6192, hash), true);
    assert.strictEqual(dedup.shouldNotify(6192, hash), false);
});

test('un write que falla no lanza: devuelve false y el aviso se repetirá', () => {
    const dedup = dedupModule.createGate1NotifyDedup({
        stateFile: tmpState('write-falla'),
        jsonImpl: {
            readJsonSafe: () => ({}),
            writeJsonAtomic: () => { throw new Error('disco lleno'); },
        },
    });
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;

    const res = dedup.notifyOnce({ issue: 6192, hash, emit: () => { emitidos += 1; } });

    assert.strictEqual(emitidos, 1, 'el aviso sale igual: la alerta vale más que el dedupe');
    assert.strictEqual(res.notified, true);
    assert.strictEqual(res.sealed, false, 'el caller tiene que poder loguear que no se selló');
});

test('las entradas más viejas que la retención se podan', () => {
    const { dedup, avanzar } = crear('poda');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    dedup.record(6192, hash);
    assert.ok(dedup.read()['6192']);

    avanzar(dedupModule.RETENTION_MS + 1000);
    dedup.record(6193, hash); // cualquier write dispara la poda
    const estado = dedup.read();

    assert.strictEqual(estado['6192'], undefined, 'la entrada vencida se poda');
    assert.ok(estado['6193'], 'la entrada nueva queda');
});

test('sin número de issue o sin hash válido se avisa igual (nunca se pierde la alerta)', () => {
    const { dedup } = crear('sin-clave');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);

    assert.strictEqual(dedup.shouldNotify(null, hash), true);
    assert.strictEqual(dedup.shouldNotify(0, hash), true);
    assert.strictEqual(dedup.shouldNotify('no-es-un-issue', hash), true);
    assert.strictEqual(dedup.shouldNotify(6192, 'no-es-un-hash'), true);
    assert.strictEqual(dedup.record(null, hash), false);
    assert.strictEqual(dedup.record(6192, 'no-es-un-hash'), false);

    let emitidos = 0;
    dedup.notifyOnce({ issue: null, hash, emit: () => { emitidos += 1; } });
    dedup.notifyOnce({ issue: null, hash, emit: () => { emitidos += 1; } });
    assert.strictEqual(emitidos, 2, 'sin clave no hay dedupe posible: se avisa siempre');
});

test('computeHash separa las partes: dos particiones distintas no colisionan', () => {
    assert.notStrictEqual(
        dedupModule.computeHash(['ab', 'c']),
        dedupModule.computeHash(['a', 'bc']),
    );
    assert.strictEqual(
        dedupModule.computeHash(['block', 'firma', BODY_V1]),
        dedupModule.computeHash(['block', 'firma', BODY_V1]),
    );
    assert.match(dedupModule.computeHash(['x']), /^[a-f0-9]{64}$/);
});


// =============================================================================
// #6207 · CA-B2 / SEC-10 — LA DEDUPLICACIÓN NUNCA DEGRADA A SILENCIO.
//
// El dedupe original silenciaba PARA SIEMPRE mientras el hash no cambiara. Un
// pedido de firma que el operador no llegó a ver (notificaciones en silencio,
// chat scrolleado, fin de semana) desaparecía sin dejar rastro y el issue
// quedaba frenado sin ninguna señal. Lo que se cementa acá es que la supresión
// es ACOTADA: se espacia la frecuencia, nunca se apaga el canal.
//
// Todo con reloj inyectado: un test de cadencia que dependa del reloj real es
// un test que no corre o que tarda seis horas.
// =============================================================================

test('CA-B2: avisa, silencia, y tras reminderMs VUELVE a avisar', () => {
    const RECORDATORIO = 6 * 60 * 60 * 1000;
    const { dedup, avanzar } = crear('recordatorio', undefined, { reminderMs: RECORDATORIO });
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;
    const emit = () => { emitidos += 1; };

    // Barrido 1: avisa.
    dedup.notifyOnce({ issue: 6207, hash, emit });
    assert.strictEqual(emitidos, 1);

    // Barridos siguientes dentro de la ventana: silencio (el pulpo barre cada
    // pocos minutos; sin esto sería un aviso por barrido).
    for (let i = 0; i < 20; i++) {
        avanzar(60 * 1000);
        dedup.notifyOnce({ issue: 6207, hash, emit });
    }
    assert.strictEqual(emitidos, 1, 'dentro de la ventana no se repite');

    // Justo antes del vencimiento: sigue en silencio.
    avanzar(RECORDATORIO - 20 * 60 * 1000 - 1);
    dedup.notifyOnce({ issue: 6207, hash, emit });
    assert.strictEqual(emitidos, 1, 'un milisegundo antes todavía no toca');

    // Cumplida la ventana: el recordatorio SALE, con el mismo hash.
    avanzar(1);
    const recordatorio = dedup.notifyOnce({ issue: 6207, hash, emit });
    assert.strictEqual(emitidos, 2, 'el pedido pendiente vuelve a aparecer');
    assert.strictEqual(recordatorio.notified, true);
    assert.strictEqual(recordatorio.reason, 'emitido');
});

test('CA-B2 / SEC-10: prohibida la supresión permanente — el aviso reaparece siempre', () => {
    const RECORDATORIO = 60 * 60 * 1000;
    const { dedup, avanzar } = crear('sin-silencio', undefined, { reminderMs: RECORDATORIO });
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    let emitidos = 0;
    const emit = () => { emitidos += 1; };

    // Cinco días de issue retenido sin que nadie edite nada.
    for (let i = 0; i < 5 * 24; i++) {
        dedup.notifyOnce({ issue: 6207, hash, emit });
        avanzar(RECORDATORIO);
    }
    assert.strictEqual(emitidos, 5 * 24, 'un recordatorio por ventana, ni uno menos');
});

test('CA-B2: `record` refresca la marca de tiempo (el recordatorio se cuenta desde el último aviso)', () => {
    const RECORDATORIO = 60 * 60 * 1000;
    const { dedup, avanzar } = crear('refresca-ts', undefined, { reminderMs: RECORDATORIO });
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);

    dedup.record(6207, hash);
    const primerTs = dedup.read()['6207'].ts;

    avanzar(RECORDATORIO / 2);
    assert.strictEqual(dedup.shouldNotify(6207, hash), false, 'media ventana: silencio');

    avanzar(RECORDATORIO / 2);
    assert.strictEqual(dedup.shouldNotify(6207, hash), true, 'ventana cumplida: avisa');

    dedup.record(6207, hash);
    const segundoTs = dedup.read()['6207'].ts;
    assert.notStrictEqual(segundoTs, primerTs, 'el sello se renueva');
    assert.strictEqual(dedup.shouldNotify(6207, hash), false, 'y la ventana arranca de nuevo');
});

test('CA-B2: una entrada con `ts` ilegible avisa (fail-safe hacia el duplicado)', () => {
    const { dedup } = crear('ts-roto');
    const hash = dedup.computeHash(['block', 'firma', BODY_V1]);
    dedup.record(6207, hash);

    // Se corrompe el `ts` a mano: sin fecha usable no se puede calcular la
    // ventana, y ante la duda el módulo avisa en vez de callarse.
    const estado = JSON.parse(fs.readFileSync(dedup.stateFile, 'utf8'));
    estado['6207'].ts = 'no-es-una-fecha';
    fs.writeFileSync(dedup.stateFile, JSON.stringify(estado), 'utf8');

    assert.strictEqual(dedup.shouldNotify(6207, hash), true);
});

test('un reminderMs inválido cae al default en vez de silenciar o spamear', () => {
    // `0` sería "recordar en cada barrido" (el spam que #6192 cerró) e
    // `Infinity` sería la supresión permanente que CA-B2 prohíbe: ambos caen al
    // default en vez de convertirse en comportamiento.
    for (const malo of [0, -1, Infinity, NaN, null, 'seis horas', {}]) {
        const { dedup } = crear(`reminder-malo`, undefined, { reminderMs: malo });
        assert.strictEqual(
            dedup.reminderMs, dedupModule.DEFAULT_REMINDER_MS,
            `reminderMs ${JSON.stringify(malo)} debe caer al default`,
        );
    }
});

test('el default del recordatorio es acotado: ni por barrido ni para siempre', () => {
    assert.ok(Number.isFinite(dedupModule.DEFAULT_REMINDER_MS));
    assert.ok(dedupModule.DEFAULT_REMINDER_MS > 60 * 60 * 1000,
        'más de una hora: no puede entrenar al operador a ignorar el canal');
    assert.ok(dedupModule.DEFAULT_REMINDER_MS <= 24 * 60 * 60 * 1000,
        'como mucho un día: en una jornada de trabajo el pedido reaparece');
});
