// =============================================================================
// Tests #4327 (CA-4) — bloque de cuota servido por `/api/state`
// (`lib/quota-state-block.buildQuotaStateBlock`).
//
// Cubre:
//   CA-4 — el bloque está poblado (providers por proveedor) con un timestamp
//          reciente (`snapshotAt`) y estado explícito (`state`).
//   Seguridad req#2 — el JSON servido NO contiene `account_handle` NI ninguna
//          clave de identidad (`handle|email|account|token|secret|password`),
//          incluso cuando el snapshot en disco SÍ trae `account_handle` crudo
//          (se verifica el paso por la allowlist `sanitizeSnapshotForOutput`).
//   CA-3 — la lista de proveedores no incluye el fantasma `groq`.
//   CA-5 — fail-closed: sin snapshot → estado `missing`, providers igual listados
//          (nunca número viejo/0 presentado como fresco).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDENTITY_KEY_RE = /handle|email|account|token|secret|password/i;

function freshBlock() {
    delete require.cache[require.resolve('../quota-state-block')];
    delete require.cache[require.resolve('../quota-snapshot-integration')];
    delete require.cache[require.resolve('../dashboard-slices')];
    return require('../quota-state-block');
}

function mkTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-4327-'));
    const pipeline = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipeline, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    // agent-models.json real (sin groq, sin deterministic filtrado en la vista).
    fs.writeFileSync(path.join(pipeline, 'agent-models.json'), JSON.stringify({
        providers: {
            anthropic: {}, 'openai-codex': {}, 'gemini-google': {},
            cerebras: {}, 'nvidia-nim': {}, deterministic: {},
        },
    }));
    return { root, pipeline };
}

function withEnv(overrides, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(overrides)) {
        prev[k] = process.env[k];
        if (v == null) delete process.env[k]; else process.env[k] = v;
    }
    try { return fn(); }
    finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v == null) delete process.env[k]; else process.env[k] = v;
        }
    }
}

// ---------------------------------------------------------------------------
// CA-5 — fail-closed: sin snapshot en disco → estado 'missing', pero providers
// igual se listan (nunca vacío que lea como "todo OK").
// ---------------------------------------------------------------------------
test('CA-5: sin snapshot → estado missing con providers listados (fail-closed)', () => {
    const { pipeline, root } = mkTmpPipeline();
    const { buildQuotaStateBlock } = freshBlock();
    const block = withEnv({ PIPELINE_DIR_OVERRIDE: pipeline, QUOTA_SNAPSHOT_ENABLED: null }, () =>
        buildQuotaStateBlock({ PIPELINE: pipeline, ROOT: root }));

    assert.equal(block.state, 'missing', 'sin .quota-history.jsonl → missing');
    assert.equal(block.lastSnapshot, null, 'sin snapshot fresco → lastSnapshot null (no dato viejo)');
    assert.ok(Object.keys(block.providers).length > 0, 'providers se listan aunque falte snapshot');
});

// ---------------------------------------------------------------------------
// CA-4 — bloque poblado con timestamp reciente.
// ---------------------------------------------------------------------------
test('CA-4: bloque poblado con snapshotAt reciente y providers por proveedor', () => {
    const { pipeline, root } = mkTmpPipeline();
    const { buildQuotaStateBlock } = freshBlock();
    const before = Date.now();
    const block = withEnv({ PIPELINE_DIR_OVERRIDE: pipeline }, () =>
        buildQuotaStateBlock({ PIPELINE: pipeline, ROOT: root }));
    const after = Date.now();

    assert.ok(Number.isFinite(block.snapshotAt), 'snapshotAt es numérico');
    assert.ok(block.snapshotAt >= before && block.snapshotAt <= after, 'snapshotAt es reciente');
    // Cada provider expone SOLO el shape mínimo {provider, adapterStatus, session, weekly}.
    for (const [p, v] of Object.entries(block.providers)) {
        assert.deepEqual(Object.keys(v).sort(), ['adapterStatus', 'provider', 'session', 'weekly'],
            `${p} expone solo el shape mínimo`);
        for (const bucket of ['session', 'weekly']) {
            assert.deepEqual(Object.keys(v[bucket]).sort(), ['confidence', 'pct'],
                `${p}.${bucket} expone solo {pct, confidence}`);
        }
    }
});

// ---------------------------------------------------------------------------
// CA-3 — sin provider fantasma `groq`.
// ---------------------------------------------------------------------------
test('CA-3: la lista de providers del bloque NO incluye groq', () => {
    const { pipeline, root } = mkTmpPipeline();
    const { buildQuotaStateBlock } = freshBlock();
    const block = withEnv({ PIPELINE_DIR_OVERRIDE: pipeline }, () =>
        buildQuotaStateBlock({ PIPELINE: pipeline, ROOT: root }));
    assert.ok(!Object.keys(block.providers).includes('groq'), 'groq (descontinuado #3353) no debe aparecer');
    // Los 5 proveedores reales presentes.
    for (const p of ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']) {
        assert.ok(p in block.providers, `${p} presente`);
    }
});

// ---------------------------------------------------------------------------
// Seguridad req#2 — regresión OBLIGATORIA: aunque el snapshot en disco traiga
// `account_handle` crudo, el bloque servido NO lo filtra (allowlist).
// ---------------------------------------------------------------------------
test('SEC: snapshot con account_handle en disco → el bloque NO lo filtra', () => {
    const { pipeline, root } = mkTmpPipeline();
    // Snapshot "sucio": incluye PII y campos de identidad que NUNCA deben salir.
    const dirtySnap = {
        ts: new Date().toISOString(),               // fresco → estado 'fresh'
        weekly_all_models_pct: 24, weekly_sonnet_pct: 12, weekly_design_pct: 3,
        session_pct: 6, session_minutes_to_reset: 120,
        daily_routines_used: 2, daily_routines_max: 15,
        api_overage_used_usd: 0, api_overage_cap_usd: 50,
        parse_confidence: 0.9,
        account_handle: 'leito@example.com',        // PII: debe desaparecer
        account_email: 'secret@intrale.com',
        api_token: 'sk-SECRET-TOKEN-123',
    };
    fs.writeFileSync(path.join(pipeline, '.quota-history.jsonl'), JSON.stringify(dirtySnap) + '\n');

    const { buildQuotaStateBlock } = freshBlock();
    const block = withEnv({ PIPELINE_DIR_OVERRIDE: pipeline }, () =>
        buildQuotaStateBlock({ PIPELINE: pipeline, ROOT: root }));

    // El snapshot se leyó (estado no-missing) y trae los pct numéricos sanos.
    assert.notEqual(block.state, 'missing', 'con snapshot fresco el estado NO es missing');
    assert.ok(block.lastSnapshot && typeof block.lastSnapshot === 'object', 'lastSnapshot poblado');
    assert.equal(block.lastSnapshot.weekly_all_models_pct, 24, 'los pct sanitizados sí viajan');

    // Ninguna clave de identidad sobrevive en el JSON del bloque completo.
    const json = JSON.stringify(block);
    assert.ok(!json.includes('account_handle'), 'account_handle NUNCA debe aparecer');
    assert.ok(!json.includes('leito@example.com'), 'el valor de account_handle no debe filtrarse');
    assert.ok(!json.includes('secret@intrale.com'), 'account_email no debe filtrarse');
    assert.ok(!json.includes('sk-SECRET-TOKEN-123'), 'api_token no debe filtrarse');
    // Barrido por regex de claves de identidad sobre las claves del lastSnapshot.
    for (const k of Object.keys(block.lastSnapshot)) {
        assert.ok(!IDENTITY_KEY_RE.test(k), `lastSnapshot no debe exponer la clave "${k}"`);
    }
});

// ---------------------------------------------------------------------------
// Defensa: el compositor es fail-closed ante fuentes rotas (no throw).
// ---------------------------------------------------------------------------
test('fail-closed: fuentes que lanzan → bloque missing sin providers, sin throw', () => {
    const { buildQuotaStateBlock } = freshBlock();
    const boom = { getBannerState() { throw new Error('boom'); } };
    const boomSlices = { quotaSlice() { throw new Error('boom'); } };
    const block = buildQuotaStateBlock({ PIPELINE: '/nope', ROOT: '/nope' },
        { integration: boom, slices: boomSlices, now: () => 4327 });
    assert.equal(block.state, 'missing');
    assert.equal(block.snapshotAt, 4327);
    assert.deepEqual(block.providers, {});
    assert.equal(block.lastSnapshot, null);
});
