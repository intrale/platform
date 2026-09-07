// =============================================================================
// dashboard-boot.js — Esperar el arranque del dashboard en tests (#5796)
// =============================================================================
//
// ## Por qué existe
//
// Seis baterías levantan el `dashboard.js` REAL como proceso hijo y esperan a
// que empiece a escuchar. Cada una traía su propio bucle de espera copiado, con
// un presupuesto expresado en INTENTOS FIJOS (40 o 60 ticks de 250ms = 10s o
// 15s) y `stdio: 'ignore'`. Esa forma de esperar tiene dos defectos que se
// pagan juntos:
//
//   1. **El presupuesto no representa la máquina real.** El pipeline corre en
//      producción continua: cuando el tester dispara la batería puede haber
//      otros agentes, un Pulpo, builds de Gradle y hasta otra corrida de la
//      misma batería en otro worktree. Arrancar un proceso Node bajo esa carga
//      supera cómodamente los 10s, y el `before` hook aborta con
//      `ECONNREFUSED` — que se lee como "el dashboard está roto" cuando en
//      realidad todavía estaba levantando.
//
//   2. **Un arranque ROTO también tarda 10s en reportarse, y sin motivo.** Con
//      `stdio: 'ignore'` el stderr del hijo se descarta: si el dashboard muere
//      en el `require` por un config inválido, el test igual agota todos los
//      intentos y falla con el mismo `ECONNREFUSED` genérico. El modo de fallo
//      lento (máquina cargada) y el rápido (dashboard roto) quedan
//      indistinguibles.
//
// Este helper separa los dos casos, que es lo que permite subir el presupuesto
// sin volver lento el diagnóstico:
//
//   - Si el hijo MUERE, rechaza en el acto con el código de salida y la cola
//     del stderr. No espera el resto del presupuesto.
//   - Si el hijo SIGUE VIVO, espera contra un deadline de reloj (no contra un
//     contador de ticks), configurable por `DASHBOARD_BOOT_TIMEOUT_MS`.
//
// El default (75s) entra con margen dentro del `--test-timeout=120000` que
// aplica el tester, así que un arranque que nunca llega sigue fallando como
// fallo de hook con mensaje propio, y no como timeout mudo del runner.
//
// ## Uso
//
//   const { spawnDashboard, waitForDashboardBoot } = require('./helpers/dashboard-boot');
//
//   child = spawnDashboard({ dashboardPath, env: { ...process.env, ... } });
//   await waitForDashboardBoot({
//       child,
//       probe: () => httpGet('/api/health').then((r) => r && r.status === 200),
//   });
//
// `probe` devuelve (o resuelve) un valor truthy cuando el dashboard está listo.
// Ese valor es lo que devuelve `waitForDashboardBoot`, así que un probe puede
// aprovechar el sondeo para traerse el body ya cargado. Si el probe rechaza, se
// toma como "todavía no" y se reintenta, guardando el motivo para el mensaje
// final.
// =============================================================================

'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_BOOT_TIMEOUT_MS = 75 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_FIRST_DELAY_MS = 300;
const STDERR_TAIL_CHARS = 1200;

/**
 * Presupuesto de arranque efectivo. `DASHBOARD_BOOT_TIMEOUT_MS` permite
 * apretarlo en una máquina holgada o aflojarlo en CI sin tocar los tests.
 *
 * @param {number} [explicitMs] - valor pasado por el caller (gana sobre el env).
 * @returns {number} milisegundos
 */
function resolveBootTimeoutMs(explicitMs) {
    if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
    const raw = Number.parseInt(process.env.DASHBOARD_BOOT_TIMEOUT_MS || '', 10);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_BOOT_TIMEOUT_MS;
}

/**
 * Spawnea el dashboard con el stderr capturado.
 *
 * Mantiene stdout en `ignore` (el dashboard es verboso y a nadie le sirve en el
 * test) pero DRENA stderr: sin drenar, un hijo que escriba más que el buffer
 * del pipe se bloquearía, que es justamente el cuelgue que este helper viene a
 * evitar.
 *
 * @param {object} opts
 * @param {string} opts.dashboardPath - ruta absoluta a `dashboard.js`.
 * @param {object} opts.env - env completo del hijo.
 * @param {string} [opts.execPath] - binario de Node (default: el actual).
 * @returns {import('node:child_process').ChildProcess} con `__stderrTail()`.
 */
function spawnDashboard({ dashboardPath, env, execPath = process.execPath }) {
    const child = spawn(execPath, [dashboardPath], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    let stderrTail = '';
    if (child.stderr) {
        child.stderr.on('data', (d) => {
            stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CHARS);
        });
        // Un error en el pipe nunca debe tumbar la batería.
        child.stderr.on('error', () => { /* best-effort */ });
    }
    child.__stderrTail = () => stderrTail;
    return child;
}

/**
 * Espera a que el dashboard esté listo, o falla rápido si el hijo murió.
 *
 * @param {object} opts
 * @param {import('node:child_process').ChildProcess} opts.child
 * @param {() => any} opts.probe - truthy (o promesa truthy) cuando está listo.
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.firstDelayMs]
 * @param {string} [opts.label] - nombre para el mensaje de error.
 * @returns {Promise<any>} el valor truthy que devolvió el probe.
 */
function waitForDashboardBoot({
    child,
    probe,
    timeoutMs,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    firstDelayMs = DEFAULT_FIRST_DELAY_MS,
    label = 'dashboard',
} = {}) {
    if (typeof probe !== 'function') {
        return Promise.reject(new Error('waitForDashboardBoot requiere un probe'));
    }
    const budgetMs = resolveBootTimeoutMs(timeoutMs);
    const deadline = Date.now() + budgetMs;

    return new Promise((resolve, reject) => {
        let settled = false;
        let lastReason = '';
        let timer = null;
        let watchdog = null;

        const stderrTail = () => {
            const tail = (child && typeof child.__stderrTail === 'function')
                ? child.__stderrTail().trim()
                : '';
            return tail ? '\n--- stderr del hijo ---\n' + tail : '';
        };
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (watchdog) clearTimeout(watchdog);
            if (child) child.removeListener('exit', onExit);
            fn(arg);
        };
        const agotado = (detalle) => new Error(
            label + ' no levantó tras ' + Math.round(budgetMs / 1000) + 's'
            + (detalle ? ' (' + detalle + ')' : '')
            + (lastReason ? ': ' + lastReason : '')
            + stderrTail(),
        );

        // ---------------------------------------------------------------------
        // Watchdog de deadline DURO.
        //
        // El bucle de sondeo sólo evalúa el deadline al agendar el próximo tick,
        // o sea: DESPUÉS de que el probe settlea. Si el probe queda pendiente
        // para siempre —un `http.get` con `timeout:` en las options pero sin
        // handler `'timeout'`, que es el patrón que traían varias de estas
        // baterías— nunca se agenda otro tick, el deadline nunca se mira y la
        // espera cuelga hasta que el runner mata la suite con el genérico
        // `test timed out after 120000ms`. Ese mensaje no dice nada: no
        // distingue "el dashboard no levanta" de "el sondeo se colgó".
        //
        // Este timer corre en paralelo al bucle y no depende de que el probe
        // resuelva: pase lo que pase, a los `budgetMs` la espera falla con un
        // mensaje propio y dentro del presupuesto del runner.
        // ---------------------------------------------------------------------
        watchdog = setTimeout(
            () => finish(reject, agotado('sondeo sin respuesta')),
            budgetMs,
        );
        if (watchdog.unref) watchdog.unref();
        // Muerte del hijo: no tiene sentido seguir sondeando un puerto que ya
        // no va a abrir nunca. Se reporta en el acto y CON el motivo.
        function onExit(code, signal) {
            finish(reject, new Error(
                label + ' murió durante el arranque (code=' + code + ', signal=' + signal + ')'
                + (lastReason ? ' · último sondeo: ' + lastReason : '')
                + stderrTail(),
            ));
        }
        if (child) child.once('exit', onExit);

        const schedule = () => {
            if (settled) return;
            const left = deadline - Date.now();
            if (left <= 0) return finish(reject, agotado(''));
            timer = setTimeout(tick, Math.min(intervalMs, left));
            if (timer.unref) timer.unref();
        };

        function tick() {
            if (settled) return;
            let pending;
            try {
                pending = Promise.resolve(probe());
            } catch (err) {
                pending = Promise.reject(err);
            }
            pending.then((value) => {
                if (settled) return;
                if (value) return finish(resolve, value);
                lastReason = 'todavía no listo';
                schedule();
            }).catch((err) => {
                if (settled) return;
                lastReason = (err && err.message) || String(err);
                schedule();
            });
        }

        timer = setTimeout(tick, Math.min(firstDelayMs, Math.max(1, deadline - Date.now())));
        if (timer.unref) timer.unref();
    });
}

module.exports = {
    spawnDashboard,
    waitForDashboardBoot,
    resolveBootTimeoutMs,
    DEFAULT_BOOT_TIMEOUT_MS,
};
