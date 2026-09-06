'use strict';

// =============================================================================
// restart-verify.js — Verificación post-arranque del restart (#6441).
// -----------------------------------------------------------------------------
// `restart.js` spawneaba la tabla de componentes y daba por hecho el resultado:
// `launchAll()` devolvía los SPAWNEADOS, no los VIVOS. Un servicio que moría al
// segundo de arrancar salía del restart indistinguible de uno sano, y el
// operador se quedaba con la impresión de "reinicié todo, está todo bien". El
// 2026-08-24 pasó exactamente eso: el restart de las 12:39 declaró
// `svc-reconciler` en su tabla, no lo levantó, y nadie se enteró hasta las 13:41.
//
// Acá vive la lógica; el I/O (descubrir PIDs, respawnear, alertar) queda en
// `restart.js`. `isAlive` se inyecta para que los tests no toquen el SO.
// =============================================================================

/**
 * Verifica componente por componente cuáles quedaron vivos.
 *
 * `supervisados` decide QUÉ hace fracasar al restart. Es la misma clasificación
 * que usa el barrido de liveness (`SUPERVISED_COMPONENTS` en
 * `lib/stale-services.js`), a propósito: si un componente cuya ausencia es
 * normal pudiera dejar el restart en degradado, cada `/restart` terminaría con
 * un aviso — y un aviso que suena siempre enseña al operador a ignorarlo, que es
 * el modo de falla que este issue viene a cerrar. `svc-emulador` es el caso
 * concreto: sólo corre en la ventana QA.
 *
 * Los NO supervisados igual se reportan línea por línea (CA-1): se ven, no
 * frenan.
 *
 * @param {Array<string|{name:string}>} componentes — los que se intentó lanzar.
 * @param {(name:string)=>boolean} isAlive — sonda de liveness (identidad real).
 * @param {string[]} [supervisados] — si se omite, TODOS cuentan (fail-closed).
 * @returns {{vivos:string[], muertos:string[], muertosSupervisados:string[], degradado:boolean}}
 */
function evaluarArranque(componentes, isAlive, supervisados) {
    const vivos = [];
    const muertos = [];
    const lista = Array.isArray(componentes) ? componentes : [];
    const sonda = typeof isAlive === 'function' ? isAlive : () => false;
    // Sin lista explícita, todo cuenta: preferimos un falso degradado a dejar
    // pasar un servicio caído por una clasificación que no llegó.
    const esSupervisado = Array.isArray(supervisados)
        ? (n) => supervisados.includes(n)
        : () => true;

    for (const c of lista) {
        const name = typeof c === 'string' ? c : (c && c.name);
        if (!name) continue;
        let ok = false;
        try { ok = !!sonda(name); }
        catch {
            // Una sonda que explota NO es evidencia de vida. Fail-closed: se
            // cuenta como muerto y el operador lo ve. El fail-open acá es
            // justamente el silencio que este issue viene a cerrar.
            ok = false;
        }
        (ok ? vivos : muertos).push(name);
    }

    const muertosSupervisados = muertos.filter(esSupervisado);
    return { vivos, muertos, muertosSupervisados, degradado: muertosSupervisados.length > 0 };
}

/**
 * Una línea por servicio, para que el resultado del restart sea explícito.
 * El camino feliz también imprime: un log mudo es indistinguible de "no corrió".
 *
 * @returns {string[]}
 */
function lineasLog(resultado) {
    const r = resultado || {};
    const out = [];
    const supervisado = new Set(r.muertosSupervisados || []);
    for (const n of (r.vivos || [])) out.push('  OK   ' + n + ' — vivo tras el arranque');
    for (const n of (r.muertos || [])) {
        out.push(supervisado.has(n)
            ? '  FAIL ' + n + ' — NO quedó vivo tras el arranque'
            : '  --   ' + n + ' — no quedó vivo (ausencia esperada, no frena el restart)');
    }
    return out;
}

/**
 * Aviso al operador en lenguaje llano. Nombra los servicios: "el restart falló"
 * a secas no le sirve a nadie a las 3 AM.
 *
 * @param {string[]} muertos
 * @returns {string} texto Markdown para `enqueueTelegramAlert`, o '' si no hay.
 */
function textoAlerta(muertos) {
    const lista = (Array.isArray(muertos) ? muertos : []).filter(Boolean);
    if (!lista.length) return '';
    const plural = lista.length > 1;
    return '🚨 *Restart degradado: ' + (plural ? 'servicios que no levantaron' : 'un servicio no levantó') + '*\n\n'
        + (plural ? 'Estos servicios' : 'Este servicio') + ' no quedó vivo ni siquiera tras el reintento:\n'
        + lista.map(n => '• `' + n + '`').join('\n') + '\n\n'
        + 'El pipeline quedó corriendo *incompleto*. Revisar `logs/<servicio>.log` '
        + 'para ver por qué no arranca.';
}

module.exports = {
    evaluarArranque,
    lineasLog,
    textoAlerta,
};
