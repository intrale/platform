// =============================================================================
// provider-terms-expired-7597.test.js — #7597 · CA-3 (vencimiento visible)
//
//   - health-cron: evento `terms_expired` (UX-2), opt-in, dedup 24 h con
//     recordatorio "Términos siguen vencidos", key por fecha de vencimiento.
//   - dashboard: chip de términos (UX-1 + adenda de contraste): warn y no
//     rojo, texto en --in-fg, badge de salud intacto, sin chip si no hay
//     política cargable.
//
// Todo con `now` inyectado (sin reloj real). Molde: agy-contract-above-tested-7371.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const healthCron = require('../lib/multi-provider/health-cron');
const providerPolicy = require('../lib/provider-policy');
const providersView = require('../views/dashboard/providers');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const HOUR = 60 * 60 * 1000;
const EXPIRED_NOW = Date.parse('2026-12-20T12:00:00Z');   // después del 15/12/2026
const VALID_NOW = Date.parse('2026-10-01T12:00:00Z');

function tmpDedup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-7597-'));
    return path.join(dir, 'dedup.json');
}

function entry(provider, state = 'green') {
    return { provider, state, reason_code: 'ok', last_checked_at: new Date(EXPIRED_NOW).toISOString() };
}

const realPolicy = () => providerPolicy.loadPolicy({ pipelineDir: PIPELINE_DIR });
const realTermsCheck = (now) => {
    const policy = realPolicy();
    return (provider) => providerPolicy.termsStatus(provider, { now, policy });
};

function tick({ providers, dedupFile, now, termsCheck }) {
    const sent = [];
    const out = healthCron.emitAlerts({
        snapshot: { ts: new Date(now).toISOString(), providers },
        prevSnapshot: { providers },   // sin transiciones: sólo el eje de términos
        telegramSender: (payload) => { sent.push(payload); return true; },
        dedupFile,
        fsImpl: fs,
        now,
        termsCheck,
    });
    return { sent, out };
}

// ─── health-cron ─────────────────────────────────────────────────────────────

test('opt-in: sin termsCheck no se evalúan términos (consumidores existentes intactos)', () => {
    const { sent } = tick({ providers: [entry('antigravity')], dedupFile: tmpDedup(), now: EXPIRED_NOW });
    assert.equal(sent.filter((p) => p.event === 'terms_expired').length, 0);
});

test('términos vigentes → sin alerta', () => {
    const { sent } = tick({
        providers: [entry('anthropic'), entry('openai'), entry('antigravity')],
        dedupFile: tmpDedup(), now: VALID_NOW, termsCheck: realTermsCheck(VALID_NOW),
    });
    assert.deepEqual(sent.filter((p) => p.event === 'terms_expired'), []);
});

test('términos vencidos → una alerta por proveedor, con el nombre de config (openai → openai-codex)', () => {
    const { out } = tick({
        providers: [entry('anthropic'), entry('openai', 'yellow'), entry('antigravity')],
        dedupFile: tmpDedup(), now: EXPIRED_NOW, termsCheck: realTermsCheck(EXPIRED_NOW),
    });
    const terms = out.filter((a) => a.kind === 'terms_expired');
    assert.deepEqual(terms.map((a) => a.provider).sort(), ['anthropic', 'antigravity', 'openai-codex']);
    for (const a of terms) {
        assert.equal(a.payload.expires_at, '2026-12-15');
        assert.equal(a.payload.reminder, false);
    }
});

test('texto UX-2: cabecera ⚠️, estado subordinado real, fecha, consecuencia, acción y código al final', () => {
    const { sent } = tick({
        providers: [entry('antigravity')], dedupFile: tmpDedup(), now: EXPIRED_NOW, termsCheck: realTermsCheck(EXPIRED_NOW),
    });
    const text = healthCron.formatAlertText(sent.find((p) => p.event === 'terms_expired'));
    assert.match(text, /^⚠️ \*Términos vencidos\* — `antigravity` sigue 🟢 SANO y sus roles vigentes siguen ruteando/);
    assert.match(text, /venció el 15\/12\/2026/);
    assert.match(text, /no se aceptan habilitaciones nuevas/);
    assert.match(text, /actualizá la fecha en docs\/legal\/proveedores-ia\.md/);
    assert.match(text, /\n\(`terms_expired`\) · Observado: /);
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/home\/|~\//, 'sin paths absolutos (SR-6)');
});

test('fecha ausente o inválida → alerta igual, diciendo que se trata como vencida', () => {
    const { sent } = tick({
        providers: [entry('antigravity')], dedupFile: tmpDedup(), now: VALID_NOW,
        termsCheck: () => providerPolicy.termsStatus({ terms: { verified_at: '2026-09-16', expires_at: 'mañana' } }, { now: VALID_NOW }),
    });
    const payload = sent.find((p) => p.event === 'terms_expired');
    assert.ok(payload);
    assert.equal(payload.expires_at, null);
    assert.match(healthCron.formatAlertText(payload), /no tiene una fecha válida y se trata como vencida/);
});

test('dedup 24 h + recordatorio "Términos siguen vencidos" sin tope; fecha nueva = key nueva', () => {
    const dedupFile = tmpDedup();
    const providers = [entry('antigravity')];
    const t0 = EXPIRED_NOW;
    const first = tick({ providers, dedupFile, now: t0, termsCheck: realTermsCheck(t0) });
    assert.equal(first.sent.filter((p) => p.event === 'terms_expired').length, 1);

    const again = tick({ providers, dedupFile, now: t0 + 2 * HOUR, termsCheck: realTermsCheck(t0 + 2 * HOUR) });
    assert.equal(again.sent.filter((p) => p.event === 'terms_expired').length, 0, 'dentro de 24 h no repite');

    for (const day of [1, 2, 3]) {
        const at = t0 + day * 24 * HOUR;
        const r = tick({ providers, dedupFile, now: at, termsCheck: realTermsCheck(at) });
        const p = r.sent.find((x) => x.event === 'terms_expired');
        assert.ok(p, `recordatorio del día ${day}`);
        assert.equal(p.reminder, true);
        assert.match(healthCron.formatAlertText(p), /^⚠️ \*Términos siguen vencidos\*/);
    }

    // Re-verificación con otra fecha que también venció: es otra key → alerta nueva, no recordatorio.
    const other = () => ({ state: 'vencido', reason: 'expired', verified_at: '2026-10-01', expires_at: '2026-12-18' });
    const r = tick({ providers, dedupFile, now: t0 + 3 * 24 * HOUR + HOUR, termsCheck: other });
    const p = r.sent.find((x) => x.event === 'terms_expired');
    assert.ok(p);
    assert.equal(p.reminder, false);
});

test('el vencimiento no toca el estado de salud del snapshot', () => {
    const providers = [entry('antigravity', 'green')];
    tick({ providers, dedupFile: tmpDedup(), now: EXPIRED_NOW, termsCheck: realTermsCheck(EXPIRED_NOW) });
    assert.equal(providers[0].state, 'green');
});

test('runOnce/tickIfDue: los callsites productivos piden el eje de términos (checkTerms: true)', () => {
    const pulpo = fs.readFileSync(path.join(PIPELINE_DIR, 'pulpo.js'), 'utf8');
    const api = fs.readFileSync(path.join(PIPELINE_DIR, 'lib', 'multi-provider', 'api.js'), 'utf8');
    assert.match(pulpo, /healthCron\.tickIfDue\(\{ checkTerms: true \}\)/);
    assert.match(api, /healthCron\.tickIfDue\(\{ checkTerms: true \}\)/);
});

// ─── dashboard ───────────────────────────────────────────────────────────────

function fila(over, now) {
    return providersView.renderProviderRow({
        key: 'antigravity', disabledKey: 'antigravity', name: 'Antigravity', accent: 'var(--provider-antigravity)',
        tier: null, tierKind: null, tierIcon: null, masked: null, fingerprint: null, keyStatus: 'not_applicable',
        editable: false, reason: null, authMode: 'oauth', freeTierNotes: null,
        catalogCheck: null, quota: null, session: null,
        lastChecked: new Date(now - HOUR).toISOString(), loadPct: 0, dispatches24h: 0, hasTraffic: false,
        models: [], disabled: false, healthState: 'green', healthReason: 'ok', cliProbe: null,
        ...over,
    }, now);
}

const agyEntry = () => realPolicy().providers.antigravity;

test('chip vencido: warn (no rojo), glifo aparte, tooltip con fechas y consecuencia; salud sigue SANO', () => {
    const html = fila({ termsEntry: agyEntry() }, EXPIRED_NOW);
    assert.match(html, /<span class="prov-terms-chip is-warn" title="Términos verificados el 16\/09\/2026 · vencieron el 15\/12\/2026 · no se aceptan habilitaciones nuevas; los roles vigentes siguen ruteando">/);
    assert.match(html, /<span class="prov-terms-glyph" aria-hidden="true">⚠<\/span> TÉRMINOS VENCIDOS/);
    assert.doesNotMatch(html, /prov-terms-chip is-bad/);
    assert.match(html, /SANO/, 'el badge de salud no cambia por el vencimiento');
});

test('chip vigente: atenuado con fecha corta en el año actual y completa si es otro año', () => {
    const html = fila({ termsEntry: agyEntry() }, VALID_NOW);
    assert.match(html, /<span class="prov-terms-chip is-dim" title="Términos verificados el 16\/09\/2026 · vencen el 15\/12\/2026">TÉRMINOS HASTA 15\/12<\/span>/);
    const nextYear = { terms: { verified_at: '2026-12-01', expires_at: '2027-02-01', sources: ['https://x'] } };
    assert.match(fila({ termsEntry: nextYear }, VALID_NOW), /TÉRMINOS HASTA 01\/02\/2027/);
});

test('sin entrada en la política → chip vencido (fail-closed); sin política cargable → sin chip', () => {
    assert.match(fila({ termsEntry: {} }, VALID_NOW), /Sin fecha de verificación válida: se trata como vencida/);
    assert.doesNotMatch(fila({ termsEntry: null }, VALID_NOW), /prov-terms-chip/);
    assert.doesNotMatch(fila({}, VALID_NOW), /prov-terms-chip/);
});

test('contraste (adenda UX): el texto del chip vencido NO usa --in-warn; borde/fondo/glifo sí', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'views', 'dashboard', 'providers.js'), 'utf8');
    const rule = /\.prov-terms-chip\.is-warn \{([^}]*)\}/.exec(src);
    assert.ok(rule, 'existe la regla del chip vencido');
    assert.match(rule[1], /color: var\(--in-fg\)/);
    assert.doesNotMatch(rule[1], /(^|[^-])color: var\(--in-warn\)/);
    assert.match(rule[1], /border-color: var\(--in-warn\)/);
    assert.match(rule[1], /background: var\(--in-warn-soft\)/);
    assert.match(src, /\.prov-terms-chip\.is-warn \.prov-terms-glyph \{ color: var\(--in-warn\); \}/);
});

test('el modelo del panel trae la entrada de la política por proveedor (catalogKey)', () => {
    const model = providersView.buildProvidersModel();
    const byKey = Object.fromEntries(model.providers.map((p) => [p.key, p]));
    const policy = realPolicy();
    assert.deepEqual(byKey.openai.termsEntry, policy.providers['openai-codex']);
    assert.deepEqual(byKey.antigravity.termsEntry, policy.providers.antigravity);
});
