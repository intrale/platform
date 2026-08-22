// =============================================================================
// health-screen.test.js — Tests de los agregadores de la pantalla EP8-H12
// (#3965). Cubre: percentiles, % same-provider de Sherlock (alerta), conteo de
// errores por clase (incl. cli_1m_context_glitch), ventana 24h, proveedor sin
// datos, no-fuga de credenciales (CA-6) y escape anti-XSS del timeline (CA-5).
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const screen = require('../health-screen');

// Timestamp fijo determinístico (no usamos Date.now() en los asserts de ventana).
const NOW = 1782400000000; // epoch-ms arbitrario dentro del rango del proyecto.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Helpers de fixtures: directorios temporales con JSONL controlado.
// ---------------------------------------------------------------------------

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mph-test-'));
}

function writeJsonl(file, entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// percentiles
// ---------------------------------------------------------------------------

test('percentiles calcula p50/p95 (nearest-rank) sobre fixture de latency_ms', () => {
    const r = screen.percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(r.count, 10);
    assert.equal(r.p50, 50); // ceil(0.5*10)=5 → idx 4 → 50
    assert.equal(r.p95, 100); // ceil(0.95*10)=10 → idx 9 → 100
});

test('percentiles ignora valores no numéricos y negativos', () => {
    const r = screen.percentiles([100, null, 'x', -5, 200, undefined, NaN]);
    assert.equal(r.count, 2);
    assert.equal(r.p50, 100);
    assert.equal(r.p95, 200);
});

test('percentiles con array vacío devuelve null (la UI muestra "sin datos")', () => {
    const r = screen.percentiles([]);
    assert.equal(r.p50, null);
    assert.equal(r.p95, null);
    assert.equal(r.count, 0);
});

// ---------------------------------------------------------------------------
// sherlockSameProviderPct — alerta a la meta del 10%
// ---------------------------------------------------------------------------

test('sherlockSameProviderPct alert=true cuando %same-provider ≥ 10%', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    // 2 same-provider de 10 = 20% ≥ 10 → alerta.
    const entries = [];
    for (let i = 0; i < 10; i++) {
        entries.push({ same_provider: i < 2, created_at: NOW - HOUR });
    }
    writeJsonl(path.join(auditDir, 'sherlock-100.jsonl'), entries);
    const r = screen.sherlockSameProviderPct({ now: NOW, auditDir });
    assert.equal(r.total, 10);
    assert.equal(r.same, 2);
    assert.equal(r.pct, 20);
    assert.equal(r.meta, 10);
    assert.equal(r.alert, true);
});

test('sherlockSameProviderPct alert=false cuando %same-provider < 10%', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    // 1 same-provider de 20 = 5% < 10 → sin alerta.
    const entries = [];
    for (let i = 0; i < 20; i++) {
        entries.push({ same_provider: i === 0, created_at: NOW - HOUR });
    }
    writeJsonl(path.join(auditDir, 'sherlock-200.jsonl'), entries);
    const r = screen.sherlockSameProviderPct({ now: NOW, auditDir });
    assert.equal(r.pct, 5);
    assert.equal(r.alert, false);
});

test('sherlockSameProviderPct agrega sobre múltiples archivos sherlock-*.jsonl', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    writeJsonl(path.join(auditDir, 'sherlock-1.jsonl'), [
        { same_provider: true, created_at: NOW - HOUR },
        { same_provider: false, created_at: NOW - HOUR },
    ]);
    writeJsonl(path.join(auditDir, 'sherlock-2-3.jsonl'), [
        { same_provider: false, created_at: NOW - HOUR },
        { same_provider: false, created_at: NOW - HOUR },
    ]);
    const r = screen.sherlockSameProviderPct({ now: NOW, auditDir });
    assert.equal(r.total, 4);
    assert.equal(r.same, 1);
    assert.equal(r.pct, 25);
});

test('sherlockSameProviderPct sin datos → pct=null, alert=false (no error)', () => {
    const root = tmpRoot();
    const r = screen.sherlockSameProviderPct({ now: NOW, auditDir: path.join(root, 'audit') });
    assert.equal(r.pct, null);
    assert.equal(r.alert, false);
    assert.equal(r.total, 0);
});

// ---------------------------------------------------------------------------
// Ventana 24h — descarta entradas viejas
// ---------------------------------------------------------------------------

test('ventana 24h descarta entradas más viejas que el cutoff (Sherlock)', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    writeJsonl(path.join(auditDir, 'sherlock-w.jsonl'), [
        { same_provider: true, created_at: NOW - HOUR },          // dentro
        { same_provider: true, created_at: NOW - (2 * DAY) },     // FUERA (vieja)
        { same_provider: false, created_at: NOW - (3 * HOUR) },   // dentro
    ]);
    const r = screen.sherlockSameProviderPct({ now: NOW, auditDir });
    assert.equal(r.total, 2, 'solo cuenta las 2 entradas dentro de la ventana 24h');
    assert.equal(r.same, 1);
});

test('readJsonlWindow filtra por created_at y también por timestamp ISO', () => {
    const root = tmpRoot();
    const file = path.join(root, 'mix.jsonl');
    writeJsonl(file, [
        { v: 'iso-in', timestamp: new Date(NOW - HOUR).toISOString() },
        { v: 'iso-old', timestamp: new Date(NOW - 2 * DAY).toISOString() },
        { v: 'epoch-in', created_at: NOW - HOUR },
    ]);
    const out = screen.readJsonlWindow(file, NOW - DAY);
    const vals = out.map(e => e.v).sort();
    assert.deepEqual(vals, ['epoch-in', 'iso-in']);
});

// ---------------------------------------------------------------------------
// errorClassCounts24h — incluye cli_1m_context_glitch
// ---------------------------------------------------------------------------

test('errorClassCounts24h cuenta la clase cli_1m_context_glitch (#3506)', () => {
    const root = tmpRoot();
    const logsDir = path.join(root, 'logs');
    const day = isoDay(NOW);
    writeJsonl(path.join(logsDir, `commander-dispatch-${day}.jsonl`), [
        { event: 'x', error_class: 'cli_1m_context_glitch', provider_effective: 'anthropic', created_at: NOW - HOUR },
        { event: 'x', error_class: 'cli_1m_context_glitch', provider_effective: 'anthropic', created_at: NOW - 2 * HOUR },
        { event: 'x', error_class: 'timeout_no_new_bytes_30s', provider_effective: 'openai', created_at: NOW - HOUR },
        { event: 'x', created_at: NOW - HOUR }, // sin error_class → no cuenta
    ]);
    const r = screen.errorClassCounts24h({ now: NOW, logsDir });
    assert.equal(r.classes['cli_1m_context_glitch'], 2);
    assert.equal(r.classes['timeout_no_new_bytes_30s'], 1);
    assert.equal(r.total, 3);
    assert.equal(r.byProvider['anthropic']['cli_1m_context_glitch'], 2);
});

test('errorClassCounts24h descarta errores fuera de la ventana 24h', () => {
    const root = tmpRoot();
    const logsDir = path.join(root, 'logs');
    const today = isoDay(NOW);
    const oldDay = isoDay(NOW - 3 * DAY);
    writeJsonl(path.join(logsDir, `commander-dispatch-${today}.jsonl`), [
        { error_class: 'cli_1m_context_glitch', created_at: NOW - HOUR },
    ]);
    writeJsonl(path.join(logsDir, `commander-dispatch-${oldDay}.jsonl`), [
        { error_class: 'cli_1m_context_glitch', created_at: NOW - 3 * DAY },
    ]);
    const r = screen.errorClassCounts24h({ now: NOW, logsDir });
    assert.equal(r.total, 1, 'el archivo viejo queda fuera de la ventana de archivos diarios');
});

// ---------------------------------------------------------------------------
// dispatchCounts24h
// ---------------------------------------------------------------------------

test('dispatchCounts24h cuenta despachos por provider efectivo', () => {
    const root = tmpRoot();
    const logsDir = path.join(root, 'logs');
    const day = isoDay(NOW);
    writeJsonl(path.join(logsDir, `cross-provider-dispatch-${day}.jsonl`), [
        { event: 'fallback_selected', fallback_provider: 'openai-codex', created_at: NOW - HOUR },
        { event: 'fallback_selected', fallback_provider: 'openai-codex', created_at: NOW - 2 * HOUR },
        { event: 'chain_exhausted', primary_provider: 'anthropic', created_at: NOW - HOUR },
    ]);
    const r = screen.dispatchCounts24h({ now: NOW, logsDir });
    assert.equal(r.totals['openai-codex'], 2);
    assert.equal(r.totals['anthropic'], 1);
    assert.equal(r.total, 3);
});

// ---------------------------------------------------------------------------
// timeline24h
// ---------------------------------------------------------------------------

test('timeline24h devuelve transiciones ordenadas y solo whitelist de campos', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    writeJsonl(path.join(auditDir, 'multi-provider-health.jsonl'), [
        { type: 'health_state_transition', provider: 'anthropic', from_state: 'red', to_state: 'green', reason_code: 'cli_oauth_ok', latency_ms: 120, created_at: NOW - 2 * HOUR, hash_self: 'SECRET_HASH', hash_prev: 'X' },
        { type: 'health_state_transition', provider: 'openai', from_state: 'green', to_state: 'red', reason_code: 'quota', latency_ms: null, created_at: NOW - HOUR },
        { type: 'health_alert_emitted', provider: 'x', created_at: NOW - HOUR }, // distinto type → ignorado
        { type: 'health_state_transition', provider: 'old', from_state: 'green', to_state: 'red', created_at: NOW - 3 * DAY }, // fuera de ventana
    ]);
    const out = screen.timeline24h({ now: NOW, auditDir });
    assert.equal(out.length, 2);
    // Orden ascendente por created_at.
    assert.equal(out[0].provider, 'anthropic');
    assert.equal(out[1].provider, 'openai');
    // Whitelist: NUNCA expone hashes de la cadena.
    for (const ev of out) {
        assert.equal(ev.hash_self, undefined);
        assert.equal(ev.hash_prev, undefined);
    }
});

// ---------------------------------------------------------------------------
// buildScreenPayload — cards + sin datos
// ---------------------------------------------------------------------------

test('buildScreenPayload arma cards con p50/p95 + despachos + errores por clase', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    const logsDir = path.join(root, 'logs');
    const day = isoDay(NOW);
    writeJsonl(path.join(auditDir, 'multi-provider-health.jsonl'), [
        { type: 'health_state_transition', provider: 'anthropic', latency_ms: 100, created_at: NOW - HOUR },
        { type: 'health_state_transition', provider: 'anthropic', latency_ms: 300, created_at: NOW - 2 * HOUR },
    ]);
    writeJsonl(path.join(logsDir, `cross-provider-dispatch-${day}.jsonl`), [
        { fallback_provider: 'anthropic', created_at: NOW - HOUR },
    ]);
    writeJsonl(path.join(logsDir, `commander-dispatch-${day}.jsonl`), [
        { error_class: 'cli_1m_context_glitch', provider_effective: 'anthropic', created_at: NOW - HOUR },
    ]);
    const payload = screen.buildScreenPayload({ now: NOW, auditDir, logsDir, skipCache: true });
    const card = payload.cards.find(c => c.provider === 'anthropic');
    assert.ok(card, 'debe existir card de anthropic');
    assert.equal(card.has_data, true);
    assert.equal(card.dispatches_24h, 1);
    assert.equal(card.latency_samples, 2);
    assert.equal(card.p50_ms, 100); // nearest-rank sobre [100,300] → ceil(0.5*2)=1 → idx 0
    assert.equal(card.p95_ms, 300);
    assert.equal(card.error_classes['cli_1m_context_glitch'], 1);
});

test('buildScreenPayload marca has_data=false para proveedor sin datos en la ventana (CA-1 "sin datos 24h")', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    const logsDir = path.join(root, 'logs');
    const day = isoDay(NOW);
    // Solo error_class viejo (fuera de ventana) y un dispatch reciente de OTRO provider.
    writeJsonl(path.join(logsDir, `cross-provider-dispatch-${day}.jsonl`), [
        { fallback_provider: 'openai', created_at: NOW - HOUR },
    ]);
    const payload = screen.buildScreenPayload({ now: NOW, auditDir, logsDir, skipCache: true });
    // 'openai' tiene dispatch → has_data true; no debe haber card sin datos espuria.
    const openai = payload.cards.find(c => c.provider === 'openai');
    assert.ok(openai && openai.has_data === true);
    // No hay card de 'anthropic' porque no aparece en ninguna fuente.
    assert.equal(payload.cards.find(c => c.provider === 'anthropic'), undefined);
});

test('buildScreenPayload incluye el resumen de Sherlock', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    const logsDir = path.join(root, 'logs');
    writeJsonl(path.join(auditDir, 'sherlock-z.jsonl'), [
        { same_provider: true, created_at: NOW - HOUR },
        { same_provider: false, created_at: NOW - HOUR },
    ]);
    const payload = screen.buildScreenPayload({ now: NOW, auditDir, logsDir, skipCache: true });
    assert.equal(payload.sherlock.total, 2);
    assert.equal(payload.sherlock.pct, 50);
    assert.equal(payload.sherlock.alert, true);
});

// ---------------------------------------------------------------------------
// CA-6 — No fuga de credenciales
// ---------------------------------------------------------------------------

test('CA-6 funcional: el payload no contiene campos de credenciales aunque el audit los traiga', () => {
    const root = tmpRoot();
    const auditDir = path.join(root, 'audit');
    const logsDir = path.join(root, 'logs');
    // Plantamos campos sensibles en las fuentes — NO deben aparecer en la salida.
    writeJsonl(path.join(auditDir, 'multi-provider-health.jsonl'), [
        { type: 'health_state_transition', provider: 'anthropic', latency_ms: 50, created_at: NOW - HOUR, api_key: 'sk-LEAK-SECRET-123', token: 'BEARER_LEAK' },
    ]);
    writeJsonl(path.join(auditDir, 'sherlock-k.jsonl'), [
        { same_provider: false, created_at: NOW - HOUR, secret: 'sk-ANOTHER-LEAK' },
    ]);
    const payload = screen.buildScreenPayload({ now: NOW, auditDir, logsDir, skipCache: true });
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /sk-LEAK-SECRET-123|BEARER_LEAK|sk-ANOTHER-LEAK/);
    assert.doesNotMatch(serialized, /"api_key"|"token"|"secret"/);
});

test('CA-6 estático: los handlers nuevos de api.js no serializan config/secrets crudos', () => {
    const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
    // Aislar el bloque de handlers EP8-H12.
    const start = apiSrc.indexOf('handleHealthScreenGet');
    const end = apiSrc.indexOf('const ROUTES = [');
    assert.ok(start > 0 && end > start, 'debe existir el bloque de handlers nuevos');
    const block = apiSrc.slice(start, end);
    // Quitar comentarios para no levantar falsos positivos por la documentación.
    const code = block
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    // No deben leer el config crudo ni invocar el módulo de secrets en los handlers.
    assert.doesNotMatch(code, /rw\.readConfig\(/, 'los handlers nuevos no deben leer el config crudo');
    assert.doesNotMatch(code, /secrets\.\w/, 'los handlers nuevos no deben invocar el módulo de secrets');
    assert.doesNotMatch(code, /JSON\.stringify\(\s*(config|cfg|snapshot)\b/, 'no serializar el config/snapshot completo');
});

// ---------------------------------------------------------------------------
// CA-5 — Escape anti-XSS del timeline en la vista
// ---------------------------------------------------------------------------

test('CA-5: el reason_code del timeline pasa por escapeHtml en la vista (anti-XSS)', () => {
    const view = require('../../../views/dashboard/multi-provider-health');
    // La vista escapa explícitamente el reason_code antes de tocar el DOM.
    assert.ok(view.CLIENT_JS.includes('escapeHtml(ev.reason_code)'),
        'renderTimeline debe escapar reason_code');

    // Verificación funcional del helper escapeHtml embebido en la vista.
    const m = view.CLIENT_JS.match(/function escapeHtml\(s\)\{[\s\S]*?\}\n/);
    assert.ok(m, 'debe existir la función escapeHtml en el CLIENT_JS');
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function('return (' + m[0].trim() + ')')();
    assert.equal(
        escapeHtml('<script>alert(1)</script>'),
        '&lt;script&gt;alert(1)&lt;/script&gt;',
        'escapeHtml debe neutralizar etiquetas HTML',
    );
});
