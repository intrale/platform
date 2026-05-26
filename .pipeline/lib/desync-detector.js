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
// NO AUTO-REPARAR. Auto-reparación bajo asunción de que waves.json es la
// verdad puede amplificar un compromiso si fue ese archivo el manipulado.
// La decisión cuál archivo refleja la realidad la toma el humano.
//
// API
// ---
//   detectDesync(opts?) → { desync: bool, waves_allowlist, partial_allowlist,
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
    if (!active || !Array.isArray(active.issues)) return [];
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
 * Detecta desync entre waves.json y .partial-pause.json.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipFlag=false] — si true, NO crea el flag al detectar.
 * @param {boolean} [opts.skipAlert=false] — si true, NO envía Telegram.
 * @returns {{
 *   desync: boolean,
 *   reason: string|null,
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
        return { desync: false, reason: null, waves_allowlist: null, partial_allowlist: null, added: [], removed: [] };
    }
    if (wavesAllow === null) {
        // Sin waves canónica, no podemos comparar. No es desync.
        return { desync: false, reason: 'no_waves_yet', waves_allowlist: null, partial_allowlist: partialAllow, added: [], removed: [] };
    }
    if (partialAllow === null) {
        // Sin partial-pause, no hay desync (es el estado esperado post-cleanup).
        return { desync: false, reason: 'no_partial_pause', waves_allowlist: wavesAllow, partial_allowlist: null, added: [], removed: [] };
    }

    const { added, removed } = diffAllowlists(wavesAllow.sort((a, b) => a - b), partialAllow.sort((a, b) => a - b));
    if (added.length === 0 && removed.length === 0) {
        return { desync: false, reason: null, waves_allowlist: wavesAllow, partial_allowlist: partialAllow, added: [], removed: [] };
    }

    const result = {
        desync: true,
        reason: 'allowlist_mismatch',
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
                    waves_allowlist: wavesAllow,
                    partial_allowlist: partialAllow,
                    added_in_waves: added,
                    removed_from_partial: removed,
                },
                action: 'Pipeline en modo human-block. NO se autoreparó (política de seguridad #7). Decidí vos cuál archivo refleja la verdad y arreglalo a mano.',
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
    isDesyncFlagSet,
    clearDesyncFlag,
    DESYNC_FLAG_BASENAME,
    _internal: {
        readWavesAllowlist,
        readPartialAllowlist,
        diffAllowlists,
        normalizeIssue,
        desyncFlagPath,
    },
};
