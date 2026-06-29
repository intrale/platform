// =============================================================================
// provider-quota-guard.test.js — #4282
//
// Cubre los criterios de aceptación verificables del guard anticipatorio de
// cuota por proveedor + su consumo en el dispatcher de fallbacks.
//
//   CA-1  — umbral cruzado con confidence==='fresh' → alerta (Telegram FS + banner).
//   CA-2  — dato stale/missing → NO actúa (ni alerta ni switch).
//   CA-3  — umbrales configurables vía config.yaml (no ENV, no hardcode).
//   CA-4  — config inválida → fallback seguro, no rompe (REQ-SEC-2).
//   CA-5  — switch off → solo alerta; switch on + fresh → marca degradación.
//   CA-6  — degradación consumida por resolveSpawnWithFallback; chain nunca vacía (REQ-SEC-3).
//   CA-7  — precedencia: el soft preventivo NO fuerza ni colisiona con el hard gate.
//   CA-8  — anti-flapping/histéresis: una alerta por cruce, reset al volver a ok.
//   CA-9  — la alerta no contiene patrones de secreto (REQ-SEC-1).
//   CA-10 — la degradación preventiva es auditable (log provider/pct/umbral/confidence).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../provider-quota-guard');
const {
    resolveSpawnWithFallback,
} = require('../agent-launcher/dispatch-with-fallback');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function setupTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pqg-test-'));
}
function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function bucket(pct, confidence) {
    return { pct, confidence };
}

// Slice con un solo proveedor/ventana relevante; el resto "missing".
function sliceFor(provider, window, pct, confidence) {
    const p = {
        provider,
        adapterStatus: 'ok',
        session: { pct: null, confidence: 'missing' },
        weekly: { pct: null, confidence: 'missing' },
    };
    p[window] = bucket(pct, confidence);
    return { providers: { [provider]: p } };
}

// Sender Telegram fake que captura los textos.
function fakeSender() {
    const texts = [];
    const fn = (t) => { texts.push(t); };
    fn.texts = texts;
    return fn;
}

// Config con defaults estándar.
function cfg({ warn = 80, crit = 95, switchOn = false, ttl = 90 } = {}) {
    return {
        providers: {},
        defaults: { warn, crit },
        preventiveSwitchEnabled: switchOn,
        markerTtlMin: ttl,
    };
}

// -----------------------------------------------------------------------------
// CA-3 / CA-4 — loadGuardConfig (validación fail-safe)
// -----------------------------------------------------------------------------

test('CA-3: loadGuardConfig consume umbrales por proveedor desde config.yaml', () => {
    const raw = {
        multi_provider: {
            quota_alert: {
                defaults: { warn: 80, crit: 95 },
                anthropic: { warn: 70, crit: 90 },
                preventive_switch: { enabled: true, marker_ttl_minutes: 30 },
            },
        },
    };
    const c = guard.loadGuardConfig(raw);
    assert.deepEqual(c.providers.anthropic, { warn: 70, crit: 90 });
    assert.deepEqual(c.defaults, { warn: 80, crit: 95 });
    assert.equal(c.preventiveSwitchEnabled, true);
    assert.equal(c.markerTtlMin, 30);
});

test('CA-4: config inválida → defaults conservadores + no lanza (REQ-SEC-2)', () => {
    const logs = [];
    const log = (m) => logs.push(m);
    // warn > crit, crit > 100, no numérico → todos inválidos.
    const raw = {
        multi_provider: {
            quota_alert: {
                anthropic: { warn: 120, crit: 50 },
                'openai-codex': { warn: 'x', crit: 95 },
                'gemini-google': { warn: 80, crit: 150 },
                preventive_switch: { enabled: 'yes' }, // no es `true` literal → off
            },
        },
    };
    let c;
    assert.doesNotThrow(() => { c = guard.loadGuardConfig(raw, { log }); });
    assert.deepEqual(c.providers, {}, 'ningún umbral inválido se acepta');
    assert.deepEqual(c.defaults, { warn: 80, crit: 95 }, 'cae a defaults internos');
    assert.equal(c.preventiveSwitchEnabled, false, "enabled solo con `true` literal");
    assert.ok(logs.length >= 3, 'loggea cada anomalía');
});

test('CA-4: rawConfig basura (null/array/string) → no lanza, defaults', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { multi_provider: 7 }]) {
        let c;
        assert.doesNotThrow(() => { c = guard.loadGuardConfig(bad); });
        assert.equal(c.preventiveSwitchEnabled, false);
        assert.equal(c.defaults.warn, 80);
    }
});

test('validThresholdPair valida 0 < warn < crit <= 100', () => {
    assert.deepEqual(guard.validThresholdPair({ warn: 80, crit: 95 }), { warn: 80, crit: 95 });
    assert.equal(guard.validThresholdPair({ warn: 0, crit: 95 }), null);
    assert.equal(guard.validThresholdPair({ warn: 95, crit: 80 }), null);
    assert.equal(guard.validThresholdPair({ warn: 80, crit: 101 }), null);
    assert.equal(guard.validThresholdPair({ warn: 80 }), null);
    assert.equal(guard.validThresholdPair(null), null);
});

// -----------------------------------------------------------------------------
// CA-1 — alerta anticipada con dato fresco
// -----------------------------------------------------------------------------

test('CA-1: umbral warn cruzado con confidence fresh → alerta + banner', () => {
    const send = fakeSender();
    const res = guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 85, 'fresh'),
        config: cfg(),
        sendTelegram: send,
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
        now: 1000,
    });
    assert.equal(res.alerts.length, 1);
    assert.equal(res.alerts[0].level, 'warn');
    assert.ok(res.banner && res.banner.active);
    assert.equal(res.banner.provider, 'anthropic');
    assert.equal(res.banner.window, 'weekly');
    assert.equal(res.banner.level, 'warn');
    assert.equal(res.banner.pct, 85);
    assert.equal(res.degraded.length, 0, 'switch off → no degrada');
    assert.match(send.texts[0], /85%/);
    assert.match(send.texts[0], /🟡/);
});

test('CA-1: alerta se encola en el FS-queue de Telegram (default sender)', () => {
    const tmp = setupTmp();
    try {
        guard.evaluate({
            slice: sliceFor('anthropic', 'weekly', 96, 'fresh'),
            config: cfg(),
            pipelineDir: tmp,
            now: 1000,
        });
        const qdir = path.join(tmp, 'servicios', 'telegram', 'pendiente');
        const files = fs.readdirSync(qdir);
        assert.equal(files.length, 1, 'un archivo encolado');
        const payload = JSON.parse(fs.readFileSync(path.join(qdir, files[0]), 'utf8'));
        assert.match(payload.text, /96%/);
        assert.equal(payload.parse_mode, 'Markdown');
    } finally {
        teardownTmp(tmp);
    }
});

// -----------------------------------------------------------------------------
// CA-2 — gate de integridad: stale/missing no actúa
// -----------------------------------------------------------------------------

test('CA-2: dato stale → NO alerta, NO banner, NO degrada', () => {
    const send = fakeSender();
    for (const conf of ['stale', 'missing', 'parser-offline', undefined]) {
        const res = guard.evaluate({
            slice: sliceFor('anthropic', 'weekly', 99, conf),
            config: cfg({ switchOn: true }),
            sendTelegram: send,
            state: { providers: {}, banner: null },
            marker: { degraded: {} },
            persist: false,
        });
        assert.equal(res.alerts.length, 0, `conf=${conf} no alerta`);
        assert.equal(res.degraded.length, 0, `conf=${conf} no degrada`);
        assert.equal(res.banner, null, `conf=${conf} no banner`);
    }
    assert.equal(send.texts.length, 0);
});

// -----------------------------------------------------------------------------
// CA-5 — switch off solo alerta; switch on + fresh marca degradación
// -----------------------------------------------------------------------------

test('CA-5: switch OFF + crit fresh → alerta pero NO degrada', () => {
    const res = guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 97, 'fresh'),
        config: cfg({ switchOn: false }),
        sendTelegram: fakeSender(),
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
    });
    assert.equal(res.alerts[0].level, 'crit');
    assert.equal(res.degraded.length, 0);
    assert.deepEqual(res.marker.degraded, {});
});

test('CA-5/CA-10: switch ON + crit fresh → marca degradación auditable', () => {
    const logs = [];
    const res = guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 97, 'fresh'),
        config: cfg({ switchOn: true, ttl: 90 }),
        sendTelegram: fakeSender(),
        log: (m) => logs.push(m),
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
        now: 5000,
    });
    assert.deepEqual(res.degraded, ['anthropic']);
    const entry = res.marker.degraded.anthropic;
    assert.ok(entry, 'marker escrito');
    assert.equal(entry.window, 'weekly');
    assert.equal(entry.threshold, 95);
    assert.equal(entry.expiresAt, 5000 + 90 * 60 * 1000);
    // CA-10: el log de auditoría incluye provider/pct/umbral/confidence.
    const audit = logs.find(l => /degradación preventiva/.test(l));
    assert.ok(audit, 'log de auditoría presente');
    assert.match(audit, /provider=anthropic/);
    assert.match(audit, /umbral=95/);
    assert.match(audit, /confidence=fresh/);
});

test('CA-5: warn (no crit) con switch ON → alerta pero NO degrada', () => {
    const res = guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 85, 'fresh'),
        config: cfg({ switchOn: true }),
        sendTelegram: fakeSender(),
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
    });
    assert.equal(res.alerts[0].level, 'warn');
    assert.equal(res.degraded.length, 0, 'solo crit degrada');
});

// -----------------------------------------------------------------------------
// CA-8 — anti-flapping / histéresis
// -----------------------------------------------------------------------------

test('CA-8: una sola alerta por cruce; no re-alerta dentro de la banda', () => {
    const send = fakeSender();
    let state = { providers: {}, banner: null };
    let marker = { degraded: {} };
    const opts = (pct) => ({
        slice: sliceFor('anthropic', 'weekly', pct, 'fresh'),
        config: cfg({ switchOn: true }),
        sendTelegram: send,
        state, marker, persist: false, now: 1,
    });

    // 1) ok → warn: alerta warn.
    let r = guard.evaluate(opts(85)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 1);

    // 2) warn → warn (mismo nivel): sin nueva alerta.
    r = guard.evaluate(opts(86)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 1, 'no re-alerta mismo nivel');

    // 3) warn → crit (escala): nueva alerta crit.
    r = guard.evaluate(opts(96)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 2);
    assert.equal(r.alerts[0].level, 'crit');

    // 4) crit → warn (baja dentro de banda, NO ok): sin alerta y el marker
    //    sigue (no oscila a fallback).
    r = guard.evaluate(opts(85)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 2, 'banda muerta: no re-alerta al bajar a warn');
    assert.ok(marker.degraded.anthropic, 'marker persiste en la banda');

    // 5) warn → crit otra vez: sin nueva alerta (high-water-mark sigue crit).
    r = guard.evaluate(opts(97)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 2, 'no re-alerta crit dentro del high-water-mark');

    // 6) recuperación a ok: reset + banner limpio + marker removido.
    r = guard.evaluate(opts(10)); state = r.state; marker = r.marker;
    assert.ok(r.cleared.includes('anthropic:weekly'));
    assert.equal(state.banner, null, 'banner se autolimpia en ok');
    assert.equal(marker.degraded.anthropic, undefined, 'marker removido en ok');

    // 7) nuevo cruce a warn después de recuperar: vuelve a alertar.
    r = guard.evaluate(opts(85)); state = r.state; marker = r.marker;
    assert.equal(send.texts.length, 3, 'tras reset, un nuevo cruce re-alerta');
});

// -----------------------------------------------------------------------------
// CA-9 — sin fuga de secretos (REQ-SEC-1)
// -----------------------------------------------------------------------------

test('CA-9: la alerta no contiene patrones de secreto', () => {
    const send = fakeSender();
    guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 96, 'fresh'),
        config: cfg({ switchOn: true }),
        sendTelegram: send,
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
    });
    const text = send.texts[0];
    assert.equal(guard.containsSecret(text), false);
    // Patrones explícitos del REQ-SEC-1.
    assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/);
    assert.doesNotMatch(text, /Bearer\s+/i);
    assert.doesNotMatch(text, /api[_-]?key/i);
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9._-]{20,}/);
});

test('containsSecret detecta patrones conocidos (sanity)', () => {
    assert.equal(guard.containsSecret('AKIAABCDEFGHIJKLMNOP'), true);
    assert.equal(guard.containsSecret('Authorization: Bearer abc.def'), true);
    assert.equal(guard.containsSecret('my api_key here'), true);
    assert.equal(guard.containsSecret('todo bien, 96% semanal'), false);
});

// -----------------------------------------------------------------------------
// isPreventivelyDegraded + persistencia
// -----------------------------------------------------------------------------

test('isPreventivelyDegraded: lee marker vigente y respeta TTL', () => {
    const tmp = setupTmp();
    try {
        guard.evaluate({
            slice: sliceFor('anthropic', 'weekly', 97, 'fresh'),
            config: cfg({ switchOn: true, ttl: 90 }),
            sendTelegram: fakeSender(),
            pipelineDir: tmp,
            now: 1000,
        });
        // marker persistido en disco.
        assert.ok(fs.existsSync(guard.markerFile(tmp)));
        assert.equal(guard.isPreventivelyDegraded('anthropic', { pipelineDir: tmp, now: 2000 }), true);
        // Otro provider no degradado.
        assert.equal(guard.isPreventivelyDegraded('openai-codex', { pipelineDir: tmp, now: 2000 }), false);
        // Expirado.
        const expired = 1000 + 90 * 60 * 1000 + 1;
        assert.equal(guard.isPreventivelyDegraded('anthropic', { pipelineDir: tmp, now: expired }), false);
    } finally {
        teardownTmp(tmp);
    }
});

test('isPreventivelyDegraded: fail-open ante marker ausente/corrupto', () => {
    const tmp = setupTmp();
    try {
        assert.equal(guard.isPreventivelyDegraded('anthropic', { pipelineDir: tmp }), false);
        fs.writeFileSync(guard.markerFile(tmp), '{corrupto', 'utf8');
        assert.equal(guard.isPreventivelyDegraded('anthropic', { pipelineDir: tmp }), false);
    } finally {
        teardownTmp(tmp);
    }
});

test('readBanner: read-only del estado vigente', () => {
    const tmp = setupTmp();
    try {
        assert.deepEqual(guard.readBanner({ pipelineDir: tmp }), { active: false });
        guard.evaluate({
            slice: sliceFor('anthropic', 'weekly', 96, 'fresh'),
            config: cfg(),
            pipelineDir: tmp,
        });
        const b = guard.readBanner({ pipelineDir: tmp });
        assert.equal(b.active, true);
        assert.equal(b.provider, 'anthropic');
        assert.equal(b.level, 'crit');
        // shape mínimo: sin campos extra de auth.
        assert.deepEqual(Object.keys(b).sort(), ['active', 'confidence', 'level', 'pct', 'provider', 'window']);
    } finally {
        teardownTmp(tmp);
    }
});

test('loadState/loadMarker: archivo corrupto → default sin lanzar', () => {
    const tmp = setupTmp();
    try {
        fs.writeFileSync(guard.stateFile(tmp), '{nope', 'utf8');
        fs.writeFileSync(guard.markerFile(tmp), 'not json', 'utf8');
        assert.deepEqual(guard.loadState(tmp), { providers: {}, banner: null });
        assert.deepEqual(guard.loadMarker(tmp), { degraded: {} });
        // round-trip de saveState/saveMarker.
        guard.saveState(tmp, { providers: { 'x:weekly': { rank: 1, level: 'warn' } }, banner: null });
        assert.equal(guard.loadState(tmp).providers['x:weekly'].level, 'warn');
    } finally {
        teardownTmp(tmp);
    }
});

test('evaluate: entradas no-objeto en el slice se ignoran sin romper', () => {
    const slice = { providers: { anthropic: null, 'openai-codex': 7, gemini: { weekly: 'x' } } };
    let r;
    assert.doesNotThrow(() => {
        r = guard.evaluate({ slice, config: cfg(), persist: false, sendTelegram: fakeSender() });
    });
    assert.equal(r.alerts.length, 0);
});

test('thresholdsFor: usa umbral por proveedor cuando existe, si no defaults', () => {
    const c = { providers: { anthropic: { warn: 70, crit: 90 } }, defaults: { warn: 80, crit: 95 } };
    assert.deepEqual(guard.thresholdsFor('anthropic', c), { warn: 70, crit: 90 });
    assert.deepEqual(guard.thresholdsFor('openai-codex', c), { warn: 80, crit: 95 });
    // classify respeta el umbral resuelto.
    assert.equal(guard.classify(72, guard.thresholdsFor('anthropic', c)), 'warn');
    assert.equal(guard.classify(72, guard.thresholdsFor('openai-codex', c)), 'ok');
});

test('CA-3: rawConfig (sin config precargada) → evaluate usa los umbrales del YAML', () => {
    const send = fakeSender();
    const raw = { multi_provider: { quota_alert: { anthropic: { warn: 70, crit: 90 } } } };
    const res = guard.evaluate({
        slice: sliceFor('anthropic', 'weekly', 72, 'fresh'),
        rawConfig: raw,
        sendTelegram: send,
        state: { providers: {}, banner: null },
        marker: { degraded: {} },
        persist: false,
    });
    assert.equal(res.alerts.length, 1, '72% cruza warn=70 del YAML (con default 80 sería ok)');
    assert.equal(res.alerts[0].level, 'warn');
});

test('evaluate: slice inválido → no actúa (fail-safe)', () => {
    for (const bad of [null, {}, { providers: null }, { providers: 'x' }]) {
        let r;
        assert.doesNotThrow(() => { r = guard.evaluate({ slice: bad, config: cfg(), persist: false }); });
        assert.equal(r.alerts.length, 0);
    }
});

// -----------------------------------------------------------------------------
// CA-6 / CA-7 — consumo en resolveSpawnWithFallback
// -----------------------------------------------------------------------------

const PIPELINE_DIR = '/repo/.pipeline';

function fakeFsWithAgentModels(pipelineDir, modelsObj) {
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    const files = new Map();
    files.set(modelsPath, JSON.stringify(modelsObj));
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => {
            if (files.has(p)) return files.get(p);
            const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
        },
        mkdirSync: () => {},
        writeFileSync: (p, c) => { files.set(p, c); },
    };
}
function fakeQuotaModule({ gatedProviders = [] } = {}) {
    return {
        shouldGateSpawn: (skill, { provider } = {}) => !!provider && gatedProviders.includes(provider),
        sanitizeRawExcerpt: (s) => String(s || ''),
    };
}
function fakeResolver(skill, opts) {
    const fsi = opts.fsImpl;
    const models = JSON.parse(fsi.readFileSync(path.join(opts.pipelineDir, 'agent-models.json')));
    const sk = models.skills[skill];
    const provider = sk.provider;
    const providerDef = models.providers[provider] || {};
    return { provider, model: providerDef.model, handler: { name: `${provider}-fake` }, source: 'agent-models' };
}
function fakeHandlerResolver(valid = ['anthropic', 'openai-codex', 'gemini']) {
    return (name) => {
        if (!valid.includes(name)) throw new Error(`[fake] ${name} inválido`);
        return { name: `${name}-fake` };
    };
}
function softGate(degradedProviders = []) {
    return { isPreventivelyDegraded: (p) => degradedProviders.includes(p) };
}
function baseModels() {
    return {
        defaults: { model: 'claude-opus-4-7' },
        providers: {
            anthropic: { model: 'claude-opus-4-7' },
            'openai-codex': { model: 'gpt-codex' },
            gemini: { model: 'gemini-pro' },
        },
        skills: {
            guru: { provider: 'anthropic', fallbacks: ['openai-codex'] },
            'lone-wolf': { provider: 'anthropic' },
        },
    };
}

test('CA-6: soft-gate preventivo → prefiere el fallback resoluble', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseModels());
    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: 4282,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }), // NO hard gate
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        softGateModule: softGate(['anthropic']),               // soft degrade
        auditLog: null,
        notify: () => {},
    });
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex', 'usa el fallback preventivamente');
    assert.equal(r.source, 'fallback');
    assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex']);
});

test('CA-6: soft-gate sin fallbacks → usa el primary, chain NUNCA vacía', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseModels());
    const r = resolveSpawnWithFallback({
        skill: 'lone-wolf',
        issue: 4282,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        softGateModule: softGate(['anthropic']),
        auditLog: null,
        notify: () => {},
    });
    assert.equal(r.gated, false, 'el soft NUNCA pausa');
    assert.equal(r.provider, 'anthropic', 'usa el primary (chain no se vacía)');
    assert.equal(r.softGatedPrimaryUsed, true);
    assert.deepEqual(r.chainTried, ['anthropic']);
});

test('CA-6: soft-gate con todos los fallbacks hard-gated → cae al primary', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseModels());
    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: 4282,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['openai-codex'] }), // fallback hard-gated
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        softGateModule: softGate(['anthropic']),
        auditLog: null,
        notify: () => {},
    });
    assert.equal(r.gated, false, 'soft no vacía la chain aunque el fallback esté gated');
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.softGatedPrimaryUsed, true);
});

test('CA-7: hard gate manda sobre el soft (precedencia, REQ-SEC-3)', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseModels());
    const r = resolveSpawnWithFallback({
        skill: 'lone-wolf',
        issue: 4282,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }), // hard gate
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        softGateModule: softGate(['anthropic']),                          // soft también
        auditLog: null,
        notify: () => {},
    });
    // hard gate + sin fallbacks → all-gated (el soft NO lo convierte en usable).
    assert.equal(r.gated, true, 'el hard gate pausa; el soft no lo anula');
    assert.equal(r.source, 'all-gated');
});

test('CA-7: soft-gate NO altera el happy path cuando el provider no está degradado', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseModels());
    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: 4282,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        softGateModule: softGate([]), // nada degradado
        auditLog: null,
        notify: () => {},
    });
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.source, 'agent-models');
    assert.notEqual(r.softGatedPrimaryUsed, true);
});
