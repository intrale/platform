'use strict';

// =============================================================================
// dispatch-facts.js — BRAZO DE RECOLECCIÓN de hechos del watchdog de despacho
// (#5400, rev-3).
//
// Por qué este módulo existe
// --------------------------
// `wave-stall-watchdog.decide()` es una función pura, bien cubierta y correcta.
// El problema de las dos revisiones anteriores no estuvo ahí sino en LO QUE LE
// ENTRA: los hechos se recolectaban inline dentro de pulpo.js (19k líneas), sin
// un solo test, y describían un pipeline idealizado en vez del que corre:
//
//   N1 — la causa declarada se resolvía SIEMPRE como `partial-pause`, porque el
//        primer chequeo era `mode !== 'running'` y desde #5060 el modo normal de
//        operación ES `partial_pause` (dispatch fail-closed acotado a la ola).
//        Todas las causas siguientes quedaban inalcanzables y el aviso nombraba
//        siempre la causa equivocada, atribuida a quien puso la allowlist.
//   N2 — "trabajo elegible esperando" se contaba como TODOS los workfiles en
//        `pendiente/`, sin cruzar con la allowlist. Con 241 pendientes de los
//        cuales 228 son backlog parkeado fuera de la ola, el contador nunca daba
//        0: el guard de CA-3 ("cola legítimamente vacía ⇒ no alertar") quedaba
//        muerto y toda pausa de despacho terminaba alertando.
//   N3 — la autoría de la pausa TOTAL se leía de `getPipelineMode().source`, que
//        devuelve `null` ESTRUCTURALMENTE para `.paused`. El dato real vive en
//        `readFullPauseOrigin()` (#5399).
//
// Todo eso ocurría en el único tramo del circuito sin cobertura. Este módulo lo
// saca de pulpo.js, lo hace INYECTABLE (todas las dependencias entran por
// parámetro) y por lo tanto testeable de punta a punta contra un filesystem de
// verdad: `.partial-pause.json` con allowlist no vacía + `pendiente/` con
// workfiles fuera de la allowlist.
//
// Reglas que manda
// ----------------
//   - FAIL-CLOSED (SEC-1): cualquier chequeo que tire se ignora. Sin causa
//     declarada el watchdog dispara; una excepción JAMÁS puede silenciarlo.
//   - READ-ONLY: no muta `.paused`, ni la allowlist, ni la cola (SEC-3).
//   - SEC-2: la autoría es display-only y se rotula siempre como DECLARADA. Sin
//     dato se devuelve `null` — prohibido defaultear a una persona.
//   - Cero dependencias npm.
// =============================================================================

const fs = require('fs');
const path = require('path');
const workfileName = require('./workfile-name');
const { isMarkerArtifact } = require('./marker-artifact');

/**
 * Lista los workfiles de `pendiente/` de TODAS las fases de TODOS los pipelines,
 * con el issue ya parseado.
 *
 * Vive acá y no en pulpo.js para que el test pueda ejercitar el barrido real
 * contra un filesystem de verdad (el bloqueante N2 se coló justamente porque
 * este tramo no se podía testear). Usa los mismos filtros que el resto del
 * Pulpo: nada de dotfiles, nada de `.gitkeep` y nada de artifacts auxiliares
 * (`<issue>.<skill>.guidance.txt` y compañía — #3638).
 *
 * Barato y best-effort: jamás puede tirar (el pipeline no puede morir por esto).
 *
 * @param {string} rootPipeline  raíz `.pipeline/`
 * @param {object} config        config del pipeline (pipelines → fases)
 * @returns {Array<{issue:string|null, name:string, pipeline:string, fase:string}>}
 */
function listarPendientesFS(rootPipeline, config) {
    const out = [];
    try {
        const pipelines = ((config || {}).pipelines) || {};
        for (const [pipelineName, pipelineConfig] of Object.entries(pipelines)) {
            for (const fase of (((pipelineConfig || {}).fases) || [])) {
                const dir = path.join(rootPipeline, pipelineName, fase, 'pendiente');
                let files = [];
                try { files = fs.readdirSync(dir); } catch { continue; }
                for (const f of files) {
                    if (f.startsWith('.') || f.endsWith('.gitkeep') || isMarkerArtifact(f)) continue;
                    out.push({
                        issue: workfileName.issueFromFile(f),
                        name: f,
                        pipeline: pipelineName,
                        fase,
                    });
                }
            }
        }
    } catch { /* config degradada: mejor 0 pendientes que tumbar el tick */ }
    return out;
}

/** Normaliza un identificador de issue a entero positivo, o null. */
function normalizarIssue(valor) {
    if (typeof valor === 'number') {
        return Number.isInteger(valor) && valor > 0 ? valor : null;
    }
    if (typeof valor === 'string') {
        const t = valor.trim();
        if (!/^[0-9]+$/.test(t)) return null;
        const n = parseInt(t, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
}

/**
 * Lee el ALCANCE de despacho vigente: qué issues podrían salir si no hubiera
 * ningún freno encima.
 *
 * Punto fino (N3 / Gherkin #1): la pausa TOTAL y la allowlist de la ola son dos
 * markers INDEPENDIENTES. `getPipelineMode()` devuelve `allowedIssues: []` y
 * `source: null` en cuanto existe `.paused`, así que leer sólo eso hace
 * desaparecer la ola y la autoría justo en el escenario que el issue quiere
 * avisar. Con `.paused` presente se lee la allowlist CRUDA
 * (`readPreviousAllowlist`) y el origen estructurado (`readFullPauseOrigin`,
 * #5399), que sí trae `source` y `ts`.
 *
 * @param {{partialPause:object}} deps
 * @returns {{mode:string, fullPaused:boolean, unscoped:boolean, scoped:boolean,
 *            allowedIssues:Set<number>, createdAt:string|null,
 *            source:string|null, pauseOrigin:object|null}}
 */
function leerAlcanceDespacho(deps) {
    const partialPause = (deps || {}).partialPause || {};

    // rev-6 (S3) — Una excepción acá NO puede silenciar el watchdog, y hasta esta
    // revisión lo silenciaba por DOBLE vía: `modo = null` degradaba a
    // `mode: 'running'` con `scoped:false / unscoped:false`, y eso encadenaba
    // `contarElegibles → fail-closed-sin-ola` (elegibles 0 ⇒ skip mudo) con
    // `resolverCausaDeclarada → wave-empty` (causa declarada ⇒ callar). O sea que
    // el header del módulo prometía lo contrario de lo que hacía el código.
    // `modeReadable: false` marca "no sé", que NO es lo mismo que "no hay ola".
    let modo = null;
    let modeReadable = true;
    try { modo = partialPause.getPipelineMode(); } catch { modo = null; modeReadable = false; }
    if (modo == null) modeReadable = false;
    const mode = (modo && typeof modo.mode === 'string') ? modo.mode : 'running';
    const fullPaused = mode === 'paused';

    let crudo = [];
    if (fullPaused) {
        try { crudo = partialPause.readPreviousAllowlist() || []; } catch { crudo = []; }
    } else if (modo && Array.isArray(modo.allowedIssues)) {
        crudo = modo.allowedIssues;
    }
    const allowedIssues = new Set();
    for (const v of crudo) {
        const n = normalizarIssue(v);
        if (n) allowedIssues.add(n);
    }

    // Escape hatch de diagnóstico (#5060): con él prendido no hay filtro de ola.
    let unscoped = false;
    try { unscoped = partialPause.unscopedDispatchEnabled() === true; }
    catch { unscoped = false; modeReadable = false; }

    let pauseOrigin = null;
    if (fullPaused) {
        try { pauseOrigin = partialPause.readFullPauseOrigin(); } catch { pauseOrigin = null; }
    }

    return {
        mode,
        modeReadable,
        fullPaused,
        unscoped,
        scoped: allowedIssues.size > 0,
        allowedIssues,
        createdAt: (modo && modo.createdAt) ? modo.createdAt : null,
        source: (modo && modo.source) ? modo.source : null,
        pauseOrigin,
    };
}

/**
 * Cuenta trabajo REALMENTE DESPACHABLE esperando (N2).
 *
 * `pendiente/` es el estacionamiento del backlog completo, no la cola de la ola:
 * al 2026-08-03 tenía 241 workfiles, 228 de ellos fuera de la allowlist y con
 * más de 24 h de antigüedad. Contarlos como "issues habilitados esperando"
 * rompía tres cosas a la vez: dejaba CA-3 inalcanzable (nunca 0), volvía
 * constante-verdadero el gate que hace ADITIVA la escalada, y mentía en el
 * mensaje por un factor de ~18x.
 *
 * Semántica del cruce:
 *   - escape hatch prendido        ⇒ todo pendiente es despachable.
 *   - allowlist presente           ⇒ pendientes ∩ allowlist. Vale también con
 *     pausa TOTAL: son los que saldrían apenas se levante (Gherkin #1).
 *   - sin allowlist (fail-closed)  ⇒ nada es despachable por scope. El backlog
 *     parkeado NO es trabajo elegible. Excepción: si `waves.json` declara una
 *     ola activa con issues abiertos, la allowlist debería existir — ese desync
 *     sí deja trabajo que debería estar saliendo, acotado a la ola (nunca al
 *     backlog entero).
 *
 * @param {object} alcance                 salida de `leerAlcanceDespacho`
 * @param {Array<number|string|{issue:*}>} pendientes  workfiles en `pendiente/`
 * @param {{issuesOlaActiva?:Array}} [opts]
 * @returns {{total:number, elegibles:number, fueraDeAlcance:number, alcanceAplicado:string}}
 */
function contarElegibles(alcance, pendientes, opts) {
    const lista = Array.isArray(pendientes) ? pendientes : [];
    const issues = lista.map((p) => normalizarIssue(
        (p && typeof p === 'object') ? p.issue : p
    ));
    const total = issues.length;

    // rev-6 (S2) — `elegibles` cuenta ISSUES DISTINTOS Y PARSEABLES, no workfiles.
    // Antes la rama `unscoped` devolvía `total` crudo (incluyendo los que no
    // parsean a issue) y el loop no deduplicaba, así que un mismo issue presente
    // en 3 fases contaba 3 veces. Ese número gobierna CA-3 y además viaja al
    // mensaje de Telegram: inflarlo es mentirle al operador sobre el tamaño de
    // la cola y volver inalcanzable el "0 = cola vacía".
    const distintos = new Set(issues.filter((n) => n != null));

    if (!alcance) {
        return {
            total, elegibles: 0, fueraDeAlcance: total,
            alcanceAplicado: 'sin-alcance', ciego: total > 0,
        };
    }
    if (alcance.unscoped) {
        const elegibles = distintos.size;
        return {
            total, elegibles, fueraDeAlcance: Math.max(0, total - elegibles),
            alcanceAplicado: 'unscoped', ciego: false,
        };
    }

    let scope = alcance.allowedIssues instanceof Set ? alcance.allowedIssues : new Set();
    let alcanceAplicado = 'allowlist';

    if (!alcance.scoped) {
        const ola = new Set();
        for (const n of (Array.isArray((opts || {}).issuesOlaActiva) ? opts.issuesOlaActiva : [])) {
            const x = normalizarIssue((n && typeof n === 'object') ? n.number : n);
            if (x) ola.add(x);
        }
        if (ola.size === 0) {
            // rev-6 (B4) — Acá NO se puede afirmar "no hay trabajo": se puede
            // afirmar "no puedo determinar QUÉ es despachable" (sin allowlist,
            // sin ola y sin escape hatch). Con la cola llena eso es CEGUERA, no
            // una cola vacía, y devolverlo como `elegibles: 0` a secas hacía que
            // `decide()` saliera por `no-enabled-work`: skip mudo con el pipeline
            // trabado. CA-3 se comía a CA-1, que es la función primaria.
            return {
                total, elegibles: 0, fueraDeAlcance: total,
                alcanceAplicado: 'fail-closed-sin-ola', ciego: total > 0,
            };
        }
        scope = ola;
        alcanceAplicado = 'desync-ola';
    }

    let elegibles = 0;
    for (const n of distintos) {
        if (scope.has(n)) elegibles++;
    }
    return {
        total, elegibles, fueraDeAlcance: Math.max(0, total - elegibles),
        alcanceAplicado,
        // Alcance conocido: el conteo es afirmable aunque dé 0.
        ciego: false,
    };
}

/** Constructor de causa declarada con la forma que consume `decide()`. */
function declarar(kind, extra) {
    return Object.assign(
        { declared: true, kind, readable: true, sinceTs: null, authorDeclared: null },
        extra || {}
    );
}

/** Parseo defensivo de un ISO a epoch ms; cualquier basura ⇒ null. */
function tsDesdeIso(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return null;
    const n = Date.parse(iso);
    return Number.isFinite(n) ? n : null;
}

/**
 * Resuelve la CAUSA DECLARADA que explica el no-despacho.
 *
 * Orden de los chequeos (importa: el primero que matchea gana):
 *   1. pausa TOTAL      — con `.paused` no sale NADA: siempre explica.
 *   2. pausa PARCIAL    — sólo explica si NO deja trabajo elegible. Es la
 *      corrección de N1: `partial_pause` con allowlist viva es el modo NORMAL de
 *      operación, no un freno; si hay elegibles esperando, lo que impide el
 *      despacho es otra cosa y hay que seguir buscándola.
 *   3. sin ola vigente  — allowlist ausente con dispatch fail-closed (#5060).
 *   4..7 ventana de reposo / cuota / presión de recursos / waiting-operator.
 *   8. artifact de causa declarada (#4709) — cubre los gates del ciclo de
 *      despacho (concurrencia, ventana de prioridad, cooldown, deadlock,
 *      cb-infra) sin duplicar su lógica.
 *
 * La ANOMALÍA nunca silencia (la filtra `dispatch-cause-kind.causeFromArtifact`).
 *
 * @param {{alcance:object, elegibles:number, deps:object}} ctx
 * @returns {object|null} causa, o null = sin causa declarada (el watchdog dispara).
 */
function resolverCausaDeclarada(ctx) {
    const c = ctx || {};
    const alcance = c.alcance || {};
    const elegibles = Number.isFinite(c.elegibles) ? c.elegibles : 0;
    const deps = c.deps || {};

    const probar = (fn) => {
        if (typeof fn !== 'function') return false;
        try { return fn() === true; } catch { return false; }
    };

    // 1. Pausa TOTAL declarada por el operador.
    if (alcance.fullPaused === true) {
        const origen = alcance.pauseOrigin || {};
        // SEC-2 — `rawSource` es la autoría tal como quedó REGISTRADA en el
        // marker. `source` no sirve acá: `readFullPauseOrigin` lo normaliza a
        // 'manual'/'unknown' para decidir el auto-levantado, y eso no es una
        // autoría. Sin `rawSource` se devuelve null y el mensaje dirá "autoría
        // no registrada" — jamás se atribuye a una persona por default.
        const autor = (typeof origen.rawSource === 'string' && origen.rawSource.trim())
            ? origen.rawSource.trim()
            : null;
        return declarar('human-halt', { sinceTs: tsDesdeIso(origen.ts), authorDeclared: autor });
    }

    // 2. Pausa PARCIAL — sólo si no deja trabajo elegible (N1).
    if (alcance.mode === 'partial_pause' && elegibles <= 0) {
        return declarar('partial-pause', {
            sinceTs: tsDesdeIso(alcance.createdAt),
            authorDeclared: alcance.source || null,
        });
    }

    // 3. Sin allowlist y sin escape hatch: no hay ola vigente que acote el
    //    dispatch, y desde #5060 eso significa DENEGAR (fail-closed).
    //
    //    rev-6 (S3) — SÓLO si el alcance se pudo LEER. Con `modeReadable: false`
    //    la ausencia de allowlist no es un hecho observado sino una lectura que
    //    falló, y convertirla en causa declarada dejaba que una excepción
    //    silenciara el watchdog — justo lo que el header del módulo prohíbe.
    //    Sin causa declarada la alarma dispara: fail-closed de verdad.
    if (alcance.modeReadable === false) return null;
    if (alcance.scoped !== true && alcance.unscoped !== true) {
        return declarar('wave-empty');
    }

    // 4. Ventana de reposo / madrugada.
    if (probar(deps.isNightWindow)) return declarar('night-window');

    // 5. Cuota agotada.
    if (probar(deps.isQuotaExhausted)) return declarar('quota');

    // 6. Presión de recursos (ORANGE / RED suprimen despacho legítimamente).
    if (probar(deps.isResourcePressure)) return declarar('resource-pressure');

    // 7. Gate de coherencia (#4578): ola retenida esperando al operador.
    if (probar(deps.isWaveWaitingOperator)) return declarar('waiting-operator');

    // 8. Artifact de causa declarada (#4709).
    if (typeof deps.causaDesdeArtifact === 'function') {
        try {
            const desdeArtifact = deps.causaDesdeArtifact();
            if (desdeArtifact) return desdeArtifact;
        } catch { /* fail-closed: sin artifact legible, no hay causa */ }
    }

    return null;
}

/**
 * Orquesta la recolección completa: alcance → conteo elegible → causa.
 * Es lo que llama el brazo del Pulpo; devuelve exactamente los hechos que
 * consume `wave-stall-watchdog.decide()`.
 *
 * @param {object} deps
 * @param {object} deps.partialPause
 * @param {Function} deps.listarPendientes   () => Array de issues/workfiles
 * @param {Function} [deps.issuesOlaActiva]  () => Array de issues de la ola
 * @param {Function} [deps.isNightWindow]
 * @param {Function} [deps.isQuotaExhausted]
 * @param {Function} [deps.isResourcePressure]
 * @param {Function} [deps.isWaveWaitingOperator]
 * @param {Function} [deps.causaDesdeArtifact]
 * @returns {{alcance:object, conteo:object, cause:object|null}}
 */
function recolectarHechos(deps) {
    const d = deps || {};
    const alcance = leerAlcanceDespacho(d);

    let pendientes = [];
    if (typeof d.listarPendientes === 'function') {
        try { pendientes = d.listarPendientes() || []; } catch { pendientes = []; }
    }
    let issuesOlaActiva = [];
    if (typeof d.issuesOlaActiva === 'function') {
        try { issuesOlaActiva = d.issuesOlaActiva() || []; } catch { issuesOlaActiva = []; }
    }

    const conteo = contarElegibles(alcance, pendientes, { issuesOlaActiva });
    const cause = resolverCausaDeclarada({ alcance, elegibles: conteo.elegibles, deps: d });
    return { alcance, conteo, cause };
}

module.exports = {
    listarPendientesFS,
    normalizarIssue,
    leerAlcanceDespacho,
    contarElegibles,
    resolverCausaDeclarada,
    recolectarHechos,
};
