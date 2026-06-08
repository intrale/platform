// =============================================================================
// Tests SSR de la ventana Pipeline (#3728, split del épico #3715).
//
// Cubre los 8 escenarios obligatorios del body del issue + CA-PL11:
//   1. Render sin pausa parcial activa.
//   2. Render con pausa parcial + 1 issue allowed.
//   3. Render con candidatos vacíos.
//   4. Escape XSS canónico en candidate.reason (CA-PL6 / CA-D1).
//   5. Escape XSS en allowedIssues no numéricos (CA-PL7 — bug latente corregido).
//   6. Hash-chain OK con N entries verificadas.
//   7. Banner crítico visible cuando chain_broken=true (#3625).
//   8. Escape XSS en justification del audit row (vía shim inyectado).
// + bonus: el módulo NO contiene fetch/addEventListener/XMLHttpRequest (CA-PL3).
//
// node:test (sin Jest). No arranca dashboard.js (side effects): usa el render
// directo del módulo con helpers inyectados (renderInfraHealth, ic y
// renderPartialPauseAuditRows fakeados / reales).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PIPELINE_PATH = path.resolve(__dirname, '..', 'pipeline.js');
const pipeline = require(PIPELINE_PATH);

// Shim real del audit-trail (igual que el inyectado por dashboard.js). Si falla,
// fallback a un renderer local que escapa, para no acoplar el test al lib.
let realRenderRows;
try {
    realRenderRows = require('../../../lib/audit-trail-renderer').renderRows;
} catch (_) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    realRenderRows = (entries) => (entries || []).map((e) => `<tr><td>${esc(e.justification)}</td></tr>`).join('');
}

// Payloads XSS canónicos (paridad con home.test.js / costos.test.js).
const XSS_SVG = '"><svg onload=alert(1)>';
const XSS_SCRIPT = '"><script>alert(1)</script>';
const XSS_IMG = '"><img src=x onerror=alert(1)>';

// --- Fakes inyectados ---------------------------------------------------------
function fakeIc(name) { return `<svg class="pl-ic"><use href="#ic-${name}"/></svg>`; }
function fakeInfraHealth() { return '<section id="infra-health-fake">infra</section>'; }
function fakeRenderRows(entries) {
    return (entries || []).map(() => '<tr><td colspan="6">row</td></tr>').join('');
}

// Helper: construye params con defaults sanos + overrides.
function buildParams(overrides) {
    return Object.assign({
        partialPauseState: { mode: 'running', allowedIssues: [] },
        allowlistCandidatesList: [],
        partialPauseAuditData: {
            chain_broken: false,
            chain_broken_at: null,
            chain_entries_checked: 0,
            entries: [],
            has_unauthorized_non_backfill: false,
            stats: { total: 0, authorized: 0, rejected: 0, unknown: 0 },
        },
        state: { priorityWindows: {} },
        stale: 0,
        blocked: false,
        isPaused: false,
        isPartialPause: false,
        trabajando: 0,
        pwThreshold: 3,
        now: 1_700_000_000_000,
        ic: fakeIc,
        renderInfraHealth: fakeInfraHealth,
        renderPartialPauseAuditRows: fakeRenderRows,
    }, overrides || {});
}

// 1. Render sin pausa parcial activa.
test('renderPipelineHTML retorna HTML no vacío sin pausa parcial activa', () => {
    const html = pipeline.renderPipelineHTML(buildParams());
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0);
    assert.ok(html.includes('id="partial-pause-deps-banner"'), 'banner deps presente');
    assert.ok(html.includes('pipeline-ctrl-bar'), 'control bar presente');
    assert.ok(html.includes('panel-allowlist-audit'), 'panel audit presente');
    assert.ok(html.includes('Sin actividad') || html.includes('trabajando'), 'status pill running');
    // El banner de deps arranca oculto (lo togglea el cliente).
    assert.match(html, /partial-pause-deps-banner"[^>]*display:none/);
});

// 2. Render con pausa parcial + 1 issue allowed.
test('renderPipelineHTML renderiza pausa parcial con 1 issue allowed', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        partialPauseState: { mode: 'partial_pause', allowedIssues: [3140] },
        isPartialPause: true,
    }));
    assert.ok(html.includes('Pausa parcial'), 'status pill partial');
    assert.ok(html.includes('#3140'), 'issue allowed en el control bar');
    assert.ok(html.includes('Reanudar'), 'botón reanudar presente');
    // El details de allowlist abre por defecto en partial-pause (decisión UX #2).
    assert.match(html, /<details open id="allowlist-candidates-section"/);
});

// 3. Render con candidatos vacíos.
test('renderPipelineHTML renderiza candidatos vacíos correctamente', () => {
    const html = pipeline.renderPipelineHTML(buildParams({ allowlistCandidatesList: [] }));
    assert.ok(html.includes('No hay candidatos likeados'), 'empty-state de candidatos');
});

// 4. Escape XSS canónico en candidate.reason (CA-PL6 / CA-D1).
test('renderPipelineHTML escapa payload XSS canónico en candidate.reason', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        allowlistCandidatesList: [{ issue: 3140, likedAt: '2026-05-31', reason: XSS_SVG }],
    }));
    assert.ok(!html.includes('<svg onload'), 'NO contiene el svg sin escapar');
    assert.ok(html.includes('&lt;svg'), 'SÍ contiene la entidad escapada');
});

// 5. Escape XSS en allowedIssues no numéricos (CA-PL7 — bug latente corregido).
test('renderPipelineHTML escapa payload XSS en allowedIssues no numéricos', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        partialPauseState: { mode: 'partial_pause', allowedIssues: [3140, XSS_SCRIPT] },
        isPartialPause: true,
    }));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'NO contiene el script sin escapar');
    assert.ok(html.includes('#3140'), 'el issue numérico sigue visible');
    assert.ok(html.includes('&lt;script&gt;'), 'el payload quedó escapado');
});

// 6. Hash-chain OK con N entries verificadas.
test('renderPipelineHTML renderiza hash-chain OK con N entries verificadas', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        partialPauseAuditData: {
            chain_broken: false,
            chain_broken_at: null,
            chain_entries_checked: 42,
            entries: [],
            has_unauthorized_non_backfill: false,
            stats: { total: 42, authorized: 40, rejected: 1, unknown: 1 },
        },
    }));
    assert.ok(html.includes('✓ 42'), 'KPI hash-chain muestra ✓ 42');
    // El banner crítico queda oculto cuando la cadena está sana.
    assert.match(html, /ppa-banner-chain"[^>]*display:none/);
});

// 7. Banner crítico visible cuando chain_broken=true (#3625 + CA-D1).
test('renderPipelineHTML muestra banner crítico cuando chain_broken=true', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        partialPauseAuditData: {
            chain_broken: true,
            chain_broken_at: 17,
            chain_entries_checked: 16,
            entries: [],
            has_unauthorized_non_backfill: false,
            stats: { total: 17, authorized: 15, rejected: 1, unknown: 1 },
        },
    }));
    assert.match(html, /ppa-banner-chain"[^>]*display:flex/);
    assert.ok(html.includes('entry #<span id="ppa-broken-at">17</span>'), 'menciona la entry rota');
    assert.ok(html.includes('✗ ROTO'), 'KPI hash-chain en ROTO');
    // El details de audit abre por defecto cuando hay chain_broken (decisión UX #2).
    assert.match(html, /<details open id="panel-allowlist-audit"/);
});

// 8. Escape XSS en justification del audit row (vía shim inyectado).
test('renderPipelineHTML escapa título de audit row con payload XSS', () => {
    const html = pipeline.renderPipelineHTML(buildParams({
        partialPauseAuditData: {
            chain_broken: false,
            chain_broken_at: null,
            chain_entries_checked: 1,
            entries: [{ visual: 'authorized', action: 'add', authorized_by: 'guru', justification: XSS_IMG }],
            has_unauthorized_non_backfill: false,
            stats: { total: 1, authorized: 1, rejected: 0, unknown: 0 },
        },
        renderPartialPauseAuditRows: realRenderRows,
    }));
    assert.ok(!html.includes('<img src=x onerror'), 'NO contiene el img sin escapar');
});

// Bonus CA-PL3: el código fuente del módulo no introduce superficie CSRF nueva.
test('el módulo pipeline.js no contiene fetch/addEventListener/XMLHttpRequest', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(PIPELINE_PATH, 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(src), 'sin fetch propio');
    assert.ok(!src.includes('addEventListener'), 'sin addEventListener');
    assert.ok(!src.includes('XMLHttpRequest'), 'sin XMLHttpRequest');
    assert.ok(!/require\(['"]\.\.?\/dashboard/.test(src), 'sin require circular del dashboard');
});

// Bonus contrato: normalizeAudit degrada campos faltantes a defaults seguros.
test('normalizeAudit degrada un slice incompleto sin romper', () => {
    const a = pipeline.normalizeAudit(undefined);
    assert.equal(a.chain_broken, false);
    assert.equal(a.chain_entries_checked, 0);
    assert.deepEqual(a.stats, { total: 0, authorized: 0, rejected: 0, unknown: 0 });
    assert.deepEqual(a.entries, []);
});
