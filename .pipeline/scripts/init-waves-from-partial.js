#!/usr/bin/env node
// =============================================================================
// init-waves-from-partial.js — Seed inicial de waves.json desde .partial-pause.json
// Issue #3616.
//
// Por qué este script existe
// --------------------------
// Hasta #3616, `.partial-pause.json` era la fuente operativa real del intake
// (el pulpo mira `partialPause.isIssueAllowed()`), pero `waves.json` quedó
// vacío desde 2026-05-24 (sin source-of-truth de planificación). El fallback
// de `lib/waves.js:getAllowlist()` enmascaraba el problema durante días sin
// que nadie notara el desync.
//
// Este init **siembra** `waves.json` UNA sola vez (cuando arranca el pulpo y
// detecta el estado degradado) usando como input la allowlist actual de
// `.partial-pause.json`. Después de eso, el flujo Opción A queda armado:
//
//   waves.json (canónica) → /wave promote → .partial-pause.json (espejo)
//
// Garantías inquebrantables (PO CA-1 + security req 1)
// ----------------------------------------------------
//   - **Idempotente**: si `waves.json` ya tiene `active_wave != null`, no
//     toca nada. Re-ejecutable infinitas veces sin corromper estado.
//   - **Atómico**: write vía `atomicWriteFile` (tmp + fsync + rename, retry
//     EPERM/EBUSY en Windows). Cero archivos parciales.
//   - **Fail-closed**: si `.partial-pause.json` está malformado (IDs no
//     enteros, payload inesperado, campos extra que no parsean), aborta sin
//     tocar `waves.json` + log explícito + Telegram dedupedo.
//   - **Cero deps npm**: solo `fs`, `path`, `crypto` + libs internas del
//     pipeline (waves, notify-telegram).
//   - **Sin red**: no llama a GitHub ni servicios externos.
//
// Numeración (guru riesgo #4)
// ---------------------------
// La ola sembrada usa `number = max(archived.number) + 1` (default `1` si no
// hay archivadas). Esto es un seed conservador — el operador puede renombrar
// después con `/wave promote N` si quiere otro número, pero el init no inventa
// nombres tipo "N+11" ni los lee del environment.
//
// API
// ---
//   initWavesFromPartial(opts?) →
//     { action, reason?, seededWave?, waveNumber?, allowlist?, skipAlert? }
//
//   action ∈ { 'noop_already_seeded', 'noop_no_partial', 'noop_empty_partial',
//              'seeded', 'aborted_invalid_partial', 'aborted_waves_corrupt' }
//
// Ejecutar como CLI (para debugging):
//   node .pipeline/scripts/init-waves-from-partial.js [--dry-run]
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Resolver el root: si el script vive en `.pipeline/scripts/`, el root es el
// parent. Si se invoca como módulo desde `pulpo.js`, `PIPELINE_DIR_OVERRIDE`
// (env var) lo redirige para tests.
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function wavesFile() { return path.join(pipelineDir(), 'waves.json'); }
function partialFile() { return path.join(pipelineDir(), '.partial-pause.json'); }

// ─── Sanitización defensiva ─────────────────────────────────────────────────

function normalizeIssue(issue) {
    // Trim + strip de `#` opcional — patrón replicado de lib/waves.js.
    const n = Number(String(issue).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── #4030 — Metadata real de la ola (nombre/número del plan maestro) ────────
//
// El seeder recupera el nombre/número reales de la ola activa para que
// sobrevivan a un `/restart` sin renombrado manual. Fuente de verdad en orden
// de preferencia:
//   1. Campos estructurados `wave_number`/`wave_name`/`wave_goal` (robusto).
//   2. Parseo del `note` de texto libre (fallback de compatibilidad, tolerante).
//   3. `Ola seed #N` (último recurso, en el constructor del seed).
//
// Ambos extractores son TOLERANTES A FALLO: nunca lanzan ni convierten el
// payload en `aborted_invalid_partial`. Un meta inválido degrada al fallback.

/**
 * Saneado fail-closed de los campos estructurados (security #4030):
 *   - `wave_number`: entero positivo.
 *   - `wave_name`: string, strip de control-chars (U+0000..U+001F), cap 120.
 *   - `wave_goal`: string opcional, strip de control-chars, cap 500.
 * Convención de display (UX #4030): el `name` guarda SÓLO el título; si viene
 * con prefijo "Ola N — " se normaliza quitándolo. Devuelve null si falta
 * número+nombre válidos.
 */
function sanitizeWaveMeta(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const stripCtl = (s) => String(s).replace(/[\x00-\x1f]/g, '').trim();
    const num = Number.isInteger(parsed.wave_number) && parsed.wave_number > 0
        ? parsed.wave_number : null;
    const rawName = typeof parsed.wave_name === 'string' ? stripCtl(parsed.wave_name) : '';
    const name = rawName
        ? rawName.replace(/^Ola\s+\d+\s*[—–-]\s*/i, '').slice(0, 120)
        : null;
    const goal = typeof parsed.wave_goal === 'string'
        ? stripCtl(parsed.wave_goal).slice(0, 500) : '';
    if (num === null || !name) return null;
    return { number: num, name, goal };
}

/**
 * Fallback de compatibilidad: parsea el `note` de texto libre del Commander
 * (ej. "Ola 4 'Memoria + dashboard operativo núcleo' habilitada por..."). Tolera
 * comillas simples, dobles y tipográficas. NO lanza ni loguea el contenido
 * crudo (security req 3). Si no matchea, devuelve null.
 */
function parseWaveMetaFromNote(note) {
    if (typeof note !== 'string' || !note) return null;
    const stripCtl = (s) => String(s).replace(/[\x00-\x1f]/g, '').trim();
    const m = note.match(/Ola\s+(\d+)\s+['"‘’“”]([^'"‘’“”]+)['"‘’“”]/);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isInteger(num) || num <= 0) return null;
    const name = stripCtl(m[2]).slice(0, 120);
    if (!name) return null;
    return { number: num, name, goal: '' };
}

/**
 * Extrae la metadata de ola del payload, preferencia estructurado > note > null.
 * Tolerante a fallo: nunca lanza.
 */
function extractWaveMeta(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    return sanitizeWaveMeta(parsed) || parseWaveMetaFromNote(parsed.note) || null;
}

function nowIso() {
    return new Date().toISOString();
}

function logInfo(msg) {
    console.log(`[init-waves] ${msg}`);
}

function logWarn(msg) {
    console.warn(`[init-waves] ${msg}`);
}

/**
 * Lee `.partial-pause.json` y devuelve `{ ok, allowedIssues, errors, raw }`.
 * Fail-closed: si CUALQUIER allowed_issue no es entero positivo, devuelve
 * ok=false + lista de errores. NO acepta payloads parciales.
 *
 * Aceptación CA-1 + security req 1:
 *   - `allowed_issues` debe ser array.
 *   - cada entrada debe normalizar a int positivo.
 *   - campos extra del payload no rompen — son ignorados (forward compat).
 */
function readPartialStrict() {
    if (!fs.existsSync(partialFile())) {
        return { ok: true, action: 'noop_no_partial', allowedIssues: [], errors: [] };
    }
    let raw, parsed;
    try {
        raw = fs.readFileSync(partialFile(), 'utf8');
    } catch (err) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: [`read falló: ${err.message}`],
        };
    }
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: [`JSON inválido: ${err.message}`],
        };
    }
    if (!parsed || typeof parsed !== 'object') {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: ['payload no es un objeto'],
        };
    }
    if (!Array.isArray(parsed.allowed_issues)) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: ['allowed_issues ausente o no-array'],
        };
    }
    // Fail-closed: si cualquier ID no normaliza a int positivo, abortamos.
    // No "filtramos los buenos" silenciosamente — el operador necesita saber
    // que su payload tiene basura antes de que el init siembre estado.
    const errors = [];
    const allowed = [];
    for (const raw of parsed.allowed_issues) {
        const n = normalizeIssue(raw);
        if (n === null) {
            errors.push(`ID inválido: ${JSON.stringify(raw)}`);
        } else {
            allowed.push(n);
        }
    }
    if (errors.length > 0) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors,
        };
    }
    // Deduplicar manteniendo orden de aparición.
    const unique = [...new Set(allowed)];
    // #4030 — Extracción tolerante de metadata de ola (aditiva, NO fail-closed):
    // un meta ausente/inválido degrada a null y el seed cae al fallback genérico.
    const waveMeta = extractWaveMeta(parsed);
    return { ok: true, allowedIssues: unique, errors: [], waveMeta };
}

/**
 * Lee `waves.json` (si existe) y devuelve `{ ok, hasActiveWave, maxArchivedNumber, errors }`.
 *
 * - Si no existe: ok=true, hasActiveWave=false, maxArchivedNumber=0.
 * - Si existe y parsea: revisa `active_wave` y `archived_waves[*].number`.
 * - Si existe pero está corrupto: ok=false, errors. NO tocamos en ese caso —
 *   el desync-detector y el recovery del Commander lo manejan.
 */
function readWavesState() {
    if (!fs.existsSync(wavesFile())) {
        return { ok: true, hasActiveWave: false, maxArchivedNumber: 0, nextWaveNumber: 1, preservedIdentity: null, raw: null };
    }
    let raw;
    try {
        raw = fs.readFileSync(wavesFile(), 'utf8');
    } catch (err) {
        return {
            ok: false,
            action: 'aborted_waves_corrupt',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: [`read falló: ${err.message}`],
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return {
            ok: false,
            action: 'aborted_waves_corrupt',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: [`JSON inválido: ${err.message}`],
        };
    }
    if (!parsed || typeof parsed !== 'object') {
        return {
            ok: false,
            action: 'aborted_waves_corrupt',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: ['payload no es un objeto'],
        };
    }
    // active_wave != null + es objeto + tiene number → ya hay ola activa.
    const hasActiveWave = !!(parsed.active_wave && typeof parsed.active_wave === 'object'
        && Number.isInteger(parsed.active_wave.number));
    // Calcular max archived number para el seed (guru riesgo #4).
    let maxArchivedNumber = 0;
    const archived = Array.isArray(parsed.archived_waves) ? parsed.archived_waves : [];
    for (const w of archived) {
        if (w && Number.isInteger(w.number) && w.number > maxArchivedNumber) {
            maxArchivedNumber = w.number;
        }
    }
    // Considerar también planned_waves para no chocar con números ya planificados.
    const planned = Array.isArray(parsed.planned_waves) ? parsed.planned_waves : [];
    for (const w of planned) {
        if (w && Number.isInteger(w.number) && w.number > maxArchivedNumber) {
            maxArchivedNumber = w.number;
        }
    }
    // #4446 — contador monotónico persistido. Es la fuente de identidad del seed:
    // si existe en `meta.next_wave_number` (entero ≥ 1) lo usamos tal cual; si no,
    // backfill `max(existentes) + 1` (incluye active_wave si lo hubiera). NUNCA se
    // deriva la identidad del `waveMeta.number` externo del .partial-pause.json.
    let maxKnown = maxArchivedNumber;
    if (parsed.active_wave && Number.isInteger(parsed.active_wave.number) && parsed.active_wave.number > maxKnown) {
        maxKnown = parsed.active_wave.number;
    }
    const persistedCounter = parsed.meta && Number.isInteger(parsed.meta.next_wave_number)
        && parsed.meta.next_wave_number >= 1
        ? parsed.meta.next_wave_number
        : null;
    const nextWaveNumber = persistedCounter !== null ? persistedCounter : (maxKnown + 1);
    // #4532 — Identidad persistida de la ola (número/título/goal/comienzo),
    // escrita por `waves.js` en cada save (`meta.active_wave_identity`). Cuando
    // `active_wave` se vació (wipe/restore parcial), esta sombra permite RECUPERAR
    // la identidad real en el re-seed en vez de mintear placeholders. Se sanea:
    // sólo se acepta si trae un `number` entero positivo.
    let preservedIdentity = null;
    const rawIdentity = parsed.meta && parsed.meta.active_wave_identity;
    if (rawIdentity && typeof rawIdentity === 'object'
        && Number.isInteger(rawIdentity.number) && rawIdentity.number > 0) {
        const stripCtl = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f]/g, '').trim() : null);
        preservedIdentity = {
            number: rawIdentity.number,
            name: stripCtl(rawIdentity.name) || null,
            goal: stripCtl(rawIdentity.goal) || null,
            started_at: (typeof rawIdentity.started_at === 'string'
                && Number.isFinite(Date.parse(rawIdentity.started_at)))
                ? rawIdentity.started_at : null,
        };
    }
    return { ok: true, hasActiveWave, maxArchivedNumber, nextWaveNumber, preservedIdentity, raw: parsed };
}

/**
 * Notifica Telegram con dedupe simple por boot (flag in-memory por proceso).
 * Si Telegram no está disponible (require falla, settings inválidas), no rompe.
 */
let _telegramSentForBoot = false;
function notifyOnceForBoot(payload) {
    if (_telegramSentForBoot) return false;
    _telegramSentForBoot = true;
    try {
        const { notifyTelegram } = require('../lib/notify-telegram');
        notifyTelegram(payload);
        return true;
    } catch (err) {
        logWarn(`notifyTelegram falló: ${err.message}`);
        return false;
    }
}

// Reset interno para tests — permite que cada caso simule un boot fresco.
function _resetDedupeForTests() {
    _telegramSentForBoot = false;
}

/**
 * Punto de entrada principal.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — si true, no escribe waves.json.
 * @param {boolean} [opts.skipAlert=false] — si true, no envía Telegram.
 * @returns {{
 *   action: 'noop_already_seeded'|'noop_no_partial'|'noop_empty_partial'|
 *           'seeded'|'aborted_invalid_partial'|'aborted_waves_corrupt',
 *   reason?: string,
 *   seededWave?: object,
 *   waveNumber?: number,
 *   allowlist?: number[],
 *   alerted?: boolean,
 *   errors?: string[],
 * }}
 */
function initWavesFromPartial(opts = {}) {
    const dryRun = opts.dryRun === true;
    const skipAlert = opts.skipAlert === true;

    // 1. Leer waves.json — si está corrupto, abortamos sin tocar.
    const wavesState = readWavesState();
    if (!wavesState.ok) {
        logWarn(`waves.json corrupto, no toco: ${wavesState.errors.join('; ')}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: 'waves.json corrupto, init abortado',
                detail: wavesState.errors.join('; ').slice(0, 200),
                action: 'Revisá .pipeline/waves.json. El init NO modificó el archivo. ' +
                    'El desync-detector va a alertar también si el partial-pause queda sin canónica.',
            });
        }
        return {
            action: 'aborted_waves_corrupt',
            reason: 'waves.json corrupto',
            errors: wavesState.errors,
        };
    }

    // 2. Idempotencia: si ya hay ola activa, NO tocar (CA-1 punto 3).
    if (wavesState.hasActiveWave) {
        logInfo(`waves.json ya tiene active_wave (number=${wavesState.raw.active_wave.number}) — no-op.`);
        return {
            action: 'noop_already_seeded',
            reason: 'active_wave existe',
            waveNumber: wavesState.raw.active_wave.number,
        };
    }

    // 3. Leer .partial-pause.json — si está malformado, fail-closed.
    const partial = readPartialStrict();
    if (!partial.ok) {
        logWarn(`.partial-pause.json malformado, init abortado: ${partial.errors.join('; ')}`);
        if (!skipAlert) {
            // Importante: NO incluir el raw del archivo (security req 3) — solo
            // contar cuántos errores hubo y el primer error para diagnóstico.
            const firstError = partial.errors[0] || 'desconocido';
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: '.partial-pause.json malformado, init abortado',
                detail: `${partial.errors.length} error(es); primero: ${firstError.slice(0, 120)}`,
                action: 'Revisá .pipeline/.partial-pause.json. ' +
                    'El init NO sembró waves.json. Allowlist queda vacía hasta que se corrija.',
            });
        }
        return {
            action: 'aborted_invalid_partial',
            reason: 'partial-pause malformado',
            errors: partial.errors,
        };
    }

    // 4. Si no hay partial-pause o está vacío, no hay nada que sembrar.
    //    Esto NO es un error — es un estado válido (pipeline fresco, sin issues
    //    en intake). El desync-detector ya tolera este caso.
    if (partial.action === 'noop_no_partial' || partial.allowedIssues.length === 0) {
        const reason = partial.action === 'noop_no_partial'
            ? 'no hay .partial-pause.json'
            : 'allowlist vacía';
        logInfo(`Nada para sembrar (${reason}) — no-op.`);
        return {
            action: partial.action === 'noop_no_partial' ? 'noop_no_partial' : 'noop_empty_partial',
            reason,
        };
    }

    // 5. Construir el seed: ola activa con los issues del allowlist.
    //    #4446 — La IDENTIDAD (número) de la ola sembrada sale del contador
    //    monotónico persistido (`meta.next_wave_number`), NO de `maxArchivedNumber
    //    + 1` ni del `waveMeta.number` externo del .partial-pause.json (fuente
    //    semi-confiable). Así un re-seed post-restart conserva el número sin
    //    reasignarlo desde metadata externa. El contador se incrementa y se
    //    persiste en el newState.meta más abajo.
    //    Guard de colisión defensivo (riesgo guru #1 + security #4): el contador
    //    monotónico es por diseño > cualquier archived/planned; si por un state
    //    corrupto quedara ≤ max conocido, lo elevamos a `maxArchivedNumber + 1`.
    // #4532 — RECUPERACIÓN DE IDENTIDAD. Si existe una identidad persistida
    // (`meta.active_wave_identity`, escrita por waves.js mientras había ola
    // activa), este re-seed NO está comenzando una ola nueva: la ola se vació
    // (wipe/restore parcial) y la estamos reconstruyendo. En ese caso preservamos
    // número, título, goal y —crítico— el `started_at` ORIGINAL (nunca `nowIso()`,
    // que es justo el bug de este issue: comienzo/velocidad reseteados). La
    // identidad SÓLO se mintea de cero cuando no hay identidad previa (primer
    // arranque real del pipeline).
    let waveNumber;
    let name;
    let goal;
    let startedAt;
    let preservingIdentity = false;
    let counterOverride = null; // si preservamos, no incrementamos el contador
    if (wavesState.preservedIdentity) {
        preservingIdentity = true;
        const pi = wavesState.preservedIdentity;
        waveNumber = pi.number;
        name = pi.name || `Ola ${waveNumber}`;
        goal = pi.goal || 'Ola recuperada tras reinicio — identidad preservada (#4532).';
        startedAt = pi.started_at || nowIso();
        // El contador ya reflejaba esta identidad; lo conservamos tal cual (no
        // "gastamos" un número nuevo por reconstruir la misma ola).
        counterOverride = (wavesState.raw && wavesState.raw.meta
            && Number.isInteger(wavesState.raw.meta.next_wave_number))
            ? wavesState.raw.meta.next_wave_number
            : (waveNumber + 1);
        logInfo(`Identidad de ola RECUPERADA de meta.active_wave_identity: #${waveNumber} "${name}" ` +
            `(comienzo original ${startedAt}) — re-seed NO resetea identidad ni comienzo.`);
    } else {
        // Sin identidad previa → minteo genuino de una ola nueva.
        waveNumber = wavesState.nextWaveNumber;
        if (!Number.isInteger(waveNumber) || waveNumber <= wavesState.maxArchivedNumber) {
            const safe = wavesState.maxArchivedNumber + 1;
            logWarn(`Contador de ola inválido/colisiona (#${waveNumber} ≤ max=${wavesState.maxArchivedNumber}) ` +
                `— elevo a #${safe}.`);
            waveNumber = safe;
        }
        //    #4030 — El partial-pause SÍ aporta nombre/goal reales del plan maestro
        //    (mejor UX que `Ola seed #N`). Mantenemos el guard de confianza original
        //    para el NOMBRE/GOAL (sólo si `waveMeta.number` supera lo archivado/
        //    planificado); pero el NÚMERO ya lo fijó el contador, nunca `waveMeta`.
        name = `Ola seed #${waveNumber}`;
        goal = 'Seed inicial generado desde .partial-pause.json (issue #3616).';
        if (partial.waveMeta && partial.waveMeta.number > wavesState.maxArchivedNumber) {
            name = partial.waveMeta.name;
            goal = partial.waveMeta.goal || goal;
            logInfo(`Metadata de ola recuperada del plan maestro: ola #${waveNumber} "${name}" ` +
                `(número asignado por contador monotónico, no por metadata externa).`);
        } else if (partial.waveMeta) {
            logWarn(`Número externo (#${partial.waveMeta.number}) colisiona con archived/planned ` +
                `(max=${wavesState.maxArchivedNumber}) — nombre genérico, número por contador #${waveNumber}.`);
        }
        startedAt = nowIso();
    }
    const seededWave = {
        number: waveNumber,
        name,
        goal,
        started_at: startedAt,
        issues: partial.allowedIssues.map((n) => ({ number: n, status: 'in_progress' })),
    };

    if (dryRun) {
        logInfo(`[dry-run] sembraría ola #${waveNumber} con ${partial.allowedIssues.length} issues.`);
        return {
            action: 'seeded',
            reason: 'dry-run',
            seededWave,
            waveNumber,
            allowlist: partial.allowedIssues,
        };
    }

    // 6. Persistir via lib/waves.js. Usamos `saveState` interno (vía
    //    `addIssueToWave` o el _internal export) NO — porque eso requeriría
    //    crear la ola "vacía" primero y después agregar issues uno a uno.
    //    En cambio, usamos `atomicWriteFile` directo con el state completo.
    //    Esto es seguro porque:
    //      - validamos el state contra `validateStateStrict` antes de escribir.
    //      - el write es atómico (tmp + fsync + rename + retry EPERM).
    //      - no estamos pisando datos: `hasActiveWave` ya fue chequeado.
    let waves;
    try {
        waves = require('../lib/waves');
    } catch (err) {
        logWarn(`lib/waves no cargó: ${err.message}`);
        return {
            action: 'aborted_waves_corrupt',
            reason: `lib/waves no disponible: ${err.message}`,
            errors: [err.message],
        };
    }

    // Construir state completo preservando lo que había (planned_waves, etc.).
    const prev = wavesState.raw || {};
    const newState = {
        version: '1.0',
        meta: {
            created_at: (prev.meta && prev.meta.created_at) || nowIso(),
            updated_at: nowIso(),
            updated_by: 'init-waves-from-partial',
            source: preservingIdentity ? 'auto-seed-recovered' : 'auto-seed',
            // #4446/#4532 — contador monotónico. Al MINTEAR una ola nueva se
            // incrementa (nunca reutiliza el número recién sembrado). Al RECUPERAR
            // una identidad existente (re-seed post-wipe) se conserva el contador
            // previo: no gastamos un número nuevo por reconstruir la misma ola.
            next_wave_number: preservingIdentity ? counterOverride : (waveNumber + 1),
            note: preservingIdentity
                ? `Re-seed con identidad RECUPERADA (#4532): ola #${waveNumber} "${name}" ` +
                    `(comienzo original preservado). ${partial.allowedIssues.length} issue(s) re-sembrados.`
                : (partial.waveMeta && partial.waveMeta.number > wavesState.maxArchivedNumber)
                    ? `Seed desde .partial-pause.json (#3616/#4030): ola #${waveNumber} "${name}" ` +
                        `con ${partial.allowedIssues.length} issue(s).`
                    : `Seed inicial desde .partial-pause.json (#3616). ` +
                        `${partial.allowedIssues.length} issue(s) sembrados en ola #${waveNumber}.`,
        },
        active_wave: seededWave,
        planned_waves: Array.isArray(prev.planned_waves) ? prev.planned_waves : [],
        archived_waves: Array.isArray(prev.archived_waves) ? prev.archived_waves : [],
        dependencies: Array.isArray(prev.dependencies) ? prev.dependencies : [],
    };

    // Validación strict pre-write (security req 1, fail-closed).
    const validationErrors = waves.validateStateStrict
        ? waves.validateStateStrict(newState)
        : [];
    if (validationErrors.length > 0) {
        logWarn(`state inválido pre-write: ${validationErrors.join('; ')}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: 'state generado inválido pre-write, init abortado',
                detail: validationErrors.join('; ').slice(0, 200),
                action: 'Bug interno del init — revisá lib/waves.validateStateStrict.',
            });
        }
        return {
            action: 'aborted_invalid_partial',
            reason: 'state generado inválido',
            errors: validationErrors,
        };
    }

    // #4577 GATE 3 — INVARIANTE log-antes-de-mutar (RS-2): registrar el re-seed
    // de ola ANTES del write atómico de waves.json (un re-seed puede resetear
    // progreso/identidad de la ola). Best-effort: el audit nunca bloquea el seed.
    try {
        require('../lib/kernel-actions-audit').safeAppendAction({
            action: 'reseed-wave', impact: 'alto',
            reason: `initWavesFromPartial: seed ola #${waveNumber} "${name}" con ${partial.allowedIssues.length} issue(s)` +
                (preservingIdentity ? ' (identidad recuperada #4532)' : ' (minteo nuevo)'),
            authorizedBy: 'kernel:auto',
        });
    } catch {}

    try {
        waves.atomicWriteFile(wavesFile(), JSON.stringify(newState, null, 2));
        waves.invalidateCache();
    } catch (err) {
        logWarn(`write atómico de waves.json falló: ${err.message}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: 'write atómico de waves.json falló',
                detail: err.message.slice(0, 200),
                action: 'Revisá permisos/espacio en disco. Pipeline puede quedar con allowlist vacía.',
            });
        }
        return {
            action: 'aborted_waves_corrupt',
            reason: `write falló: ${err.message}`,
            errors: [err.message],
        };
    }

    logInfo(`waves.json sembrado: ola #${waveNumber} con ${partial.allowedIssues.length} issue(s).`);
    return {
        action: 'seeded',
        seededWave,
        waveNumber,
        allowlist: partial.allowedIssues,
    };
}

module.exports = {
    initWavesFromPartial,
    // Helpers expuestos para tests.
    _internal: {
        readPartialStrict,
        readWavesState,
        normalizeIssue,
        _resetDedupeForTests,
        // #4030 — extractores de metadata de ola (expuestos para tests).
        sanitizeWaveMeta,
        parseWaveMetaFromNote,
        extractWaveMeta,
    },
};

// ─── CLI mode ───────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const result = initWavesFromPartial({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    // Exit code: 0 si no hubo error fatal, 2 si abortamos por inputs inválidos.
    if (result.action === 'aborted_invalid_partial' || result.action === 'aborted_waves_corrupt') {
        process.exit(2);
    }
    process.exit(0);
}
