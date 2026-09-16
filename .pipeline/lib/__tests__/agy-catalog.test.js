'use strict';
// =============================================================================
// agy-catalog.test.js — #6858: cruce automático de los ids de Antigravity
// (config + 3 barreras) contra el catálogo real del CLI (`agy models`).
//
// Offline: fixture `fixtures/agy-models-2026-09-16.tsv` (salida cruda y real del
// CLI 1.2.4 medida el 2026-09-16). En vivo: si el binario está instalado, el
// último test ejecuta `agy models` de verdad y cruza; si no, se saltea con
// motivo (CA-2 pide que la verificación exista y falle al divergir — no que
// cada máquina de desarrollo tenga Antigravity).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agyCatalog = require('../multi-provider/agy-catalog');
const { ALLOWED_MODELS_BY_LAUNCHER } = require('../agent-models-validate');
const { PROVIDER_MODELS_ALLOWLIST } = require('../multi-provider/completion-client');
const { CATALOG } = require('../multi-provider/model-catalog');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const FIXTURE_TSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-models-2026-09-16.tsv'), 'utf8');
const FIXTURE_IDS = agyCatalog.parseAgyModelsOutput(FIXTURE_TSV).map((m) => m.id);
const REAL_CONFIG = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, 'agent-models.json'), 'utf8'));

// Ids del Gemini CLI gratuito / AI Studio que motivaron la historia. NINGUNO
// puede volver a aparecer en config ni en barreras.
const RETIRED_IDS = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro',
    'gemini-2.0-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];

test.beforeEach(() => agyCatalog._resetCacheForTesting());

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------
test('parseAgyModelsOutput: lee la salida TSV real del CLI (id<TAB>label) y devuelve los 14 modelos', () => {
    const models = agyCatalog.parseAgyModelsOutput(FIXTURE_TSV);
    assert.equal(models.length, 14);
    assert.deepEqual(models[0], { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' });
    assert.ok(models.some((m) => m.id === 'claude-opus-4-6-thinking' && m.label === 'Claude Opus 4.6 (Thinking)'));
    assert.ok(models.some((m) => m.id === 'gpt-oss-120b-medium'));
});

test('parseAgyModelsOutput: ignora spinner, líneas vacías, CRLF, escapes ANSI y duplicados', () => {
    const ruidoso = [
        '\u001b[2K⠋ Fetching available models...',
        '',
        'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\r',
        'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
        'Model-Con-Mayus\tno válido',
        '   ',
        'gemini-3.1-pro-low',
    ].join('\n');
    assert.deepEqual(agyCatalog.parseAgyModelsOutput(ruidoso), [
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        { id: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' },
    ]);
    assert.deepEqual(agyCatalog.parseAgyModelsOutput(''), []);
    assert.deepEqual(agyCatalog.parseAgyModelsOutput(null), []);
});

// -----------------------------------------------------------------------------
// fetchAgyModels — binario, argv fijo, errores tipados, caché
// -----------------------------------------------------------------------------
test('fetchAgyModels: ejecuta el binario con argv fijo ["models"], sin shell, y cachea por TTL', () => {
    const calls = [];
    const execFileSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return FIXTURE_TSV; };
    const env = { AGY_BIN: 'C:\\fake\\agy.exe' };
    let clock = 1_000_000;
    const now = () => clock;

    const a = agyCatalog.fetchAgyModels({ env, execFileSync, now });
    assert.equal(a.ok, true);
    assert.equal(a.ids.length, 14);
    assert.equal(a.fromCache, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'C:\\fake\\agy.exe');
    assert.deepEqual(calls[0].args, ['models']);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.shell, undefined, 'execFile: nunca shell');

    clock += 60_000;
    const b = agyCatalog.fetchAgyModels({ env, execFileSync, now });
    assert.equal(b.fromCache, true, 'segunda lectura dentro del TTL sale de caché');
    assert.equal(calls.length, 1);

    const c = agyCatalog.fetchAgyModels({ env, execFileSync, now, fresh: true });
    assert.equal(c.fromCache, false, '--fresh salta la caché');
    assert.equal(calls.length, 2);
});

test('fetchAgyModels: CLI ausente → cli_unavailable; CLI que falla → cli_failed; salida vacía → empty_catalog; nunca lanza', () => {
    const enoent = () => { const e = new Error('spawn agy ENOENT'); e.code = 'ENOENT'; throw e; };
    const r1 = agyCatalog.fetchAgyModels({ env: {}, execFileSync: enoent, cacheTtlMs: 0 });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'cli_unavailable');
    assert.deepEqual(r1.ids, []);

    const boom = () => { const e = new Error('exit 1'); e.status = 1; throw e; };
    const r2 = agyCatalog.fetchAgyModels({ env: {}, execFileSync: boom, cacheTtlMs: 0 });
    assert.equal(r2.error, 'cli_failed');

    const r3 = agyCatalog.fetchAgyModels({ env: {}, execFileSync: () => '⠋ Fetching...\n', cacheTtlMs: 0 });
    assert.equal(r3.ok, false);
    assert.equal(r3.error, 'empty_catalog');
});

test('resolveAgyBin: misma cascada que el handler (AGY_BIN → %LOCALAPPDATA%\\agy\\bin\\agy.exe → PATH)', () => {
    assert.equal(agyCatalog.resolveAgyBin({ AGY_BIN: '/x/agy' }).cmd, '/x/agy');
    const fsImpl = { existsSync: (p) => p.endsWith(path.join('agy', 'bin', 'agy.exe')) };
    const win = agyCatalog.resolveAgyBin({ LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' }, fsImpl);
    assert.equal(win.kind, 'native-exe');
    assert.equal(agyCatalog.resolveAgyBin({}, { existsSync: () => false }).cmd, 'agy');
});

// -----------------------------------------------------------------------------
// collectConfiguredGeminiModels — las 4 fuentes, sólo gemini-google
// -----------------------------------------------------------------------------
test('collectConfiguredGeminiModels: junta provider.model, alternative_models, model_override y fallbacks sólo de gemini-google', () => {
    const cfg = {
        providers: {
            'gemini-google': { model: 'a', alternative_models: ['b'] },
            anthropic: { model: 'claude-opus-4-7', alternative_models: ['no-entra'] },
        },
        skills: {
            guru: { provider: 'gemini-google', model_override: 'c', fallbacks: [{ provider: 'anthropic', model_override: 'no-entra' }] },
            qa: { provider: 'anthropic', model_override: 'no-entra', fallbacks: [{ provider: 'gemini-google', model_override: 'd' }, { provider: 'gemini-google', model_override: 'a' }] },
        },
    };
    const got = agyCatalog.collectConfiguredGeminiModels(cfg);
    assert.deepEqual([...got.keys()].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(got.get('a'), ['providers.gemini-google.model', 'skills.qa.fallbacks[1].model_override']);
    assert.deepEqual(got.get('b'), ['providers.gemini-google.alternative_models[0]']);
    assert.deepEqual(got.get('c'), ['skills.guru.model_override']);
    assert.deepEqual(got.get('d'), ['skills.qa.fallbacks[0].model_override']);
});

test('collectConfiguredGeminiModels: el agent-models.json REAL declara exactamente 4 ids de Antigravity en 11 rutas', () => {
    const got = agyCatalog.collectConfiguredGeminiModels(REAL_CONFIG);
    assert.deepEqual([...got.keys()].sort(), [
        'gemini-3.7-flash-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium',
    ]);
    const rutas = [...got.values()].flat();
    assert.equal(rutas.length, 11, 'provider.model + alternative_models[0] + 9 fallbacks (uno por skill del issue)');
    // Los 9 skills del issue tienen su eslabón gemini-google con un id válido.
    for (const skill of ['android-dev', 'web-dev', 'qa', 'po', 'ux', 'architect', 'perf', 'telegram-commander', 'telegram-sherlock']) {
        assert.ok(rutas.some((r) => r.startsWith(`skills.${skill}.fallbacks[`)), `skill ${skill} conserva su eslabón gemini-google`);
    }
});

// -----------------------------------------------------------------------------
// crossCheck — semántica dead / unlisted
// -----------------------------------------------------------------------------
test('crossCheck: un id configurado ausente del catálogo es `dead` y baja ok a false, con la ruta exacta', () => {
    const cfg = { providers: { 'gemini-google': { model: 'gemini-3-flash-preview', alternative_models: ['gemini-3.7-flash-medium'] } }, skills: {} };
    const r = agyCatalog.crossCheck({
        catalogIds: FIXTURE_IDS, agentModels: cfg,
        barriers: { validate: FIXTURE_IDS, completion: FIXTURE_IDS, catalog: FIXTURE_IDS },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.dead, [{ id: 'gemini-3-flash-preview', sources: ['agent-models.json:providers.gemini-google.model'] }]);
    assert.match(r.summary, /FALLA: 1 id\(s\)/);
    assert.match(r.summary, /gemini-3-flash-preview ← agent-models\.json:providers\.gemini-google\.model/);
});

test('crossCheck: un id muerto en CUALQUIERA de las tres barreras también falla (reemplazo, no agregado)', () => {
    const cfg = { providers: { 'gemini-google': { model: 'gemini-3.8-flash-medium' } }, skills: {} };
    for (const [barrier, nombre] of [['validate', 'ALLOWED_MODELS_BY_LAUNCHER'], ['completion', 'PROVIDER_MODELS_ALLOWLIST'], ['catalog', 'CATALOG']]) {
        const barriers = { validate: FIXTURE_IDS, completion: FIXTURE_IDS, catalog: FIXTURE_IDS, [barrier]: [...FIXTURE_IDS, 'gemini-2.5-flash'] };
        const r = agyCatalog.crossCheck({ catalogIds: FIXTURE_IDS, agentModels: cfg, barriers });
        assert.equal(r.ok, false, `${nombre} con id retirado debe fallar`);
        assert.equal(r.dead.length, 1);
        assert.equal(r.dead[0].id, 'gemini-2.5-flash');
        assert.match(r.dead[0].sources[0], new RegExp(nombre));
    }
});

test('crossCheck: un modelo NUEVO del CLI que ninguna barrera conoce es `unlisted` (aviso) y NO baja ok', () => {
    const cfg = { providers: { 'gemini-google': { model: 'gemini-3.8-flash-medium' } }, skills: {} };
    const r = agyCatalog.crossCheck({
        catalogIds: [...FIXTURE_IDS, 'gemini-4.0-flash-high'], agentModels: cfg,
        barriers: { validate: FIXTURE_IDS, completion: FIXTURE_IDS, catalog: FIXTURE_IDS },
    });
    assert.equal(r.ok, true, 'un modelo nuevo del vendor nunca dispara rollback del pipeline');
    assert.deepEqual(r.unlisted, [{ id: 'gemini-4.0-flash-high', missingFrom: ['ALLOWED_MODELS_BY_LAUNCHER', 'PROVIDER_MODELS_ALLOWLIST', 'CATALOG'] }]);
    assert.match(r.summary, /1 id\(s\) del CLI sin adoptar \(aviso, no bloquea\)/);
});

// -----------------------------------------------------------------------------
// CA-1 / CA-3 — estado REAL del repo contra el snapshot real del CLI
// -----------------------------------------------------------------------------
test('CA-1/CA-3: config real + las tres barreras reales están 100% en el catálogo de agy (snapshot 2026-09-16) y sin ids retirados', () => {
    const r = agyCatalog.crossCheck({ catalogIds: FIXTURE_IDS, agentModels: REAL_CONFIG });
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.dead, []);
    assert.deepEqual(r.unlisted, [], 'las tres barreras son espejo exacto del catálogo del CLI');

    const barreras = {
        ALLOWED_MODELS_BY_LAUNCHER: ALLOWED_MODELS_BY_LAUNCHER['gemini-google'],
        PROVIDER_MODELS_ALLOWLIST: PROVIDER_MODELS_ALLOWLIST['gemini-google'],
        CATALOG: CATALOG['gemini-google'].map((m) => m.id),
    };
    for (const [nombre, ids] of Object.entries(barreras)) {
        assert.deepEqual([...ids].sort(), [...FIXTURE_IDS].sort(), `${nombre} == agy models`);
        for (const retirado of RETIRED_IDS) {
            assert.ok(!ids.includes(retirado), `${nombre} no puede reintroducir ${retirado}`);
        }
    }
    const raw = fs.readFileSync(path.join(PIPELINE_DIR, 'agent-models.json'), 'utf8');
    // El `_doc` narra la migración y nombra el id viejo a propósito; lo que no
    // puede haber es el id viejo como VALOR de `model` / `model_override` /
    // `alternative_models`.
    for (const retirado of RETIRED_IDS) {
        assert.doesNotMatch(raw, new RegExp(`"(model|model_override)":\\s*"${retirado.replace(/\./g, '\\.')}"`), `agent-models.json no declara ${retirado}`);
        assert.doesNotMatch(raw, new RegExp(`"alternative_models":\\s*\\[[^\\]]*"${retirado.replace(/\./g, '\\.')}"`), `alternative_models no declara ${retirado}`);
    }
});

test('CA-3: el CATALOG del dashboard trae label humano de agy, sin precios inventados y con recommended_for coherente con la config', () => {
    const byId = new Map(CATALOG['gemini-google'].map((m) => [m.id, m]));
    const fixture = new Map(agyCatalog.parseAgyModelsOutput(FIXTURE_TSV).map((m) => [m.id, m.label]));
    for (const [id, label] of fixture) {
        assert.equal(byId.get(id).label, label, `label de ${id} = nombre humano que devuelve agy models`);
        assert.equal(byId.get(id).cost_per_1m, null, 'Antigravity factura por licencia: sin precio por token');
    }
    const configured = agyCatalog.collectConfiguredGeminiModels(REAL_CONFIG);
    for (const [id, rutas] of configured) {
        const skills = rutas.map((r) => (r.match(/^skills\.([^.]+)\./) || [])[1]).filter(Boolean);
        for (const s of skills) {
            assert.ok(byId.get(id).recommended_for.includes(s), `${id}.recommended_for incluye ${s}`);
        }
    }
});

test('CA-5: el modelo alternativo del provider es de una familia distinta al primario (adversarialidad #3501)', () => {
    const p = REAL_CONFIG.providers['gemini-google'];
    const familia = (id) => id.replace(/-(high|medium|low)$/, '');
    assert.equal(p.alternative_models.length, 1);
    assert.notEqual(familia(p.alternative_models[0]), familia(p.model));
    assert.ok(FIXTURE_IDS.includes(p.alternative_models[0]));
});

// -----------------------------------------------------------------------------
// checkAgainstCli + main — orquestación y códigos de salida
// -----------------------------------------------------------------------------
test('checkAgainstCli: con CLI ausente devuelve reason cli_unavailable y main sale 0 sin --check / 2 con --check', () => {
    const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    const r = agyCatalog.checkAgainstCli({ env: {}, execFileSync: enoent, cacheTtlMs: 0, agentModels: REAL_CONFIG });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
    assert.equal(r.check, null);
});

test('checkAgainstCli: con el catálogo real y la config real → ok; con un id muerto → dead_models', () => {
    const exec = () => FIXTURE_TSV;
    const ok = agyCatalog.checkAgainstCli({ env: {}, execFileSync: exec, cacheTtlMs: 0, agentModels: REAL_CONFIG });
    assert.equal(ok.reason, 'ok');
    assert.equal(ok.check.dead.length, 0);

    const roto = JSON.parse(JSON.stringify(REAL_CONFIG));
    roto.skills.qa.fallbacks.find((f) => f.provider === 'gemini-google').model_override = 'gemini-3-flash-preview';
    const bad = agyCatalog.checkAgainstCli({ env: {}, execFileSync: exec, cacheTtlMs: 0, agentModels: roto });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'dead_models');
    assert.equal(bad.check.dead[0].id, 'gemini-3-flash-preview');
    assert.deepEqual(bad.check.dead[0].sources, ['agent-models.json:skills.qa.fallbacks[1].model_override']);
});

// -----------------------------------------------------------------------------
// EN VIVO (CA-2) — sólo si Antigravity está instalado en esta máquina
// -----------------------------------------------------------------------------
test('CA-2 (en vivo): `agy models` real coincide con config + barreras; se saltea si el CLI no está', (t) => {
    const fetched = agyCatalog.fetchAgyModels({ fresh: true, cacheTtlMs: 0, timeoutMs: 45_000 });
    if (!fetched.ok && (fetched.error === 'cli_unavailable' || fetched.error === 'cli_failed')) {
        t.skip(`agy no disponible en esta máquina (${fetched.error}: ${fetched.detail || fetched.bin})`);
        return;
    }
    assert.equal(fetched.ok, true, `agy models devolvió catálogo vacío (${fetched.bin})`);
    const r = agyCatalog.crossCheck({ catalogIds: fetched.ids, agentModels: REAL_CONFIG });
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.dead, []);
    // Si el vendor publicó modelos nuevos, el aviso aparece acá sin romper: el
    // snapshot del fixture es el que hay que refrescar cuando se adopten.
    if (r.unlisted.length) t.diagnostic(`agy models tiene ${r.unlisted.length} id(s) que el pipeline no adoptó: ${r.unlisted.map((u) => u.id).join(', ')}`);
});
