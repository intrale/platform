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

/** Arma el teclado igual que `pulpo.js::buildGate1SignatureKeyboard`. */
function teclado(gate, issue) {
    const approve = gate.register({ issue, action: 'approve' });
    const reject = gate.register({ issue, action: 'reject' });
    const adjust = gate.register({ issue, action: 'adjust-definicion' });
    return {
        markup: gate.buildInlineKeyboard({
            approveId: approve.callbackData,
            rejectId: reject.callbackData,
            adjustId: adjust.callbackData,
        }),
        ids: { approve: approve.callbackData, reject: reject.callbackData, adjust: adjust.callbackData },
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
