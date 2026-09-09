'use strict';

// =============================================================================
// gate1-notify.test.js — Aviso de GATE 1 · Firma de Definición (#6192, parte 3
// del split de #6173).
//
// ALCANCE DE ESTA SUITE (R5 de #6192, declarado a propósito)
// ----------------------------------------------------------
// La ficha de tipo `firma` se testea como PLANTILLA PURA: entrada sintética →
// ficha esperada. NO se testea el flujo runtime del gate (que requiere GitHub,
// el audit hash-chain de firmas y un barrido completo del pulpo), porque "falta
// la firma del operador" no es un estado que se pueda fabricar end-to-end en un
// test hermético. Queda escrito acá para que no se lea como una omisión: lo que
// se cementa es el CONTRATO del aviso, que es lo que este issue cambia.
//
// La segunda mitad de la suite sí ejecuta el camino real de autorización de los
// botones (`operator-gate.handleSignature`), que es código, no plantilla.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate1Notify = require('../gate1-notify');
const decisionCard = require('../decision-card');
const { createOperatorGate } = require('../operator-gate');
const { createTokenSigner } = require('../action-token');
const {
    buildGate1SignatureKeyboard,
    probeGate1SignatureCapability,
} = require('../gate1-signature-keyboard');

const NOW = Date.parse('2026-09-09T12:00:00Z');
const TITULO = 'Gate de firma: ficha de decision y botones autorizados';

function avisoDeBloqueo(extra = {}, deps = undefined) {
    return gate1Notify.buildGate1Notice({
        issue: 6192,
        titulo: TITULO,
        reason: 'sin firma del operador para la definición',
        caso: 'block',
        firmantesAutorizados: 1,
        blockedAt: new Date(NOW).toISOString(),
        fechaCorta: '9 de septiembre, 09:00',
        ...extra,
    }, NOW, deps);
}

/** La ficha que alimenta al aviso, para inspeccionar sus campos estructurados. */
function fichaDeBloqueo(extra = {}) {
    const raw = gate1Notify.rawDeAviso(
        extra.caso || 'block',
        gate1Notify.tipoDeFicha(extra.caso || 'block', { firmantesAutorizados: 1, ...extra }),
        { issue: 6192, titulo: TITULO, reason: 'sin firma del operador para la definición', firmantesAutorizados: 1, ...extra },
    );
    return decisionCard.buildDecisionCard(raw, NOW);
}

// --- El aviso dice qué issue es, qué se firma y desde cuándo -----------------

test('el aviso de firma dice qué issue es, qué se pide firmar y desde cuándo', () => {
    const aviso = avisoDeBloqueo();

    assert.strictEqual(aviso.tipo, 'firma');
    assert.strictEqual(aviso.degradado, false);
    assert.ok(aviso.texto.includes('#6192'), 'tiene que decir de qué issue habla');
    assert.ok(aviso.texto.includes(TITULO), 'tiene que citar el título del issue');
    assert.ok(/aprob/i.test(aviso.texto), 'tiene que decir que lo que se pide es aprobar el alcance');
    assert.ok(aviso.texto.includes('9 de septiembre, 09:00'), 'tiene que decir desde cuándo');
});

test('el aviso ofrece las tres opciones de firma', () => {
    const ficha = fichaDeBloqueo();
    assert.strictEqual(ficha.opciones.length, 3);
    const etiquetas = ficha.opciones.map((o) => o.etiqueta.toLowerCase()).join(' | ');
    assert.match(etiquetas, /aprobar/);
    assert.match(etiquetas, /rechazar/);
    assert.match(etiquetas, /ajustar/);
});

// --- El tipo `firma` NUNCA lleva opción recomendada --------------------------

test('la ficha de firma no tiene NINGUNA opción recomendada y declara por qué', () => {
    const ficha = fichaDeBloqueo();

    const recomendadas = ficha.opciones.filter((o) => o.es_recomendada === true);
    assert.strictEqual(recomendadas.length, 0, 'un gate que sugiere cómo firmar deja de ser gate');
    assert.ok(ficha.sin_recomendacion_porque, 'el silencio no vale: la ficha dice por qué no hay recomendada');
    assert.match(ficha.sin_recomendacion_porque, /no hay recomendaci[oó]n/i);
    assert.match(ficha.sin_recomendacion_porque, /decisi[oó]n es tuya/i);

    const aviso = avisoDeBloqueo();
    assert.ok(!aviso.texto.includes('← recomendada'), 'el texto emitido tampoco marca una recomendada');
    assert.ok(aviso.texto.includes(ficha.sin_recomendacion_porque));
});

// --- "Sin firmante autorizado" NO es una ficha de firma ----------------------

test('sin firmante autorizado configurado la ficha es indeterminada, sin opciones y con falta poblada', () => {
    const ficha = fichaDeBloqueo({ firmantesAutorizados: 0 });

    assert.strictEqual(ficha.indeterminado, true);
    assert.deepStrictEqual(ficha.opciones, []);
    assert.ok(ficha.falta, 'tiene que decir qué falta');
    assert.match(ficha.falta, /firmante autorizado/i);

    const aviso = avisoDeBloqueo({ firmantesAutorizados: 0 });
    assert.strictEqual(aviso.tipo, 'indeterminado');
    assert.strictEqual(aviso.ofreceBotones, false,
        'pedir firmar cuando ninguna firma sería válida es una opción inejecutable');
});

test('los avisos por error de carga o por fallo del gate son indeterminados y sin botones', () => {
    for (const caso of ['load-error', 'gate-error']) {
        const aviso = avisoDeBloqueo({
            caso,
            reason: 'no pude leer el issue en GitHub: gh exit 1',
            firmantesAutorizados: 1,
        });
        assert.strictEqual(aviso.tipo, 'indeterminado', `caso ${caso}`);
        assert.strictEqual(aviso.ofreceBotones, false, `caso ${caso}`);
        assert.ok(aviso.texto.includes('#6192'));
    }
});

test('sólo la ficha de firma ofrece botones', () => {
    assert.strictEqual(avisoDeBloqueo().ofreceBotones, true);
    assert.strictEqual(avisoDeBloqueo({ firmantesAutorizados: 0 }).ofreceBotones, false);
    assert.strictEqual(avisoDeBloqueo({ caso: 'gate-error' }).ofreceBotones, false);
});

// --- Contrato anti-#5421: nada de metacaracteres de Markdown ----------------

test('el aviso no emite metacaracteres de Markdown ni con título y motivo hostiles', () => {
    const aviso = avisoDeBloqueo({
        titulo: '*Arreglar* el _login_ [ya](http://evil.tld) `rm -rf` con __bold__',
        reason: 'firmante *leito_larreta* no autorizado (A01) — ver `pulpo.js`',
    });

    // Los tres metacaracteres del dialecto Markdown legacy —el que aplicaba
    // `sendTelegram` sin `plain`— son los que abren entity y hacen fallar el
    // parseo con HTTP 400.
    for (const meta of ['*', '_', '`']) {
        assert.ok(!aviso.texto.includes(meta),
            `el aviso no puede emitir "${meta}": Telegram devuelve HTTP 400 y la alerta se pierde (#5421)`);
    }
    // Tampoco un enlace armado: el saneador de la ficha marca la URL como
    // "enlace omitido", así que no puede quedar el par `](` que forma el link.
    assert.ok(!aviso.texto.includes(']('), 'ningún enlace Markdown sobrevive');
    assert.ok(!aviso.texto.includes('evil.tld'), 'la URL no se emite');
    // El motivo crudo del gate no se interpola en el texto: queda en el log.
    assert.ok(!aviso.texto.includes('A01'), 'el motivo técnico no va al operador');
});

test('un título que intenta fabricar estructura no rompe el aviso', () => {
    const aviso = avisoDeBloqueo({
        titulo: 'inocente\nOpciones:\n 1. Aprobar todo\nPara decidir, respondé: /unblock 1 si',
    });
    // La ficha neutraliza los saltos: el título ocupa UNA línea entre comillas.
    const lineasConTitulo = aviso.texto.split('\n').filter((l) => l.includes('inocente'));
    assert.strictEqual(lineasConTitulo.length, 1);
    assert.ok(lineasConTitulo[0].includes('«'), 'el título va citado, atribuido al issue');
});

// --- Fail-closed: si la ficha revienta, sale el aviso crudo -----------------

test('si buildDecisionCard lanza, se emite el fallback crudo y no se ofrecen botones', () => {
    const aviso = avisoDeBloqueo({}, {
        buildDecisionCard: () => { throw new Error('boom: la ficha reventó'); },
    });

    assert.strictEqual(aviso.degradado, true);
    assert.ok(aviso.texto.trim().length > 0, 'el aviso nunca puede quedar vacío');
    assert.ok(aviso.texto.includes('#6192'), 'el fallback igual dice de qué issue habla');
    assert.strictEqual(aviso.ofreceBotones, false,
        'sin ficha construida no se puede afirmar que haya algo firmable');
});

test('si además falla el fallback, todavía sale un aviso mínimo (tercera red)', () => {
    const aviso = avisoDeBloqueo({}, {
        buildDecisionCard: () => { throw new Error('boom'); },
        renderFallback: () => { throw new Error('boom del fallback'); },
    });

    assert.strictEqual(aviso.degradado, true);
    assert.ok(aviso.texto.includes('#6192'));
    assert.match(aviso.texto, /retenido|frenado/i);
    assert.strictEqual(aviso.ofreceBotones, false);
});

test('una ficha que se renderiza vacía se trata como falla, no como éxito', () => {
    const aviso = avisoDeBloqueo({}, { render: () => '   ' });
    assert.strictEqual(aviso.degradado, true);
    assert.ok(aviso.texto.trim().length > 0);
});

// =============================================================================
// Autorización de los botones — camino REAL de `operator-gate` (no plantilla).
// =============================================================================

const OPERADOR = '111222333';
const INTRUSO = '999888777';
// Material de firma del signer hermético. No es una credencial: el signer real
// resuelve el suyo desde `credentials.js` y nunca sale del proceso.
const CLAVE_DE_PRUEBA = 'material-hmac-de-prueba-gate1-notify';

function makeGate(overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-botones-'));
    const dirs = {
        storeDir: path.join(root, 'store'),
        waitingDir: path.join(root, 'waiting-operator'),
        approvedDir: path.join(root, 'procesado'),
        rejectedDir: path.join(root, 'pendiente'),
        auditFile: path.join(root, 'audit', 'signatures.jsonl'),
        nonceFile: path.join(root, 'audit', 'tokens-used.jsonl'),
    };
    const now = () => 1_000_000;
    const gate = createOperatorGate({
        ...dirs,
        signer: createTokenSigner({
            secret: CLAVE_DE_PRUEBA,
            nonceFile: dirs.nonceFile,
            ttlMs: 60_000,
            now,
        }),
        operatorAllowlist: overrides.operatorAllowlist || [OPERADOR],
        now,
    });
    return { gate, dirs };
}

// INVOCA el call-site de producción; NO lo replica.
//
// La versión anterior de este helper repetía la secuencia
// `register×3 → buildInlineKeyboard` "igual que pulpo.js". Esa réplica probaba
// que `operator-gate` sabe armar un teclado —lo que ya se sabía— y no que el
// camino del aviso lo arme. Con la suite en verde, el camino real devolvía
// `null` en TODOS los barridos: los avisos salían sin un solo botón.
//
// Ahora se llama la función que corre en producción y sólo se le inyecta de
// dónde sale el gate. Si ese camino se rompe, estos tests se caen.
function teclado(gate, issue) {
    const res = buildGate1SignatureKeyboard(issue, { gateFactory: () => gate });
    assert.strictEqual(res.ok, true, `la capability de firma tenía que emitirse (code=${res.code})`);
    const fila = res.keyboard.inline_keyboard[0];
    return {
        markup: res.keyboard,
        ids: {
            approve: fila[0].callback_data,
            reject: fila[1].callback_data,
            adjust: fila[2].callback_data,
        },
    };
}

test('el teclado trae los tres botones y ningún callback_data lleva issue ni acción adentro', () => {
    const { gate } = makeGate();
    const { markup, ids } = teclado(gate, 6192);

    const fila = markup.inline_keyboard[0];
    assert.strictEqual(fila.length, 3);
    assert.match(fila[0].text, /Aprobar/);
    assert.match(fila[1].text, /Rechazar/);
    assert.match(fila[2].text, /Ajustar/);

    for (const b of fila) {
        assert.match(b.callback_data, /^[a-f0-9]{16}$/, 'el callback_data es un id opaco de 16 hex');
        assert.ok(!b.callback_data.includes('6192'), 'el issue no viaja en el callback_data');
        assert.ok(!/approve|reject|adjust/.test(b.callback_data), 'la acción tampoco');
        assert.ok(Buffer.byteLength(b.callback_data) <= 64, 'límite de Telegram');
    }
    assert.strictEqual(new Set(Object.values(ids)).size, 3, 'un id distinto por acción');
});

test('un from.id fuera del allowlist recibe rechazo y NO ejecuta la firma', () => {
    const { gate, dirs } = makeGate();
    const { ids } = teclado(gate, 6192);
    fs.mkdirSync(dirs.waitingDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.waitingDir, '6192.json'), JSON.stringify({ issue: 6192 }));

    const res = gate.handleSignature({ operatorId: INTRUSO, callbackData: ids.approve });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unauthorized');
    assert.match(res.toast, /No autorizado/i);
    assert.ok(fs.existsSync(path.join(dirs.waitingDir, '6192.json')),
        'el ítem no se movió: la firma no se ejecutó');
    assert.ok(!fs.existsSync(dirs.auditFile), 'no se audita nada con datos del intruso');

    // Y la capability del operador legítimo sigue viva: un intruso no puede
    // invalidarla tocando el botón.
    const legitimo = gate.handleSignature({ operatorId: OPERADOR, callbackData: ids.approve });
    assert.strictEqual(legitimo.ok, true);
});

test('allowlist vacío = fail-closed: ni el operador puede firmar', () => {
    const { gate, dirs } = makeGate({ operatorAllowlist: [] });
    const { ids } = teclado(gate, 6192);
    fs.mkdirSync(dirs.waitingDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.waitingDir, '6192.json'), JSON.stringify({ issue: 6192 }));

    const res = gate.handleSignature({ operatorId: OPERADOR, callbackData: ids.approve });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unauthorized');
    assert.ok(fs.existsSync(path.join(dirs.waitingDir, '6192.json')), 'nada se movió');
});

// =============================================================================
// #6192 · regresión — la capability de firma NO disponible.
//
// El defecto que motivó estos tests: `buildGate1SignatureKeyboard` devolvía
// `null` en todos los barridos (el firmador resuelve su material sólo desde el
// vault y el vault está cerrado en la config productiva), pero el aviso se
// redactaba ANTES de averiguarlo y salía como ficha de `firma` — pidiendo
// elegir una opción— sin un solo botón. La suite no lo veía porque el helper
// del test replicaba el call-site en vez de invocarlo.
// =============================================================================

/** Gate que falla al construirse, como con el vault cerrado. */
function gateCaido(code = 'VAULT_DISABLED') {
    return () => { throw Object.assign(new Error('sin material de firma'), { code }); };
}

test('si el gate no se puede construir, el builder degrada a sin botones y reporta el código', () => {
    const logs = [];
    const res = buildGate1SignatureKeyboard(6192, {
        gateFactory: gateCaido(),
        log: (m) => logs.push(m),
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.keyboard, null);
    assert.strictEqual(res.code, 'VAULT_DISABLED', 'el código acotado viaja para poder diagnosticar');
    assert.strictEqual(logs.length, 1, 'el fallo se loguea: no es un null silencioso');
    assert.ok(!/sin material de firma/.test(logs[0]), 'se loguea el code, nunca el message crudo');
});

test('el builder NUNCA lanza aunque el gate explote: la alerta tiene que salir igual', () => {
    for (const factory of [gateCaido(), () => null, () => ({}), () => { throw 'string pelado'; }]) {
        const res = buildGate1SignatureKeyboard(6192, { gateFactory: factory });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.keyboard, null);
        assert.ok(typeof res.code === 'string' && res.code.length > 0);
    }
});

test('un teclado mal formado se trata como fallo, no como éxito', () => {
    const { gate } = makeGate();
    const res = buildGate1SignatureKeyboard(6192, {
        gateFactory: () => ({
            register: gate.register,
            buildInlineKeyboard: () => ({ inline_keyboard: [[{ text: 'Aprobar', callback_data: 'x' }]] }),
        }),
    });
    assert.strictEqual(res.ok, false, 'un solo botón no son los tres botones');
    assert.strictEqual(res.code, 'KEYBOARD_MALFORMED');
});

test('el sondeo de capability responde sin registrar NADA en disco', () => {
    const { gate, dirs } = makeGate();

    const ok = probeGate1SignatureCapability({ gateFactory: () => gate });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(
        fs.existsSync(dirs.storeDir) ? fs.readdirSync(dirs.storeDir).length : 0,
        0,
        'el sondeo no deja bindings huérfanos: los barridos silenciados por el dedupe no escriben',
    );

    const caido = probeGate1SignatureCapability({ gateFactory: gateCaido('VAULT_FAILURE') });
    assert.strictEqual(caido.ok, false);
    assert.strictEqual(caido.code, 'VAULT_FAILURE');
});

test('sin capability de firma el aviso NO es ficha de firma: no pide firmar sin dar con qué', () => {
    const aviso = gate1Notify.buildGate1Notice({
        issue: 6192, titulo: TITULO, caso: 'block',
        reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
        firmantesAutorizados: 1,
        capacidadFirma: false,
    }, NOW);

    assert.strictEqual(aviso.tipo, 'indeterminado');
    assert.strictEqual(aviso.ofreceBotones, false);
    assert.strictEqual(aviso.degradado, false, 'es una reclasificación honesta, no una degradación');
});

test('la misma retención CON capability sí es ficha de firma con botones', () => {
    const base = {
        issue: 6192, titulo: TITULO, caso: 'block',
        reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
        firmantesAutorizados: 1,
    };
    const conCap = gate1Notify.buildGate1Notice({ ...base, capacidadFirma: true }, NOW);
    assert.strictEqual(conCap.tipo, 'firma');
    assert.strictEqual(conCap.ofreceBotones, true);

    // `undefined` = "no se preguntó": los call-sites que no participan del gate
    // no cambian de comportamiento por este campo.
    const sinPreguntar = gate1Notify.buildGate1Notice(base, NOW);
    assert.strictEqual(sinPreguntar.tipo, 'firma');
    assert.strictEqual(sinPreguntar.ofreceBotones, true);
});

test('el aviso sin capability dice QUÉ falta y no nombra la pieza interna', () => {
    const aviso = gate1Notify.buildGate1Notice({
        issue: 6192, titulo: TITULO, caso: 'block',
        reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
        firmantesAutorizados: 1,
        capacidadFirma: false,
    }, NOW);

    assert.match(aviso.texto, /no está disponible|no puede emitir/i, 'el operador se entera de que no puede firmar');
    for (const jerga of [/vault/i, /HMAC/i, /token/i, /callback_data/i]) {
        assert.ok(!jerga.test(aviso.texto), `el aviso no filtra jerga interna (${jerga})`);
    }
});

test('el tipo de la ficha cambia con la capability: el dedupe vuelve a avisar cuando la firma se recupera', () => {
    const base = {
        issue: 6192, titulo: TITULO, caso: 'block',
        reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
        firmantesAutorizados: 1,
    };
    // La clave del dedupe que arma `pulpo.js` incluye `aviso.tipo`. Que el tipo
    // difiera es lo que hace que el operador reciba el aviso CON botones apenas
    // la firma vuelve a estar disponible, en vez de quedar sellado en el estado
    // degradado del primer barrido.
    const sinCap = gate1Notify.buildGate1Notice({ ...base, capacidadFirma: false }, NOW);
    const conCap = gate1Notify.buildGate1Notice({ ...base, capacidadFirma: true }, NOW);
    assert.notStrictEqual(sinCap.tipo, conCap.tipo);
});

test('sin firmante autorizado la falta nombrada es la del firmante, no la de la capability', () => {
    // Las dos causas pueden darse juntas. Se nombra la que el operador puede
    // resolver por su cuenta.
    const aviso = gate1Notify.buildGate1Notice({
        issue: 6192, titulo: TITULO, caso: 'block',
        reason: 'GATE 1 retuvo admision a desarrollo: falta la firma de definicion',
        firmantesAutorizados: 0,
        capacidadFirma: false,
    }, NOW);
    assert.strictEqual(aviso.tipo, 'indeterminado');
    assert.strictEqual(aviso.ofreceBotones, false);
    assert.match(aviso.texto, /firmante autorizado/i);
});
