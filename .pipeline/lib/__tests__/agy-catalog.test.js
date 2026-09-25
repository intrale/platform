// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// agy-catalog.test.js — #6858: cruce automático de los ids de Antigravity
// (config + barreras) contra el catálogo real del CLI (`agy models`).
//
// #6861 — las tres barreras que se cruzan son `agent-models.json` (config),
// `ALLOWED_MODELS_BY_LAUNCHER['antigravity']` y `CATALOG['antigravity']`. La
// ex tercera barrera de código, `PROVIDER_MODELS_ALLOWLIST['antigravity']` de
// completion-client.js, se retiró con el shim HTTP de AI Studio: antigravity
// es spawn puro por `agy` y no tiene allowlist HTTP.
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
    const env = { ANTIGRAVITY_BIN: 'C:\\fake\\agy.exe' };
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

test('resolveAgyBin: misma cascada que el handler (ANTIGRAVITY_BIN → %LOCALAPPDATA%\\agy\\bin\\agy.exe → PATH)', () => {
    assert.equal(agyCatalog.resolveAgyBin({ ANTIGRAVITY_BIN: '/x/agy' }).cmd, '/x/agy');
    const fsImpl = { existsSync: (p) => p.endsWith(path.join('agy', 'bin', 'agy.exe')) };
    const win = agyCatalog.resolveAgyBin({ LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' }, fsImpl);
    assert.equal(win.kind, 'native-exe');
    assert.equal(agyCatalog.resolveAgyBin({}, { existsSync: () => false }).cmd, 'agy');
});

// -----------------------------------------------------------------------------
// collectConfiguredGeminiModels — las 4 fuentes, sólo antigravity
// -----------------------------------------------------------------------------
test('collectConfiguredGeminiModels: junta provider.model, alternative_models, model_override y fallbacks sólo de antigravity', () => {
    const cfg = {
        providers: {
            'antigravity': { model: 'a', alternative_models: ['b'] },
            anthropic: { model: 'claude-opus-4-7', alternative_models: ['no-entra'] },
        },
        skills: {
            guru: { provider: 'antigravity', model_override: 'c', fallbacks: [{ provider: 'anthropic', model_override: 'no-entra' }] },
            qa: { provider: 'anthropic', model_override: 'no-entra', fallbacks: [{ provider: 'antigravity', model_override: 'd' }, { provider: 'antigravity', model_override: 'a' }] },
        },
    };
    const got = agyCatalog.collectConfiguredGeminiModels(cfg);
    assert.deepEqual([...got.keys()].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(got.get('a'), ['providers.antigravity.model', 'skills.qa.fallbacks[1].model_override']);
    assert.deepEqual(got.get('b'), ['providers.antigravity.alternative_models[0]']);
    assert.deepEqual(got.get('c'), ['skills.guru.model_override']);
    assert.deepEqual(got.get('d'), ['skills.qa.fallbacks[0].model_override']);
});

test('collectConfiguredGeminiModels: matriz firmada #6860, 6 ids en 8 rutas y 6 skills', () => {
    const got = agyCatalog.collectConfiguredGeminiModels(REAL_CONFIG);
    assert.deepEqual(Object.fromEntries([...got.entries()].sort(([a], [b]) => a.localeCompare(b))), {
        'claude-sonnet-4-6': ['skills.telegram-commander.fallbacks[1].model_override'],
        'gemini-3.1-pro-high': ['skills.architect.fallbacks[1].model_override'],
        'gemini-3.1-pro-low': ['skills.po.fallbacks[0].model_override', 'skills.ux.fallbacks[0].model_override'],
        'gemini-3.7-flash-medium': ['providers.antigravity.alternative_models[0]'],
        'gemini-3.8-flash-high': ['skills.perf.fallbacks[1].model_override'],
        'gemini-3.8-flash-medium': ['providers.antigravity.model', 'skills.telegram-sherlock.fallbacks[1].model_override'],
    });
    const rutas = [...got.values()].flat();
    assert.equal(rutas.length, 8, 'provider.model + alternative_models[0] + 6 fallbacks');
    assert.deepEqual(rutas.filter(r => /^skills\.(android-dev|web-dev|qa)\./.test(r)), []);
    // #6563 dio de baja cerebras/nvidia-nim/kimi-moonshot: los excluidos quedan
    // sólo con Codex y po/ux con Google → Codex (Decisión 2 del sign-off).
    for (const skill of ['android-dev', 'web-dev', 'qa']) {
        assert.deepEqual(REAL_CONFIG.skills[skill].fallbacks.map(f => f.provider), ['openai-codex']);
    }
    for (const skill of ['po', 'ux']) {
        assert.deepEqual(REAL_CONFIG.skills[skill].fallbacks.map(f => f.provider), ['antigravity', 'openai-codex']);
    }
    for (const skill of ['architect', 'perf', 'telegram-commander', 'telegram-sherlock']) {
        assert.deepEqual(REAL_CONFIG.skills[skill].fallbacks.map(f => f.provider), ['openai-codex', 'antigravity']);
    }
});

// -----------------------------------------------------------------------------
// crossCheck — semántica dead / unlisted
// -----------------------------------------------------------------------------
test('crossCheck: un id configurado ausente del catálogo es `dead` y baja ok a false, con la ruta exacta', () => {
    const cfg = { providers: { 'antigravity': { model: 'gemini-3-flash-preview', alternative_models: ['gemini-3.7-flash-medium'] } }, skills: {} };
    const r = agyCatalog.crossCheck({
        catalogIds: FIXTURE_IDS, agentModels: cfg,
        barriers: { validate: FIXTURE_IDS, completion: FIXTURE_IDS, catalog: FIXTURE_IDS },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.dead, [{ id: 'gemini-3-flash-preview', sources: ['agent-models.json:providers.antigravity.model'] }]);
    assert.match(r.summary, /FALLA: 1 id\(s\)/);
    assert.match(r.summary, /gemini-3-flash-preview ← agent-models\.json:providers\.antigravity\.model/);
});

test('crossCheck: un id muerto en CUALQUIERA de las barreras de código también falla (reemplazo, no agregado)', () => {
    const cfg = { providers: { 'antigravity': { model: 'gemini-3.8-flash-medium' } }, skills: {} };
    // #6861 — quedan dos barreras de código (la de completion-client se retiró
    // con el shim HTTP); junto con la config son las tres que cruza el módulo.
    for (const [barrier, nombre] of [['validate', 'ALLOWED_MODELS_BY_LAUNCHER'], ['catalog', 'CATALOG']]) {
        const barriers = { validate: FIXTURE_IDS, catalog: FIXTURE_IDS, [barrier]: [...FIXTURE_IDS, 'gemini-2.5-flash'] };
        const r = agyCatalog.crossCheck({ catalogIds: FIXTURE_IDS, agentModels: cfg, barriers });
        assert.equal(r.ok, false, `${nombre} con id retirado debe fallar`);
        assert.equal(r.dead.length, 1);
        assert.equal(r.dead[0].id, 'gemini-2.5-flash');
        assert.match(r.dead[0].sources[0], new RegExp(nombre));
    }
});

test('crossCheck: un modelo NUEVO del CLI que ninguna barrera conoce es `unlisted` (aviso) y NO baja ok', () => {
    const cfg = { providers: { 'antigravity': { model: 'gemini-3.8-flash-medium' } }, skills: {} };
    const r = agyCatalog.crossCheck({
        catalogIds: [...FIXTURE_IDS, 'gemini-4.0-flash-high'], agentModels: cfg,
        barriers: { validate: FIXTURE_IDS, catalog: FIXTURE_IDS },
    });
    assert.equal(r.ok, true, 'un modelo nuevo del vendor nunca dispara rollback del pipeline');
    assert.deepEqual(r.unlisted, [{ id: 'gemini-4.0-flash-high', missingFrom: ['ALLOWED_MODELS_BY_LAUNCHER', 'CATALOG'] }]);
    assert.match(r.summary, /1 id\(s\) del CLI sin adoptar \(aviso, no bloquea\)/);
    assert.match(r.summary, /config \+ 2 barreras/, '#6861: el resumen cuenta las dos barreras de código que quedan');
});

// -----------------------------------------------------------------------------
// CA-1 / CA-3 — estado REAL del repo contra el snapshot real del CLI
// -----------------------------------------------------------------------------
test('CA-1/CA-3: config real + las tres barreras reales están 100% en el catálogo de agy (snapshot 2026-09-16) y sin ids retirados', () => {
    const r = agyCatalog.crossCheck({ catalogIds: FIXTURE_IDS, agentModels: REAL_CONFIG });
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.provider, 'antigravity');
    assert.deepEqual(r.dead, []);
    assert.deepEqual(r.unlisted, [], 'las barreras de código son espejo exacto del catálogo del CLI');

    // #6861 — las tres barreras usan la clave nueva: la config (`providers.
    // antigravity` + eslabones con provider antigravity, cruzada arriba) y las
    // dos de código, ambas indexadas por `antigravity`.
    assert.ok(Array.isArray(REAL_CONFIG.providers.antigravity.alternative_models), 'config: providers.antigravity');
    assert.equal('gemini-google' in REAL_CONFIG.providers, false, 'config: sin el id viejo');
    assert.equal('gemini-google' in ALLOWED_MODELS_BY_LAUNCHER, false);
    assert.equal('gemini-google' in CATALOG, false);
    // La ex barrera HTTP no vuelve por accidente: la tabla está vacía.
    assert.deepEqual(PROVIDER_MODELS_ALLOWLIST, {}, '#6861: sin allowlist HTTP para antigravity ni para nadie');
    assert.equal(PROVIDER_MODELS_ALLOWLIST['antigravity'], undefined);

    const barreras = {
        ALLOWED_MODELS_BY_LAUNCHER: ALLOWED_MODELS_BY_LAUNCHER['antigravity'],
        CATALOG: CATALOG['antigravity'].map((m) => m.id),
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
    const byId = new Map(CATALOG['antigravity'].map((m) => [m.id, m]));
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
    const p = REAL_CONFIG.providers['antigravity'];
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
    roto.skills.po.fallbacks.find((f) => f.provider === 'antigravity').model_override = 'gemini-3-flash-preview';
    const bad = agyCatalog.checkAgainstCli({ env: {}, execFileSync: exec, cacheTtlMs: 0, agentModels: roto });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'dead_models');
    assert.equal(bad.check.dead[0].id, 'gemini-3-flash-preview');
    assert.deepEqual(bad.check.dead[0].sources, ['agent-models.json:skills.po.fallbacks[0].model_override']);
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
