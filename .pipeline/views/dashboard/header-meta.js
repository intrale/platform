'use strict';

// ============================================================================
// Issue #4463 — Encabezado común: pills de CPU/RAM y uptime del Pulpo + hora
// ----------------------------------------------------------------------------
// Modulo compartido entre home.js y satellites.js. Es el espejo de nav-tabs.js
// para las PILLS del header (no para la nav). Centraliza:
//   1. renderHeaderMetaSsr({ withMode }): markup SSR del <div class="in-header-meta">
//      con las tres pills invariantes (#hdr-resources, #hdr-pulpo, #hdr-clock) y,
//      cuando `withMode` es true, la pill de estado del pipeline (#hdr-mode).
//   2. headerPillsClientScript(): script cliente (STRING) que define
//      window.__hydrateHeaderPills(d) — la lógica de coloreo/umbrales de la pill
//      de recursos (in-pill-ok/warn/bad) y de la pill del Pulpo, UNIFICADA para
//      home y satélites (evita el drift entre dos tickHeader duplicados).
//
// Contexto del problema (issue #4463):
//   - Antes, home.js armaba su propio <div class="in-header-meta"> con las tres
//     pills, y satellites.js armaba OTRO con sólo #hdr-mode + #hdr-clock. Las
//     pills de CPU/RAM y uptime del Pulpo NO existían en los satélites → header
//     inconsistente entre Inicio y Pipeline/Roadmap/Providers. Este módulo emite
//     el MISMO markup en ambos y comparte la hidratación.
//
// Por qué módulo separado (misma razón que nav-tabs.js):
//   - satellites.js no requiere a home.js ni viceversa. Exportar el render desde
//     home.js obligaría a un ciclo de require. header-meta.js queda chico y con
//     una única responsabilidad.
//
// Seguridad (SEC-1 / FE-SEC-4, comment de security en #4463):
//   - El SSR es 100% literal estático: IDs, title y aria-label son constantes
//     hardcoded. Nunca se interpola dato dinámico del slice /api/dash/header en
//     el markup del servidor.
//   - La hidratación usa SIEMPRE .textContent / .classList / .title (property).
//     PROHIBIDO innerHTML sobre datos del slice. Los emojis son prefijos string
//     estáticos concatenados a valores numéricos vía textContent — sin XSS.
//
// Contratos preservados (no romper):
//   - IDs literales hdr-resources / hdr-pulpo / hdr-clock / hdr-mode
//     (snapshot R-G1 en __tests__/home.test.js; tickers de home y satélites).
// ============================================================================

// renderHeaderMetaSsr(opts)
//   opts.withMode (bool, default false): si true, antepone la pill de estado del
//     pipeline (#hdr-mode). home NO la muestra en el header visible (vive en el
//     sink oculto, #4227) → withMode:false. Los satélites SÍ la muestran →
//     withMode:true.
//   Devuelve el HTML del <div class="in-header-meta"> con orden estable:
//     [mode?] → recursos → pulpo → reloj (guideline UX-3: mismo orden y gap en
//     todas las vistas).
// #6708 — El espacio libre en disco viaja en la MISMA pill que CPU/RAM
// (#hdr-resources-disk). Va acá y no sólo en la system card del home porque esa
// card vive en el sink de telemetría oculto (mz-telemetry-sink, display:none
// desde #4227): existe en el DOM para mantener vivos los tickers, pero el
// operador no la ve. Esta pill es la superficie que SÍ se ve, y la comparten
// home y todos los satélites, así que el dato llega a cada pantalla.
function renderHeaderMetaSsr(opts) {
    const withMode = !!(opts && opts.withMode);
    // Todos los atributos son literales hardcoded. NO concatenar con datos
    // externos / query params / slice. Placeholder "…" hasta la 1ª hidratación.
    const modePill = withMode
        ? '<span class="in-pill" id="hdr-mode">…</span>\n      '
        : '';
    return `
    <div class="in-header-meta">
      <span class="in-pill in-build-status in-pill-info" id="bld-status"
            title="Estado del último build (marker local .pipeline/build-status.json, sin gh api)."
            aria-label="Build sin datos"><span class="in-status-dot" aria-hidden="true">○</span><span id="bld-status-label">Build sin datos</span></span>
      ${modePill}<span class="in-pill" id="hdr-resources" title="CPU, RAM y disco del sistema" aria-label="Recursos CPU, RAM y disco">
        <span aria-hidden="true">🖥</span>
        <span id="hdr-resources-cpu">CPU …</span>
        <span class="in-header-divider" aria-hidden="true">·</span>
        <span id="hdr-resources-mem">RAM …</span>
        <span class="in-header-divider" aria-hidden="true">·</span>
        <span id="hdr-resources-disk">Disco …</span>
      </span>
      <span class="in-pill" id="hdr-pulpo" aria-label="Estado del pulpo">…</span>
      <span class="in-pill in-clock" id="hdr-clock" aria-label="Fecha y hora local">…</span>
    </div>`;
}

// headerPillsClientScript()
//   Devuelve el script cliente (STRING) que define window.__hydrateHeaderPills(d)
//   con la lógica compartida de las pills de recursos y del Pulpo. Se inyecta una
//   sola vez dentro del <script> principal de home.js y de satellites.js (ambos
//   comparten este módulo), después de que fmtDur() esté definido en ese scope.
//
//   Idempotente: guard `window.__hydrateHeaderPills` para no redefinir en
//   re-render (mismo patrón que navMoreAutoCloseClientScript).
//
//   `d` es el slice de GET /api/dash/header (CPU%, RAM%, pulpoAlive,
//   pulpoUptimeMs, resources.{cpuPercent,memPercent,maxCpu,maxMem,...}).
//
//   Umbrales (idénticos a los históricos de home.js, no se cambia el cálculo):
//     - cpu>maxCpu || mem>maxMem  → in-pill-bad
//     - max(cpu,mem) > 50         → in-pill-warn
//     - resto                     → in-pill-ok
//
//   SEC-1: sólo .textContent / .classList / .title (property). Sin innerHTML.
function headerPillsClientScript() {
    return `
// #5176 CA-UX-3 — rótulo canónico de la ventana de dispatch, espejo client-side
// de lib/dispatch-window-label.js. Se define ANTES (y fuera) del guard de
// __hydrateHeaderPills porque lo consumen también las vistas que arman su
// propia pill de modo (home.js mantiene un menú desplegable dentro de #hdr-mode
// y por eso no delega el textContent en el hidratador compartido).
if (typeof window !== 'undefined' && !window.__dispatchWindowLabel) {
    window.__dispatchWindowLabel = function (allowedIssues, allowedSkills) {
        var nIssues = Array.isArray(allowedIssues) ? allowedIssues.length : 0;
        var nSkills = Array.isArray(allowedSkills) ? allowedSkills.length : 0;
        var parts = [];
        if (nIssues > 0) parts.push(nIssues + ' issues');
        if (nSkills > 0) parts.push(nSkills + ' skills');
        if (parts.length === 0) return '0 issues';
        return parts.join(' · ');
    };
}
// #6708 — Emoji por nivel de disco. Espejo client-side de LEVEL_EMOJI de
// lib/disk-guard.js: la severidad se comunica por forma además de por color.
var __DISK_EMOJI = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴', unknown: '⚪' };
// #6708 (rebote rev-1) — Espejo client-side de LEVEL_LABELS de lib/disk-guard.js.
// El escalón se muestra como TEXTO, no sólo como color/emoji: el operador tiene
// que poder leer "ALERTA" sin pasar el mouse por encima (el tooltip no existe
// en táctil y no lo anuncia un lector de pantalla).
var __DISK_LABEL = { green: 'NORMAL', yellow: 'ATENCIÓN', orange: 'ALERTA', red: 'CRÍTICO', unknown: 'SIN DATO' };
if (typeof window !== 'undefined' && !window.__hydrateHeaderPills) {
    // Formateo de uptime autocontenido (idéntico a fmtDur de home/satélites) para
    // que el helper sea portable a vistas que no definen fmtDur (providers, roadmap).
    var __fmtUptime = function (ms) {
        if (!ms || ms < 0) return '—';
        var s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60), r = s % 60;
        if (m < 60) return m + 'm ' + r + 's';
        var h = Math.floor(m / 60), rm = m % 60;
        return h + 'h ' + rm + 'm';
    };
    window.__hydrateHeaderPills = function (d) {
        if (!d) return;
        var buildPill = document.getElementById('bld-status');
        if (buildPill) {
            var status = d.build && d.build.status ? d.build.status : 'unknown';
            var buildMeta = {
                passing: { cls: 'in-pill-ok', dot: '🟢', label: 'Build OK' },
                failing: { cls: 'in-pill-bad', dot: '🔴', label: 'Build roto' },
                running: { cls: 'in-pill-warn', dot: '🟡', label: 'Build corriendo' },
                unknown: { cls: 'in-pill-info', dot: '○', label: 'Build sin datos' }
            };
            var bm = buildMeta[status] || buildMeta.unknown;
            buildPill.classList.remove('in-pill-ok', 'in-pill-warn', 'in-pill-bad', 'in-pill-info');
            buildPill.classList.add(bm.cls);
            var dot = buildPill.querySelector('.in-status-dot');
            var labelEl = document.getElementById('bld-status-label');
            if (dot) dot.textContent = bm.dot;
            if (labelEl) labelEl.textContent = bm.label;
            var detail = [];
            if (d.build && d.build.branch) detail.push(d.build.branch);
            if (d.build && d.build.commit) detail.push(d.build.commit);
            buildPill.title = 'Estado del último build (marker local .pipeline/build-status.json, sin gh api). '
                + bm.label + (detail.length ? ' · ' + detail.join(' · ') : '');
            buildPill.setAttribute('aria-label', bm.label + (detail.length ? ' ' + detail.join(' ') : ''));
        }
        // Pill de estado del pipeline (#hdr-mode) — sólo presente con withMode:true
        // (satélites). Se hidrata acá para que la bandeja unificada quede
        // completa con una sola llamada (evita tickers de mode duplicados por
        // vista). SEC-1: sólo .classList / .textContent (property sinks seguros).
        var modePill = document.getElementById('hdr-mode');
        if (modePill) {
            modePill.classList.remove('in-mode-running', 'in-mode-paused', 'in-mode-partial');
            var modeLabel;
            if (d.mode === 'paused') {
                modePill.classList.add('in-mode-paused');
                modeLabel = '⏸ Pausado';
            } else if (d.mode === 'partial_pause') {
                // #5176 CA-UX-3 — una ventana por skill se rotula por SKILLS.
                // Antes: 'Parcial · 0 issues', indistinguible de una pausa
                // parcial vacía (que sí equivale a running normal).
                modePill.classList.add('in-mode-partial');
                modeLabel = '⏸ Parcial · ' + window.__dispatchWindowLabel(d.allowedIssues, d.allowedSkills);
            } else {
                modePill.classList.add('in-mode-running');
                modeLabel = '🟢 Running';
            }
            // Sólo reemplazar el texto cuando la pill NO tiene estructura hija que
            // la vista gestione por su cuenta (ej. home mantiene un menú desplegable
            // #hdr-mode-menu dentro de la pill oculta). textContent borraría ese
            // menú; en ese caso dejamos el texto a la lógica propia de la vista.
            if (!modePill.querySelector('*')) modePill.textContent = modeLabel;
        }
        // Pill del Pulpo: estado (verde/rojo) + uptime formateado.
        var pulpoPill = document.getElementById('hdr-pulpo');
        if (pulpoPill) {
            pulpoPill.classList.remove('in-pill-ok', 'in-pill-bad');
            pulpoPill.classList.add(d.pulpoAlive ? 'in-pill-ok' : 'in-pill-bad');
            pulpoPill.textContent = (d.pulpoAlive ? '🟢' : '🔴') + ' Pulpo · ' + __fmtUptime(d.pulpoUptimeMs);
        }
        // Pill de recursos: CPU/RAM con coloreo semántico por umbrales.
        var res = d.resources;
        var resPill = document.getElementById('hdr-resources');
        if (resPill && res) {
            var cpu = res.cpuPercent != null ? res.cpuPercent : '?';
            var mem = res.memPercent != null ? res.memPercent : '?';
            var cpuEl = document.getElementById('hdr-resources-cpu');
            var memEl = document.getElementById('hdr-resources-mem');
            if (cpuEl) cpuEl.textContent = 'CPU ' + cpu + '%';
            if (memEl) memEl.textContent = 'RAM ' + mem + '%';
            resPill.classList.remove('in-pill-ok', 'in-pill-warn', 'in-pill-bad');
            if (cpuEl) cpuEl.classList.remove('in-resource-alert');
            if (memEl) memEl.classList.remove('in-resource-alert');
            var maxCpu = res.maxCpu || 70;
            var maxMem = res.maxMem || 70;
            var worst = Math.max(Number(cpu) || 0, Number(mem) || 0);
            var cpuAlert = (Number(cpu) || 0) > maxCpu;
            var memAlert = (Number(mem) || 0) > maxMem;
            if (cpuAlert && cpuEl) cpuEl.classList.add('in-resource-alert');
            if (memAlert && memEl) memEl.classList.add('in-resource-alert');
            if (cpuAlert || memAlert) resPill.classList.add('in-pill-bad');
            else if (worst > 50) resPill.classList.add('in-pill-warn');
            else resPill.classList.add('in-pill-ok');
            resPill.title = 'CPU ' + cpu + '% (cap ' + maxCpu + '%) · RAM ' + mem + '% ('
                + (res.memUsedGB || '?') + 'GB / ' + (res.memTotalGB || '?') + 'GB · cap ' + maxMem + '%) · '
                + (res.cpuCores || '?') + ' cores';
            // #6708 — Disco: GB LIBRES (no % usado) con el color del umbral
            // vigente de disk_budget. El emoji del nivel va delante para que la
            // severidad no dependa sólo del color (WCAG). El color se aplica
            // sólo si es hex: el estado sale de un JSON en disco y un valor
            // arbitrario no debe poder inyectar CSS.
            var diskEl = document.getElementById('hdr-resources-disk');
            var dsk = res.disk;
            if (diskEl) {
                if (dsk && typeof dsk.freeGB === 'number' && isFinite(dsk.freeGB)) {
                    var emo = __DISK_EMOJI[dsk.level] || '⚪';
                    // #6708 (rebote rev-1) — RÓTULO + VALOR + ESCALÓN, los tres
                    // como texto visible: "🔴 Disco 8.0 GB · CRÍTICO".
                    // Antes decía sólo "🟢 24.0 GB": sin la palabra "Disco"
                    // el número quedaba sin rotular al lado de CPU/RAM (que sí
                    // lo están), y el escalón vivía únicamente en el tooltip.
                    // El servidor manda dsk.label; el mapa local es el fallback
                    // para estados viejos persistidos sin ese campo.
                    var lbl = (typeof dsk.label === 'string' && dsk.label)
                        ? dsk.label
                        : (__DISK_LABEL[dsk.level] || __DISK_LABEL.unknown);
                    diskEl.textContent = emo + ' Disco ' + dsk.freeGB.toFixed(1) + ' GB · ' + lbl;
                    diskEl.style.color = /^#[0-9a-fA-F]{3,8}$/.test(String(dsk.color)) ? dsk.color : '';
                    var b = dsk.budget || {};
                    var escala = (typeof b.green_gb === 'number')
                        ? 'verde >' + b.green_gb + ' · amarillo >' + b.yellow_gb + ' · naranja >' + b.orange_gb + ' GB libres'
                        : 'presupuesto sin configurar';
                    resPill.title += ' · Disco ' + dsk.freeGB.toFixed(1) + ' GB libres'
                        + ((typeof dsk.totalGB === 'number') ? ' de ' + dsk.totalGB + ' GB' : '')
                        + ' · nivel ' + dsk.level + ' (disk_budget: ' + escala + ')'
                        + (dsk.frozen ? ' · despacho de build y qa FRENADO por falta de disco' : '');
                    // El nivel de disco también degrada la pill entera: si el
                    // disco está en rojo, el header no puede seguir en verde.
                    if (dsk.level === 'red') {
                        resPill.classList.remove('in-pill-ok', 'in-pill-warn');
                        resPill.classList.add('in-pill-bad');
                        diskEl.classList.add('in-resource-alert');
                    } else {
                        diskEl.classList.remove('in-resource-alert');
                        if (dsk.level === 'orange' && !resPill.classList.contains('in-pill-bad')) {
                            resPill.classList.remove('in-pill-ok');
                            resPill.classList.add('in-pill-warn');
                        }
                    }
                } else {
                    // Sin medición: rótulo + escalón igual, para que el hueco
                    // se lea como "todavía no se midió" y no como "0 GB".
                    diskEl.textContent = '⚪ Disco — · ' + __DISK_LABEL.unknown;
                    diskEl.style.color = '';
                    diskEl.classList.remove('in-resource-alert');
                }
            }
        }
        var clockPill = document.getElementById('hdr-clock');
        if (clockPill) {
            var now = new Date();
            var date = now.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
            var time = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            clockPill.textContent = '🕒 ' + date + ' · ' + time;
            clockPill.title = 'Fecha y hora local: ' + date + ' ' + time;
        }
    };
}
`;
}

// headerPillsPollClientScript()
//   Poller autocontenido (STRING) para vistas standalone que NO tienen ya un
//   ticker sobre /api/dash/header (ej. providers.js). Fetch cada 5s + llamada a
//   window.__hydrateHeaderPills. Defensivo: .catch silencioso, sin innerHTML.
//   Requiere que headerPillsClientScript() se inyecte antes en el mismo <script>.
function headerPillsPollClientScript() {
    return `
(function () {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    function __tickHeaderPills() {
        fetch('/api/dash/header', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (typeof window.__hydrateHeaderPills === 'function') window.__hydrateHeaderPills(d); })
            .catch(function () {});
    }
    __tickHeaderPills();
    setInterval(__tickHeaderPills, 5000);
})();
`;
}

module.exports = {
    renderHeaderMetaSsr,
    headerPillsClientScript,
    headerPillsPollClientScript,
};
