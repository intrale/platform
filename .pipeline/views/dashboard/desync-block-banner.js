'use strict';

// =============================================================================
// desync-block-banner.js — Banner "Dispatch suspendido por desync" (#5724 CA-4).
//
// POR QUÉ ES UN COMPONENTE Y NO MARKUP EMBEBIDO
// ---------------------------------------------
// El semáforo de sync allowlist↔ola (#4375) se implementó como un pill dentro
// de `views/dashboard/pipeline.js`, módulo que sólo se renderiza desde el
// catch-all legacy de `dashboard.js`. Ninguna de las rutas del menú del
// dashboard pasa por ahí, así que el operador nunca lo vio: el 2026-08-09 el
// dispatch estuvo ~10 h suspendido y la vista Inicio seguía diciendo "No hay
// agentes corriendo. Verificar pausa parcial, cola y blocked:dependencies" —
// las tres causas equivocadas.
//
// El banner vive acá para poder montarse en las superficies que el operador
// SÍ usa (Inicio `/` y Pipeline `/pipeline`) sin duplicar markup, estilos ni
// hidratación. El copy sale de `lib/desync-copy.js`, compartido también con el
// pill del panel Pipeline: ninguna superficie inventa texto propio.
//
// CONTRATO
// --------
//   renderDesyncBlockBannerSsr(desyncStatus) -> HTML de la barra (SSR REAL: con
//       el bloqueo activo el texto viaja en el HTML, sin depender de JS, para
//       que `curl` lo vea; sin bloqueo emite el contenedor vacío con los ids
//       invariantes y `data-active="false"`, que ocupa 0px).
//   DESYNC_BLOCK_BANNER_CSS -> estilos (tokens del design system, cero colores
//       hardcodeados).
//   desyncBlockBannerClientScript() -> hidratación: `tickDesyncBlock()` contra
//       /api/dash/desync-status. El host la registra en su tabla de polls.
// =============================================================================

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const desyncCopy = require('../../lib/desync-copy.js');

// Resolución del estado para el SSR. El caller puede pasarlo precomputado; si
// no, lo leemos acá. Es a propósito: que ninguna superficie quede sin banner
// por olvido del call-site — este criterio ya falló una vez por depender de
// una superficie que nadie visitaba. El slice es READ-ONLY (skipFlag/skipAlert)
// y el require es perezoso + envuelto: si el módulo no carga, la página
// renderiza igual (sin banner) en vez de romper.
// Caché de 2 s. Antes esto era UNA lectura por request del endpoint; ahora el
// SSR lo resuelve en cada render de cada ventana (19 superficies), y cada
// resolución es I/O sincrónico sobre waves/partial-pause/flag. 2 s es más corto
// que el poll del cliente (15 s), así que no cambia la frescura observable: el
// banner sigue actualizándose por hidratación, y una recarga manual nunca ve
// datos de más de 2 s. `explicit` (el call-site que ya lo tiene precomputado)
// sigue teniendo prioridad y no toca la caché.
// `_dsbCacheLleno` en vez de comparar `_dsbCache !== null`: el estado degradado
// (slice caído → null) también se cachea. Si no, justo el caso que más I/O
// desperdicia sería el único que reintenta en cada render de cada ventana.
const _DSB_TTL_MS = 2000;
let _dsbCache = null;
let _dsbCacheLleno = false;
let _dsbCacheAt = 0;
function resolveDesyncStatus(explicit) {
    if (explicit && typeof explicit === 'object') return explicit;
    const ahora = Date.now();
    if (_dsbCacheLleno && (ahora - _dsbCacheAt) < _DSB_TTL_MS) return _dsbCache;
    let valor = null;
    try {
        const slices = require('../../lib/dashboard-slices.js');
        if (slices && typeof slices.desyncStatusSlice === 'function') {
            valor = slices.desyncStatusSlice({}, {});
        }
    } catch {
        valor = null;
    }
    _dsbCache = valor;
    _dsbCacheLleno = true;
    _dsbCacheAt = ahora;
    return valor;
}

// Helper de test: invalida la caché para que cada caso arranque limpio.
function _resetDesyncStatusCacheForTests() {
    _dsbCache = null;
    _dsbCacheLleno = false;
    _dsbCacheAt = 0;
}

function _chipsSsr(chips) {
    if (!Array.isArray(chips) || chips.length === 0) return '';
    return chips.map((c) => {
        if (c.tipo === 'add') return '<span class="dsb-chip dsb-chip-add">+#' + escapeHtmlText(String(c.issue)) + '</span>';
        if (c.tipo === 'rem') return '<span class="dsb-chip dsb-chip-rem">−#' + escapeHtmlText(String(c.issue)) + '</span>';
        return '<span class="dsb-chip dsb-chip-more" title="' + escapeHtmlAttr(`${c.ocultos} issues más en la divergencia`) + '">+' + escapeHtmlText(String(c.ocultos)) + ' más</span>';
    }).join('');
}

// El CTA apunta a `/pipeline`, la ruta REAL de la ventana Pipeline según el
// catálogo de nav-tabs. Ojo con `/dashboard?view=pipeline`: ese slug no existe
// en VIEW_SLUGS y caería al fallback de home — el mismo tipo de link a ninguna
// parte que dejó este criterio inerte.
const DSB_CTA_HREF = '/pipeline';

function renderDesyncBlockBannerSsr(desyncStatus) {
    const p = desyncCopy.buildDesyncPresentation(desyncStatus);
    // Sólo el bloqueo REAL (flag puesto) se lleva la barra full-width. Una
    // divergencia que el Pulpo resuelve solo no frena nada y no debe gastar el
    // peso visual de una alarma: si todo alarma, nada alarma. Los estados no
    // bloqueantes siguen viviendo en el semáforo del panel Pipeline.
    if (p.bloqueado !== true) {
        return `
  <section class="desync-block-banner" id="desync-block-banner" role="status" aria-live="polite" aria-hidden="true" data-active="false">
    <div class="desync-block-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img"><use href="#ic-pause-lock"></use></svg>
    </div>
    <div class="desync-block-content">
      <div class="desync-block-title" id="desync-block-title"></div>
      <div class="desync-block-detail" id="desync-block-detail"></div>
      <div class="desync-block-chips" id="desync-block-chips"></div>
      <div class="desync-block-accion" id="desync-block-accion"></div>
    </div>
    <a class="desync-block-cta" id="desync-block-cta" href="${DSB_CTA_HREF}"
       title="Abrir la ventana Pipeline para comparar la allowlist con la ola activa">Ver allowlist ↔ ola</a>
  </section>`;
    }
    return `
  <section class="desync-block-banner" id="desync-block-banner" role="${escapeHtmlAttr(p.role)}" aria-live="assertive"
           aria-label="${escapeHtmlAttr(p.ariaFull)}" data-active="true">
    <div class="desync-block-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img"><use href="#ic-${escapeHtmlAttr(p.icon)}"></use></svg>
    </div>
    <div class="desync-block-content">
      <div class="desync-block-title" id="desync-block-title">${escapeHtmlText(p.label)}</div>
      <div class="desync-block-detail" id="desync-block-detail">${escapeHtmlText(p.detail)}</div>
      <div class="desync-block-chips" id="desync-block-chips">${_chipsSsr(p.chips)}</div>
      <div class="desync-block-accion" id="desync-block-accion">${escapeHtmlText(p.accion)}</div>
    </div>
    <a class="desync-block-cta" id="desync-block-cta" href="${DSB_CTA_HREF}"
       title="Abrir la ventana Pipeline para comparar la allowlist con la ola activa">Ver allowlist ↔ ola</a>
  </section>`;
}

// Estilos. Misma mecánica que `quota-exhausted-banner`: barra full-width bajo
// el header, `data-active` gobierna el display, 0px cuando no aplica. Usa el
// rojo --danger del design system y no el ámbar de la cuota: esto no es una
// degradación parcial, el pipeline entero deja de lanzar agentes.
//
// CADENA DE FALLBACK DEL ROJO (#5724 rev-3, defecto B1)
// -----------------------------------------------------
// `--danger` / `--danger-bg` se definen en UN SOLO archivo (assets/design-tokens.css)
// y 10 de las 16 ventanas que montan este banner NO lo cargan: sólo cargan
// `views/dashboard/theme.css`, que no define esos tokens. Con `var(--danger)` a
// secas la declaración es *invalid at computed-value time* y se caían background,
// border, border-left, color del ícono, chips, borde del CTA y outline del focus:
// el banner quedaba texto plano justo donde tiene que gritar.
//
// La cadena se resuelve UNA vez acá y se expone como alias local para que ningún
// call-site futuro pueda volver a olvidarla:
//   --danger  (design-tokens.css) → --in-bad      (theme.css) → literal
// El literal final es el mismo #F85149 de design-tokens.css, así que las tres
// ramas pintan idéntico; sólo cambia de dónde sale. Consecuencia: el banner es
// AUTOSUFICIENTE — se ve rojo en cualquier shell, cargue o no design-tokens.css.
const DESYNC_BLOCK_BANNER_CSS = `
.desync-block-banner {
    --dsb-danger: var(--danger, var(--in-bad, #f85149));
    --dsb-danger-bg: var(--danger-bg, var(--in-bad-soft, rgba(248, 81, 73, 0.14)));
    display: none;
    margin: 0 22px 10px;
    padding: 14px 18px;
    background: var(--dsb-danger-bg);
    color: var(--text-primary, var(--in-fg));
    border: 1px solid var(--dsb-danger);
    border-left: 4px solid var(--dsb-danger);
    border-radius: var(--in-radius, 8px);
    font-size: 13px;
    line-height: 1.4;
    grid-template-columns: auto 1fr auto;
    column-gap: 16px;
    align-items: center;
}
.desync-block-banner[data-active="true"] { display: grid; }
.desync-block-icon { width: 28px; height: 28px; flex: 0 0 28px; color: var(--dsb-danger); }
.desync-block-icon svg { width: 100%; height: 100%; fill: currentColor; }
.desync-block-content { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.desync-block-title {
    font-size: 14px; font-weight: 700; letter-spacing: 0.2px;
    color: var(--text-primary, var(--in-fg));
}
.desync-block-detail {
    font-size: 12px; word-break: break-word;
    color: var(--text-secondary, var(--in-fg-dim));
}
/* La acción concreta, separada del diagnóstico: un banner que sólo describe el
 * problema deja al operador adivinando qué hacer con él. */
.desync-block-accion {
    font-size: 11px; opacity: 0.85;
    color: var(--text-secondary, var(--in-fg-dim));
}
.desync-block-accion:empty { display: none; }
.desync-block-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.desync-block-chips:empty { display: none; }
.dsb-chip {
    display: inline-flex; align-items: center;
    border-radius: 12px; padding: 2px 9px;
    font-size: 11px; font-weight: 700;
    font-variant-numeric: tabular-nums;
    font-family: var(--in-mono, 'Roboto Mono', monospace);
    border: 1px solid var(--border, var(--in-border));
    background: var(--surface-1, var(--in-bg-2));
    color: var(--text-secondary, var(--in-fg-dim));
}
/* La dirección de la divergencia se lee por el signo y la posición, nunca sólo
 * por color (WCAG AA): el chip sigue diciendo lo mismo en monocromo. */
.dsb-chip-rem { border-color: var(--dsb-danger); color: var(--dsb-danger); }
.dsb-chip-add { border-color: var(--border-strong, var(--in-border)); color: var(--text-primary, var(--in-fg)); }
.dsb-chip-more { font-weight: 500; opacity: 0.85; }
.desync-block-cta {
    justify-self: end; white-space: nowrap;
    font-size: 12px; font-weight: 700; text-decoration: none;
    color: var(--text-primary, var(--in-fg));
    border: 1px solid var(--dsb-danger);
    border-radius: var(--in-radius, 8px);
    padding: 7px 14px;
    background: transparent;
}
.desync-block-cta:hover { background: var(--dsb-danger-bg); }
.desync-block-cta:focus-visible { outline: 2px solid var(--dsb-danger); outline-offset: 2px; }
/* En los satélites el banner es hijo directo del frame y se alinea con el
 * padding horizontal del cuerpo (mismo criterio que el banner de ola). */
.satellite-frame > .desync-block-banner { margin: 18px 28px 0; }
`;

// Hidratación. La decisión de copy llega YA RESUELTA en `d.presentacion`
// (calculada server-side por lib/desync-copy.js): el cliente no reimplementa el
// mapeo estado→texto, que es exactamente cómo el pill del panel Pipeline y el
// renderer del monolito terminaron pudiendo divergir.
//
// SEC: todo por textContent / createElement, cero innerHTML con datos del
// endpoint. No depende de que el shell inyecte nada: el acceso HTTP pasa por
// `_dsbFetchStatus()`, que usa `fetchJson` (FETCH_CLIENT_JS) si está y cae a
// `fetch` nativo si no — ver el comentario de esa función.
function desyncBlockBannerClientScript() {
    return `
function _dsbSetActive(banner, activo){
    banner.dataset.active = activo ? 'true' : 'false';
    // Bloqueante ⇒ role="alert" (assertive): un estado que frena el pipeline
    // entero no espera a que el lector de pantalla termine la frase anterior.
    banner.setAttribute('role', activo ? 'alert' : 'status');
    banner.setAttribute('aria-live', activo ? 'assertive' : 'polite');
    if(activo) banner.removeAttribute('aria-hidden');
    else banner.setAttribute('aria-hidden', 'true');
}
function _dsbText(id, txt){
    const el = document.getElementById(id);
    if(el) el.textContent = txt || '';
}
function renderDesyncBlockBanner(d){
    const banner = document.getElementById('desync-block-banner');
    if(!banner) return;
    const p = (d && d.presentacion) || null;
    const bloqueado = !!(p && p.bloqueado);
    const chipsBox = document.getElementById('desync-block-chips');
    if(!bloqueado){
        _dsbSetActive(banner, false);
        banner.removeAttribute('aria-label');
        _dsbText('desync-block-title', '');
        _dsbText('desync-block-detail', '');
        _dsbText('desync-block-accion', '');
        if(chipsBox) chipsBox.textContent = '';
        return;
    }
    _dsbSetActive(banner, true);
    banner.setAttribute('aria-label', p.ariaFull || p.label || '');
    // Sin fallback literal del label: el texto del bloqueo NO debe existir en
    // el HTML cuando no hay bloqueo, o \`curl | grep\` matchea de mentira y la
    // verificación de esta superficie vuelve a dar un falso verde.
    _dsbText('desync-block-title', p.label || '');
    _dsbText('desync-block-detail', p.detail || '');
    _dsbText('desync-block-accion', p.accion || '');
    if(chipsBox){
        chipsBox.textContent = '';
        const chips = Array.isArray(p.chips) ? p.chips : [];
        for(const c of chips){
            const el = document.createElement('span');
            if(c.tipo === 'more'){
                el.className = 'dsb-chip dsb-chip-more';
                el.textContent = '+' + c.ocultos + ' más';
                el.title = c.ocultos + ' issues más en la divergencia';
            } else {
                el.className = 'dsb-chip ' + (c.tipo === 'add' ? 'dsb-chip-add' : 'dsb-chip-rem');
                el.textContent = (c.tipo === 'add' ? '+#' : '−#') + c.issue;
            }
            chipsBox.appendChild(el);
        }
    }
}
// El empty-state de "AHORA · EN EJECUCIÓN" mandaba a revisar pausa parcial,
// cola y blocked:dependencies. Con el dispatch suspendido por desync esas tres
// son la causa equivocada y el operador va a mirar donde no está el problema
// (fue lo que pasó durante las 10 h del incidente). El texto correcto lo
// decide el server (presentacion.emptyState).
function _dsbApplyEmptyState(d){
    const msg = document.querySelector('#active-empty .active-empty-msg');
    if(!msg) return;
    const p = (d && d.presentacion) || null;
    if(p && typeof p.emptyState === 'string' && p.emptyState) msg.textContent = p.emptyState;
}
// Cliente HTTP propio del banner (#5724 rev-3, defecto B2).
//
// Antes esto llamaba directo a \`fetchJson\` (FETCH_CLIENT_JS). Tres ventanas que
// SÍ montan el bundle no inyectan ese helper (logs, multi-provider-coverage,
// onboarding-wizard): \`tickDesyncBlock()\` tiraba ReferenceError, el
// \`.catch(function(){})\` del scheduler se lo tragaba y quedaba un setInterval de
// 15 s que no hacía nada nunca. Si el bloqueo arrancaba con el operador parado
// en Logs no se enteraba hasta recargar — el escenario exacto del incidente.
//
// Ahora el bundle es AUTOSUFICIENTE: usa \`fetchJson\` cuando el shell lo tiene
// (así conserva la señal de dato desactualizado que ese helper ya maneja) y cae
// a \`fetch\` nativo cuando no. Cualquier shell nuevo que monte el bundle hereda
// el poll vivo sin tener que acordarse de inyectar nada.
async function _dsbFetchStatus(){
    if (typeof fetchJson === 'function') return await fetchJson('/api/dash/desync-status');
    try {
        const r = await fetch('/api/dash/desync-status', { headers: { 'Accept': 'application/json' } });
        if (!r || !r.ok) return null;
        return await r.json();
    } catch (_) {
        return null;
    }
}
async function tickDesyncBlock(){
    const d = await _dsbFetchStatus();
    // Endpoint caído: NO apagamos el banner. Un bloqueo real que desaparece de
    // la pantalla porque falló un fetch es peor que un banner viejo — de la
    // señal de dato desactualizado ya se encarga fetchJson.
    if(!d) return;
    renderDesyncBlockBanner(d);
    _dsbApplyEmptyState(d);
}
`;
}

// Scheduler propio del banner. Los satélites no comparten una tabla de polls
// (cada vista arma la suya), así que el bundle trae su propio setInterval. 15s:
// el estado no cambia rápido —lo escribe el Pulpo al evaluar la divergencia—
// pero frena el pipeline entero y no puede quedar detrás de un poll lento.
// Defensivo de punta a punta: el `.catch` cubre un endpoint caído o un shell
// raro dejando el SSR (correcto al cargar la página) en vez de romper la
// ventana entera. Ojo: ese `.catch` es una red de seguridad, NO una licencia
// para que el tick dependa de globals del shell — un tick que siempre tira se
// vuelve invisible acá dentro (fue el defecto B2). Ver `_dsbFetchStatus()`.
const DESYNC_BLOCK_SCHEDULER_JS = `
if (typeof tickDesyncBlock === 'function') {
    tickDesyncBlock().catch(function(){});
    setInterval(function(){ tickDesyncBlock().catch(function(){}); }, 15000);
}`;

// Bundle listo para pegar en el <script> de cualquier shell: hidratación +
// scheduler. Un solo punto de montaje por ventana.
function desyncBlockBannerBundleJs() {
    return desyncBlockBannerClientScript() + '\n' + DESYNC_BLOCK_SCHEDULER_JS;
}

// Montaje de UNA sola llamada (#5724 rev-3, defecto B3).
//
// El montaje "clásico" son 3 puntos de edición por ventana (CSS al <head>, SSR
// al body, bundle al <script>). Con 16 ventanas y 3 dialectos de shell distintos
// eso ya se olvidó tres veces: wizard-descanso, wizard-ola y wizard-providers
// emitían documento completo con nav-tabs y no montaban NADA — el operador que
// entraba a crear una ola no veía que el dispatch estaba suspendido.
//
// Este helper devuelve el bloque entero autocontenido (style + markup + script)
// para pegar en una línea después de `${navHtml}`. Los shells que ya hacen el
// montaje en 3 puntos NO deben usarlo además: duplicaría los ids del banner.
function renderDesyncBlockMountHtml(desyncStatus) {
    return '<style>' + DESYNC_BLOCK_BANNER_CSS + '</style>\n'
        + renderDesyncBlockBannerSsr(resolveDesyncStatus(desyncStatus)) + '\n'
        + '<script>' + desyncBlockBannerBundleJs() + '</script>';
}

module.exports = {
    resolveDesyncStatus,
    renderDesyncBlockBannerSsr,
    renderDesyncBlockMountHtml,
    DESYNC_BLOCK_BANNER_CSS,
    desyncBlockBannerClientScript,
    desyncBlockBannerBundleJs,
    DESYNC_BLOCK_SCHEDULER_JS,
    DSB_CTA_HREF,
    _resetDesyncStatusCacheForTests,
};
