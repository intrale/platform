'use strict';

// =============================================================================
// costos.js — Ventana "Costos" del Dashboard V3 (issue #3735, padre #3715).
//
// Extracción del bloque "Costos" embebido en el shell del monolito
// `dashboard.js`: la PILL de consumo anómalo del header + el BANNER persistente
// de alerta de consumo anómalo (antes inline entre las líneas ~5018-5099).
//
// ALCANCE (decisión cerrada UX/architect — narrativa-costos-v3.md):
//   - En este split se extrae SOLO el banner + pill embebidos en home. La
//     página standalone `/consumo` (renderConsumoHtml) queda como está; su
//     consolidación con este módulo sale como recomendación abierta (#3779).
//   - Son FRAGMENTOS que se embeben en la home shell → heredan el CSS del
//     dashboard (clases .anomaly-pill / .cost-anomaly-banner ya viven en el
//     <style> de dashboard.js). El módulo NO carga su propio theme: si lo
//     hiciera duplicaría la paleta y rompería el layout del shell.
//
// Contrato de exports (estable, consumido por dashboard.js y reutilizable por
// home.js sin duplicar la request — opción A del riesgo #3 del architect):
//   - renderCostosPill(state, opts?)   → HTML de la pill o '' si no visible.
//   - renderCostosBanner(state, opts?) → HTML del banner o '' si no visible.
//   - renderInert(msg?)                → banner inerte visible (CA-A3).
//
// IDs invariantes preservados (el cliente hace DOM morphing y los necesita
// exactos): `cost-anomaly-banner` (target del scrollIntoView de la pill).
//
// Seguridad (CA-B3 / CA-D1):
//   - Todo dato dinámico (pct, montos, skill names) pasa por escapeHtmlText /
//     escapeHtmlAttr de `lib/escape-html.js` (#3722, ya en main).
//   - Tooltips (title=) en cada acción operativa van por escapeHtmlAttr.
//
// Nota: la validación server-side del snooze (whitelist 1|4|24h, cap máximo)
// vive en `rest-mode-state.snoozeAlert()` y se testea ahí; este módulo solo
// renderiza la UI de los botones.
// =============================================================================

let escapeHtmlText;
let escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch (_) {
    // Fallback inline (CA-A3): si el helper compartido no cargó, el módulo
    // sigue escapando en vez de romper o emitir HTML crudo.
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    escapeHtmlText = esc;
    escapeHtmlAttr = esc;
}

// Tooltips acordados con Product Owner (CA-C1, tooltips #1..#4 del CA-4.1).
const TOOLTIPS = {
    pill: 'Pico de consumo detectado · click para ver detalle',
    ack: 'Confirma que viste la alerta — la pill y el banner desaparecen',
    snooze1: 'Silencia una hora',
    snooze4: 'Silencia cuatro horas — útil cuando sabés que viene una ráfaga',
    snooze24: 'Cap máximo permitido (24h) — no se puede más',
};

// Renderer de íconos: replica el markup de `ic()` de dashboard.js
// (`<svg class="pl-ic"><use href="#ic-NAME"/></svg>`) para no romper el sprite
// ya inyectado por loadIconSprite() en la página. Inyectable vía opts.ic para
// los tests / reuso.
function defaultIc(name, ariaLabel, extraClass) {
    const cls = 'pl-ic' + (extraClass ? ' ' + extraClass : '');
    const aria = ariaLabel
        ? ` role="img" aria-label="${escapeHtmlAttr(ariaLabel)}"`
        : ' aria-hidden="true"';
    return `<svg class="${cls}"${aria}><use href="#ic-${escapeHtmlAttr(name)}"/></svg>`;
}

// Normaliza el slice costAnomaly del state. Devuelve null si no hay alerta
// visible (la pill/banner no deben renderizarse).
function readAnomaly(state) {
    const ca = (state && state.costAnomaly) || {};
    if (!ca.visible) return null;
    const a = ca.alert || {};
    const ratioOk = a.ratio != null && Number.isFinite(Number(a.ratio));
    return {
        pctStr: ratioOk ? `+${Math.round((Number(a.ratio) - 1) * 100)}%` : '+?%',
        actualUsd: Number(a.actual_usd || 0).toFixed(2),
        baselineUsd: Number(a.baseline_usd || 0).toFixed(2),
        hour: String(a.hour || '').padStart(2, '0'),
        topSkills: Array.isArray(a.top_skills) ? a.top_skills.slice(0, 3) : [],
    };
}

// --- Pill del header -------------------------------------------------------
function renderCostosPill(state, opts) {
    try {
        const a = readAnomaly(state);
        if (!a) return '';
        const ic = (opts && typeof opts.ic === 'function') ? opts.ic : defaultIc;
        return `<button class="anomaly-pill" `
            + `onclick="document.getElementById('cost-anomaly-banner')?.scrollIntoView({behavior:'smooth',block:'start'})" `
            + `title="${escapeHtmlAttr(TOOLTIPS.pill)}" `
            + `aria-label="Consumo anómalo detectado, click para ver detalle">`
            + `${ic('cost-anomaly')}<span>CONSUMO ANÓMALO · ${escapeHtmlText(a.pctStr)}</span></button>`;
    } catch (_) {
        return '';
    }
}

// --- Banner persistente ----------------------------------------------------
function renderCostosBanner(state, opts) {
    try {
        const a = readAnomaly(state);
        if (!a) return '';
        const ic = (opts && typeof opts.ic === 'function') ? opts.ic : defaultIc;
        const nextHH = String((Number(a.hour) + 1) % 24).padStart(2, '0');
        const topHtml = a.topSkills.length === 0
            ? '<span class="ca-empty">sin desglose por skill (snapshot vacío)</span>'
            : a.topSkills.map((s, i) =>
                `<span class="ca-skill">`
                + `<span class="ca-skill-rank">${i + 1}</span>`
                + `<span class="ca-skill-name">${escapeHtmlText(String(s.skill || ''))}</span>`
                + `<span class="ca-skill-cost">$${escapeHtmlText(Number(s.cost_usd || 0).toFixed(2))}</span>`
                + `</span>`).join('');
        return `
  <section id="cost-anomaly-banner" class="cost-anomaly-banner" role="alert" aria-live="assertive" aria-label="Alerta de consumo anómalo">
    <div class="ca-rail" aria-hidden="true"></div>
    <div class="ca-icon" aria-hidden="true">${ic('cost-anomaly', 'Pico de consumo')}</div>
    <div class="ca-body">
      <div class="ca-headline">Pico de consumo detectado — última hora ${escapeHtmlText(a.pctStr)} sobre el promedio histórico</div>
      <div class="ca-detail">$${escapeHtmlText(a.actualUsd)} USD/h consumidos · esperado $${escapeHtmlText(a.baselineUsd)} USD/h · franja ${escapeHtmlText(a.hour)}:00–${escapeHtmlText(nextHH)}:00 (rolling 7d)</div>
      <div class="ca-skills">Top 3 consumidores: ${topHtml}</div>
      <div class="ca-foot">Persistente hasta acuse manual o vuelta a baseline (2 chequeos consecutivos).</div>
    </div>
    <div class="ca-actions">
      <span class="ca-actions-label">ACCIONES</span>
      <button class="ca-btn-ack" onclick="costAnomalyAck()" title="${escapeHtmlAttr(TOOLTIPS.ack)}">${ic('health-ok', 'check')}<span>Ya lo vi</span></button>
      <div class="ca-snooze">
        <span class="ca-snooze-icon" aria-hidden="true">${ic('snooze')}</span>
        <span class="ca-snooze-label">Silenciar</span>
        <button class="ca-snooze-btn" onclick="costAnomalySnooze(1)" title="${escapeHtmlAttr(TOOLTIPS.snooze1)}">1h</button>
        <button class="ca-snooze-btn" onclick="costAnomalySnooze(4)" title="${escapeHtmlAttr(TOOLTIPS.snooze4)}">4h</button>
        <button class="ca-snooze-btn ca-snooze-max" onclick="costAnomalySnooze(24)" title="${escapeHtmlAttr(TOOLTIPS.snooze24)}">24h</button>
      </div>
    </div>
  </section>`;
    } catch (e) {
        return renderInert();
    }
}

// --- Fallback inerte visible (CA-A3) --------------------------------------
// Mantiene el id `cost-anomaly-banner` para que el scrollIntoView de la pill
// no apunte a un nodo inexistente.
function renderInert(msg) {
    const detail = msg
        ? escapeHtmlText(msg)
        : 'No se pudo renderizar el detalle de la alerta de consumo.';
    return `
  <section id="cost-anomaly-banner" class="cost-anomaly-banner" role="alert" aria-live="assertive" aria-label="Ventana Costos no disponible">
    <div class="ca-rail" aria-hidden="true"></div>
    <div class="ca-body">
      <div class="ca-headline">Ventana Costos no disponible</div>
      <div class="ca-foot">${detail}</div>
    </div>
  </section>`;
}

module.exports = { renderCostosPill, renderCostosBanner, renderInert, TOOLTIPS };
