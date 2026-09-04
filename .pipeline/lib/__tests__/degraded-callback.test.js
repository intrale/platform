// =============================================================================
// degraded-callback.test.js — Ruteo de los botones degradados (issue #5923)
//
// Cuando el dashboard no es público, los botones de acción se emiten como
// `callback_data` en vez de `url`. Sin este ruteo la degradación entregaría
// BOTONES MUERTOS, que es peor que el estado actual. Acá se verifica el otro
// extremo del cable: `.claude/hooks/commander/callback-handler.js`.
//
// Aislamiento: `CLAUDE_PROJECT_DIR` apunta a un tmp ANTES de que se cargue
// `human-block` (resuelve su PIPELINE_DIR desde ese env en require-time), y
// `fetch` se stubea, así que ningún test toca el pipeline real ni la red.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-degraded-cb-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

// Raíz REAL del repo: es de donde sale el código de los módulos de `.pipeline/`.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const handler = require(path.join(REPO_ROOT, '.claude', 'hooks', 'commander', 'callback-handler.js'));

const CHAT_ID = 111222333;
const MESSAGE = { message_id: 42, chat: { id: CHAT_ID }, text: '⚠️ Pausa parcial trabada\n\nEl issue #5923 ...' };
const OPERADOR = 111222333;

/** Instala un tgApi fake que captura cada llamada a la Bot API. */
function installFakeTgApi(repoRoot = REPO_ROOT) {
    const calls = [];
    handler.init({
        tgApi: {
            getChatId: () => CHAT_ID,
            telegramPost: async (method, params) => { calls.push({ method, params }); return { ok: true }; },
            escHtml: (s) => String(s),
            sendMessage: async () => ({ ok: true }),
        },
        log: () => {},
        repoRoot,
        hooksDir: path.join(REPO_ROOT, '.claude', 'hooks'),
    });
    return calls;
}

/** Stubea `fetch` global. Devuelve la lista de requests salientes. */
function installFakeFetch(responder) {
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        requests.push({ url: String(url), opts });
        const r = responder ? responder(String(url), opts) : { status: 200, body: { ok: true, msg: 'Listo.' } };
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => r.body,
        };
    };
    requests.restore = () => { globalThis.fetch = original; };
    return requests;
}

const toastOf = (calls) => calls.find(c => c.method === 'answerCallbackQuery');
const editOf = (calls) => calls.find(c => c.method === 'editMessageText');

// ─── Audit real de `human-block` (R-SEC-9) ───────────────────────────────────
// `human-block.js` resuelve su PIPELINE_DIR desde `CLAUDE_PROJECT_DIR` en
// require-time, así que las entries caen en el tmp. Se leen del DISCO —no de un
// fake que devuelva el eco de su input— para que el test falle si mañana el
// audit deja de escribirse de verdad.
const AUDIT_DIR = path.join(TMP_DIR, '.pipeline', 'audit');

function auditEntries() {
    if (!fs.existsSync(AUDIT_DIR)) return [];
    return fs.readdirSync(AUDIT_DIR)
        .filter(f => f.startsWith('human-block-actions-') && f.endsWith('.jsonl'))
        .flatMap(f => fs.readFileSync(path.join(AUDIT_DIR, f), 'utf8')
            .split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

function clearAudit() {
    fs.rmSync(AUDIT_DIR, { recursive: true, force: true });
}

// ─── Fail-closed ─────────────────────────────────────────────────────────────

test('#5923 pp:../kill-agent:1 muere en el lookup del mapa congelado, sin request saliente', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        const handled = await handler.handleDegradedActionCallback('pp:../kill-agent:1', 'cbq-1', MESSAGE, OPERADOR);
        assert.equal(handled, true, 'el namespace es nuestro: no cae al fail-safe del listener');
        assert.equal(requests.length, 0, 'path traversal no puede generar ningún request');
        assert.match(toastOf(calls).params.text, /no reconocida/i);
        assert.equal(editOf(calls), undefined, 'no se toca el mensaje');
    } finally { requests.restore(); }
});

test('#5923 hb:accion-inexistente:1 es fail-closed con toast, sin ejecutar nada', async () => {
    const calls = installFakeTgApi();
    const handled = await handler.handleDegradedActionCallback('hb:accion-inexistente:1', 'cbq-2', MESSAGE, OPERADOR);
    assert.equal(handled, true);
    assert.match(toastOf(calls).params.text, /no reconocida/i);
});

test('#5923 un issue que no es entero pelado se rechaza antes de tocar nada', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        for (const data of ['hb:unblock:../../etc', 'hb:unblock:1e3', 'hb:unblock:9999999', 'pp:include-deps:%2e%2e']) {
            calls.length = 0;
            await handler.handleDegradedActionCallback(data, 'cbq-x', MESSAGE, OPERADOR);
            assert.match(toastOf(calls).params.text, /inválid/i, `${data} debe rechazarse`);
        }
        assert.equal(requests.length, 0);
    } finally { requests.restore(); }
});

test('#5923 sin _repoRoot el handler es fail-closed con toast, nunca throw', async () => {
    const calls = installFakeTgApi(null);
    const handled = await handler.handleDegradedActionCallback('pp:include-deps:5923', 'cbq-3', MESSAGE, OPERADOR);
    assert.equal(handled, true);
    assert.ok(toastOf(calls), 'el spinner se corta igual');
    assert.ok(toastOf(calls).params.text.length > 0);
});

// ─── Ejecución + feedback concreto (D5 / CA-15) ──────────────────────────────

test('#5923 pp: no destructivo ejecuta, avisa el resultado concreto y retira el teclado', async () => {
    const calls = installFakeTgApi();
    // #6118 — El endpoint responde AMBOS textos: `msg` para el dashboard y
    // `operatorMsg` para Telegram. El handler tiene que elegir el segundo.
    const requests = installFakeFetch(() => ({
        status: 200,
        body: {
            ok: true,
            msg: 'Allowlist actualizado: 5923, 5924.',
            operatorMsg: 'Listo: #5924 quedó habilitado en esta ola. #5923 ya puede avanzar.',
        },
    }));
    try {
        // Acción histórica: los mensajes anteriores a #6118 siguen en el chat con
        // `pp:include-deps`. El alias la normaliza y la manda al endpoint acotado
        // en vez de dejar el botón muerto.
        await handler.handleDegradedActionCallback('pp:include-deps:5923', 'cbq-4', MESSAGE, OPERADOR);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'http://127.0.0.1:3200/api/partial-pause/include-deps-for-issue',
            'el destino sale del mapa congelado, nunca de interpolar el action');
        assert.equal(requests[0].opts.method, 'POST');
        assert.equal(requests[0].opts.headers['Content-Type'], 'application/json');
        // `authorizedBy` es la CLASE de origen del enum cerrado de #3625; la
        // identidad fina del operador viaja aparte. Mandar `telegram:<from.id>`
        // dejaba el valor fuera del enum: pasaba sólo por el grace period y con
        // `PARTIAL_PAUSE_STRICT_AUTH=1` el botón daba 403 para siempre.
        const sent = JSON.parse(requests[0].opts.body);
        assert.equal(sent.authorizedBy, 'telegram:operator', 'origen registrado en el enum, no un valor inventado');
        assert.equal(sent.operatorRef, '111222333', 'el operador real viaja para la trazabilidad fina');
        // #6118 — El issue viaja en el body. Antes se parseaba y se descartaba,
        // así que el servidor no podía saber sobre cuál de los issues alertados
        // se apretó el botón y toda acción terminaba siendo de alcance global.
        assert.equal(sent.issue, '5923', 'el issue de la alerta llega al servidor');
        const audit = require('../partial-pause-audit');
        assert.equal(audit.validateAuthorizedBy(sent.authorizedBy).valid, true,
            'lo que se manda tiene que pasar el validador REAL, no sólo un fake');

        const toast = toastOf(calls);
        assert.ok(toast.params.text.length > 0, 'nunca un ack vacío');
        // #6118 CA-7 — el toast usa `operatorMsg`, no el `msg` interno: el
        // operador de Telegram lee sobre el issue y su dependencia, no sobre el
        // vocabulario del dashboard.
        assert.match(toast.params.text, /#5923 ya puede avanzar/, 'feedback CONCRETO del resultado');
        assert.doesNotMatch(toast.params.text, /allowlist/i,
            'la jerga interna del dashboard no puede filtrarse a Telegram');

        const edit = editOf(calls);
        assert.ok(edit, 'deja constancia en el mensaje');
        assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] }, 'retira el teclado');
        assert.match(edit.params.text, /operador 111222333/, 'constancia con el operador');
        assert.ok(edit.params.text.startsWith('⚠️ Pausa parcial trabada'), 'preserva el texto original');
        assert.equal(edit.params.parse_mode, undefined, 'sin parse_mode: el edit no puede fallar por markdown roto');
    } finally { requests.restore(); }
});

test('#5923 un 409 del dashboard (anti-replay) informa y NO retira el teclado', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch(() => ({ status: 409, body: { ok: false, msg: 'Pipeline está en modo "running", no en partial_pause' } }));
    try {
        await handler.handleDegradedActionCallback('pp:keep-original:5923', 'cbq-5', MESSAGE, OPERADOR);
        const toast = toastOf(calls);
        assert.match(toast.params.text, /partial_pause|ya no aplica/i);
        const edit = editOf(calls);
        assert.ok(edit.params.reply_markup.inline_keyboard.length > 0, 'se puede reintentar');
    } finally { requests.restore(); }
});

test('#5923 si el dashboard no responde, el operador se entera (no queda el spinner)', async () => {
    const calls = installFakeTgApi();
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
        const handled = await handler.handleDegradedActionCallback('pp:include-deps:5923', 'cbq-6', MESSAGE, OPERADOR);
        assert.equal(handled, true);
        assert.match(toastOf(calls).params.text, /no se pudo contactar al dashboard/i);
    } finally { globalThis.fetch = original; }
});

test('#5923 hb: no destructivo ejecuta contra human-block y devuelve su msg', async () => {
    const calls = installFakeTgApi();
    // Sin markers en el tmp: `unblock` es no-op idempotente pero ok:true.
    await handler.handleDegradedActionCallback('hb:unblock:5923', 'cbq-7', MESSAGE, OPERADOR);
    const toast = toastOf(calls);
    assert.ok(toast.params.text.length > 0);
    assert.match(toast.params.text, /5923/, 'el toast nombra el issue afectado');
    assert.deepEqual(editOf(calls).params.reply_markup, { inline_keyboard: [] });
});

// ─── Trazabilidad del operador (R-SEC-9) ─────────────────────────────────────

test('#5923 R-SEC-9.a sin from.id es fail-closed: cero requests, cero audit, toast uniforme', async () => {
    // Cada acción privilegiada del canal, con cada forma de "no hay identidad".
    // El `0` entra a propósito: no hay usuario de Telegram con id 0, así que
    // tratarlo como identidad válida sería aceptar un valor centinela.
    // #6118 — la lista sigue a los botones vigentes: silenciar también es
    // privilegiado (deja de avisar sobre un issue trabado), así que sin
    // identidad tampoco puede correr.
    for (const cbData of ['pp:include-deps-for-issue:5923', 'pp:mute-alert:5923', 'pp:keep-original:5923',
                          'hb:unblock:5923', 'hb:c:devolver-definicion:5923']) {
        for (const sinId of [undefined, null, '', 0, '   ', 'undefined']) {
            clearAudit();
            const calls = installFakeTgApi();
            const requests = installFakeFetch();
            try {
                const handled = await handler.handleDegradedActionCallback(cbData, 'cbq-noid', MESSAGE, sinId);

                assert.equal(handled, true, 'el namespace sigue siendo nuestro: no cae al fail-safe del listener');
                assert.equal(requests.length, 0, `${cbData} con from.id=${JSON.stringify(sinId)} no puede generar request`);
                assert.deepEqual(auditEntries(), [], 'sin identidad no se asienta NADA: un audit sin autor real es peor que ninguno');
                assert.equal(editOf(calls), undefined, 'no se toca el mensaje');

                const toast = toastOf(calls);
                // Mismo texto que el fail-safe del listener: no le confirma al
                // que aprieta si el callback existía o no.
                assert.equal(toast.params.text, 'Acción inválida o expirada',
                    'toast uniforme, sin filtrar si la acción existía');
            } finally { requests.restore(); }
        }
    }
});

test('#5923 R-SEC-9.b hb: con from.id válido asienta una entry con el operador REAL', async () => {
    clearAudit();
    const calls = installFakeTgApi();
    await handler.handleDegradedActionCallback('hb:unblock:5923', 'cbq-audit-1', MESSAGE, OPERADOR);

    const entries = auditEntries();
    assert.equal(entries.length, 1, 'el 3er canal a executeQuickAction deja huella, igual que los otros dos');
    const e = entries[0];
    assert.equal(e.from, String(OPERADOR), 'el from.id REAL, no un literal ni el bot');
    assert.equal(e.action, 'unblock');
    assert.equal(e.issue, 5923);
    assert.equal(e.intent_class, 'human-block-action');
    assert.equal(String(e.chat_id), String(CHAT_ID), 'el chat desde donde se apretó');
    assert.equal(e.message_id, 42, 'el mensaje concreto, para reconstruir qué botón era');
    assert.equal(e.result_status, 'authorized');
    assert.ok(toastOf(calls), 'la acción se ejecutó igual: el audit no la bloquea');
});

test('#5923 R-SEC-9.b devolver-definicion (descarta trabajo) también queda asentado al confirmar', async () => {
    clearAudit();
    // 1er tap: sólo pide confirmación ⇒ no ejecuta ⇒ no audita.
    await handler.handleDegradedActionCallback('hb:devolver-definicion:5923', 'cbq-audit-2', MESSAGE, OPERADOR);
    assert.deepEqual(auditEntries(), [], 'pedir confirmación no es ejecutar');

    // 2do tap: ejecuta ⇒ tiene que quedar registrado quién descartó el trabajo.
    await handler.handleDegradedActionCallback('hb:c:devolver-definicion:5923', 'cbq-audit-3', MESSAGE, OPERADOR);
    const entries = auditEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].from, String(OPERADOR));
    assert.equal(entries[0].action, 'devolver-definicion');
    assert.equal(entries[0].issue, 5923);
});

// ─── Doble tap de las acciones destructivas (CA-17 / CA-UX-1..3) ─────────────

// #6118 CA-6 — El botón de alcance global se retiró. No alcanzaba con sacarlo
// del teclado que emite el Pulpo: el `callback_data` no tiene nonce ni TTL y los
// mensajes viven para siempre en el chat. Este test cubre el escenario Gherkin
// "un tap sobre un mensaje viejo no cambia el alcance global".
test('#6118 CA-6 pp:cancel-partial-pause de un mensaje histórico ya NO resuelve', async () => {
    const requests = installFakeFetch();
    try {
        for (const cbData of ['pp:cancel-partial-pause', 'pp:c:cancel-partial-pause', 'pp:cancel-partial-pause:5923']) {
            const calls = installFakeTgApi();
            const handled = await handler.handleDegradedActionCallback(cbData, 'cbq-8', MESSAGE, OPERADOR);

            assert.equal(handled, true, 'el namespace sigue siendo nuestro: no cae al fail-safe del listener');
            assert.equal(requests.length, 0, `${cbData} no puede generar ningún request saliente`);
            assert.match(toastOf(calls).params.text, /no reconocida|ya no disponible/i,
                'el operador se entera de que ese botón ya no existe');
            assert.equal(editOf(calls), undefined, 'no se toca el mensaje');
        }
    } finally { requests.restore(); }
});

// El doble tap sigue existiendo como mecanismo; lo que ya no hay es una acción
// `pp:` de alto impacto que lo dispare (silenciar y habilitar deps no son
// destructivos). La cobertura del mecanismo vive en el test de
// `hb:devolver-definicion`, que sí descarta trabajo.
test('#6118 ninguna acción de la alerta de dependencias exige doble tap', () => {
    for (const [action, meta] of Object.entries(handler.PP_META)) {
        assert.equal(meta.highImpact, false,
            `${action} no muta el alcance global: pedir confirmación sería fricción sin motivo`);
    }
});

test('#5923 el 2do tap (pp:c:) sí ejecuta', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch(() => ({
        status: 200,
        body: { ok: true, msg: 'Se mantiene el allowlist actual (2 issues).',
                operatorMsg: '#5923 va a seguir avanzando sin esperar a #6032. El riesgo queda asumido.' },
    }));
    try {
        await handler.handleDegradedActionCallback('pp:c:keep-original:5923', 'cbq-9', MESSAGE, OPERADOR);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'http://127.0.0.1:3200/api/partial-pause/keep-original');
        assert.match(toastOf(calls).params.text, /sin esperar a #6032/);
        assert.deepEqual(editOf(calls).params.reply_markup, { inline_keyboard: [] });
    } finally { requests.restore(); }
});

test('#5923 cancelar la confirmación (pp:x:) restaura el teclado original y no ejecuta', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        const confirmado = {
            ...MESSAGE,
            text: MESSAGE.text + '\n\n⚠️ Vas a dejar que el issue avance sin esperar a sus dependencias, asumiendo el riesgo.',
        };
        await handler.handleDegradedActionCallback('pp:x:keep-original:5923', 'cbq-10', confirmado, OPERADOR);

        assert.equal(requests.length, 0);
        assert.match(toastOf(calls).params.text, /Cancelado/);
        const edit = editOf(calls);
        assert.equal(edit.params.text, MESSAGE.text, 'restaura el texto original, sin el bloque de confirmación');
        const kb = edit.params.reply_markup.inline_keyboard.flat();
        assert.deepEqual(kb.map(b => b.callback_data),
            ['pp:include-deps-for-issue:5923', 'pp:keep-original:5923', 'pp:mute-alert:5923'],
            'CA-UX-3: cancelar RESTAURA el teclado, no lo retira — ya sin el botón de alcance global');
    } finally { requests.restore(); }
});

// #6118 — Blinda la falla silenciosa: si `_degradedOriginalKeyboard` tira, el
// `try/catch` devuelve `null` y el operador lee "no se pudo restaurar el
// teclado" sin que ningún test se entere. Sacar una acción de `PP_META` sin
// tocar el rearmado producía exactamente eso (un `undefined.text`).
test('#6118 el rearmado del teclado pp: devuelve 3 filas de 1 botón, nunca null', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        await handler.handleDegradedActionCallback('pp:x:keep-original:6033', 'cbq-kb', MESSAGE, OPERADOR);
        const rows = editOf(calls).params.reply_markup.inline_keyboard;
        assert.ok(Array.isArray(rows) && rows.length === 3, 'tres filas, no un teclado vacío ni null');
        for (const row of rows) {
            assert.equal(row.length, 1, 'un botón por fila: dos de ~30 chars se truncan con … en el celular');
            assert.ok(Buffer.byteLength(row[0].callback_data, 'utf8') <= 64, 'entra en el límite de la Bot API');
            assert.ok(row[0].text.length > 0);
        }
        const textos = rows.flat().map(b => b.text).join(' | ');
        assert.doesNotMatch(textos, /pausa parcial|allowlist|dispatch/i,
            'CA-1: el teclado rearmado tampoco puede traer jerga de vuelta');
    } finally { requests.restore(); }
});

test('#5923 hb:devolver-definicion (descarta trabajo) también exige doble tap', async () => {
    const calls = installFakeTgApi();
    await handler.handleDegradedActionCallback('hb:devolver-definicion:5923', 'cbq-11', MESSAGE, OPERADOR);
    const toast = toastOf(calls);
    assert.equal(toast.params.show_alert, true);
    assert.match(toast.params.text, /descarta el trabajo de desarrollo/i, 'consequence literal de ACTION_META');
    const kb = editOf(calls).params.reply_markup.inline_keyboard[0];
    assert.equal(kb[0].callback_data, 'hb:c:devolver-definicion:5923');
    assert.equal(kb[1].callback_data, 'hb:x:devolver-definicion:5923');
    // El peor caso de longitud sigue bajo el límite de la Bot API.
    for (const b of kb) assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64);
});

test('#5923 hb: no destructivo NO pide confirmación (un tap y listo)', async () => {
    const calls = installFakeTgApi();
    await handler.handleDegradedActionCallback('hb:mas-contexto:5923', 'cbq-12', MESSAGE, OPERADOR);
    assert.deepEqual(editOf(calls).params.reply_markup, { inline_keyboard: [] }, 'ejecutó directo');
});

// ─── Contrato del mapa de rutas ──────────────────────────────────────────────

test('#6118 PP_ROUTES está congelado y cubre exactamente los 3 botones emitidos', () => {
    assert.ok(Object.isFrozen(handler.PP_ROUTES));
    assert.deepEqual(Object.keys(handler.PP_ROUTES).sort(),
        ['include-deps-for-issue', 'keep-original', 'mute-alert']);
    for (const [action, route] of Object.entries(handler.PP_ROUTES)) {
        assert.equal(route, `/api/partial-pause/${action}`);
    }
    // Ningún botón se entrega sin rama: todo lo que emite el pulpo está mapeado.
    assert.deepEqual(Object.keys(handler.PP_META).sort(), Object.keys(handler.PP_ROUTES).sort());
});

test('#6118 los `consequence` de PP_META están libres de jerga interna (CA-1, 4ta superficie)', () => {
    // Son texto VISIBLE: van al modal de confirmación y quedan escritos en el
    // mensaje editado. Los tres de antes concentraban los tres términos.
    for (const [action, meta] of Object.entries(handler.PP_META)) {
        for (const texto of [meta.text, meta.consequence]) {
            assert.doesNotMatch(texto, /pausa parcial|allowlist|dispatch|cooldown|\bdeps\b/i,
                `${action}: "${texto}" expone vocabulario interno al operador`);
        }
    }
});

test('#6118 `pp:` sigue siendo namespace privilegiado y el botón nuevo matchea', () => {
    // Sin `COMMANDER_NAMESPACES` el callback cae en `operator-gate` y el botón
    // nace muerto; con él pero sin `PRIVILEGED_NAMESPACES`, cualquiera del chat
    // podría silenciar la alerta. Por eso se reusa `pp:` y no un prefijo nuevo.
    // Se usan los helpers REALES de membresía, no una reimplementación del
    // matcheo: si mañana cambia la regla de prefijos, el test la sigue.
    for (const data of ['pp:mute-alert:6033', 'pp:include-deps-for-issue:6033', 'pp:keep-original:6033']) {
        assert.ok(handler.isCommanderNamespace(data), `${data} tiene que rutear al commander`);
        assert.ok(handler.isPrivilegedNamespace(data), `${data} exige authz por from.id`);
    }
});

test('#5923 los 4 botones de human-block tienen ejecución en el handler', () => {
    const hb = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'human-block.js'));
    for (const action of hb.HUMAN_BLOCK_ACTIONS) {
        assert.ok(hb.isQuickAction(action), `${action} debe ser ejecutable por executeQuickAction`);
        assert.ok(hb.ACTION_META[action].consequence, `${action} necesita consequence para el doble tap`);
    }
});
