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
function renderHeaderMetaSsr(opts) {
    const withMode = !!(opts && opts.withMode);
    // Todos los atributos son literales hardcoded. NO concatenar con datos
    // externos / query params / slice. Placeholder "…" hasta la 1ª hidratación.
    const modePill = withMode
        ? '<span class="in-pill" id="hdr-mode">…</span>\n      '
        : '';
    return `
    <div class="in-header-meta">
      ${modePill}<span class="in-pill" id="hdr-resources" title="CPU y RAM del sistema" aria-label="Recursos CPU y RAM">…</span>
      <span class="in-pill" id="hdr-pulpo" aria-label="Estado del pulpo">…</span>
      <span class="in-clock" id="hdr-clock" aria-label="Hora local">…</span>
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
    window.__hydrateHeaderPills = function (d) {
        if (!d) return;
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
            resPill.textContent = '🖥 CPU ' + cpu + '% · RAM ' + mem + '%';
            resPill.classList.remove('in-pill-ok', 'in-pill-warn', 'in-pill-bad');
            var maxCpu = res.maxCpu || 70;
            var maxMem = res.maxMem || 70;
            var worst = Math.max(Number(cpu) || 0, Number(mem) || 0);
            if ((Number(cpu) || 0) > maxCpu || (Number(mem) || 0) > maxMem) resPill.classList.add('in-pill-bad');
            else if (worst > 50) resPill.classList.add('in-pill-warn');
            else resPill.classList.add('in-pill-ok');
            resPill.title = 'CPU ' + cpu + '% (cap ' + maxCpu + '%) · RAM ' + mem + '% ('
                + (res.memUsedGB || '?') + 'GB / ' + (res.memTotalGB || '?') + 'GB · cap ' + maxMem + '%) · '
                + (res.cpuCores || '?') + ' cores';
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
