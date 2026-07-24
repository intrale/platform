'use strict';

// =============================================================================
// mizpa-frame.js — Marco común MIZPÁ reutilizable (#4236, sobre #4234).
//
// Centraliza los tres bloques superiores idénticos en todas las pantallas del
// dashboard MIZPÁ, para que las vistas los CONSUMAN en vez de duplicar markup
// (CA-5 de #4236). Mismo patrón que `nav-tabs.js` (renderNavTabsSsr):
//
//   ① Cabecera MIZPÁ  → renderBrandBar()       (marca + selector de proyecto)
//   ② Cabecera de ola → renderMissionBanner()  (tag + título + métricas + AVANCE)
//   ③ Barra de subventanas → la sigue proveyendo nav-tabs.js (renderNavTabsSsr)
//
// El banner de ola usa las clases canónicas `mz-*` (las mismas que home.js y
// pipeline-redesign.js — #4234), de modo que el marco es IDÉNTICO al resto.
// A diferencia de home/pipeline (que SSR-ean un esqueleto con ids y lo hidratan
// por polling), acá el banner se rinde server-side ya poblado con los datos de
// la ola; las pantallas sin loop de hidratación (como LOGS) lo muestran completo.
//
// CSS: las clases `mz-mission*` viven hoy inline en home.js (no en theme.css —
// ver nota en pipeline-redesign.js sobre "el pipeline no puede morir" > de-dup).
// Para que una vista que sólo incluye theme.css (LOGS) las tenga, este módulo
// exporta `MIZPA_FRAME_CSS` con exactamente esas reglas. La cabecera/brand bar y
// el selector de proyecto ya viven en theme.css (.in-header-brand, .mz-logo,
// .mz-projsel…), así que MIZPA_FRAME_CSS sólo aporta el banner de misión.
//
// Defensivo: ningún colector lanza; degradan a estado vacío (regla transversal).
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

let escapeHtmlText;
try {
    ({ escapeHtmlText } = require('../../lib/escape-html.js'));
} catch (_) {
    escapeHtmlText = (s) => (s === null || s === undefined ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const WAVES_PATH = path.join(__dirname, '../../waves.json');

// ───────────────────────── Formato de fecha de inicio de ola (#4447) ─────────
// Defensa en profundidad (requisito de security): parsea el ISO crudo a `Date`,
// valida `isNaN` y formatea con `Intl.DateTimeFormat` es-AR + TZ Buenos Aires
// (dd/MM/yyyy HH:mm). Cae a `—` cuando `startedAt` es null (olas legacy previas
// al campo `started_at`) o cuando el string es inválido. Nunca lanza.
const WAVE_START_FALLBACK = '—';

function formatWaveStart(iso) {
    if (!iso) return WAVE_START_FALLBACK;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return WAVE_START_FALLBACK;
    try {
        return new Intl.DateTimeFormat('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZone: 'America/Argentina/Buenos_Aires',
        }).format(d);
    } catch (_) {
        return WAVE_START_FALLBACK;
    }
}

// ───────────────────────── Colector de la ola activa ─────────────────────────

/**
 * Lee la ola activa de waves.json. Degrada a `{active:false}` cuando no hay ola
 * planificada (estado inicial real del repo). Mapea nombres de campo comunes sin
 * asumir un schema rígido (waves.json se puebla vía /planner).
 * @param {string} [wavesPath]  override del path (tests).
 * @returns {{active:boolean, number?:string, name?:string, desc?:string, tag?:string,
 *            startedAt?:string|null, eta?:string, velocity?:string, delivered?:number, total?:number,
 *            done?:number, activeCount?:number, blocked?:number, queue?:number, pct?:number}}
 */
function collectWave(wavesPath) {
    try {
        const raw = JSON.parse(fs.readFileSync(wavesPath || WAVES_PATH, 'utf8'));
        const w = raw && raw.active_wave;
        if (!w || typeof w !== 'object') return { active: false };
        const total = Number(w.total ?? w.issues_total ?? (Array.isArray(w.issues) ? w.issues.length : 0)) || 0;
        const done = Number(w.done ?? w.delivered ?? w.completed ?? 0) || 0;
        const activeCount = Number(w.active ?? w.in_progress ?? 0) || 0;
        const blocked = Number(w.blocked ?? 0) || 0;
        const queue = Math.max(0, total - done - activeCount - blocked);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return {
            active: true,
            number: w.number != null ? String(w.number) : (w.id != null ? String(w.id) : '—'),
            name: w.name || w.title || 'Ola activa',
            desc: w.description || w.desc || '',
            tag: w.tag || null,
            startedAt: w.started_at || null,
            eta: w.eta || null,
            velocity: w.velocity != null ? String(w.velocity) : null,
            delivered: done,
            total,
            done,
            activeCount,
            blocked,
            queue,
            pct,
        };
    } catch {
        return { active: false };
    }
}

// ───────────────────────── ① Cabecera MIZPÁ (brand bar) ─────────────────────────

/**
 * Cabecera de marca MIZPÁ común: logo + identidad + selector de proyecto.
 * Idéntica en todas las pantallas. El CSS (.in-header-brand, .mz-logo,
 * .mz-projsel…) ya vive en theme.css (compartido por todos los satélites).
 * @returns {string}
 */
function renderBrandBar() {
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · atalaya de agentes</div>
      </div>
      <div class="mz-projsel" role="button" tabindex="0"
           title="Proyecto activo. MIZPÁ es el motor; el proyecto es intercambiable (multiproyecto — selección en evaluación)."
           aria-label="Proyecto activo: Intrale, 1 de 3">
        <span class="mz-proj-avatar" aria-hidden="true">i</span>
        <span class="mz-proj-id">
          <span class="mz-proj-name">Intrale</span>
          <span class="mz-proj-state">PROYECTO ACTIVO</span>
        </span>
        <span class="mz-proj-badge">1 / 3</span>
        <span class="mz-proj-caret" aria-hidden="true">▾</span>
      </div>
    </div>`;
}

// ───────────────────────── ② Cabecera de ola (mission banner) ─────────────────────────

/**
 * Banner de misión de la ola activa, SSR ya poblado con `wave` (collectWave()).
 * Markup canónico `mz-*` — idéntico al de home.js / pipeline-redesign.js (#4234):
 * tag de ola + título + descripción + métricas (⏳ ETA · 🚀 velocidad · 📦
 * entregados) + bloque AVANCE (barra apilada + leyenda de puntitos).
 * @param {object} wave  resultado de collectWave().
 * @returns {string}
 */
function renderMissionBanner(wave) {
    if (!wave || !wave.active) {
        return `
    <section class="mz-mission is-empty" aria-label="Misión de la ola activa"
             title="Ola activa del plan: avance, ritmo de entrega y cierre estimado. Sin ola activa por ahora.">
      <div class="mz-wavetag" title="Número de la ola activa.">
        <span class="mz-wavetag-k">OLA</span>
        <span class="mz-wavetag-n">—</span>
      </div>
      <div class="mz-mission-text">
        <div class="mz-mission-ttl"><span>Sin ola activa</span></div>
        <div class="mz-mission-desc">Esperando la planificación de la ola activa.</div>
      </div>
    </section>`;
    }
    const restantes = Math.max(0, wave.total - wave.delivered);
    return `
    <section class="mz-mission" aria-label="Misión de la ola activa"
             title="Ola activa del plan: avance, ritmo de entrega y cierre estimado.">
      <div class="mz-wavetag" title="Número de la ola activa.">
        <span class="mz-wavetag-k">OLA</span>
        <span class="mz-wavetag-n">${escapeHtmlText(wave.number)}</span>
      </div>
      <div class="mz-mission-text">
        <div class="mz-mission-ttl">
          <span>${escapeHtmlText(wave.name)}</span>
          ${wave.tag ? `<span class="mz-mission-badge" title="Marca contextual de la ola.">${escapeHtmlText(wave.tag)}</span>` : ''}
        </div>
        <div class="mz-mission-desc">${escapeHtmlText(wave.desc || 'Ola en ejecución.')}</div>
        <div class="mz-mission-metrics">
          ${(() => {
              const startFmt = formatWaveStart(wave.startedAt);
              const isFallback = startFmt === WAVE_START_FALLBACK;
              const startTitle = isFallback
                  ? 'Ola sin fecha de inicio registrada (ola previa al campo).'
                  : 'Fecha y hora en que se activó la ola.';
              const startVal = isFallback
                  ? escapeHtmlText(WAVE_START_FALLBACK)
                  : `${escapeHtmlText(startFmt)} <span class="mz-wm-u">hs</span>`;
              return `<div class="mz-wm" title="${escapeHtmlText(startTitle)}">
            <div class="mz-wm-l">🗓️ COMIENZO</div>
            <div class="mz-wm-v">${startVal}</div>
            <div class="mz-wm-s">inicio de la ola</div>
          </div>`;
          })()}
          <div class="mz-wm" title="Tiempo estimado para cerrar la ola.">
            <div class="mz-wm-l">⏳ ETA DE LA OLA</div>
            <div class="mz-wm-v">${escapeHtmlText(wave.eta || '—')}</div>
            <div class="mz-wm-s">cierre estimado</div>
          </div>
          <div class="mz-wm" title="Velocidad de entrega: issues cerrados por hora.">
            <div class="mz-wm-l">🚀 VELOCIDAD</div>
            <div class="mz-wm-v">${escapeHtmlText(wave.velocity || '—')} <span class="mz-wm-u">iss/h</span></div>
            <div class="mz-wm-s">media reciente</div>
          </div>
          <div class="mz-wm" title="Issues entregados sobre el total de la ola.">
            <div class="mz-wm-l">📦 ENTREGADOS</div>
            <div class="mz-wm-v">${escapeHtmlText(String(wave.delivered))}<span class="mz-wm-u"> / ${escapeHtmlText(String(wave.total))}</span></div>
            <div class="mz-wm-s">${escapeHtmlText(String(restantes))} restantes</div>
          </div>
        </div>
      </div>
      <div class="mz-mission-prog" title="Avance total de la ola, desglosado por estado de sus issues.">
        <div class="mz-prog-head"><span>AVANCE</span><span class="mz-prog-pct">${escapeHtmlText(String(wave.pct))}%</span></div>
        <div class="mz-prog-bar">
          <i style="width:${Math.max(0, Math.min(100, Number(wave.pct) || 0))}%;background:var(--in-ok,#3fb950)"></i>
        </div>
        <div class="mz-prog-legend">
          <span><i class="mz-dot" style="background:var(--in-ok,#3fb950)"></i> <b>${escapeHtmlText(String(wave.done))}</b> hechos</span>
          <span><i class="mz-dot" style="background:var(--in-info,#58a6ff)"></i> <b>${escapeHtmlText(String(wave.activeCount))}</b> activos</span>
          <span><i class="mz-dot" style="background:var(--in-bad,#f85149)"></i> <b>${escapeHtmlText(String(wave.blocked))}</b> bloq.</span>
          <span><i class="mz-dot" style="background:rgba(255,255,255,.25)"></i> <b>${escapeHtmlText(String(wave.queue))}</b> cola</span>
        </div>
      </div>
    </section>`;
}

// ───────────────────────── CSS del banner de misión ─────────────────────────

// Reglas canónicas `mz-mission*` (extraídas de home.js, idénticas). Las pantallas
// que no incluyen el CSS inline de home/pipeline (p. ej. LOGS, que sólo carga
// theme.css) inyectan esto para rendir el banner correctamente.
const MIZPA_FRAME_CSS = `
/* --- Banner de misión MIZPÁ (marco común #4236 / #4234) --- */
.mz-mission { display: flex; align-items: center; gap: 22px; position: relative; overflow: hidden;
    background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%),
                linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 24px; }
.mz-mission::after { content: "🌊"; position: absolute; right: 18px; top: -14px; font-size: 90px; opacity: .06; }
.mz-wavetag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 96px;
    padding: 10px 14px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.mz-wavetag-k { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #9fe9ee; }
.mz-wavetag-n { font-size: 34px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-mission-text { flex: 1; min-width: 0; }
.mz-mission-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mz-mission-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.mz-mission-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 560px; line-height: 1.45; }
.mz-mission-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
@media (max-width: 1100px) { .mz-mission-metrics { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px)  { .mz-mission-metrics { grid-template-columns: 1fr; } }
.mz-wm { min-width: 0; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07));
    border-radius: 11px; padding: 9px 12px; }
.mz-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.mz-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 600; }
.mz-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 3px; }
.mz-mission-prog { min-width: 280px; }
.mz-prog-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11.5px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; }
.mz-prog-pct { font-size: 26px; font-weight: 800; color: var(--brand-cyan,#34D9E0); font-variant-numeric: tabular-nums; }
.mz-prog-bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); overflow: hidden; display: flex; margin: 9px 0 8px; }
.mz-prog-bar i { height: 100%; transition: width .4s ease; }
.mz-prog-legend { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim,#8A93A6); flex-wrap: wrap; }
.mz-prog-legend span { display: flex; align-items: center; gap: 5px; }
.mz-prog-legend b { font-variant-numeric: tabular-nums; }
.mz-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
/* #4500 — Timeline único de la ola (reemplaza .mz-mission-metrics + .mz-mission-prog).
   Narrativa comienzo→ahora→cierre en UNA línea, con el fill de progreso SOBRE el
   mismo rail, velocidad/entregados como anotaciones y un sparkline de ritmo debajo.
   Sólo tokens de theme.css (cero hex nuevos): fill --in-accent→--in-ok, marcador
   y sparkline --brand-cyan, velocidad --in-ok, entregados --in-info, dim --in-fg-dim. */
.mz-timeline { margin-top: 14px; }
.mz-tl-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.mz-tl-cap { display: flex; flex-direction: column; min-width: 0; }
.mz-tl-cap-mid { align-items: center; }
.mz-tl-cap-eta { align-items: flex-end; text-align: right; }
.mz-tl-cap-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8b949e); }
.mz-tl-cap-v { font-size: 15px; font-weight: 800; margin-top: 2px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-tl-cap-s { font-size: 10px; color: var(--in-fg-dim,#8b949e); margin-top: 2px; }
/* #4588 — línea del ETA descompuesto (firma del operador). */
.mz-tl-cap-decomp { font-size: 10.5px; font-weight: 700; color: var(--brand-cyan,#34D9E0); margin-top: 3px; line-height: 1.35; font-variant-numeric: tabular-nums; max-width: 260px; }
.mz-tl-cap .mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#8b949e); font-weight: 600; }
.mz-tl-cap-mid .mz-prog-pct { font-size: 22px; }
.mz-tl-track { position: relative; margin-top: 34px; height: 8px; }
/* #4532 (re-QA) — VELOCIDAD y ENTREGADOS viven en una fila de flujo normal
   (flex + space-between), NO en la capa absoluta que seguía al marcador "ahora".
   Antes, .mz-tl-annot-vel se posicionaba con left:<avance>% + translateX(-50%) y,
   con avance alto (>=~37%), su borde cruzaba sobre ENTREGADOS (anclada a right:0)
   → texto encimado/ilegible. Con space-between el solape se elimina por
   construcción para cualquier avance; el left:% queda reservado al marcador del rail. */
.mz-tl-annots { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.mz-tl-annot { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; min-width: 0; }
.mz-tl-annot .mz-wm-u { font-size: 10px; color: var(--in-fg-dim,#8b949e); font-weight: 600; }
.mz-tl-annot-vel { color: var(--in-ok,#3fb950); }
.mz-tl-annot-del { color: var(--in-info,#58a6ff); text-align: right; }
.mz-tl-annot-s { color: var(--in-fg-dim,#8b949e); font-weight: 600; font-size: 10px; }
.mz-tl-annot-l { color: var(--in-fg-dim,#8b949e); font-weight: 600; font-size: 10px; letter-spacing: .04em; }
.mz-tl-rail { position: relative; height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); }
.mz-tl-fill { position: absolute; left: 0; top: 0; height: 100%; width: 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--in-accent,#2ee6c1), var(--in-ok,#3fb950)); transition: width .4s ease; }
.mz-tl-now { position: absolute; top: 50%; left: 0; width: 14px; height: 14px; border-radius: 50%;
    background: var(--brand-cyan,#34D9E0); border: 2px solid var(--in-bg-2,#161b22);
    box-shadow: 0 0 0 3px rgba(52,217,224,.25); transform: translate(-50%,-50%); transition: left .4s ease; z-index: 2; }
.mz-spark { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.mz-spark-cap { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8b949e); flex: none; }
.mz-spark-plot { display: block; flex: 1; height: 24px; min-width: 60px; }
.mz-spark-plot .mz-spark-svg { width: 100%; height: 100%; display: block; }
/* #4500 (re-QA #4568) — CA-UX-9: con <2 deltas el sparkline NO reserva la fila de
   24px del plot. La cápsula "📈 RITMO · datos insuficientes" queda en una fila slim
   y el <svg> se colapsa (display:none) en vez de dibujar guiones en 24px de alto
   (espacio muerto que originó el re-QA visual del 2026-07-08). El client togglea
   la clase .mz-spark-empty según haya o no serie de ritmo suficiente. */
.mz-spark-empty .mz-spark-plot { display: none; }
.mz-spark-note { font-size: 10.5px; font-weight: 700; color: var(--brand-cyan,#34D9E0); flex: none; font-variant-numeric: tabular-nums; }
.mz-tl-legend { margin-top: 14px; }
@media (max-width: 880px) {
    .mz-mission { flex-direction: column; align-items: stretch; }
}
`;

module.exports = {
    collectWave,
    formatWaveStart,
    renderBrandBar,
    renderMissionBanner,
    MIZPA_FRAME_CSS,
};
