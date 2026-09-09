// =============================================================================
// reco-banners.js — Banners de la vista de recomendaciones del dashboard V3.
// Issue #5691 (parte 3 de 3 de #5678) · CA E2 y E3.
//
// Vive fuera de `dashboard.js` para que el render sea testeable con
// `node --test` sin levantar el servidor (mismo criterio que
// `lib/dispatch-cause-render.js`).
//
// E2 · Banner de transición
// -------------------------
// El cuerpo original de #5691 pedía este banner sobre el KPI `kpi-needs-human`,
// asumiendo que caería de ~936 a ~13 el día de la migración. Verificado sobre
// el código: ESO NO OCURRE. `kpi-needs-human` se alimenta de
// `state.bloqueados.length` (`dashboard.js`, vía `human-block.listBlockedIssues()`),
// que lee MARKERS DEL FILESYSTEM, no el label de GitHub — `GITHUB_HUMAN_BLOCK_LABELS`
// de `human-block.js` sólo contiene `blocked:routing-manual`. Un banner ahí
// quedaría permanentemente descolgado de la métrica que dice acompañar.
//
// Por eso se toma la opción (a) del CA E2: el banner se coloca en la VISTA DE
// RECOMENDACIONES, que es la que efectivamente cambia el día de la migración.
//
// E3 · Banner de truncamiento
// ---------------------------
// `lib/recommendations.js` lista con `--limit 200` contra un universo de
// recomendaciones abiertas mucho mayor: la vista muestra una fracción y hoy no
// lo dice. El total se computa EN RUNTIME (`cache.totalAbiertas`), nunca como
// constante: la población se movió ~34× en un mes. Resolver el límite
// estructural queda fuera de alcance (#5685); acá sólo se DECLARA.
//
// Seguridad (REQ-SEC-C · A03 stored XSS)
// --------------------------------------
//  · Toda interpolación pasa por `escapeHtmlText`/`escapeHtmlAttr` del helper
//    compartido `lib/escape-html.js` — no se introduce un `esc()` nuevo.
//  · Los conteos pasan por `Number()` y se descartan si no son finitos: vienen
//    de un cache en disco que es entrada no confiable.
//  · El `href` a GitHub se construye con `encodeURIComponent` sobre la query y
//    con el `repo` validado contra `owner/name`; si no valida, no se emite link.
//  · El estado del banner descartable vive en `localStorage`, que también es
//    entrada no confiable: el cliente sólo compara contra un literal y nunca
//    inyecta el valor leído en el DOM.
// =============================================================================

'use strict';

const { escapeHtmlText, escapeHtmlAttr } = require('./escape-html');

// Clave del banner descartable. Versionada: si el copy cambia, cambiar la clave
// vuelve a mostrarlo una vez.
const TRANSITION_BANNER_KEY = 'reco-transicion-5678-v1';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Número seguro para render, o null. El cache es entrada no confiable.
 * @param {*} v
 * @returns {number|null}
 */
function conteoSeguro(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

/**
 * URL de la búsqueda completa de recomendaciones abiertas en GitHub.
 * @param {string} repo
 * @returns {string|null} null si el repo no valida
 */
function urlBusquedaCompleta(repo) {
    if (!REPO_RE.test(String(repo || ''))) return null;
    const q = `repo:${repo} is:open is:issue label:tipo:recomendacion`;
    return `https://github.com/search?q=${encodeURIComponent(q)}&type=issues`;
}

/**
 * Banner de transición de #5678 (E2). Descartable, se muestra una sola vez.
 *
 * No afirma ninguna cifra: la migración se corre en un despliegue separado y la
 * población se mueve. Explica el cambio de modelo, que es lo que el operador
 * necesita para no leer la vista como una avería.
 *
 * @param {{key?:string}} [opts]
 * @returns {string} HTML
 */
function renderTransitionBanner({ key = TRANSITION_BANNER_KEY } = {}) {
    const k = escapeHtmlAttr(key);
    return `<div class="reco-banner reco-banner-transicion" data-banner-key="${k}" hidden>
  <svg class="reco-banner-ic" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-triage-backlog"></use></svg>
  <div class="reco-banner-txt">
    <div class="reco-banner-tit">Las recomendaciones ya no usan <code>needs-human</code> — es el efecto esperado de #5678</div>
    <div class="reco-banner-sub">Ahora esperan en <code>needs:triage-backlog</code>: siguen acá, no bloquean ninguna ola y no notifican. <code>needs-human</code> queda reservado para bloqueos reales, con un agente frenado atrás. <span class="dim">· Se muestra una sola vez y es descartable.</span></div>
  </div>
  <button type="button" class="reco-btn reco-banner-cerrar" onclick="recoDescartarBanner(this)">Entendido</button>
</div>`;
}

/**
 * Banner ámbar de truncamiento (E3). Se emite sólo si el total conocido supera
 * lo mostrado; si el total no se conoce, no se inventa nada.
 *
 * @param {{mostrando:number, total:(number|null), repo?:string}} params
 * @returns {string} HTML ('' si no corresponde)
 */
function renderTruncationBanner({ mostrando, total, repo = 'intrale/platform' } = {}) {
    const n = conteoSeguro(mostrando);
    const m = conteoSeguro(total);
    if (n === null || m === null) return '';
    if (m <= n) return '';
    const href = urlBusquedaCompleta(repo);
    const link = href
        ? `<a class="reco-btn reco-banner-link" href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">Abrir en GitHub ↗</a>`
        : '';
    return `<div class="reco-banner reco-banner-truncado" role="status">
  <div class="reco-banner-txt">
    <div class="reco-banner-tit">Mostrando ${escapeHtmlText(String(n))} de ${escapeHtmlText(String(m))} — la lista está truncada</div>
    <div class="reco-banner-sub">Ordenadas por más recientes. Para ver el resto, abrí la búsqueda completa en GitHub.</div>
  </div>
  ${link}
</div>`;
}

module.exports = {
    TRANSITION_BANNER_KEY,
    conteoSeguro,
    urlBusquedaCompleta,
    renderTransitionBanner,
    renderTruncationBanner,
};
