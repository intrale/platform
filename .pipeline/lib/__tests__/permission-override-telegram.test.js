// =============================================================================
// permission-override-telegram.test.js — formato natural y enqueue
// Issue #3082 — CA-17 + G2 (UX).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const telegramHelper = require('../permission-override-telegram');

function sampleEntry(overrides = {}) {
    return {
        type: 'permission_override',
        skill: 'qa',
        provider: 'openai-codex',
        mode_requerido: 'bypassPermissions',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Necesitamos QA en codex porque la cuota Anthropic se agotó y la window QA está activa.',
        autor: 'leito.larreta@gmail.com',
        ttl_horas: 24,
        created_at: Date.now(),
        hash_self: 'abcdef0123456789' + 'f'.repeat(48),
        hash_prev: 'GENESIS',
        ...overrides,
    };
}

test('formatOverrideMessage produce un texto Markdown natural con bloques requeridos (G2)', () => {
    const payload = telegramHelper.formatOverrideMessage(sampleEntry());
    assert.equal(payload.parse_mode, 'Markdown');
    const text = payload.text;
    // Bloques obligatorios G2
    assert.match(text, /qa/);
    assert.match(text, /openai-codex/);
    assert.match(text, /24h/);
    assert.match(text, /tool_use_gated/);
    assert.match(text, /leito\.larreta/);
    assert.match(text, /Para revocar antes del TTL/);
    assert.match(text, /revoke-permission\.js/);
});

test('formatOverrideMessage incluye fecha absoluta + relativa (G3)', () => {
    const payload = telegramHelper.formatOverrideMessage(sampleEntry());
    assert.match(payload.text, /UTC/);
    assert.match(payload.text, /vence en \d+h \d+m/);
});

test('formatOverrideMessage varía el verbo de apertura según hash (anti-template robótico, G2)', () => {
    const verbs = new Set();
    for (let i = 0; i < 50; i++) {
        const hash = i.toString(16).padStart(4, '0') + 'f'.repeat(60);
        const payload = telegramHelper.formatOverrideMessage(sampleEntry({ hash_self: hash }));
        // El verbo de apertura es lo que viene después de la 🛂 antes del * de cierre
        const m = payload.text.match(/🛂 \*(.+?)\*/);
        if (m) verbs.add(m[1]);
    }
    assert.ok(verbs.size >= 2, `Esperaba varios verbos rotativos, encontré: ${[...verbs].join(', ')}`);
});

test('formatOverrideMessage trunca justificación larga a 80 chars con elipsis', () => {
    const long = 'a'.repeat(200);
    const payload = telegramHelper.formatOverrideMessage(sampleEntry({ justificacion: long }));
    assert.match(payload.text, /…/);
});

test('enqueueTelegramNotification escribe en pendiente/ y crea dir si falta', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg-'));
    const queued = telegramHelper.enqueueTelegramNotification({
        payload: { text: 'hola', parse_mode: 'Markdown' },
        pipelineRoot: tmp,
    });
    assert.ok(fs.existsSync(queued));
    const content = JSON.parse(fs.readFileSync(queued, 'utf8'));
    assert.equal(content.text, 'hola');
});

test('notifyOverrideCreated combina format + enqueue en una sola llamada', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg2-'));
    const queued = telegramHelper.notifyOverrideCreated(sampleEntry(), { pipelineRoot: tmp });
    assert.ok(fs.existsSync(queued));
    const content = JSON.parse(fs.readFileSync(queued, 'utf8'));
    assert.match(content.text, /qa/);
});

// =============================================================================
// #7112 — sin `pipelineRoot`, la cola se resuelve por el envoltorio único
// (`lib/write-target`), igual que notify-telegram.js / health-cron.js. Es el
// camino de los dos callers reales (scripts/override-permission.js y
// lib/multi-provider/api.js), que llaman sin `pipelineRoot`.
//
// El helper lee `process.env` por llamada, así que estos tests lo aíslan con
// `withEnv` (#6258); nunca escriben en un `.pipeline` real.
// =============================================================================

const writeTarget = require('../write-target');
const { withEnv } = require('../test-helpers/with-env');

// Las cinco variables que gobiernan el resolvedor se dejan SIEMPRE en un estado
// conocido: `undefined` las borra (D-6258-5), así el test no depende de lo que
// herede del shell ni de lo que deje el runner (PIPELINE_DIR_OVERRIDE global).
const ENV_7112_LIMPIO = Object.freeze({
    PIPELINE_AMBIENTE: undefined,
    PIPELINE_DIR_OVERRIDE: undefined,
    PIPELINE_STATE_DIR: undefined,
    PIPELINE_REPO_ROOT: undefined,
    NODE_TEST_CONTEXT: undefined,
});

function withEnv7112(patch, fn) {
    // R0 de #7114: PIPELINE_AMBIENTE es variable de control (`cualquiera`);
    // borrarla es la posicion INERTE (default `pruebas`), declarada a proposito.
    return withEnv({ ...ENV_7112_LIMPIO, ...patch }, fn, {
        permitirApagarControl: ['PIPELINE_AMBIENTE'],
        motivo: 'el test borra PIPELINE_AMBIENTE para partir del default pruebas (sin declaracion): posicion inerte',
    });
}

function walk7112(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk7112(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('#7112 · sin pipelineRoot bajo el runner (PIPELINE_DIR_OVERRIDE + REPO_ROOT heredado): el dropfile cae en <override>/servicios/telegram/pendiente y NO en <REPO_ROOT>/.pipeline', () => {
    const fakeProd = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg-fakeprod-'));
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg-rundir-'));
    fs.mkdirSync(path.join(fakeProd, '.pipeline'), { recursive: true });
    try {
        const queued = withEnv7112({
            PIPELINE_REPO_ROOT: fakeProd,
            PIPELINE_DIR_OVERRIDE: runDir,
            NODE_TEST_CONTEXT: '1',
        }, () => telegramHelper.notifyOverrideCreated(sampleEntry()));

        const esperado = path.join(runDir, 'servicios', 'telegram', 'pendiente');
        assert.equal(path.dirname(queued), esperado);
        assert.ok(fs.existsSync(queued));
        assert.match(JSON.parse(fs.readFileSync(queued, 'utf8')).text, /qa/);
        // El "productivo" heredado queda intacto: cero archivos nuevos.
        assert.deepEqual(walk7112(fakeProd), []);
        assert.ok(!fs.existsSync(path.join(fakeProd, '.pipeline', 'servicios')));
    } finally {
        fs.rmSync(fakeProd, { recursive: true, force: true });
        fs.rmSync(runDir, { recursive: true, force: true });
    }
});

test('#7112 · sin pipelineRoot, sin override ni declaración de ambiente: lanza EscrituraBloqueadaError y no escribe nada (ni en cwd ni en REPO_ROOT)', () => {
    const fakeProd = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg-fakeprod2-'));
    fs.mkdirSync(path.join(fakeProd, '.pipeline'), { recursive: true });
    try {
        withEnv7112({ PIPELINE_REPO_ROOT: fakeProd, NODE_TEST_CONTEXT: '1' }, () => {
            assert.throws(
                () => telegramHelper.notifyOverrideCreated(sampleEntry()),
                (e) => e instanceof writeTarget.EscrituraBloqueadaError
                    && e.code === writeTarget.CODIGO_BLOQUEO
                    && e.canal === 'colas'
                    && e.destino === 'servicios/telegram/pendiente',
            );
        });
        assert.deepEqual(walk7112(fakeProd), []);
    } finally {
        fs.rmSync(fakeProd, { recursive: true, force: true });
    }
});

test('#7112 · el helper no usa PIPELINE_REPO_ROOT ni cwd como fallback de la cola (fuera del resolvedor)', () => {
    const src = fs.readFileSync(require.resolve('../permission-override-telegram'), 'utf8');
    // Sólo código: se descartan los comentarios de línea (que sí nombran la variable).
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /PIPELINE_REPO_ROOT/);
    assert.doesNotMatch(code, /process\.cwd\(\)/);
    assert.match(src, /require\('\.\/write-target'\)\.writeDir\(process\.env, \{ canal: 'colas', destino: 'servicios\/telegram\/pendiente' \}\)/);
});
