// =============================================================================
// desync-detector.js — Detección de desync entre waves.json y .partial-pause.json
// Issue #3518 (CA-6).
//
// Por qué este detector existe
// ----------------------------
// El Commander escribe los DOS archivos secuencialmente al promover una ola
// (waves.json → setActiveWave, luego .partial-pause.json → setAllowlist).
// Si el proceso muere entre los dos writes, los archivos quedan inconsistentes:
//
//   - waves.json dice "ola N+8 es activa, issues=[A, B, C]"
//   - .partial-pause.json sigue con allowlist=[X, Y] de la ola previa
//
// Resultado: el Pulpo procesa issues del wave VIEJO (los del allowlist) o NO
// procesa issues que ya deberían estarlo (los del wave nuevo).
//
// Política (security req #7 + CA-6)
// ----------------------------------
// Al startup del Pulpo, llamamos a `detectDesync()`. Si hay desync:
//
//   1. Loggear con detalle exacto de qué difiere.
//   2. Notificar Telegram con call-to-action y comando de diagnóstico.
//   3. Marcar `_desync-detected.flag` en .pipeline/ para que el dispatch loop
//      del Pulpo entre en modo human-block (no procesar nada hasta que un
//      humano lo destrabe explícitamente).
//
// Política de auto-reparación (SEC-6, carve-out #4350)
// ----------------------------------------------------
// Regla general: NO auto-reparar bajo asunción ciega de que waves.json es la
// verdad — hacerlo puede amplificar un compromiso si fue ese archivo el
// manipulado (OWASP A08). Por eso la clasificación es ASIMÉTRICA:
//
//   - `resoluble_reductivo`: la divergencia SOLO implica QUITAR de la allowlist
//     issues cerrados/ajenos a la ola activa (no otorga permisos nuevos a
//     partir de waves.json). El pulpo puede realinear a la ola activa dejando
//     traza (ver pulpo.realignAllowlistToActiveWave). SEC-1: la realineación
//     nunca agrega un issue ABIERTO ajeno; solo reduce.
//   - `ambiguo`: hay al menos un issue ABIERTO en la allowlist que NO está en
//     la ola activa (una autorización deliberada que realinear revocaría en
//     silencio), o el estado de cierre es indeterminado. En ese caso el
//     detector mantiene el comportamiento histórico: flag + human-block, NO
//     tocar. La decisión la toma el humano.
//
// Este módulo NO auto-repara: solo CLASIFICA y expone `classification`. La
// realineación reductiva vive en el pulpo (con predicado isClosed inyectado),
// nunca acá (regla "sin red / sin GitHub" del detector).
//
// API
// ---
//   detectDesync(opts?) → { desync: bool, reason, classification,
//                           waves_allowlist, partial_allowlist,
//                           added, removed, flag_path?, alerted? }
//
//   isDesyncFlagSet()  → bool  (consulta del flag de bloqueo)
//   clearDesyncFlag()  → void  (humano destraba)
//
// Reglas inquebrantables
// ----------------------
//   - Cero side effects en require (safe para tests).
//   - Tolerante a archivos ausentes (no es desync, es estado inicial).
//   - El "allowlist" comparable se deriva con normalizeIssue (int positivo).
//   - El detector NO escribe waves.json ni .partial-pause.json. Solo flag.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { notifyTelegram } = require('./notify-telegram');

const DESYNC_FLAG_BASENAME = '.desync-detected.flag';

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function desyncFlagPath() {
    return path.join(pipelineDir(), DESYNC_FLAG_BASENAME);
}

function normalizeIssue(issue) {
    const n = Number(String(issue).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Lee la allowlist de waves.json (vía lib/waves.getAllowlist) sin propagar
 * excepciones de schema (si waves.json está roto, devolvemos null y dejamos
 * que el caller decida cómo tratarlo). Sin fallback a partial-pause —
 * acá queremos la canónica del waves.
 */
function readWavesAllowlist(opts = {}) {
    const wavesPath = path.join(pipelineDir(), 'waves.json');
    if (!fs.existsSync(wavesPath)) return null;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(wavesPath, 'utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const active = parsed.active_wave;
    // active_wave === null/undefined: no hay ola promovida vía Commander todavía
    // (estado inicial o legacy con allowlist seteado manualmente). NO es desync,
    // es ausencia de canónica → mismo trato que "waves.json no existe".
    if (active === null || active === undefined) return null;
    if (typeof active !== 'object' || !Array.isArray(active.issues)) return [];
    return active.issues
        .filter((i) => i && i.status !== 'completed')
        .map((i) => normalizeIssue(i && i.number))
        .filter(Boolean);
}

/**
 * Lee la allowlist del .partial-pause.json. null si el archivo no existe o
 * es ilegible. Devuelve array vacío si existe pero está vacío.
 */
function readPartialAllowlist() {
    const partialPath = path.join(pipelineDir(), '.partial-pause.json');
    if (!fs.existsSync(partialPath)) return null;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(partialPath, 'utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const arr = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
    return arr.map(normalizeIssue).filter(Boolean);
}

/**
 * Calcula la diferencia entre dos arrays de números.
 * Devuelve { added: en B no en A, removed: en A no en B }.
 */
function diffAllowlists(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    const added = b.filter((x) => !setA.has(x));
    const removed = a.filter((x) => !setB.has(x));
    return { added, removed };
}

/**
 * Clasifica ASIMÉTRICAMENTE una divergencia entre la ola activa (waves.json) y
 * la allowlist (.partial-pause.json). Carve-out SEC-1..SEC-6 del issue #4350.
 *
 * Convención de `diff`: `added` = issues presentes en la ALLOWLIST que NO están
 * en la ola activa (extras de la allowlist); `removed` = issues de la ola que
 * faltan en la allowlist. La clave de la clasificación son los `added`:
 *
 *   - `resoluble_reductivo`: NO hay `added`, o todos los `added` están
 *     CONFIRMADOS cerrados. Realinear a la ola solo quita basura (cerrados/
 *     ajenos-cerrados) y agrega issues de una ola ya promovida atómicamente →
 *     el pulpo puede auto-reparar dejando traza.
 *   - `ambiguo`: hay al menos un `added` ABIERTO o de estado INDETERMINADO
 *     (sin predicado isClosed, o isClosed devuelve undefined). Realinear
 *     revocaría en silencio una autorización deliberada, o se apoyaría en
 *     estado no confiable → NO tocar, flag + human-block.
 *
 * Fail-safe (SEC-4): estado indeterminado nunca se trata como "cerrado" → cae
 * en `ambiguo`, jamás habilita una remoción a ciegas.
 *
 * @param {{ added: number[], removed: number[] }} diff
 * @param {(n:number)=>boolean|undefined} [isClosed] — predicado inyectado.
 *   `true` = cerrado confirmado; `false` = abierto; `undefined` = indeterminado.
 * @returns {'resoluble_reductivo'|'ambiguo'}
 */
function classifyDesync(diff, isClosed) {
    const added = Array.isArray(diff && diff.added) ? diff.added : [];
    if (added.length === 0) {
        // La allowlist es subconjunto de la ola; realinear solo agrega issues
        // de una ola ya promovida (no revoca nada abierto y ajeno).
        return 'resoluble_reductivo';
    }
    if (typeof isClosed !== 'function') {
        // Sin forma de confirmar que los extras están cerrados → conservador.
        return 'ambiguo';
    }
    // Reductivo SOLO si CADA extra de la allowlist está confirmado cerrado.
    // Cualquier abierto (false) o indeterminado (undefined) → ambiguo.
    const allExtrasClosed = added.every((n) => isClosed(n) === true);
    return allExtrasClosed ? 'resoluble_reductivo' : 'ambiguo';
}

/**
 * Detecta desync entre waves.json y .partial-pause.json.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipFlag=false] — si true, NO crea el flag al detectar.
 * @param {boolean} [opts.skipAlert=false] — si true, NO envía Telegram.
 * @param {(n:number)=>boolean|undefined} [opts.isClosed] — predicado inyectado
 *   para clasificar (ver classifyDesync). Sin él, cualquier divergencia con
 *   extras en la allowlist queda `ambiguo` (fail-safe). NUNCA llama a GitHub.
 * @returns {{
 *   desync: boolean,
 *   reason: string|null,
 *   classification: 'resoluble_reductivo'|'ambiguo'|null,
 *   waves_allowlist: number[]|null,
 *   partial_allowlist: number[]|null,
 *   added: number[],
 *   removed: number[],
 *   flag_path?: string,
 *   alerted?: boolean,
 * }}
 */
function detectDesync(opts = {}) {
    const wavesAllow = readWavesAllowlist();
    const partialAllow = readPartialAllowlist();

    // Casos sin desync:
    //   1. waves.json no existe ni partial-pause → estado inicial limpio.
    //   2. Solo existe partial-pause (waves.json todavía sin escribir) →
    //      backward compat con el modo legacy, no es inconsistencia.
    //   3. Solo existe waves.json (partial-pause se eliminó tras transición) →
    //      el pulpo usa getAllowlist() que ya cubre este caso.
    if (wavesAllow === null && partialAllow === null) {
        return { desync: false, reason: null, classification: null, waves_allowlist: null, partial_allowlist: null, added: [], removed: [] };
    }
    if (wavesAllow === null) {
        // Sin waves canónica, no podemos comparar. No es desync.
        return { desync: false, reason: 'no_waves_yet', classification: null, waves_allowlist: null, partial_allowlist: partialAllow, added: [], removed: [] };
    }
    if (partialAllow === null) {
        // Sin partial-pause, no hay desync (es el estado esperado post-cleanup).
        return { desync: false, reason: 'no_partial_pause', classification: null, waves_allowlist: wavesAllow, partial_allowlist: null, added: [], removed: [] };
    }

    const { added, removed } = diffAllowlists(wavesAllow.sort((a, b) => a - b), partialAllow.sort((a, b) => a - b));
    if (added.length === 0 && removed.length === 0) {
        return { desync: false, reason: null, classification: null, waves_allowlist: wavesAllow, partial_allowlist: partialAllow, added: [], removed: [] };
    }

    // Clasificación asimétrica (#4350): decide si el pulpo puede realinear
    // reductivamente (resoluble_reductivo) o debe bloquear (ambiguo).
    const classification = classifyDesync({ added, removed }, opts.isClosed);

    const result = {
        desync: true,
        reason: 'allowlist_mismatch',
        classification,
        waves_allowlist: wavesAllow,
        partial_allowlist: partialAllow,
        added,
        removed,
    };

    // Crear flag de bloqueo (humano destraba después de auditar).
    if (!opts.skipFlag) {
        const flagPath = desyncFlagPath();
        try {
            fs.writeFileSync(flagPath, JSON.stringify({
                detected_at: new Date().toISOString(),
                pid: process.pid,
                classification,
                waves_allowlist: wavesAllow,
                partial_allowlist: partialAllow,
                added,
                removed,
            }, null, 2));
            result.flag_path = flagPath;
        } catch (err) {
            console.warn(`[desync-detector] no se pudo crear flag ${flagPath}: ${err.message}`);
        }
    }

    if (!opts.skipAlert) {
        try {
            notifyTelegram({
                level: 'warn',
                component: 'waves-desync',
                message: 'waves.json y .partial-pause.json desincronizados',
                context: {
                    classification,
                    waves_allowlist: wavesAllow,
                    partial_allowlist: partialAllow,
                    extras_in_allowlist: added,
                    missing_from_allowlist: removed,
                },
                action: classification === 'resoluble_reductivo'
                    ? 'Divergencia REDUCTIVA (la allowlist tiene issues cerrados/ajenos respecto de la ola activa). El Pulpo realinea automáticamente a la ola activa dejando traza (carve-out #4350). No requiere acción manual salvo auditar la traza.'
                    : 'Divergencia AMBIGUA (hay issues abiertos en la allowlist fuera de la ola, o estado indeterminado). Pipeline en human-block. NO se autoreparó (SEC-1). Decidí vos cuál archivo refleja la verdad y arreglalo a mano.',
                diag: 'diff <(jq \'.active_wave.issues\' .pipeline/waves.json) <(jq \'.allowed_issues\' .pipeline/.partial-pause.json)',
            });
            result.alerted = true;
        } catch (err) {
            console.warn(`[desync-detector] alerta Telegram falló: ${err.message}`);
            result.alerted = false;
        }
    }

    return result;
}

function isDesyncFlagSet() {
    return fs.existsSync(desyncFlagPath());
}

function clearDesyncFlag() {
    const p = desyncFlagPath();
    if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
    }
}

module.exports = {
    detectDesync,
    classifyDesync,
    isDesyncFlagSet,
    clearDesyncFlag,
    DESYNC_FLAG_BASENAME,
    _internal: {
        readWavesAllowlist,
        readPartialAllowlist,
        diffAllowlists,
        classifyDesync,
        normalizeIssue,
        desyncFlagPath,
    },
};
