// =============================================================================
// commander-activity.js — Panel «ACTIVIDAD DEL COMMANDER» del home V3 (#6459).
//
// EL DEFECTO QUE CIERRA
// ---------------------
// El listado de peticiones del Commander con su badge de resultado
// (#3949/#3951) sólo se emitía desde `generateHTML()` de `dashboard.js`, que el
// dispatch sirve ÚNICAMENTE para `/legacy`. El dashboard que abre el operador
// (`/`, `/v3`, `/dashboard`) lo produce `home.js`, que no lo tenía: verificado
// con `curl` sobre el server vivo, esas tres rutas devolvían CERO ocurrencias
// de `cmd-result`. El badge `huerfano` nacía mudo — el mismo escape #4531 que
// CA-9/CA-13 vienen a cerrar.
//
// Este módulo es el render de esa fila en la superficie V3. Los DATOS salen de
// `lib/commander/recent-requests.js` (fuente única compartida con el legacy) y
// los BADGES de `lib/commander/result-badge.js` (fuente única del enum + CSS),
// así que no hay forma de que las dos pantallas divergan.
//
// Anatomía de la fila = mockup acordado, panel C:
//   `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`
//   → id mono a la izquierda, fecha/hora al medio, badge a la derecha, y una
//     barra de acento a la izquierda SÓLO en las filas huérfanas (la señal
//     redundante que el mockup pide para no depender sólo del color).
//
// Require defensivo en el caller: si este módulo falla al cargar, el home
// degrada a un panel inerte visible (patrón CA-A2/CA-A3 del resto de vistas),
// nunca a una página en blanco.
// =============================================================================
'use strict';

const path = require('path');

const recentRequests = require('../../lib/commander/recent-requests');
const resultBadge = require('../../lib/commander/result-badge');

const MAX_ROWS = 8;

function escapeHtmlText(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// dd/mm HH:MM en hora local del kiosk. `epochms === 0` (nombre sin timestamp
// parseable) ⇒ guión: no inventamos una fecha.
function fmtWhen(epochms) {
    if (!epochms) return '—';
    const d = new Date(epochms);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/**
 * CSS del panel. Incluye el bloque de badges desde su fuente única
 * (`RESULT_BADGE_CSS`): sin eso el badge renderiza sin color ni borde, que es
 * la mitad silenciosa del defecto.
 */
function commanderActivityStyles() {
    return resultBadge.RESULT_BADGE_CSS + `

/* #6459 — Panel de actividad del Commander (home V3). */
.cmd-act-list{display:flex;flex-direction:column;gap:6px}
.cmd-act-row{
  display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:12px;
  padding:8px 12px;border-radius:var(--in-radius-sm,8px);
  background:var(--in-bg-3,#1f2937);border:1px solid var(--in-border,#30363d);
  border-left:3px solid transparent;
  text-decoration:none;color:var(--in-fg,#e6edf3);transition:background 0.15s;
}
.cmd-act-row:hover{background:var(--in-bg,#0d1117)}
/* Señal redundante del mockup: barra de acento + borde teñido, no sólo el
   color del badge (WCAG 1.4.1 — nunca sólo color). */
.cmd-act-row-huerfano{
  border-left-color:var(--result-huerfano,#FF6B8A);
  border-color:var(--result-huerfano-dim,#B8254A);
}
.cmd-act-id{
  font-family:"SF Mono",Consolas,"Liberation Mono",Menlo,Monaco,monospace;
  font-size:12px;color:var(--in-fg-dim,#8b949e);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cmd-act-when{font-size:12px;color:var(--in-fg-dim,#8b949e);white-space:nowrap}
.cmd-act-badges{display:inline-flex;align-items:center;white-space:nowrap}
.cmd-act-nobadge{font-size:11px;color:var(--in-fg-soft,#6e7681);white-space:nowrap}
.cmd-act-empty{padding:14px 12px;font-size:12px;color:var(--in-fg-dim,#8b949e)}
`;
}

/**
 * Filas del panel (sin el `<section>` contenedor). Expuesto aparte para poder
 * testear el HTML de la lista sin arrastrar el chrome del panel.
 *
 * @param {string} logDir directorio de logs del pipeline.
 * @param {number} [limit]
 * @param {object} [deps] inyección `{ fs, path }` para tests.
 */
function renderCommanderActivityRows(logDir, limit, deps) {
    let items = [];
    try {
        items = recentRequests.listRecentRequests(logDir, limit || MAX_ROWS, deps);
    } catch {
        items = [];
    }

    if (!items.length) {
        return '<div class="cmd-act-empty">sin peticiones registradas</div>';
    }

    const rows = items.map((it) => {
        let badges = '';
        try { badges = resultBadge.buildResultBadges(it.meta, escapeHtmlText); }
        catch { badges = ''; }

        const isHuerfano = !!(it.meta && it.meta.resultado === 'huerfano');
        const cls = 'cmd-act-row' + (isHuerfano ? ' cmd-act-row-huerfano' : '');
        // Sin badge la fila lo DICE. El mockup es explícito: una fila muda debe
        // volver a significar una sola cosa — "no hay dato" — y no "se perdió
        // la respuesta".
        const right = badges
            ? '<span class="cmd-act-badges">' + badges + '</span>'
            : '<span class="cmd-act-nobadge">(sin badge)</span>';

        return '<a class="' + cls + '" href="/logs/view/' + encodeURIComponent(it.file) + '"'
            + ' target="_blank" rel="noopener noreferrer" title="' + escapeHtmlText(it.id) + '">'
            + '<span class="cmd-act-id">' + escapeHtmlText(it.id) + '</span>'
            + '<span class="cmd-act-when">' + escapeHtmlText(fmtWhen(it.epochms)) + '</span>'
            + right
            + '</a>';
    }).join('');

    return '<div class="cmd-act-list">' + rows + '</div>';
}

/**
 * Panel completo, listo para interpolar en el home V3.
 * @param {{logDir?:string, limit?:number, deps?:object}} [opts]
 */
function renderCommanderActivity(opts) {
    const o = opts || {};
    // `__dirname` ⇒ `.pipeline/views/dashboard`; el logDir vive en `.pipeline/logs`.
    // Nada de `process.cwd()` / `process.env` acá (CA-3725.6 del home).
    const logDir = o.logDir || path.join(__dirname, '..', '..', 'logs');
    const rows = renderCommanderActivityRows(logDir, o.limit || MAX_ROWS, o.deps);
    return `
    <section class="mz-panel mz-cmd-act" aria-label="Últimas peticiones atendidas por el Commander">
      <div class="mz-panel-head">
        <div class="mz-panel-t" title="Últimas peticiones que atendió el Commander, con el resultado de cada una. ∅ huérfano = se ejecutó y su respuesta nunca se confirmó como entregada.">
          <span class="mz-panel-ic">💬</span> ACTIVIDAD DEL COMMANDER
        </div>
        <div class="mz-panel-hint">últimas ${MAX_ROWS}</div>
      </div>
      ${rows}
    </section>`;
}

/** Fallback inerte VISIBLE si el módulo o el render fallan (CA-A3 / CA-14). */
function renderInert(reason) {
    return `
    <section class="mz-panel mz-cmd-act" aria-label="Actividad del Commander no disponible">
      <div class="mz-panel-head">
        <div class="mz-panel-t"><span class="mz-panel-ic">💬</span> ACTIVIDAD DEL COMMANDER</div>
      </div>
      <div class="cmd-act-empty">No se pudo leer la actividad del Commander: ${escapeHtmlText(reason || 'error de render')}</div>
    </section>`;
}

module.exports = {
    renderCommanderActivity,
    renderCommanderActivityRows,
    commanderActivityStyles,
    renderInert,
    MAX_ROWS,
};
