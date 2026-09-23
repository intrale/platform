'use strict';

// =============================================================================
// #6565 — Panel de saldo y ritmo de cuota por proveedor en el dashboard.
//
// Cubre los criterios de aceptación del issue y los UX-1..UX-11 del contrato
// (`.pipeline/assets/mockups/6565/ux-validacion-6565.md`):
//   - CA-1: para cada proveedor activo se ve techo, consumo, saldo, ritmo y proyección.
//   - CA-2: excedido muestra el excedente explícito (UX-5).
//   - CA-3: la vista NO recalcula la fórmula (consume `estado` y campos del slice).
//   - CA-4: una sola sección de cuota; la ventana larga ya no se hidrata desde
//     /api/dash/quota (UX-1/UX-2).
//   - CA-5: `sin_datos` = saldo completo en gris, nunca error (UX-4).
//   - UX-3: chip con ícono + texto + aria-label (nunca sólo color).
//   - UX-6: sin proyección ni marca de cierre sobre dato viejo/insuficiente.
//   - UX-7: fail-closed con `ok:false` → "sin dato" gris + motivo en title.
//   - UX-8: cero hex nuevos en home.js.
//   - UX-9: countdowns vivos descontados localmente; vencido → 'renovando…'.
//   - UX-10: title completo en las celdas del período.
//
// La hidratación se prueba con las funciones REALES del script cliente
// (`home.renderClientScript()`), evaluadas sobre un DOM falso mínimo — misma
// disciplina que #4900: sin copias del código.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const home = require('../views/dashboard/home');
const evidence = require('../tools/render-quota-balance-evidence-6565');
const { ESTADOS } = require('../lib/multi-provider/quota-balance');

const HOME_SRC = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard', 'home.js'), 'utf8');
const CLIENT_JS = home.renderClientScript();
const HOUR = 3600 * 1000;
const NOW = evidence.NOW;

// ---------- DOM falso mínimo (classList, style, textContent, atributos) ----------
function mkEl() {
    const classes = new Set();
    const attrs = {};
    return {
        textContent: '', style: {}, _classes: classes,
        classList: {
            add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
            contains(c) { return classes.has(c); },
        },
        getAttribute(k) { return attrs[k] != null ? attrs[k] : null; },
        setAttribute(k, v) { attrs[k] = String(v); },
        removeAttribute(k) { delete attrs[k]; },
        _attrs: attrs,
    };
}

// Registra los ids que emite `_mzBalanceCells(key)` (fuente única: se parsean del SSR real).
function installRow(els, key) {
    const html = home._mzBalanceCells(key, 'Sem');
    for (const m of html.matchAll(/id="([^"]+)"/g)) els[m[1]] = mkEl();
    return els;
}

// Extrae del script cliente REAL el bloque #6565 y lo evalúa con el DOM falso.
function loadHydrator(els) {
    const start = CLIENT_JS.indexOf('// #6565 — "Proveedores sanos" cruza');
    const end = CLIENT_JS.indexOf('let _quotaBalanceData = null;', start);
    assert.ok(start >= 0 && end > start, 'anclas del bloque #6565 en el script cliente');
    // fmtETA y setText son helpers reales del mismo script; se extraen por nombre.
    const fmtEtaSrc = CLIENT_JS.slice(CLIENT_JS.indexOf('function fmtETA(ms){'), CLIENT_JS.indexOf('function renderQuotaCard('));
    const setTextSrc = CLIENT_JS.slice(CLIENT_JS.indexOf('function setText(id, value)'), CLIENT_JS.indexOf('\n', CLIENT_JS.indexOf('function setText(id, value)')));
    const factory = new Function('document', 'MZ_PROVIDER_META', 'MZ_ACTIVE_PROVIDERS', 'Date', `
        ${fmtEtaSrc}
        ${setTextSrc}
        ${CLIENT_JS.slice(start, end)}
        return { _mzHydrateBalanceRow, renderQuotaBalanceMatrix, _mzBalanceVerdict, _mzFmtPts, _mzFmtSigned, _mzFmtRate, _mzRelAgo, _mzFmtLive, _mzUpdateHealthySig, _mzHealthyShort, _mzHealthyBalance };
    `);
    const FakeDate = Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC });
    return factory({ getElementById: (id) => els[id] || null }, home.MZ_PROVIDER_META, home.MZ_ACTIVE_PROVIDERS, FakeDate);
}

function hydrate(key, fixture, opts) {
    const els = installRow({}, key);
    const h = loadHydrator(els);
    const r = h._mzHydrateBalanceRow(key, fixture, (opts && opts.elapsed) || 0, NOW);
    return { els, h, r };
}
const txt = (els, id) => els[id].textContent;
const cls = (els, id) => [...els[id]._classes];

// =============================================================================
// SSR
// =============================================================================
test('CA-4/UX-1 — una sola sección de cuota en home: el panel #4533 se extiende, no se duplica', () => {
    const html = home.renderHomeHTML({});
    assert.equal((html.match(/CUOTA POR PROVEEDOR/g) || []).length, 1, 'una sola sección "CUOTA POR PROVEEDOR"');
    assert.equal((html.match(/class="mz-sysquota"/g) || []).length, 1, 'un solo panel mz-sysquota');
    assert.ok(html.includes('>Período · saldo<') && html.includes('>Ritmo · proyección<'), 'columnas nuevas del período');
    assert.ok(!html.includes('>Ventana larga<'), 'la columna "Ventana larga" fue reemplazada');
    assert.ok(html.includes('id="mz-qb-note"'), 'nota del header con antigüedad de la muestra');
});

test('UX-1/UX-2 — la ventana corta queda intacta y la larga no se emite', () => {
    const row = home._mzProviderMatrixRow('anthropic');
    assert.ok(row.includes(home._mzWinCell('anthropic', 'short', home.MZ_PROVIDER_WINDOWS.anthropic.short)),
        'la celda corta es byte-a-byte la de #4533');
    assert.ok(!row.includes('id="mz-qm-anthropic-long"'), 'sin celda mz-qm-<key>-long');
    for (const key of home.MZ_ACTIVE_PROVIDERS) {
        const r = home._mzProviderMatrixRow(key);
        for (const id of [`mz-qb-${key}`, `mz-qb-${key}-fill`, `mz-qb-${key}-over`, `mz-qb-${key}-mark`, `mz-qb-${key}-saldo`,
            `mz-qr-${key}-rate`, `mz-qr-${key}-eta`, `mz-qv-${key}`, `mz-qv-${key}-ic`, `mz-qv-${key}-tx`, `mz-ql2-${key}-rd`]) {
            assert.ok(r.includes(`id="${id}"`), `fila ${key} emite ${id}`);
        }
    }
});

test('UX-7 — skeleton pendiente: "…" atenuado (mz-qm-nodata), nunca 0 % ni 100 %', () => {
    const cells = home._mzBalanceCells('anthropic', 'Sem');
    assert.match(cells, /class="mz-qb mz-qm-nodata"/);
    assert.match(cells, /class="mz-qr mz-qm-nodata"/);
    assert.match(cells, /id="mz-qb-anthropic-saldo">…</);
    assert.ok(!/\b(0|100) %/.test(cells), 'sin saldo por defecto');
    assert.ok(cells.includes(home.MZ_BALANCE_PENDING_HINT), 'title explica que es pendiente');
});

test('el script cliente registra tickQuotaBalance a 60 s y deja de hidratar la ventana larga desde /api/dash/quota', () => {
    assert.match(CLIENT_JS, /\{ fn: tickQuotaBalance, ms: 60000 \}/);
    assert.match(CLIENT_JS, /fetchJson\('\/api\/dash\/quota-balance'\)/);
    const body = CLIENT_JS.slice(CLIENT_JS.indexOf('function renderProviderQuotaMatrix('), CLIENT_JS.indexOf('// #6565 — Período · saldo'));
    assert.ok(!body.includes("'long'"), 'renderProviderQuotaMatrix ya no toca el slot long');
    assert.ok(!body.includes('weekly'), 'renderProviderQuotaMatrix ya no lee el bucket weekly');
});

// =============================================================================
// Hidratación real por estado (UX §4 — un estado = un render)
// =============================================================================
test('los 6 estados del enum ESTADOS tienen tono y copy (contrato cerrado)', () => {
    const { h } = hydrate('anthropic', evidence.STATE_FIXTURES.alcanza);
    for (const estado of ESTADOS) {
        assert.ok(evidence.STATE_FIXTURES[estado], `fixture del estado ${estado}`);
        const v = h._mzBalanceVerdict(evidence.STATE_FIXTURES[estado], { agota: null, cierre: null }, NOW);
        assert.ok(v && v.text && v.eta, `veredicto para ${estado}`);
    }
    assert.equal(h._mzBalanceVerdict({ estado: 'inventado' }, {}, NOW), null, 'estado desconocido → null (fail-closed)');
});

test('alcanza — verde, marca de cierre dentro del saldo, chip "+37 % al cierre"', () => {
    const { els, r } = hydrate('anthropic', evidence.STATE_FIXTURES.alcanza);
    assert.ok(cls(els, 'mz-qb-anthropic').includes('ok') && cls(els, 'mz-qv-anthropic').includes('ok'));
    assert.equal(txt(els, 'mz-qb-anthropic-saldo'), '59 %');
    assert.equal(els['mz-qb-anthropic-fill'].style.width, '41.0%');
    assert.equal(els['mz-qb-anthropic-mark'].getAttribute('data-on'), '1');
    assert.equal(els['mz-qb-anthropic-mark'].style.left, '63.0%', 'marca en (techo − al_cierre)/techo');
    assert.equal(txt(els, 'mz-qr-anthropic-rate'), '0,38');
    assert.equal(txt(els, 'mz-qr-anthropic-eta'), 'agota en 6d 11h');
    assert.equal(txt(els, 'mz-qv-anthropic-ic'), '✓');
    assert.equal(txt(els, 'mz-qv-anthropic-tx'), 'Alcanza · +37 % al cierre');
    assert.equal(txt(els, 'mz-ql2-anthropic-rd'), 'techo 100 · consumido 41 ↻ cierra en 2d 9h');
    assert.equal(r.healthy, true);
});

test('alcanza sin cierre conocido (rolling) — guard: "cierre desconocido", nunca "+null %" (guru §4.3)', () => {
    const f = Object.assign({}, evidence.STATE_FIXTURES.alcanza, { al_cierre_pts: null, cierre_en_ms: null, cierre_periodo_at: null, reposicion: 'rolling', rolling: true });
    const { els } = hydrate('anthropic', f);
    assert.equal(txt(els, 'mz-qv-anthropic-tx'), 'Alcanza · cierre desconocido');
    assert.ok(!txt(els, 'mz-qv-anthropic-tx').includes('null'));
    assert.equal(els['mz-qb-anthropic-mark'].getAttribute('data-on'), '0', 'sin cierre no hay marca');
    assert.equal(txt(els, 'mz-ql2-anthropic-rd'), 'techo 100 · consumido 41 ↻ cierre desconocido');
});

test('alcanza con ritmo 0 — "no se agota"', () => {
    const f = Object.assign({}, evidence.STATE_FIXTURES.alcanza, { ritmo_pts_por_hora: 0, agota_at: null, agota_en_ms: null, al_cierre_pts: 59 });
    const { els } = hydrate('anthropic', f);
    assert.equal(txt(els, 'mz-qr-anthropic-eta'), 'no se agota');
    assert.equal(txt(els, 'mz-qr-anthropic-rate'), '0,00');
});

test('se_agota_antes — ámbar, chip con cuánto antes y el faltante con signo tipográfico', () => {
    const { els } = hydrate('anthropic', evidence.STATE_FIXTURES.se_agota_antes);
    assert.ok(cls(els, 'mz-qb-anthropic').includes('warn') && cls(els, 'mz-qr-anthropic').includes('warn') && cls(els, 'mz-qv-anthropic').includes('warn'));
    assert.equal(txt(els, 'mz-qb-anthropic-saldo'), '77 %');
    assert.equal(txt(els, 'mz-qv-anthropic-ic'), '⚠');
    assert.equal(txt(els, 'mz-qv-anthropic-tx'), 'Se agota 1d 1h antes del cierre · −16 %');
    assert.equal(txt(els, 'mz-qr-anthropic-eta'), 'agota en 5d 4h');
    assert.equal(els['mz-qb-anthropic-mark'].style.left, '100.0%', 'marca clampeada al 100 % cuando al_cierre < 0');
    assert.equal(els['mz-qv-anthropic'].getAttribute('aria-label'), 'Se agota 1d 1h antes del cierre · −16 % · Anthropic', 'UX-3: aria-label = texto + proveedor');
});

test('se_agota_antes con cierre desconocido — "Se agota en X · cierre desconocido"', () => {
    const f = Object.assign({}, evidence.STATE_FIXTURES.se_agota_antes, { cierre_en_ms: null, cierre_periodo_at: null, al_cierre_pts: null });
    const { els } = hydrate('openai-codex', f);
    assert.equal(txt(els, 'mz-qv-openai-codex-tx'), 'Se agota en 5d 4h · cierre desconocido');
});

test('CA-2/UX-5 — excedido: saldo 0, chip "+12 % sobre el techo", barra llena + tramo rayado, "agotado"', () => {
    const { els, r } = hydrate('antigravity', evidence.STATE_FIXTURES.excedido);
    assert.ok(cls(els, 'mz-qb-antigravity').includes('bad') && cls(els, 'mz-qv-antigravity').includes('bad'));
    assert.equal(txt(els, 'mz-qb-antigravity-saldo'), '0 %', 'nunca saldo negativo');
    assert.equal(els['mz-qb-antigravity-fill'].style.width, '100.0%');
    assert.equal(els['mz-qb-antigravity-over'].style.width, '12.0%', 'tramo rayado = excedente/techo');
    assert.equal(els['mz-qb-antigravity-bar'].getAttribute('data-over'), '1');
    assert.equal(els['mz-qb-antigravity-mark'].getAttribute('data-on'), '0');
    assert.equal(txt(els, 'mz-qv-antigravity-ic'), '✕');
    assert.equal(txt(els, 'mz-qv-antigravity-tx'), 'Excedido +12 % sobre el techo');
    assert.equal(txt(els, 'mz-qr-antigravity-eta'), 'agotado');
    assert.equal(txt(els, 'mz-ql2-antigravity-rd'), 'techo 100 · consumido 112 ↻ repone en 3h 20m');
    assert.equal(r.healthy, false);
});

test('CA-5/UX-4 — sin_datos: saldo completo en gris (dim, no ok), nunca error', () => {
    const { els, r } = hydrate('antigravity', evidence.STATE_FIXTURES.sin_datos);
    const c = cls(els, 'mz-qb-antigravity');
    assert.ok(c.includes('dim') && !c.includes('ok') && !c.includes('bad') && !c.includes('mz-qm-nodata'), `clases: ${c}`);
    assert.equal(txt(els, 'mz-qb-antigravity-saldo'), '100 %');
    assert.equal(txt(els, 'mz-qb-antigravity-tag'), 'DÍA');
    assert.equal(txt(els, 'mz-qr-antigravity-rate'), '—');
    assert.equal(txt(els, 'mz-qr-antigravity-eta'), 'sin proyección');
    assert.equal(txt(els, 'mz-qv-antigravity-tx'), 'Sin datos del período');
    assert.equal(txt(els, 'mz-qv-antigravity-ic'), '○');
    assert.equal(txt(els, 'mz-ql2-antigravity-rd'), 'saldo completo · sin muestras ↻ cierra en 18h');
    assert.equal(r.healthy, false, 'sin dato real no cuenta como sano');
});

test('UX-6 — desactualizado: ámbar con antigüedad, ritmo "—", sin proyección ni marca', () => {
    const { els } = hydrate('anthropic', evidence.STATE_FIXTURES.desactualizado);
    assert.ok(cls(els, 'mz-qb-anthropic').includes('warn'));
    assert.equal(txt(els, 'mz-qv-anthropic-ic'), '⏱');
    assert.equal(txt(els, 'mz-qv-anthropic-tx'), 'Dato viejo · muestra de hace 47m');
    assert.equal(txt(els, 'mz-qr-anthropic-rate'), '—');
    assert.equal(txt(els, 'mz-qr-anthropic-eta'), 'sin proyección');
    assert.equal(els['mz-qb-anthropic-mark'].getAttribute('data-on'), '0');
});

test('UX-6 — sin_proyeccion: saldo con color normal (ok), ritmo dim "en cálculo 1/3", repuesto hace 12m', () => {
    const { els } = hydrate('openai-codex', evidence.STATE_FIXTURES.sin_proyeccion);
    assert.ok(cls(els, 'mz-qb-openai-codex').includes('ok'), 'el saldo conserva su color normal');
    assert.ok(cls(els, 'mz-qr-openai-codex').includes('dim') && cls(els, 'mz-qv-openai-codex').includes('dim'));
    assert.equal(txt(els, 'mz-qv-openai-codex-ic'), '◌');
    assert.equal(txt(els, 'mz-qv-openai-codex-tx'), 'Ritmo en cálculo · 1/3 muestras');
    assert.equal(txt(els, 'mz-qb-openai-codex-saldo'), '100 %');
    assert.equal(txt(els, 'mz-ql2-openai-codex-rd'), 'saldo completo · repuesto hace 12m ↻ cierra en 7d');
});

test('UX-10 — title completo en las tres celdas del período', () => {
    const { els } = hydrate('anthropic', evidence.STATE_FIXTURES.se_agota_antes);
    const t = els['mz-qb-anthropic'].getAttribute('title');
    for (const frag of ['plan Max', 'techo 100 %', 'consumo 23 %', 'saldo 77 %', 'ritmo 0,62 %/h', 'ventana móvil 60 min', '4/3 muestras', 'agota ', 'cierre ', 'al cierre −16 %', 'muestra ', '(fresh)', 'reposición dom 21:00', 'estado se_agota_antes']) {
        assert.ok(t.includes(frag), `title incluye "${frag}": ${t}`);
    }
    assert.equal(els['mz-qr-anthropic'].getAttribute('title'), t);
    assert.equal(els['mz-qv-anthropic'].getAttribute('title'), t);
});

// =============================================================================
// Fail-closed (UX-7) y proveedor ausente
// =============================================================================
test('UX-7 — ok:false ⇒ "sin dato" gris con el motivo en title, header "⚠ balance no disponible", 0 sanos', () => {
    const els = {};
    for (const k of home.MZ_ACTIVE_PROVIDERS) installRow(els, k);
    els['mz-qb-note'] = mkEl(); els['mz-qm-h-note'] = mkEl(); els['mz-sig-healthy'] = mkEl();
    const h = loadHydrator(els);
    h.renderQuotaBalanceMatrix(evidence.FAIL_CLOSED, NOW, NOW);
    for (const k of home.MZ_ACTIVE_PROVIDERS) {
        assert.ok(cls(els, `mz-qb-${k}`).includes('mz-qm-nodata') && cls(els, `mz-qr-${k}`).includes('mz-qm-nodata'));
        assert.equal(txt(els, `mz-qb-${k}-saldo`), 'sin dato');
        assert.equal(txt(els, `mz-qr-${k}-rate`), 'sin dato');
        assert.match(els[`mz-qb-${k}`].getAttribute('title'), /config inválida: QuotaCeilingError/);
        assert.equal(txt(els, `mz-qv-${k}-tx`), 'Balance no disponible');
        assert.equal(els[`mz-qb-${k}-fill`].style.width, '0%');
    }
    assert.equal(txt(els, 'mz-qb-note'), '⚠ balance no disponible');
    assert.equal(els['mz-qm-h-note'].getAttribute('data-balance'), '0');
    assert.equal(txt(els, 'mz-sig-healthy'), '0/3');
});

test('UX-7 — respuesta con shape inválido o estado desconocido también cae a "sin dato"', () => {
    const els = {};
    for (const k of home.MZ_ACTIVE_PROVIDERS) installRow(els, k);
    els['mz-qb-note'] = mkEl(); els['mz-qm-h-note'] = mkEl(); els['mz-sig-healthy'] = mkEl();
    const h = loadHydrator(els);
    h.renderQuotaBalanceMatrix({ ok: true }, NOW, NOW);
    assert.equal(txt(els, 'mz-qb-anthropic-saldo'), 'sin dato');
    const r = h._mzHydrateBalanceRow('anthropic', Object.assign({}, evidence.STATE_FIXTURES.alcanza, { estado: 'raro' }), 0, NOW);
    assert.equal(r.healthy, false);
    assert.equal(txt(els, 'mz-qb-anthropic-saldo'), 'sin dato');
    assert.match(els['mz-qb-anthropic'].getAttribute('title'), /estado desconocido/);
});

test('proveedor sin techo declarado (ausente en balance.providers) → "sin dato" con motivo, no error', () => {
    const els = {};
    for (const k of home.MZ_ACTIVE_PROVIDERS) installRow(els, k);
    els['mz-qb-note'] = mkEl(); els['mz-qm-h-note'] = mkEl(); els['mz-sig-healthy'] = mkEl();
    const h = loadHydrator(els);
    const d = JSON.parse(JSON.stringify(evidence.PANEL_BALANCE));
    delete d.balance.providers.antigravity;
    h.renderQuotaBalanceMatrix(d, NOW, NOW);
    assert.equal(txt(els, 'mz-qb-antigravity-saldo'), 'sin dato');
    assert.match(els['mz-qb-antigravity'].getAttribute('title'), /sin techo declarado/);
    assert.equal(txt(els, 'mz-qb-anthropic-saldo'), '77 %', 'los demás se hidratan normal');
    assert.equal(txt(els, 'mz-qb-note'), 'muestra hace 2m', 'nota del header = muestra más reciente');
    assert.equal(els['mz-qm-h-note'].getAttribute('data-balance'), '1');
});

// =============================================================================
// Countdowns vivos (UX-9)
// =============================================================================
test('UX-9 — los countdowns se descuentan con el tiempo transcurrido; vencido → "renovando…"', () => {
    const f = Object.assign({}, evidence.STATE_FIXTURES.alcanza, { agota_en_ms: 2 * HOUR, cierre_en_ms: 30 * 60000 });
    const a = hydrate('anthropic', f, { elapsed: 0 });
    assert.equal(txt(a.els, 'mz-qr-anthropic-eta'), 'agota en 2h');
    assert.equal(txt(a.els, 'mz-ql2-anthropic-rd'), 'techo 100 · consumido 41 ↻ cierra en 30m');
    const b = hydrate('anthropic', f, { elapsed: 45 * 60000 });
    assert.equal(txt(b.els, 'mz-qr-anthropic-eta'), 'agota en 1h 15m');
    assert.equal(txt(b.els, 'mz-ql2-anthropic-rd'), 'techo 100 · consumido 41 ↻ cierra en renovando…', 'vencido: nunca negativo');
});

// =============================================================================
// Formateadores (UX §3)
// =============================================================================
test('formatos: % sin decimales, tokens en M/k, mensajes/créditos con unidad, ritmo con coma es-AR', () => {
    const { h } = hydrate('anthropic', evidence.STATE_FIXTURES.alcanza);
    assert.equal(h._mzFmtPts(77.4, 'porcentaje'), '77 %');
    assert.equal(h._mzFmtPts(-5, 'porcentaje'), '5 %', 'nunca negativo');
    assert.equal(h._mzFmtPts(1200000, 'tokens'), '1,2 M tok');
    assert.equal(h._mzFmtPts(850000, 'tokens'), '850 k tok');
    assert.equal(h._mzFmtPts(999, 'tokens'), '999 tok');
    assert.equal(h._mzFmtPts(12, 'mensajes'), '12 mensajes');
    assert.equal(h._mzFmtPts(1500, 'creditos'), '1.500 créditos');
    assert.equal(h._mzFmtPts(null, 'porcentaje'), '—');
    assert.equal(h._mzFmtSigned(-16, 'porcentaje'), '−16 %');
    assert.equal(h._mzFmtSigned(37, 'porcentaje'), '+37 %');
    assert.equal(h._mzFmtRate(0.62), '0,62');
    assert.equal(h._mzFmtRate(1.8), '1,80');
    assert.equal(h._mzFmtRate(null), '—');
    assert.equal(h._mzRelAgo(new Date(NOW - 47 * 60000).toISOString(), NOW), 'hace 47m');
    assert.equal(h._mzRelAgo(new Date(NOW - 26 * HOUR).toISOString(), NOW), 'hace 1d 2h');
    assert.equal(h._mzFmtLive(0), 'renovando…');
    assert.equal(h._mzFmtLive(null), null);
});

// =============================================================================
// CA-3 — la vista no recalcula la fórmula; UX-8 — cero hex nuevos
// =============================================================================
test('CA-3 — el bloque #6565 del cliente no deriva estado ni color por umbral de %', () => {
    const start = CLIENT_JS.indexOf('// #6565 — Período · saldo');
    const end = CLIENT_JS.indexOf('let _quotaBalanceData = null;', start);
    const block = CLIENT_JS.slice(start, end);
    assert.ok(!block.includes('_mzThresholdClass') && !block.includes('_mzConsumedClass'), 'no reutiliza los umbrales de la ventana corta');
    assert.ok(!/consumo_pct\s*[<>]=?/.test(block) && !/saldo_pts\s*[<>]=?\s*\d/.test(block), 'no compara consumo/saldo contra umbrales numéricos');
    assert.ok(/MZ_QB_TONE\[p\.estado\]/.test(block), 'el tono sale de p.estado');
    assert.ok(!/techo\s*-\s*consumo\s*\)\s*\/\s*ritmo/.test(block), 'no proyecta "agota" con regla de tres');
});

test('UX-8 — el CSS y el script del panel #6565 no introducen hex nuevos en home.js', () => {
    const cssStart = HOME_SRC.indexOf('/* ===== #6565 — Período · saldo');
    const cssEnd = HOME_SRC.indexOf('/* --- Grilla 2-col + paneles --- */', cssStart);
    assert.ok(cssStart > 0 && cssEnd > cssStart);
    const block = HOME_SRC.slice(cssStart, cssEnd);
    const rest = HOME_SRC.slice(0, cssStart) + HOME_SRC.slice(cssEnd);
    const hexes = new Set((block.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()));
    assert.ok(hexes.size > 0, 'el bloque usa fallbacks (sanity)');
    for (const hx of hexes) {
        assert.ok(rest.toLowerCase().includes(hx), `hex ${hx} ya existía fuera del bloque #6565`);
    }
    assert.ok(!/var\(--(?!in-)/.test(block), 'sólo tokens --in-*');
});

// =============================================================================
// Harness de evidencia (render real, sin copias)
// =============================================================================
test('el harness de evidencia incrusta CSS, SSR y script REALES de home.js y cubre los 6 estados + fail-closed', () => {
    const html = evidence.buildHarnessHtml();
    assert.ok(html.includes(home.homeStyles()), 'CSS real verbatim');
    assert.ok(html.includes(home.renderClientScript()), 'script cliente real verbatim');
    for (const estado of ESTADOS) assert.ok(html.includes(`id="mz-qb-cat-${estado}"`), `catálogo incluye ${estado}`);
    assert.ok(html.includes('id="fc-mz-qb-anthropic"'), 'bloque fail-closed');
    assert.ok(html.includes('renderQuotaBalanceMatrix(FX.panel'), 'hidrata con la función real');
});

// =============================================================================
// UX-11 — "nada recortado a 1440 px · no se oculta" (rebote QA rev-2)
// La línea 2 (chip de veredicto + lectura del período) desbordaba su celda en el
// ancho real de la matriz (743 px) con un saldo proyectado de 3 dígitos y
// .mz-sysquota{overflow:hidden} escondía la cola ("cierra en 5d 1"). El harness
// rendía a 1384 px y no lo veía.
// =============================================================================
// Extrae el cuerpo de una regla CSS de home.js buscando el selector literal a
// principio de línea (los selectores del panel #6565 se escriben en una línea).
function cssRule(selector) {
    const start = HOME_SRC.indexOf('\n' + selector + ' {');
    assert.ok(start > 0, 'regla CSS "' + selector + '" presente en home.js');
    const from = start + selector.length + 3;
    const end = HOME_SRC.indexOf('}', from);
    assert.ok(end > from, 'regla CSS "' + selector + '" cerrada');
    return HOME_SRC.slice(from, end);
}

test('UX-11 — .mz-ql2 envuelve SIEMPRE (flex-wrap sin media query): chip y lectura son unidades nowrap', () => {
    const ql2 = cssRule('.mz-ql2');
    assert.match(ql2, /flex-wrap:\s*wrap/, 'la línea 2 envuelve cuando no entra en su celda');
    assert.match(ql2, /min-width:\s*0/, 'la celda de grilla puede encoger (no fuerza el ancho del contenido)');
    assert.match(ql2, /white-space:\s*nowrap/, 'cada pieza sigue siendo una unidad (no parte "cierra en 5d 13h" por la mitad)');
    assert.match(cssRule('.mz-ql2 .mz-ql2-rd'), /margin-left:\s*auto/, 'la lectura queda a la derecha también en la 2.ª línea');
    assert.ok(!/@media \(max-width: 1200px\) \{ \.mz-ql2/.test(HOME_SRC), 'el wrap ya no depende de un breakpoint que nunca aplica al kiosk-frame fijo');
});

test('UX-11 — el harness rinde al ancho real del home (kiosk-frame − padding = 1036 px), derivado del CSS', () => {
    const w = evidence.harnessBodyWidth();
    const frame = /\.kiosk-frame\s*\{[^}]*?width:\s*(\d+)px/.exec(home.homeStyles());
    const pad = /\.kiosk-body\s*\{[^}]*?padding:\s*\d+px\s+(\d+)px/.exec(home.homeStyles());
    assert.ok(frame && pad, 'el CSS real declara ancho fijo del frame y padding lateral del body');
    assert.equal(w, Number(frame[1]) - 2 * Number(pad[1]));
    assert.equal(w, 1036, 'valor vigente: 1080 − 2×22 (matriz ≈ 743 px como midió QA)');
    assert.equal(evidence.harnessBodyWidth('css sin kiosk'), 1036, 'fallback al valor vigente si el CSS cambia de forma');
    const html = evidence.buildHarnessHtml();
    assert.ok(html.includes('width:' + w + 'px;'), 'el body del harness usa ese ancho');
    assert.ok(!html.includes('width:1384px'), 'ya no rinde al ancho irreal que escondía el recorte');
});

test('UX-11 — el harness incluye el bloque ④ (lecturas largas −152 / −1.841 %) y el clip guard', () => {
    const html = evidence.buildHarnessHtml();
    assert.ok(html.includes('id="lg-mz-ql2-anthropic"') && html.includes('id="lg-mz-ql2-openai-codex"'), 'panel ④ con ids prefijados lg-');
    assert.ok(html.includes('renderQuotaBalanceMatrix(FX.long'), 'se hidrata con la función real');
    assert.ok(html.includes('id="harness-clip"') && html.includes("setAttribute('data-clipped'"), 'clip guard embebido en la página');
    assert.ok(html.includes(evidence.CLIP_GUARD_SCRIPT), 'script del guard verbatim');
    assert.equal(evidence.PANEL_REALISTA.balance.providers.anthropic.al_cierre_pts, -152, 'escenario del rechazo: −152 %');
    assert.equal(evidence.PANEL_REALISTA.balance.providers['openai-codex'].al_cierre_pts, -1841, 'peor caso medido por QA en el home vivo');
    assert.equal(evidence.EXIT_CLIPPED, 5);
});

test('UX-11 — las lecturas largas se emiten completas (chip + "cierra en 5d 13h"), nunca truncadas por la lógica', () => {
    const els = {};
    for (const k of home.MZ_ACTIVE_PROVIDERS) installRow(els, k);
    els['mz-qb-note'] = mkEl(); els['mz-qm-h-note'] = mkEl(); els['mz-sig-healthy'] = mkEl();
    const h = loadHydrator(els);
    h.renderQuotaBalanceMatrix(JSON.parse(JSON.stringify(evidence.PANEL_REALISTA)), NOW, NOW);
    assert.equal(txt(els, 'mz-qv-anthropic-tx'), 'Se agota 3d 13h antes del cierre · −152 %');
    assert.equal(txt(els, 'mz-ql2-anthropic-rd'), 'techo 100 · consumido 28 ↻ cierra en 5d 13h');
    assert.equal(txt(els, 'mz-qv-openai-codex-tx'), 'Se agota 5d 8h antes del cierre · −1.841 %');
    assert.equal(txt(els, 'mz-ql2-openai-codex-rd'), 'techo 100 · consumido 28 ↻ cierra en 5d 13h');
});

// Medición REAL en navegador (la única que prueba el recorte). Se salta sin
// puppeteer (no es dependencia del pipeline): el tool la ejecuta en el QA.
test('UX-11 — en Chrome, al ancho real, ninguna pieza de la matriz queda recortada (clip guard = 0)', async (t) => {
    const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((c) => fs.existsSync(c));
    if (!chrome) return t.skip('sin Chrome/Edge');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb6565-'));
    const htmlPath = path.join(dir, 'harness.html');
    fs.writeFileSync(htmlPath, evidence.buildHarnessHtml(), 'utf8');
    let clip;
    try {
        clip = await evidence.measureClipping(chrome, htmlPath, 1440);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (!clip) return t.skip('sin puppeteer (NODE_PATH=$(npm root -g))');
    assert.equal(clip.panels.length, 3, 'tres paneles medidos (①, ③, ④)');
    for (const p of clip.panels) assert.equal(p.matrix_w, 743, 'matriz al ancho real que midió QA');
    assert.deepEqual(clip.clipped, [], 'nada recortado: ' + JSON.stringify(clip.clipped));
});
