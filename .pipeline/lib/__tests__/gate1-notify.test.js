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

const FECHA_CORTA = '6 de septiembre, 09:00';
// Tres días antes de `NOW`: separa la FECHA CONCRETA de la edad relativa, que
// son dos hechos distintos y los dos tienen que sobrevivir la reclasificación.
const BLOCKED_AT = '2026-09-06T12:00:00Z';

/**
 * `capacidadFirma` es OBLIGATORIO en los helpers de esta suite (#6192, precisión
 * de CA-1 del `po`).
 *
 * Omitirlo lo dejaba `undefined`, que el módulo interpreta como "no se
 * preguntó" y clasifica como `firma`. Con `vault.enabled: false` —la config
 * productiva— el camino que corre en producción es el OTRO: `capacidadFirma:
 * false` → `indeterminado`. Una suite entera en verde sobre el camino `firma`
 * dejó pasar dos veces el mismo defecto, así que acá el helper NO tiene default:
 * cada test declara qué camino ejercita, o revienta.
 */
function exigirCapability(extra, quien) {
    if (!Object.prototype.hasOwnProperty.call(extra, 'capacidadFirma')) {
        throw new Error(
            `${quien}: falta 'capacidadFirma'. Sin él el test corre el camino 'firma', `
            + 'que hoy NO se ejecuta en producción. Declaralo explícito o usá porCapability().',
        );
    }
}

function avisoDeBloqueo(extra = {}, deps = undefined) {
    exigirCapability(extra, 'avisoDeBloqueo');
    return gate1Notify.buildGate1Notice({
        issue: 6192,
        titulo: TITULO,
        reason: 'sin firma del operador para la definición',
        caso: 'block',
        firmantesAutorizados: 1,
        blockedAt: BLOCKED_AT,
        fechaCorta: FECHA_CORTA,
        ...extra,
    }, NOW, deps);
}

/** La ficha que alimenta al aviso, para inspeccionar sus campos estructurados. */
function fichaDeBloqueo(extra = {}) {
    exigirCapability(extra, 'fichaDeBloqueo');
    const base = {
        issue: 6192,
        titulo: TITULO,
        reason: 'sin firma del operador para la definición',
        firmantesAutorizados: 1,
        blockedAt: BLOCKED_AT,
        fechaCorta: FECHA_CORTA,
        ...extra,
    };
    const raw = gate1Notify.rawDeAviso(
        extra.caso || 'block',
        gate1Notify.tipoDeFicha(extra.caso || 'block', base),
        base,
    );
    return decisionCard.buildDecisionCard(raw, NOW);
}

/**
 * Corre el mismo cuerpo con la capability disponible y sin ella. Los CA que no
 * dependen de los botones tienen que valer en LOS DOS caminos: el que corre hoy
 * y el que va a correr cuando la firma esté operativa.
 */
function porCapability(cuerpo) {
    for (const capacidadFirma of [true, false]) cuerpo(capacidadFirma);
}

// --- El aviso dice qué issue es, qué se firma y desde cuándo -----------------

// CA-1 (reformulado por el `po` el 09/09): vale para TODOS los tipos de ficha,
// no sólo para `firma`. La reclasificación por falta de capability cambia las
// OPCIONES ofrecidas, no los HECHOS informados.
test('el aviso dice qué issue es, qué se pide firmar y desde cuándo — con y sin capability', () => {
    porCapability((capacidadFirma) => {
        const aviso = avisoDeBloqueo({ capacidadFirma });
        const ctx = `capacidadFirma=${capacidadFirma}`;

        assert.strictEqual(aviso.tipo, capacidadFirma ? 'firma' : 'indeterminado', ctx);
        assert.strictEqual(aviso.degradado, false, `${ctx}: reclasificar no es degradar`);
        assert.ok(aviso.texto.includes('#6192'), `${ctx}: tiene que decir de qué issue habla`);
        assert.ok(aviso.texto.includes(TITULO), `${ctx}: tiene que citar el título del issue`);
        assert.ok(/aprob/i.test(aviso.texto), `${ctx}: tiene que decir que lo que se pide es aprobar el alcance`);
        // CA-1.a — la fecha CONCRETA, no sólo la edad relativa.
        assert.ok(aviso.texto.includes(FECHA_CORTA), `${ctx}: tiene que decir desde cuándo (fecha concreta)`);
        assert.match(aviso.texto, /hace 3 d/, `${ctx}: y también la antigüedad relativa`);
    });
});

// --- CA-1.a..e con el camino que corre HOY en producción ---------------------
//
// Con `vault.enabled: false` el sondeo devuelve `ok:false` en TODOS los
// barridos, así que `capacidadFirma:false` no es un borde: es el único camino
// que el operador ve. Estos asserts son sobre ESE camino.

test('CA-1.a — sin capability el aviso conserva la fecha concreta que le pasa el call-site', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: false });
    assert.strictEqual(aviso.tipo, 'indeterminado');
    assert.ok(aviso.texto.includes(FECHA_CORTA),
        'la reclasificación saca las opciones, no los hechos: la fecha viaja en el input y tiene que salir');
});

test('CA-1.b — sin capability el aviso sigue nombrando que lo que falta es la firma de la definición', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: false });
    assert.match(aviso.texto, /¿Aprobás el alcance de #6192/,
        'tiene que decir qué se pide firmar, no sólo que algo está frenado');
    assert.match(aviso.texto, /visto bueno/i, 'y por qué está retenido');
    assert.match(aviso.texto, /firma por botón no está disponible/i, 'y qué es lo que no se puede hacer');
});

test('CA-1.c — sin capability el aviso no afirma desconocimiento: la causa se conoce y se imprime', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: false });
    assert.ok(!/no supe clasificar/i.test(aviso.texto),
        'el aviso no puede decir que no sabe por qué, dos líneas arriba de decir por qué');
    assert.ok(!/no las puedo justificar/i.test(aviso.texto),
        'la justificación está impresa en «Qué me falta»: negarla es contradecirse');
    assert.ok(!/No tengo el dato/i.test(aviso.texto), 'el dato lo tiene: es el que acaba de imprimir');
});

test('CA-1.d — sin capability el pie conserva la acción conocida, no degrada al molde libre', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: false });
    assert.ok(aviso.texto.includes('/unblock 6192 aprobar'),
        'la acción se conoce: el comando tiene que poder pegarse tal cual');
    assert.ok(!aviso.texto.includes('seguido de qué querés que se haga'),
        'el molde libre es para cuando NO se sabe qué hay que hacer');
});

test('CA-1.e — sin capability el aviso no filtra infraestructura al canal', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: false });
    for (const jerga of [/vault/i, /\bSSM\b/, /\btoken\b/i, /secreto/i, /HMAC/i]) {
        assert.ok(!jerga.test(aviso.texto), `el aviso no puede nombrar ${jerga}`);
    }
});

test('cuando el motivo llegó ilegible el aviso SÍ dice que no sabe: no inventa la firma como causa', () => {
    // La contracara de CA-1.c. El copy honesto de `indeterminado` no se elimina:
    // se reserva para cuando el desconocimiento es real.
    const aviso = avisoDeBloqueo({
        caso: 'gate-error',
        capacidadFirma: false,
        reason: 'no pude leer el issue en GitHub: gh exit 1',
    });
    assert.strictEqual(aviso.tipo, 'indeterminado');
    assert.match(aviso.texto, /no supe clasificar/i);
    assert.match(aviso.texto, /ilegible|no entra en un aviso/i,
        'lo que falta es el motivo, no la firma: no se puede afirmar que falte firmar');
    assert.ok(!/firma por botón/i.test(aviso.texto),
        'con el motivo ilegible, nombrar la firma sería inventar la causa');
});

test('el aviso ofrece las tres opciones de firma', () => {
    const ficha = fichaDeBloqueo({ capacidadFirma: true });
    assert.strictEqual(ficha.opciones.length, 3);
    const etiquetas = ficha.opciones.map((o) => o.etiqueta.toLowerCase()).join(' | ');
    assert.match(etiquetas, /aprobar/);
    assert.match(etiquetas, /rechazar/);
    assert.match(etiquetas, /ajustar/);
});

// --- El tipo `firma` NUNCA lleva opción recomendada --------------------------

test('la ficha de firma no tiene NINGUNA opción recomendada y declara por qué', () => {
    const ficha = fichaDeBloqueo({ capacidadFirma: true });

    const recomendadas = ficha.opciones.filter((o) => o.es_recomendada === true);
    assert.strictEqual(recomendadas.length, 0, 'un gate que sugiere cómo firmar deja de ser gate');
    assert.ok(ficha.sin_recomendacion_porque, 'el silencio no vale: la ficha dice por qué no hay recomendada');
    assert.match(ficha.sin_recomendacion_porque, /no hay recomendaci[oó]n/i);
    assert.match(ficha.sin_recomendacion_porque, /decisi[oó]n es tuya/i);

    const aviso = avisoDeBloqueo({ capacidadFirma: true });
    assert.ok(!aviso.texto.includes('← recomendada'), 'el texto emitido tampoco marca una recomendada');
    assert.ok(aviso.texto.includes(ficha.sin_recomendacion_porque));
});

// --- "Sin firmante autorizado" NO es una ficha de firma ----------------------

test('sin firmante autorizado configurado la ficha es indeterminada, sin opciones y con falta poblada', () => {
    const ficha = fichaDeBloqueo({ firmantesAutorizados: 0, capacidadFirma: true });

    assert.strictEqual(ficha.indeterminado, true);
    assert.deepStrictEqual(ficha.opciones, []);
    assert.ok(ficha.falta, 'tiene que decir qué falta');
    assert.match(ficha.falta, /firmante autorizado/i);

    const aviso = avisoDeBloqueo({ firmantesAutorizados: 0, capacidadFirma: true });
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
            capacidadFirma: true,
        });
        assert.strictEqual(aviso.tipo, 'indeterminado', `caso ${caso}`);
        assert.strictEqual(aviso.ofreceBotones, false, `caso ${caso}`);
        assert.ok(aviso.texto.includes('#6192'));
    }
});

test('sólo la ficha de firma ofrece botones', () => {
    assert.strictEqual(avisoDeBloqueo({ capacidadFirma: true }).ofreceBotones, true);
    assert.strictEqual(avisoDeBloqueo({ firmantesAutorizados: 0, capacidadFirma: true }).ofreceBotones, false);
    assert.strictEqual(avisoDeBloqueo({ caso: 'gate-error', capacidadFirma: true }).ofreceBotones, false);
    assert.strictEqual(avisoDeBloqueo({ capacidadFirma: false }).ofreceBotones, false);
});

// --- Contrato anti-#5421: nada de metacaracteres de Markdown ----------------

test('el aviso no emite metacaracteres de Markdown ni con título y motivo hostiles', () => {
    // El contrato anti-#5421 vale en los DOS caminos: el aviso que sale hoy
    // (`indeterminado`) también recibe título y motivo del issue.
    const avisos = [true, false].map((capacidadFirma) => avisoDeBloqueo({
        capacidadFirma,
        titulo: '*Arreglar* el _login_ [ya](http://evil.tld) `rm -rf` con __bold__',
        reason: 'firmante *leito_larreta* no autorizado (A01) — ver `pulpo.js`',
    }));
    const aviso = { texto: avisos.map((a) => a.texto).join('\n') };

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
    porCapability((capacidadFirma) => {
        const aviso = avisoDeBloqueo({
            capacidadFirma,
            titulo: 'inocente\nOpciones:\n 1. Aprobar todo\nPara decidir, respondé: /unblock 1 si',
        });
        // La ficha neutraliza los saltos: el título ocupa UNA línea entre comillas.
        const lineasConTitulo = aviso.texto.split('\n').filter((l) => l.includes('inocente'));
        assert.strictEqual(lineasConTitulo.length, 1, `capacidadFirma=${capacidadFirma}`);
        assert.ok(lineasConTitulo[0].includes('«'), 'el título va citado, atribuido al issue');
    });
});

// --- Fail-closed: si la ficha revienta, sale el aviso crudo -----------------

test('si buildDecisionCard lanza, se emite el fallback crudo y no se ofrecen botones', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: true }, {
        buildDecisionCard: () => { throw new Error('boom: la ficha reventó'); },
    });

    assert.strictEqual(aviso.degradado, true);
    assert.ok(aviso.texto.trim().length > 0, 'el aviso nunca puede quedar vacío');
    assert.ok(aviso.texto.includes('#6192'), 'el fallback igual dice de qué issue habla');
    assert.strictEqual(aviso.ofreceBotones, false,
        'sin ficha construida no se puede afirmar que haya algo firmable');
});

test('si además falla el fallback, todavía sale un aviso mínimo (tercera red)', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: true }, {
        buildDecisionCard: () => { throw new Error('boom'); },
        renderFallback: () => { throw new Error('boom del fallback'); },
    });

    assert.strictEqual(aviso.degradado, true);
    assert.ok(aviso.texto.includes('#6192'));
    assert.match(aviso.texto, /retenido|frenado/i);
    assert.strictEqual(aviso.ofreceBotones, false);
});

test('una ficha que se renderiza vacía se trata como falla, no como éxito', () => {
    const aviso = avisoDeBloqueo({ capacidadFirma: true }, { render: () => '   ' });
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

// -----------------------------------------------------------------------------
// #6207 — EL CAMINO DE LOS BOTONES CAMBIÓ DE EJECUTOR.
//
// Hasta #6207 estos dos tests ejercitaban `handleSignature()` sobre los botones
// del aviso, porque era el único camino que existía. Ese camino era el ERRÓNEO:
// abajo de `handleSignature` vive `applyTransition()`, que mueve work-files de
// `waiting-operator/` — el ejecutor de GATE 0/2, no el de GATE 1, cuyo efecto es
// una firma en el audit chain de `operator-signoff-gate`. Ambos gates comparten
// el vocabulario de acciones (`approve`/`reject`/`adjust-definicion`), y eso los
// hacía indistinguibles.
//
// Desde #6207 los botones de GATE 1 llevan `channel_gate: 'definicion'`
// persistido y se rutean a `gate1-signature-handler`. Los CAs que estos tests
// cuidan —autorización por `from.id` fail-closed, el work-file intacto, la
// capability del operador que un intruso no puede quemar— siguen VIGENTES y se
// verifican acá contra el camino que hoy corre de verdad. El test se muda con el
// código; el criterio no se relaja.
// -----------------------------------------------------------------------------

const canalDeAprobacion = require('../approval-channel');
const depositoGate1 = require('../gate1-signature-deposit');
const { createGate1SignatureHandler } = require('../gate1-signature-handler');
const auditLogGate1 = require('../audit-log');

const BODY_GATE1 = '## Criterios\n\n- [ ] CA-1 el operador firma desde Telegram\n';

/**
 * Gate + canal + handler herméticos, compartiendo raíz. Devuelve además el
 * episodio ya armado (pedido depositado + los tres botones emitidos), que es el
 * estado en el que el operador recibe el aviso.
 */
function makeEpisodioGate1(overrides = {}) {
    const { gate, dirs } = makeGate(overrides);
    const root = path.dirname(dirs.storeDir);
    const allow = overrides.operatorAllowlist || [OPERADOR];

    const channelDeps = {
        depositDir: path.join(root, 'canal', 'pendiente'),
        auditFile: path.join(root, 'audit', 'approval-channel.jsonl'),
        rejectFile: path.join(root, 'audit', 'approval-channel-rejects.jsonl'),
        rateFile: path.join(root, 'canal', '.reject-rate.json'),
        signer: createTokenSigner({
            secret: CLAVE_DE_PRUEBA,
            nonceFile: path.join(root, 'audit', 'canal-tokens.jsonl'),
        }),
        auditCompanion: (record) => auditLogGate1.appendChained({
            file: dirs.auditFile,
            entry: { ...record, ts: new Date().toISOString() },
        }),
        env: allow.length > 0 ? { TELEGRAM_LEO_OPERATOR_CHAT_ID: String(allow[0]) } : {},
        config: {
            operator_signoff: { enabled: true, gate_mode: 'enforce' },
            operator_signature: { enabled: true, gate_mode: 'enforce' },
            cua: { operator_chat_ids: [] },
        },
        writerPipelineDir: root,
    };

    const dep = depositoGate1.depositGate1Request(
        { issue: 6192, body: BODY_GATE1, title: TITULO },
        { approvalImpl: canalDeAprobacion, channelDeps },
    );
    assert.strictEqual(dep.ok, true, `el pedido tenía que depositarse: ${dep.reason}`);

    const handler = createGate1SignatureHandler({
        gateFactory: () => gate,
        approvalImpl: canalDeAprobacion,
        depositImpl: depositoGate1,
        channelDeps,
        readIssueBody: () => BODY_GATE1,
        enqueueGithub: () => { },
    });

    return {
        gate, dirs, handler, root,
        ids: teclado(gate, 6192).ids,
        firmaDelGate: () => {
            const f = path.join(root, 'audit', 'operator-signoff.jsonl');
            return fs.existsSync(f) ? auditLogGate1.readAll(f) : [];
        },
    };
}

test('un from.id fuera del allowlist recibe rechazo y NO ejecuta la firma', () => {
    const env = makeEpisodioGate1();
    fs.mkdirSync(env.dirs.waitingDir, { recursive: true });
    const workfile = path.join(env.dirs.waitingDir, '6192.json');
    fs.writeFileSync(workfile, JSON.stringify({ issue: 6192 }));

    const res = env.handler.handleGate1Signature({
        operatorId: INTRUSO, callbackData: env.ids.approve,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unauthorized');
    assert.match(res.toast, /No autorizado/i);
    assert.ok(fs.existsSync(workfile), 'el ítem no se movió: la firma no se ejecutó');
    assert.deepStrictEqual(env.firmaDelGate(), [], 'no queda ninguna firma del intruso');

    // Y la capability del operador legítimo sigue viva: un intruso no puede
    // invalidarla tocando el botón.
    const legitimo = env.handler.handleGate1Signature({
        operatorId: OPERADOR, callbackData: env.ids.approve,
    });
    assert.strictEqual(legitimo.ok, true, `el operador debía poder firmar: ${legitimo.reason}`);
    assert.strictEqual(env.firmaDelGate().length, 1);
    // Y el work-file SIGUE intacto: firmar GATE 1 no mueve nada de lifecycle.
    assert.ok(fs.existsSync(workfile), 'firmar GATE 1 no toca work-files');
});

test('allowlist vacío = fail-closed: ni el operador puede firmar', () => {
    const env = makeEpisodioGate1({ operatorAllowlist: [] });
    fs.mkdirSync(env.dirs.waitingDir, { recursive: true });
    const workfile = path.join(env.dirs.waitingDir, '6192.json');
    fs.writeFileSync(workfile, JSON.stringify({ issue: 6192 }));

    const res = env.handler.handleGate1Signature({
        operatorId: OPERADOR, callbackData: env.ids.approve,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unauthorized');
    assert.ok(fs.existsSync(workfile), 'nada se movió');
    assert.deepStrictEqual(env.firmaDelGate(), []);
});

test('#6207: un botón de GATE 1 NO puede atravesar handleSignature (confused deputy)', () => {
    const env = makeEpisodioGate1();
    fs.mkdirSync(env.dirs.waitingDir, { recursive: true });
    const workfile = path.join(env.dirs.waitingDir, '6192.json');
    fs.writeFileSync(workfile, JSON.stringify({ issue: 6192 }));

    // Defensa en profundidad: aunque el ruteo del listener fallara y el binding
    // llegara al camino de lifecycle, ahí se rechaza SIN consumir y sin mover
    // nada. Esto es lo que impide que ✅ Aprobar de GATE 1 promueva un ítem de
    // otro gate por compartir el nombre de la acción.
    const res = env.gate.handleSignature({ operatorId: OPERADOR, callbackData: env.ids.approve });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'not-a-lifecycle-binding');
    assert.ok(fs.existsSync(workfile), 'el work-file de otro gate queda donde estaba');
    assert.ok(env.gate.resolve(env.ids.approve), 'y la capability sigue viva para su handler');
});

test('#6207: los botones del aviso clasifican como `gate-signature`, no como `gate`', () => {
    const env = makeEpisodioGate1();
    for (const id of Object.values(env.ids)) {
        assert.strictEqual(env.gate.classifyCallback(id), 'gate-signature');
    }
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
