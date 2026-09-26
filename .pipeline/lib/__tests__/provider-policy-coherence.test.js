// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// provider-policy-coherence.test.js — #7597 · CA-1 / CA-2 / SR-3 / SR-6
//
//   1. La matriz REAL (`agent-models.json`, primario Y cada `fallbacks[*]`)
//      coincide con la política: cero violaciones, y las únicas diferencias
//      toleradas son las registradas en `open_differences` (pendientes de
//      firma, con link al pedido).
//   2. Fixtures negativos: cada forma de divergencia hace fallar.
//   3. Drift doc ↔ JSON: la tabla de respuesta rápida y la de diferencias
//      abiertas de `docs/legal/proveedores-ia.md` dicen lo mismo que el JSON.
//   4. SR-6: ni el doc ni el JSON (repo público) llevan nombres de variables de
//      credenciales, ARNs, IDs de cuenta ni paths absolutos del operador.
//
// `now` fijo en todos los casos: el vencimiento real de los términos no puede
// romper este test (se ve en runtime: dashboard + health-cron).
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pp = require('../provider-policy');
const bce = require('../build-child-env');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'legal', 'proveedores-ia.md');
const NOW = Date.parse('2026-10-01T12:00:00Z');
const SIGN = 'https://github.com/intrale/platform/issues/6860#issuecomment-5723188265';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const realModels = () => readJson(path.join(PIPELINE_DIR, 'agent-models.json'));
const realPolicy = () => {
    const pol = pp.loadPolicy({ pipelineDir: PIPELINE_DIR });
    assert.equal(pol._loaded, true, `la política real no carga: ${JSON.stringify(pol._errors)}`);
    return pol;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function chain(cfg) {
    return [cfg.provider, ...(cfg.fallbacks || []).map((f) => (typeof f === 'string' ? f : f.provider))];
}

// ─── 1. Matriz real ──────────────────────────────────────────────────────────

test('matriz real: primario y fallbacks habilitados por la política (sin violaciones)', () => {
    const r = pp.checkMatrixCoherence(realModels(), realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
    assert.deepEqual(r.warnings, []);
});

test('matriz real: las únicas diferencias toleradas son las pendientes de firma declaradas', () => {
    const pol = realPolicy();
    const r = pp.checkMatrixCoherence(realModels(), pol, { now: NOW, pipelineDir: PIPELINE_DIR });
    const pendingPairs = [...new Set(r.pending.map((p) => `${p.provider}|${p.role}`))].sort();
    const declared = [...new Set(pol.open_differences.map((d) => `${d.provider}|${d.role}`))].sort();
    assert.deepEqual(pendingPairs, declared);
    // Casos mínimos del CA-2: po/ux→antigravity con scope github pendientes.
    // #7636 · CA-4 — architect declara `github` y suma el mismo pendiente.
    assert.deepEqual(declared, ['antigravity|architect', 'antigravity|po', 'antigravity|ux']);
    for (const d of pol.open_differences) {
        assert.equal(d.kind, 'scope_exceeded');
        assert.equal(d.scope, 'github');
        assert.match(d.request_ref, pp.SIGNOFF_REF_RE);
    }
});

test('matriz real: android-dev, web-dev y qa no rutean por antigravity y la política no los habilita', () => {
    const models = realModels();
    const pol = realPolicy();
    const agy = pol.providers.antigravity.roles_allowed.map((g) => g.role);
    for (const role of ['android-dev', 'web-dev', 'qa']) {
        assert.ok(!chain(models.skills[role]).includes('antigravity'), `${role} no debe tener eslabón antigravity`);
        assert.ok(!agy.includes(role), `${role} no debe estar habilitado en antigravity`);
        assert.equal(pp.canEnable('antigravity', role, { now: NOW, policy: pol, pipelineDir: PIPELINE_DIR }).ok, false);
    }
});

test('matriz real: architect, perf y telegram-* habilitados en antigravity con sign-off', () => {
    const pol = realPolicy();
    for (const role of ['perf', 'telegram-commander', 'telegram-sherlock']) {
        const r = pp.canEnable('antigravity', role, { now: NOW, policy: pol, pipelineDir: PIPELINE_DIR });
        assert.deepEqual(r, { ok: true, reasons: [] }, role);
    }
    // #7636 · CA-4 — architect conserva su habilitación con sign-off, pero su
    // scope `github` (nuevo) queda pendiente de firma: la ÚNICA razón es ésa y
    // está declarada en open_differences.
    const arch = pp.canEnable('antigravity', 'architect', { now: NOW, policy: pol, pipelineDir: PIPELINE_DIR });
    assert.deepEqual(arch.reasons, ['El rol architect recibe el scope github, que antigravity no tiene permitido.']);
    assert.ok(pol.open_differences.some((d) => d.provider === 'antigravity' && d.role === 'architect'
        && d.kind === 'scope_exceeded' && d.scope === 'github'));
    const tg = pol.providers.antigravity.data.telegram;
    assert.equal(tg.allowed, true);
    assert.deepEqual([...tg.roles].sort(), ['telegram-commander', 'telegram-sherlock']);
});

test('matriz real: todo proveedor de la matriz (salvo exentos) tiene entrada y viceversa', () => {
    const models = realModels();
    const pol = realPolicy();
    const matrixLlm = Object.keys(models.providers).filter((p) => !pol.exempt_providers.includes(p)).sort();
    assert.deepEqual(Object.keys(pol.providers).sort(), matrixLlm);
});

test('matriz real: con términos vencidos los pares vigentes son warning, no violación', () => {
    const r = pp.checkMatrixCoherence(realModels(), realPolicy(), {
        now: Date.parse('2031-01-01T00:00:00Z'), pipelineDir: PIPELINE_DIR,
    });
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.warnings.map((w) => w.provider).sort(), ['anthropic', 'antigravity', 'openai-codex']);
    assert.ok(r.warnings.every((w) => w.kind === 'terms_expired'));
});

// ─── 2. Fixtures negativos ───────────────────────────────────────────────────

function kinds(r) {
    return r.violations.map((v) => `${v.kind}:${v.provider}:${v.role || ''}`).sort();
}

test('negativo: fallback a proveedor no habilitado para el rol ⇒ violación', () => {
    const models = realModels();
    models.skills.qa.fallbacks = [...models.skills.qa.fallbacks, { provider: 'antigravity' }];
    const r = pp.checkMatrixCoherence(models, realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(kinds(r).includes('role_not_allowed:antigravity:qa'), kinds(r).join('\n'));
    assert.ok(r.violations.some((v) => v.kind === 'scope_exceeded' && v.role === 'qa' && v.scope === 'aws'));
});

test('negativo: scope excedido por un requires_credentials nuevo ⇒ violación', () => {
    const models = realModels();
    models.skills.perf.requires_credentials = ['aws'];
    const r = pp.checkMatrixCoherence(models, realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(r.violations.some((v) => v.kind === 'scope_exceeded' && v.provider === 'antigravity' && v.role === 'perf' && v.scope === 'aws'));
});

test('negativo: scope nuevo en un par pendiente de firma NO queda tapado por la pendencia', () => {
    const models = realModels();
    models.skills.po.requires_credentials = ['github', 'aws'];
    const r = pp.checkMatrixCoherence(models, realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(r.violations.some((v) => v.kind === 'scope_exceeded' && v.role === 'po' && v.scope === 'aws'));
});

test('negativo: proveedor en la matriz sin entrada en la política ⇒ violación', () => {
    const models = realModels();
    models.providers['nuevo-llm'] = {};
    models.skills.guru.fallbacks = [...models.skills.guru.fallbacks, { provider: 'nuevo-llm' }];
    const r = pp.checkMatrixCoherence(models, realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(kinds(r).includes('provider_without_policy:nuevo-llm:guru'));
});

test('negativo: proveedor en la política que no existe en la matriz ⇒ violación', () => {
    const pol = clone(realPolicy());
    pol.providers.fantasma = clone(pol.providers.antigravity);
    const r = pp.checkMatrixCoherence(realModels(), pol, { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(r.violations.some((v) => v.kind === 'policy_provider_unknown' && v.provider === 'fantasma'));
});

test('negativo: habilitación en la política sin eslabón en la matriz ⇒ violación', () => {
    const pol = clone(realPolicy());
    pol.providers.antigravity.roles_allowed.push({ role: 'doc', signoff_ref: SIGN });
    const r = pp.checkMatrixCoherence(realModels(), pol, { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(kinds(r).includes('grant_not_routed:antigravity:doc'));
});

test('negativo: diferencia abierta que ya no ocurre ⇒ violación (hay que limpiarla)', () => {
    const models = realModels();
    models.skills.po.fallbacks = models.skills.po.fallbacks.filter((f) => f.provider !== 'antigravity');
    const r = pp.checkMatrixCoherence(models, realPolicy(), { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(kinds(r).includes('stale_open_difference:antigravity:po'));
});

test('negativo: política vacía (fail-closed) ⇒ toda la matriz LLM es violación', () => {
    const empty = { exempt_providers: [], providers: {}, open_differences: [] };
    const r = pp.checkMatrixCoherence(realModels(), empty, { now: NOW, pipelineDir: PIPELINE_DIR });
    assert.ok(r.violations.length > 0);
    assert.ok(r.violations.some((v) => v.kind === 'provider_without_policy' && v.provider === 'deterministic'));
});

// ─── 3. Drift doc ↔ JSON ─────────────────────────────────────────────────────

const CODE_WORD = { read: 'lectura', write: 'escritura', none: 'ninguno' };

function tableAfter(md, heading) {
    const start = md.indexOf(heading);
    assert.ok(start >= 0, `falta la sección "${heading}" en el doc`);
    const lines = md.slice(start).split(/\r?\n/);
    const rows = [];
    let inTable = false;
    for (const line of lines.slice(1)) {
        if (line.startsWith('|')) { inTable = true; rows.push(line); continue; }
        if (inTable) break;
    }
    // Sin header ni separador.
    return rows.slice(2).map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
}

const unTick = (s) => s.replace(/`/g, '');
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).sort();

test('drift: la tabla de respuesta rápida coincide con el JSON', () => {
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    const pol = realPolicy();
    const rows = tableAfter(md, '## 1. Respuesta rápida');
    const byProvider = new Map(rows.map((c) => [unTick(c[0]), c]));
    assert.deepEqual([...byProvider.keys()].sort(), Object.keys(pol.providers).sort());
    for (const [name, entry] of Object.entries(pol.providers)) {
        const [, code, data, env, roles, expires] = byProvider.get(name);
        assert.equal(code, CODE_WORD[entry.code.access], `${name}: código`);
        const allowedData = pp.DATA_CATEGORIES.filter((c) => entry.data[c].allowed);
        assert.deepEqual(list(data), [...allowedData].sort(), `${name}: datos`);
        const scopes = /scopes:\s*([^·]+)/.exec(env);
        assert.ok(scopes, `${name}: entorno sin scopes`);
        assert.deepEqual(list(scopes[1]), [...entry.env.allowed_scopes].sort(), `${name}: scopes`);
        assert.match(env, new RegExp(`permisos: ${entry.env.permission_mode}\\b`), `${name}: modo de permisos`);
        assert.deepEqual(list(roles), entry.roles_allowed.map((g) => g.role).sort(), `${name}: roles`);
        assert.equal(expires, pp.formatDateDMY(entry.terms.expires_at), `${name}: vencimiento`);
    }
});

test('drift: la tabla de diferencias abiertas coincide con open_differences', () => {
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    const pol = realPolicy();
    const rows = tableAfter(md, '## 4. Diferencias abiertas');
    const docItems = rows.map((c) => {
        const link = /\((https:[^)]+)\)/.exec(c[3]);
        return `${unTick(c[0])}|${c[1]}|${c[2]}|${link ? link[1] : ''}`;
    }).sort();
    const jsonItems = pol.open_differences.map((d) => `${d.provider}|${d.role}|${d.scope || ''}|${d.request_ref}`).sort();
    assert.deepEqual(docItems, jsonItems);
});

test('drift: cada proveedor tiene su sección con los subtítulos fijos (UX-3) y deterministic figura exento', () => {
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    const pol = realPolicy();
    for (const name of Object.keys(pol.providers)) {
        const start = md.search(new RegExp(`^### \\d+\\.\\d+ \`${name}\`$`, 'm'));
        assert.ok(start >= 0, `falta la sección de ${name}`);
        const bodyStart = md.indexOf('\n', start) + 1;
        const next = md.slice(bodyStart).search(/^##+ /m);
        const section = md.slice(start, next < 0 ? undefined : bodyStart + next);
        for (const sub of ['**Código.**', '**Datos.**', '**Entorno.**', '**Variables recibidas:**',
            '**Archivos alcanzables:**', '**Red y herramientas:**', '**Modo de permisos:**',
            '**Fundamento contractual.**', '**Roles habilitados.**', '**Vencimiento.**']) {
            assert.ok(section.includes(sub), `${name}: falta ${sub}`);
        }
        for (const src of pol.providers[name].terms.sources) assert.ok(section.includes(src), `${name}: falta la fuente ${src}`);
        for (const g of pol.providers[name].roles_allowed) assert.ok(section.includes(g.signoff_ref), `${name}: falta el sign-off`);
    }
    assert.match(md, /`deterministic` está \*\*exento\*\*/);
    assert.match(md, /LLM01/);
});

// ─── 4. SR-6: sin secretos ni mapa operativo en superficies públicas ─────────

test('SR-6: el doc y el JSON no contienen nombres de variables, ARNs, IDs de cuenta ni paths absolutos', () => {
    const varNames = new Set();
    for (const vars of Object.values(bce.CREDENTIAL_SCOPES)) for (const v of vars) varNames.add(v);
    for (const v of Object.values(bce.PROVIDER_DEFAULT_CREDENTIAL_ENV)) if (v) varNames.add(v);
    for (const v of bce.RESERVED_CHILD_SECRET_NAMES) varNames.add(v);

    const surfaces = {
        'docs/legal/proveedores-ia.md': fs.readFileSync(DOC_PATH, 'utf8'),
        '.pipeline/provider-policy.json': fs.readFileSync(path.join(PIPELINE_DIR, 'provider-policy.json'), 'utf8'),
    };
    const patterns = [
        ['ARN de AWS', /arn:aws:/i],
        ['ID de cuenta (12 dígitos)', /(?<!\d)\d{12}(?!\d)/],
        ['path absoluto con unidad', /\b[A-Za-z]:[\\/]/],
        ['path de home', /(^|[\s(`'"])(~[\\/]|\/home\/|\/Users\/)/m],
        ['clave de acceso AWS', /\bAKIA[0-9A-Z]{16}\b/],
    ];
    for (const [where, text] of Object.entries(surfaces)) {
        for (const [what, re] of patterns) assert.ok(!re.test(text), `${where} contiene ${what}`);
        for (const v of varNames) {
            assert.ok(!new RegExp(`\\b${v}\\b`).test(text), `${where} nombra la variable ${v}`);
        }
    }
});
