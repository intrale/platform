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
    const requests = installFakeFetch(() => ({ status: 200, body: { ok: true, msg: 'Allowlist actualizado: 5923, 5924.' } }));
    try {
        await handler.handleDegradedActionCallback('pp:include-deps:5923', 'cbq-4', MESSAGE, OPERADOR);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'http://127.0.0.1:3200/api/partial-pause/include-deps',
            'el destino sale del mapa congelado, nunca de interpolar el action');
        assert.equal(requests[0].opts.method, 'POST');
        assert.equal(requests[0].opts.headers['Content-Type'], 'application/json');
        assert.match(JSON.parse(requests[0].opts.body).authorizedBy, /^telegram:111222333$/,
            'el operador real viaja al gate, no un literal hardcodeado');

        const toast = toastOf(calls);
        assert.ok(toast.params.text.length > 0, 'nunca un ack vacío');
        assert.match(toast.params.text, /Allowlist actualizado/, 'feedback CONCRETO del resultado');

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

// ─── Doble tap de las acciones destructivas (CA-17 / CA-UX-1..3) ─────────────

test('#5923 pp:cancel-partial-pause NO ejecuta al primer tap: pide confirmación', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        await handler.handleDegradedActionCallback('pp:cancel-partial-pause', 'cbq-8', MESSAGE, OPERADOR);
        assert.equal(requests.length, 0, 'un tap solo no puede liberar todo el backlog');

        const toast = toastOf(calls);
        assert.equal(toast.params.show_alert, true, 'modal, no un toast que se pierde');
        assert.match(toast.params.text, /TODO el backlog/, 'la consecuencia literal, no un genérico');

        const kb = editOf(calls).params.reply_markup.inline_keyboard[0];
        assert.equal(kb.length, 2);
        assert.match(kb[0].text, /^⚠️ Sí,/, 'confirmar a la izquierda');
        assert.equal(kb[0].callback_data, 'pp:c:cancel-partial-pause');
        assert.match(kb[1].text, /Cancelar/);
        assert.equal(kb[1].callback_data, 'pp:x:cancel-partial-pause');
        assert.match(editOf(calls).params.text, /TODO el backlog/, 'la consecuencia queda escrita en el mensaje');
    } finally { requests.restore(); }
});

test('#5923 el 2do tap (pp:c:) sí ejecuta', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch(() => ({ status: 200, body: { ok: true, msg: 'Pausa parcial levantada.' } }));
    try {
        await handler.handleDegradedActionCallback('pp:c:cancel-partial-pause', 'cbq-9', MESSAGE, OPERADOR);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'http://127.0.0.1:3200/api/partial-pause/cancel-partial-pause');
        assert.match(toastOf(calls).params.text, /levantada/);
        assert.deepEqual(editOf(calls).params.reply_markup, { inline_keyboard: [] });
    } finally { requests.restore(); }
});

test('#5923 cancelar la confirmación (pp:x:) restaura el teclado original y no ejecuta', async () => {
    const calls = installFakeTgApi();
    const requests = installFakeFetch();
    try {
        const confirmado = {
            ...MESSAGE,
            text: MESSAGE.text + '\n\n⚠️ Vas a levantar la pausa parcial: el pipeline vuelve a tomar TODO el backlog, no sólo el allowlist actual.',
        };
        await handler.handleDegradedActionCallback('pp:x:cancel-partial-pause', 'cbq-10', confirmado, OPERADOR);

        assert.equal(requests.length, 0);
        assert.match(toastOf(calls).params.text, /Cancelado/);
        const edit = editOf(calls);
        assert.equal(edit.params.text, MESSAGE.text, 'restaura el texto original, sin el bloque de confirmación');
        const kb = edit.params.reply_markup.inline_keyboard.flat();
        assert.deepEqual(kb.map(b => b.callback_data),
            ['pp:include-deps', 'pp:keep-original', 'pp:cancel-partial-pause'],
            'CA-UX-3: cancelar RESTAURA el teclado, no lo retira');
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

test('#5923 PP_ROUTES está congelado y cubre exactamente los 3 botones emitidos', () => {
    assert.ok(Object.isFrozen(handler.PP_ROUTES));
    assert.deepEqual(Object.keys(handler.PP_ROUTES).sort(),
        ['cancel-partial-pause', 'include-deps', 'keep-original']);
    for (const [action, route] of Object.entries(handler.PP_ROUTES)) {
        assert.equal(route, `/api/partial-pause/${action}`);
    }
    // Ningún botón se entrega sin rama: todo lo que emite el pulpo está mapeado.
    assert.deepEqual(Object.keys(handler.PP_META).sort(), Object.keys(handler.PP_ROUTES).sort());
});

test('#5923 los 4 botones de human-block tienen ejecución en el handler', () => {
    const hb = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'human-block.js'));
    for (const action of hb.HUMAN_BLOCK_ACTIONS) {
        assert.ok(hb.isQuickAction(action), `${action} debe ser ejecutable por executeQuickAction`);
        assert.ok(hb.ACTION_META[action].consequence, `${action} necesita consequence para el doble tap`);
    }
});
