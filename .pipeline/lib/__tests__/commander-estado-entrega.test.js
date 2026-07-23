// =============================================================================
// commander-estado-entrega.test.js — Suite del comando `/entregado` (#4090).
//
// Cubre:
//   - CA-3: parseEntregadoArgs rechaza inyección (`5;rm`, `--flag`, backticks),
//     floats, vacío y tokens extra; acepta `<issue>` y `<issue> pr <n>`.
//   - CA-1/CA-4: render de cada uno de los 4 estados con el template
//     `estado-entrega.md` (veredicto con glifo + cita determinística).
//   - A09: la salida pasa por redacción — no expone tokens/paths absolutos.
//   - CA-3: grep estático — el código nuevo del comando NO contiene
//     execFile/spawnSync/--jq (solo compone vía canonical).
//   - E2E del dispatcher con impls fake (sin red/shell): `/entregado 4090`
//     responde con el veredicto + cita canónica.
//
// Diseño: fakes inyectables vía `canonicalImpls`. CERO red/FS-de-prod/shell.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cd = require('../commander-deterministic');
const {
    classify,
    parseEntregadoArgs,
    deliveryCitationFor,
    createDispatcher,
} = cd;
const { fillTemplate, clearCache } = require('../commander/fill-template');

// -----------------------------------------------------------------------------
// CA-3 — sintaxis estricta de `/entregado`.
// -----------------------------------------------------------------------------
test('parseEntregadoArgs: formas válidas', () => {
    assert.deepEqual(parseEntregadoArgs('4090'), { issue: 4090, pr: null });
    assert.deepEqual(parseEntregadoArgs('#4090'), { issue: 4090, pr: null });
    assert.deepEqual(parseEntregadoArgs('4090 pr 4091'), { issue: 4090, pr: 4091 });
    assert.deepEqual(parseEntregadoArgs('4090 PR #4091'), { issue: 4090, pr: 4091 });
});

test('parseEntregadoArgs: inyección y sintaxis inválida → null (nada se ejecuta)', () => {
    const bad = [
        '', '   ', 'abc', '4090.5', '0', '-1', '0x10',
        '4090;rm -rf /', '4090 `whoami`', '4090 $(id)', '--flag',
        '4090 pr', '4090 pr abc', '4090 pr 4091 extra', '4090 4091',
        '4090 issue 4091', 'pr 4091', '4090 pr -1', '4090 pr 0',
    ];
    for (const args of bad) {
        assert.equal(parseEntregadoArgs(args), null, `args "${args}" NO fue rechazado`);
    }
});

test('classify: `/entregado` y NLP "está entregado ..." rutean al comando determinístico', () => {
    const slash = classify('/entregado 4090');
    assert.equal(slash.class, 'deterministic');
    assert.equal(slash.command, 'entregado');
    assert.equal(slash.args, '4090');

    const alias = classify('/estado-entrega 4090');
    assert.equal(alias.command, 'estado-entrega');

    const nlp = classify('está entregado 4090');
    assert.equal(nlp.class, 'deterministic');
    assert.equal(nlp.command, 'entregado');
    assert.equal(nlp.args, '4090');
});

// -----------------------------------------------------------------------------
// CA-1 / CA-4 — render de cada uno de los 4 estados.
// -----------------------------------------------------------------------------
function renderState(delivery, issue = 4090) {
    clearCache();
    const state = delivery.state;
    return fillTemplate('estado-entrega', {
        numero: issue,
        state,
        'is-mergeado': state === 'mergeado_en_main',
        'is-pusheado': state === 'pusheado_sin_merge',
        'is-pipeline': state === 'en_pipeline',
        'is-no-verificable': state === 'not_verifiable',
        fase: delivery.fase || '',
        citation: deliveryCitationFor(issue, delivery),
    });
}

test('render: mergeado_en_main → ✅ entregado, mergeado en main', () => {
    const out = renderState({ state: 'mergeado_en_main', facts: { prMerged: { value: true } } });
    assert.match(out, /✅/);
    assert.match(out, /mergeado en/);
    assert.match(out, /MERGED/);
});

test('render: pusheado_sin_merge → 🟡 SIN merge (CA-4: no colapsa con entregado)', () => {
    const out = renderState({ state: 'pusheado_sin_merge', facts: {} });
    assert.match(out, /🟡/);
    assert.match(out, /SIN merge/);
});

test('render: en_pipeline → 🔵 con fase', () => {
    const out = renderState({ state: 'en_pipeline', fase: 'dev', facts: {} });
    assert.match(out, /🔵/);
    assert.match(out, /dev/);
});

test('render: not_verifiable → 🤷 no asumir "no entregado"', () => {
    const out = renderState({ state: 'not_verifiable', facts: {} });
    assert.match(out, /🤷/);
    assert.match(out, /No pude verificar|no asumir/i);
});

// -----------------------------------------------------------------------------
// A09 — la salida no expone paths absolutos ni tokens.
// -----------------------------------------------------------------------------
test('A09: la cita/salida NO arrastra paths absolutos, flags ruidosos ni dumps', () => {
    for (const state of ['mergeado_en_main', 'pusheado_sin_merge', 'en_pipeline', 'not_verifiable']) {
        const out = renderState({ state, fase: 'dev', facts: { prMerged: { value: true } } });
        assert.ok(!/--json|--jq|C:\\|\/home\/|\\Workspaces/.test(out),
            `${state}: la salida arrastra paths/flags: "${out}"`);
    }
});

// -----------------------------------------------------------------------------
// CA-3 — grep estático del código nuevo del comando.
// -----------------------------------------------------------------------------
test('grep estático: parseEntregadoArgs/entregadoHandler/deliveryCitationFor sin execFile/spawn/--jq', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commander-deterministic.js'), 'utf8');
    for (const anchor of ['function parseEntregadoArgs', 'function deliveryCitationFor', 'const entregadoHandler']) {
        const start = src.indexOf(anchor);
        assert.ok(start > 0, `no se encontró ${anchor}`);
        const body = src.slice(start, start + 2500);
        assert.ok(!/execFile|spawnSync|spawn\(/.test(body), `${anchor}: NO debe ejecutar comandos directos`);
        assert.ok(!/--jq/.test(body), `${anchor}: NO debe usar --jq`);
    }
});

// -----------------------------------------------------------------------------
// E2E del dispatcher — `/entregado` responde con la cita canónica (fakes).
// -----------------------------------------------------------------------------
function mkDispatcher(canonicalImpls) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entregado-dispatch-'));
    fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
    return createDispatcher({
        pipelineRoot: tmp,
        logsDir: path.join(tmp, 'logs'),
        destructiveCooldown: false,
        canonicalImpls,
    });
}

test('E2E: /entregado 4090 con rama mergeada a main → ✅ entregado', async () => {
    const gitImpl = async ({ args }) => {
        if (args.includes('--merged')) return { ok: true, stdout: '  remotes/origin/agent/4090-x\n' };
        return { ok: false, stdout: '' };
    };
    const { dispatch } = mkDispatcher({ gitImpl, ghApi: async () => ({ ok: false, stdout: '' }) });
    const out = await dispatch({ chat_id: '1', text: '/entregado 4090' });
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /✅/);
    assert.match(out.reply, /entregado en main/);
});

test('E2E: /entregado 4090 rama presente sin merge → 🟡 pusheado sin merge', async () => {
    const gitImpl = async ({ args }) => {
        if (args.includes('--merged')) return { ok: true, stdout: '' };
        if (args[0] === 'branch' && args.includes('--list')) return { ok: true, stdout: '  remotes/origin/agent/4090-x\n' };
        return { ok: false, stdout: '' };
    };
    const { dispatch } = mkDispatcher({ gitImpl, ghApi: async () => ({ ok: true, stdout: JSON.stringify({ state: 'OPEN', closed: false }) }) });
    const out = await dispatch({ chat_id: '1', text: '/entregado 4090' });
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /🟡/);
    assert.match(out.reply, /SIN merge/);
});

test('E2E: fuente canónica caída → 🤷 not_verifiable (sin especular "no entregado")', async () => {
    const gitImpl = async () => ({ ok: false, stdout: '' });
    const { dispatch } = mkDispatcher({ gitImpl, ghApi: async () => ({ ok: false, stdout: '' }) });
    const out = await dispatch({ chat_id: '1', text: '/entregado 4090' });
    assert.equal(out.status, 'ok');
    assert.match(out.reply, /🤷/);
    assert.ok(!/✅ \*Entregado/.test(out.reply), 'no debe afirmar entregado sin evidencia');
});

test('E2E: args inválidos (/entregado 4090;rm) → invalid_args, el handler NO corre', async () => {
    let called = false;
    const gitImpl = async () => { called = true; return { ok: true, stdout: '' }; };
    const { dispatch } = mkDispatcher({ gitImpl });
    const out = await dispatch({ chat_id: '1', text: '/entregado 4090;rm -rf /' });
    assert.equal(out.status, 'invalid_args');
    assert.equal(called, false, 'la fuente canónica NUNCA debe ejecutarse con args inválidos');
});
