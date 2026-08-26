// =============================================================================
// auto-recheck-counter.js — Techo de auto-destrabes por causa (#6611, CA-8).
//
// QUÉ EVITA
// ---------
// El bucle destrabe → re-bloqueo. Si el PR vuelve a `MERGEABLE`+`CLEAN` pero la
// protección de rama lo frena otra vez por la misma razón, el auto-destrabe lo
// reencolaría indefinidamente, quemando slot de ola y cuota de `gh`. Al tercer
// ciclo sobre la MISMA causa (`<issue>::<kind>::<pr>`) se deja de auto-destrabar
// y el bloqueo escala como duro.
//
// POR QUÉ UN STORE PROPIO Y NO EL `.reason.json` / EL MARKER
// ----------------------------------------------------------
// `security` refutó explícitamente guardarlo ahí: `unblockIssue` hace
// `fs.unlinkSync(reasonFilePath(...))` en CADA destrabe, y el marker se renombra
// a `pendiente/` y lo pisa el agente. El contador se borraría justo en el evento
// que tiene que contar ⇒ el techo no dispararía nunca. Fuera del ciclo de vida
// del marker, entonces.
//
// PERSISTENCIA: `.pipeline/state/auto-recheck-counters.jsonl` — append-only
// (`appendFileSync`, patrón de `lib/metrics/auto-repair.js`). Una línea por
// auto-destrabe; el conteo se agrega en lectura. Append-only evita la carrera
// read-modify-write entre el tick del pulpo y cualquier otro escritor.
//
//   {"key":"6145::pr_merge_blocked::6593","issue":6145,"kind":"pr_merge_blocked",
//    "pr":6593,"ts":"2026-08-26T..."}
//
// Cubre además el "contador de métrica" del punto 4 del issue: mismo store,
// misma línea — no hay un segundo contador que mantener sincronizado.
//
// GARANTÍAS
// ---------
// - **Fail-CLOSED en `count`**: si el archivo es ilegible, `count` devuelve
//   `Infinity`. No poder leer el contador NO puede habilitar un destrabe: el
//   techo existe justo para el caso en que algo anda mal.
// - **Fail-open en `increment`**: un error de escritura no rompe el destrabe ya
//   decidido; sólo se pierde una marca (y el techo se vuelve más permisivo, no
//   más restrictivo — por eso `count` compensa siendo fail-closed).
// - **TTL 7 días**: líneas viejas se ignoran en lectura. Un re-bloqueo meses
//   después es una causa nueva, no la continuación de un bucle.
// - **0o600** al crear el archivo.
//
// Node puro (fs, path).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Techo de auto-destrabes por causa (CA-8). Configurable desde `config.yaml`
// (`human_block_auto_recheck.max_auto_releases`), este es el default.
const DEFAULT_MAX_AUTO_RELEASES = 3;

// Más allá de esto, un re-bloqueo es una causa nueva, no un bucle.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Cota dura de líneas parseadas. Un archivo que creció sin control no puede
// convertir una lectura en un cuelgue del tick del pulpo.
const MAX_LINES = 20000;

function stateFile(pipelineDir) {
    return path.join(pipelineDir, 'state', 'auto-recheck-counters.jsonl');
}

/**
 * Clave de "misma causa": mismo issue, mismo kind, mismo PR. Un PR distinto
 * sobre el mismo issue es otra causa y arranca su propio contador.
 */
function makeKey(issue, kind, pr) {
    return String(issue) + '::' + String(kind) + '::' + String(pr);
}

/**
 * count — cuántos auto-destrabes activos (dentro del TTL) hay para esta causa.
 *
 * FAIL-CLOSED: cualquier error de IO/parseo devuelve `Infinity`, que rio abajo
 * significa "techo alcanzado ⇒ no liberar". Un contador ilegible no puede
 * traducirse en permiso para seguir destrabando.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {number|string} opts.issue
 * @param {string} opts.kind
 * @param {number|string} opts.pr
 * @param {number} [opts.now]
 * @param {number} [opts.ttlMs]
 * @param {object} [opts.fsImpl]
 * @returns {number} conteo activo, o `Infinity` si no se pudo leer.
 */
function count(opts = {}) {
    const { pipelineDir, issue, kind, pr } = opts;
    if (!pipelineDir || issue == null || !kind || pr == null) return Infinity;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    const key = makeKey(issue, kind, pr);
    try {
        const file = stateFile(pipelineDir);
        if (!_fs.existsSync(file)) return 0; // ausencia == nunca se destrabó
        const raw = _fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n');
        if (lines.length > MAX_LINES) return Infinity; // fail-closed: archivo desbordado
        let n = 0;
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let entry;
            // Una línea corrupta se saltea: el resto del archivo sigue siendo
            // evidencia válida y descartarlo entero sería MÁS permisivo.
            try { entry = JSON.parse(t); } catch { continue; }
            if (!entry || typeof entry !== 'object' || entry.key !== key) continue;
            const ts = entry.ts ? Date.parse(entry.ts) : NaN;
            if (!Number.isFinite(ts)) continue;   // sin timestamp válido ⇒ no cuenta
            if (now - ts > ttlMs) continue;        // vencida
            n++;
        }
        return n;
    } catch {
        return Infinity; // fail-closed
    }
}

/**
 * increment — asienta UN auto-destrabe de esta causa.
 *
 * Se llama AL AUTO-DESTRABAR (no al re-bloquearse): el evento que existe y es
 * observable es el destrabe. Contar re-bloqueos exigiría correlacionar dos
 * eventos separados en el tiempo y perdería el caso en que el issue nunca
 * vuelve a bloquearse.
 *
 * @returns {boolean} true si persistió.
 */
function increment(opts = {}) {
    const { pipelineDir, issue, kind, pr } = opts;
    if (!pipelineDir || issue == null || !kind || pr == null) return false;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const file = stateFile(pipelineDir);
        _fs.mkdirSync(path.dirname(file), { recursive: true });
        const line = JSON.stringify({
            key: makeKey(issue, kind, pr),
            issue: Number(issue) || String(issue),
            kind: String(kind),
            pr: Number(pr) || String(pr),
            ts: new Date(now).toISOString(),
        }) + '\n';
        _fs.appendFileSync(file, line, { mode: 0o600 });
        return true;
    } catch {
        return false; // fail-open: no romper el destrabe ya decidido
    }
}

/**
 * ceilingReached — ¿esta causa agotó su techo de auto-destrabes?
 * @returns {boolean} true ⇒ NO auto-destrabar (escala como bloqueo duro).
 */
function ceilingReached(opts = {}) {
    const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : DEFAULT_MAX_AUTO_RELEASES;
    return count(opts) >= max;
}

module.exports = {
    count,
    increment,
    ceilingReached,
    stateFile,
    makeKey,
    DEFAULT_MAX_AUTO_RELEASES,
    DEFAULT_TTL_MS,
};
