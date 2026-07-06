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
//   opts.withMode  (bool, default false): si true, incluye la pill de estado del
//     pipeline (#hdr-mode). home NO la muestra en el header visible (vive en el
//     sink oculto, #4227) → withMode:false. Los satélites SÍ la muestran →
//     withMode:true.
//   opts.withBuild (bool, default false): si true, incluye el segmento de estado
//     del build (#bld-status) como PRIMER segmento de la bandeja. #4531 lo movió
//     desde la brand bar a la bandeja unificada para que build/recursos/pulpo/
//     reloj compartan el mismo sistema visual. home y satélites lo activan.
//   Devuelve el HTML de la BANDEJA de estado (#4531): un único contenedor
//     `.in-header-meta.in-tray` con segmentos `.in-seg` separados por divisores,
//     misma altura/tipografía/radio. Orden estable:
//       [build?] → [mode?] → recursos → pulpo → reloj (guideline UX-3).
//   El contenedor conserva la clase `in-header-meta` (contrato de tests/CSS) y
//   los IDs invariantes hdr-resources / hdr-pulpo / hdr-clock / hdr-mode /
//   bld-status. SEC-1: markup 100% literal, placeholder "…" hasta la 1ª
//   hidratación; ningún dato del slice se interpola server-side.
function renderHeaderMetaSsr(opts) {
    const withMode = !!(opts && opts.withMode);
    const withBuild = !!(opts && opts.withBuild);

    // Segmento de build (#4531): dot semántico (idle/building/ok/fail) + etiqueta
    // "Build" + estado real en palabra (idle/OK/roto/corriendo) — sin el "?".
    // Arranca en idle; la hidratación lo repinta con d.build del slice.
    const buildSeg = withBuild
        ? '<span class="in-seg in-seg-build in-pill" id="bld-status" title="Estado del build del pipeline" aria-label="Estado del build">'
          + '<span class="in-dot in-dot-idle" data-bld-dot aria-hidden="true"></span>'
          + '<span class="in-seg-val">Build</span>'
          + '<span class="in-seg-sec" data-bld-state>…</span></span>\n      '
        : '';

    // Segmento de estado del pipeline (satélites): pill simple; su hidratación
    // (running/pausa/parcial) la maneja el ticker de cada vista (no el helper
    // compartido, para no pisar el menú desplegable que home monta como child).
    const modeSeg = withMode
        ? '<span class="in-seg in-seg-mode in-pill" id="hdr-mode" aria-label="Estado del pipeline">…</span>\n      '
        : '';

    return `
    <div class="in-header-meta in-tray" role="group" aria-label="Salud del sistema">
      ${buildSeg}${modeSeg}<span class="in-seg in-seg-res in-pill" id="hdr-resources" title="CPU y RAM del sistema" aria-label="Recursos CPU y RAM">
        <span class="in-dot in-dot-idle" data-res-dot aria-hidden="true"></span>
        <span class="in-res-metrics">
          <span class="in-metric"><span class="in-mk">CPU</span><span class="in-mv" data-res-cpu>…</span></span>
          <span class="in-midsep" aria-hidden="true"></span>
          <span class="in-metric"><span class="in-mk">RAM</span><span class="in-mv" data-res-mem>…</span></span>
        </span>
      </span>
      <span class="in-seg in-seg-pulpo in-pill" id="hdr-pulpo" aria-label="Estado del pulpo">
        <span class="in-dot in-dot-idle" data-pulpo-dot aria-hidden="true"></span>
        <span class="in-seg-lbl">Pulpo</span><span class="in-seg-up" data-pulpo-up>…</span>
      </span>
      <span class="in-seg in-seg-clock in-clock" id="hdr-clock" aria-label="Hora local">
        <span class="in-clk-ic" aria-hidden="true">🕐</span>
        <span class="in-clk-stack"><span class="in-clk-time" data-clk-time>…</span><span class="in-clk-date" data-clk-date>…</span></span>
      </span>
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
if (!window.__hydrateHeaderPills) {
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
    // Aplica una de las clases mutuamente excluyentes de una familia a un nodo,
    // limpiando las demás. Sólo classList (SEC-1). El nodo puede ser null.
    var __setClass = function (el, family, add) {
        if (!el) return;
        for (var i = 0; i < family.length; i++) el.classList.remove(family[i]);
        if (add) el.classList.add(add);
    };
    var __DOT_FAMILY = ['in-dot-idle', 'in-dot-ok', 'in-dot-warn', 'in-dot-bad'];
    var __PILL_FAMILY = ['in-pill-ok', 'in-pill-warn', 'in-pill-bad', 'in-pill-info'];
    // Mapa de estado de build → dot semántico + palabra de estado (sin "?").
    var __BUILD_META = {
        passing: { dot: 'in-dot-ok', word: 'OK' },
        failing: { dot: 'in-dot-bad', word: 'roto' },
        running: { dot: 'in-dot-warn', word: 'corriendo' },
        unknown: { dot: 'in-dot-idle', word: 'idle' },
    };

    window.__hydrateHeaderPills = function (d) {
        if (!d) return;
        // Segmento del Pulpo: dot (verde/rojo) + uptime formateado en su span.
        var pulpoSeg = document.getElementById('hdr-pulpo');
        if (pulpoSeg) {
            var pulpoUp = pulpoSeg.querySelector('[data-pulpo-up]');
            if (pulpoUp) pulpoUp.textContent = __fmtUptime(d.pulpoUptimeMs);
            __setClass(pulpoSeg.querySelector('[data-pulpo-dot]'), __DOT_FAMILY, d.pulpoAlive ? 'in-dot-ok' : 'in-dot-bad');
            pulpoSeg.title = d.pulpoAlive ? ('Pulpo activo · uptime ' + __fmtUptime(d.pulpoUptimeMs)) : 'Pulpo detenido';
        }
        // Segmento de recursos: CPU/RAM en spans separados; la métrica que supera
        // su cap se resalta (clase .in-mv-hot) en vez de teñir todo el segmento.
        // Se preservan las clases de presión in-pill-ok/warn/bad (contrato #4463).
        var res = d.resources;
        var resSeg = document.getElementById('hdr-resources');
        if (resSeg && res) {
            var cpu = res.cpuPercent != null ? res.cpuPercent : '?';
            var mem = res.memPercent != null ? res.memPercent : '?';
            var cpuEl = resSeg.querySelector('[data-res-cpu]');
            var memEl = resSeg.querySelector('[data-res-mem]');
            if (cpuEl) cpuEl.textContent = cpu + '%';
            if (memEl) memEl.textContent = mem + '%';
            var maxCpu = res.maxCpu || 70;
            var maxMem = res.maxMem || 70;
            var cpuHot = (Number(cpu) || 0) > maxCpu;
            var memHot = (Number(mem) || 0) > maxMem;
            if (cpuEl) cpuEl.classList.toggle('in-mv-hot', cpuHot);
            if (memEl) memEl.classList.toggle('in-mv-hot', memHot);
            var worst = Math.max(Number(cpu) || 0, Number(mem) || 0);
            var pill = (cpuHot || memHot) ? 'in-pill-bad' : (worst > 50 ? 'in-pill-warn' : 'in-pill-ok');
            __setClass(resSeg, __PILL_FAMILY, pill);
            resSeg.classList.toggle('in-seg-alert', cpuHot || memHot);
            __setClass(resSeg.querySelector('[data-res-dot]'), __DOT_FAMILY,
                (cpuHot || memHot) ? 'in-dot-bad' : (worst > 50 ? 'in-dot-warn' : 'in-dot-ok'));
            resSeg.title = 'CPU ' + cpu + '% (cap ' + maxCpu + '%) · RAM ' + mem + '% ('
                + (res.memUsedGB || '?') + 'GB / ' + (res.memTotalGB || '?') + 'GB · cap ' + maxMem + '%) · '
                + (res.cpuCores || '?') + ' cores';
        }
        // Segmento de build (#4531): dot semántico + palabra de estado, sin "?".
        var bldSeg = document.getElementById('bld-status');
        if (bldSeg && d.build) {
            var meta = __BUILD_META[d.build.status] || __BUILD_META.unknown;
            __setClass(bldSeg.querySelector('[data-bld-dot]'), __DOT_FAMILY, meta.dot);
            var stateEl = bldSeg.querySelector('[data-bld-state]');
            if (stateEl) stateEl.textContent = meta.word;
            var detail = [d.build.branch, d.build.commit].filter(Boolean).join(' · ');
            bldSeg.title = 'Estado del build del pipeline · ' + meta.word + (detail ? ' · ' + detail : '');
        }
    };

    // __updateHeaderClock(): pinta el reloj (#4531) con hora HH:MM + fecha corta
    // en los spans nested del segmento. Independiente del slice (base temporal),
    // se llama desde el ticker de cada vista. Sólo .textContent (SEC-1).
    window.__updateHeaderClock = function () {
        var clk = document.getElementById('hdr-clock');
        if (!clk) return;
        var now = new Date();
        var t = clk.querySelector('[data-clk-time]');
        var dt = clk.querySelector('[data-clk-date]');
        try {
            if (t) t.textContent = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
            if (dt) dt.textContent = now.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
        } catch (_) {
            if (t) t.textContent = now.toLocaleTimeString('es-AR');
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
    function __tickHeaderPills() {
        if (typeof window.__updateHeaderClock === 'function') window.__updateHeaderClock();
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
