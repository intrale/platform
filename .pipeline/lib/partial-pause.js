// V3 Partial pause — pausa del pipeline con allowlist explícita de issues (#2490).
//
// Tres estados del pipeline:
//   - running        → sin archivos de control (ver #5060: NO es barra libre)
//   - paused         → .pipeline/.paused existe → no procesa nada
//   - partial_pause  → .pipeline/.partial-pause.json existe → procesa solo issues del allowlist
//
// Precedencia: paused > partial_pause > running. Si coexisten .paused y
// .partial-pause.json, .paused gana (más restrictivo).
//
// La tabla de verdad de isIssueAllowed(issue):
//   running          → false (#5060: ejecución solo por olas; sin allowlist no
//                      hay ola vigente que acote el dispatch. Escape hatch de
//                      diagnóstico: PIPELINE_ALLOW_UNSCOPED_DISPATCH=1)
//   paused           → false
//   partial_pause    → issue in allowedIssues
//
// El marker JSON tiene el shape (campos adicionales son aditivos: lectores que
// no los conocen los ignoran sin romperse):
//   {
//     allowed_issues: [2490, 2491],
//     created_at: "2026-04-23T19:40:00Z",
//     source: "telegram",
//     accepted_dep_risk?: true,             // #2893: el operador eligió continuar
//                                           //         aceptando que un issue tiene
//                                           //         deps abiertas fuera del allowlist.
//     dep_sources?: { "2491": "auto-deps" }, // #2893: por qué cada issue está incluido.
//     allowed_skills?: ["multi-provider-smoke-test"]  // #3680 CA-A15: skills
//                                           //         (no issues) habilitados para
//                                           //         correr en la ventana de pausa.
//                                           //         Co-existe con allowed_issues;
//                                           //         el harness chequea su skill
//                                           //         contra esta lista vía
//                                           //         isSkillAllowed(name).
//   }
//
// -----------------------------------------------------------------------------
// #3625 — Gate de autorización + audit trail (Ola N+11 incident hardening)
// -----------------------------------------------------------------------------
//
// Toda mutación de `.partial-pause.json` ahora pasa por un gate que:
//   1. Valida `opts.authorizedBy` contra un enum cerrado (ver
//      `lib/partial-pause-audit.AUTHORIZED_BY_ENUM`).
//   2. Computa diff (added/removed) entre el estado previo y el propuesto.
//   3. Rechaza removals sin `authorizedBy` válido → REJECTED + audit entry.
//   4. Sanitiza `opts.justification` (max 500 chars + redact secrets).
//   5. **Orden invariante**: escribe la entry de audit ANTES de modificar el
//      estado. Si el proceso muere entre los dos pasos, el audit registra la
//      intención pero el estado sigue como antes (recuperable). El orden
//      inverso es el bug exacto que estamos arreglando.
//
// **Período de gracia (CA-2)**: durante 1 release los callers sin
// `authorizedBy` reciben un warning (no fail-closed estricto). El env var
// `PARTIAL_PAUSE_STRICT_AUTH=1` activa el fail-closed antes de tiempo (para
// tests). Pasado el grace period, el default cambia a strict.

'use strict';

const fs = require('fs');
const path = require('path');
const { withLockSync } = require('./file-lock');
const { notifyTelegram } = require('./notify-telegram');
const { atomicWriteFile } = require('./waves');
const audit = require('./partial-pause-audit');

const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;

// #3625 — Fail-closed estricto cuando se rechaza removal sin authorizedBy.
// **Default OFF (grace mode)** por decisión PO/security CA-2: 1 release con
// deprecation warning logueado para detectar callers no migrados, antes del
// fail-closed estricto. Operador habilita strict explícitamente con
// `PARTIAL_PAUSE_STRICT_AUTH=1`. El audit log captura las mutaciones SIEMPRE
// (con `gate_grace: true` para los rechazos que pasaron en este período).
function strictGateEnabled() {
    return process.env.PARTIAL_PAUSE_STRICT_AUTH === '1';
}

function pipelineDir() {
    // Permitir override en tests vía env var
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function partialFile() { return path.join(pipelineDir(), '.partial-pause.json'); }
function pauseFile() { return path.join(pipelineDir(), '.paused'); }

function normalizeIssue(issue) {
    const n = Number(String(issue).replace(/^#/, '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

// #4030 — Metadata estructurada de la ola activa (campos aditivos). Permite que
// el seeder (init-waves-from-partial) recupere nombre/número reales tras un
// `/restart` sin tener que parsear el `note` de texto libre. Saneado fail-closed
// (mismo criterio que el resto del marker + hardening de security #4030):
//   - `wave_number`: entero positivo.
//   - `wave_name`: string, strip de control-chars (U+0000..U+001F), cap 120.
//   - `wave_goal`: string opcional, strip de control-chars, cap 500.
// Convención de display (UX #4030): `wave_name` guarda SÓLO el título; si el
// caller trae el prefijo "Ola N — " lo normalizamos quitándolo, para que cada
// consumidor (/wave, dashboard) componga "Ola N — <título>" sin duplicar.
// Devuelve null si falta número+nombre válidos (el seeder cae al fallback).
function sanitizeWaveMetaForWrite(opts) {
    if (!opts || typeof opts !== 'object') return null;
    const stripCtl = (s) => String(s).replace(/[\x00-\x1f]/g, '').trim();
    const num = Number.isInteger(opts.waveNumber) && opts.waveNumber > 0
        ? opts.waveNumber : null;
    const rawName = typeof opts.waveName === 'string' ? stripCtl(opts.waveName) : '';
    const name = rawName
        ? rawName.replace(/^Ola\s+\d+\s*[—–-]\s*/i, '').slice(0, 120)
        : null;
    const goal = typeof opts.waveGoal === 'string'
        ? stripCtl(opts.waveGoal).slice(0, 500) : '';
    if (num === null || !name) return null;
    return { wave_number: num, wave_name: name, wave_goal: goal };
}

function readPartialFile() {
    try {
        const raw = fs.readFileSync(partialFile(), 'utf8');
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
        const allowed = arr.map(normalizeIssue).filter(Boolean);
        // #2893: campos opcionales aditivos.
        const acceptedDepRisk = parsed.accepted_dep_risk === true;
        const depSources = (parsed.dep_sources && typeof parsed.dep_sources === 'object')
            ? parsed.dep_sources
            : null;
        // #3680 CA-A15: allowed_skills co-existente con allowed_issues.
        // Normalización: strings no vacíos, sin duplicados, orden estable.
        const rawSkills = Array.isArray(parsed.allowed_skills) ? parsed.allowed_skills : [];
        const allowedSkills = [...new Set(
            rawSkills
                .filter(s => typeof s === 'string')
                .map(s => s.trim())
                .filter(Boolean)
        )].sort();
        return {
            allowed_issues: allowed,
            allowed_skills: allowedSkills,
            created_at: parsed.created_at || null,
            source: parsed.source || null,
            accepted_dep_risk: acceptedDepRisk,
            dep_sources: depSources,
            // #3625: TTLs de autoría heredada (recursive-deps:from-N) viven en
            // un campo aditivo del JSON y se purgan vía pulpo:cleanup cron.
            authorization_ttls: (parsed.authorization_ttls && typeof parsed.authorization_ttls === 'object')
                ? parsed.authorization_ttls
                : null,
        };
    } catch {
        return null;
    }
}

/**
 * Lee el snapshot raw del archivo (allowlist sin filtrar a lista vacía).
 * Útil para callers del gate que necesitan la "previous" exacta antes del
 * write — `getPipelineMode()` mapea a `running` cuando la lista está vacía
 * y eso oculta el diff real.
 */
function readPreviousAllowlist() {
    const raw = readPartialFile();
    return raw ? raw.allowed_issues : [];
}

/**
 * Estado actual del pipeline.
 * @returns {{
 *   mode: 'running'|'paused'|'partial_pause',
 *   allowedIssues: number[],
 *   createdAt: string|null,
 *   source: string|null,
 *   acceptedDepRisk: boolean,
 *   depSources: Object|null,
 * }}
 */
function getPipelineMode() {
    if (fs.existsSync(pauseFile())) {
        return {
            mode: 'paused', allowedIssues: [], allowedSkills: [], createdAt: null, source: null,
            acceptedDepRisk: false, depSources: null,
        };
    }
    const partial = readPartialFile();
    // #3680 CA-A15: el modo partial_pause se activa si hay allowed_issues O
    // allowed_skills no vacíos. Antes era sólo allowed_issues; agregamos la
    // disyunción para que un harness que se identifica por skill (no por issue
    // concreto, ej. multi-provider-smoke-test) pueda activar la ventana sin
    // sentinels mágicos en allowed_issues.
    const hasIssues = partial && partial.allowed_issues.length > 0;
    const hasSkills = partial && partial.allowed_skills && partial.allowed_skills.length > 0;
    if (partial && (hasIssues || hasSkills)) {
        return {
            mode: 'partial_pause',
            allowedIssues: partial.allowed_issues,
            allowedSkills: partial.allowed_skills || [],
            createdAt: partial.created_at,
            source: partial.source,
            acceptedDepRisk: partial.accepted_dep_risk === true,
            depSources: partial.dep_sources || null,
            authorizationTtls: partial.authorization_ttls || null,
        };
    }
    return {
        mode: 'running', allowedIssues: [], allowedSkills: [], createdAt: null, source: null,
        acceptedDepRisk: false, depSources: null,
    };
}

// -----------------------------------------------------------------------------
// #5060 — Ejecución SOLO por olas (fail-closed sin allowlist).
//
// Incidente 2026-07-26: al cerrarse la ola 8, la poda convergente (#4753)
// llamó `setPartialPause([])`, que con lista vacía delega en
// `clearPartialPause()` y BORRA `.partial-pause.json`. Sin ese archivo el modo
// caía a `running` y `isIssueAllowedInState()` devolvía `true` para cualquier
// issue: el Pulpo perdió su único freno y dispatchó ~320 agentes sobre ~100
// issues del backlog histórico, que a su vez generaron 97 issues nuevos.
//
// El alcance de la ola NO se enforza en `waves.json` (registro semántico) sino
// en esta allowlist. Por eso "sin allowlist" pasa a significar **denegar**, no
// **permitir**: el estado natural del pipeline es acotado a la ola vigente.
//
// El escape hatch existe para diagnóstico/recuperación, apagado por default y
// con warning en cada uso — jamás debe quedar prendido en operación normal.
// -----------------------------------------------------------------------------
function unscopedDispatchEnabled() {
    return process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH === '1';
}

// Warning una sola vez por proceso: el gate se consulta por issue y por tick,
// loguear en cada llamada inundaría el log del Pulpo.
let unscopedWarned = false;
function warnUnscopedOnce() {
    if (unscopedWarned) return;
    unscopedWarned = true;
    try {
        console.warn(
            '[partial-pause] ⚠️  PIPELINE_ALLOW_UNSCOPED_DISPATCH=1 — dispatch SIN filtro de ola. ' +
            'Escape hatch de diagnóstico (#5060): el pipeline puede tomar cualquier issue del backlog.'
        );
    } catch { /* best-effort: el warning nunca rompe el gate */ }
}

/**
 * Determina si un issue puede procesarse según el estado actual.
 * @param {number|string} issue
 * @returns {boolean}
 */
function isIssueAllowed(issue) {
    return isIssueAllowedInState(issue, getPipelineMode());
}

/**
 * Variante pura de `isIssueAllowed` que recibe el estado ya leído (#2957).
 *
 * Pensada para callers que iteran muchos issues en un mismo tick (counters
 * de cola, reconciler) y no quieren pagar el costo de releer el filesystem
 * por cada uno. La política es la misma que `isIssueAllowed`.
 *
 * Tabla de verdad (#5060 cambia la primera fila):
 *   running        → false, salvo `PIPELINE_ALLOW_UNSCOPED_DISPATCH=1`
 *   paused         → false
 *   partial_pause  → issue ∈ allowedIssues
 *
 * @param {number|string} issue
 * @param {ReturnType<typeof getPipelineMode>} state
 * @returns {boolean}
 */
function isIssueAllowedInState(issue, state) {
    const n = normalizeIssue(issue);
    if (!n) return false;
    if (!state || state.mode === 'paused') return false;
    // #5060 — sin allowlist NO hay ola vigente que acote el dispatch: fail-closed.
    if (state.mode === 'running') {
        if (!unscopedDispatchEnabled()) return false;
        warnUnscopedOnce();
        return true;
    }
    return Array.isArray(state.allowedIssues) && state.allowedIssues.includes(n);
}

// -----------------------------------------------------------------------------
// #3680 CA-A15 — isSkillAllowed / isSkillAllowedInState
//
// Hermana semántica de isIssueAllowed pero indexada por skill. Pensada para
// componentes que no son issues concretos pero quieren correr en ventanas de
// pausa (ej. multi-provider-smoke-test, harnesses de diagnóstico futuros).
//
// Política:
//   running         → true (no hay pausa)
//   paused          → false (halt total)
//   partial_pause   → skill ∈ allowedSkills
//
// #5060 — NO se le aplica el fail-closed de `isIssueAllowedInState`. El gate de
// issues acota el BACKLOG a la ola vigente; los skills de acá son componentes
// del control-plane (smoke-test de providers, harnesses de diagnóstico) que no
// consumen backlog y deben seguir corriendo entre olas. Denegarlos dejaría al
// pipeline sin diagnóstico justo cuando no hay ola activa.
// -----------------------------------------------------------------------------
function isSkillAllowed(skillName) {
    return isSkillAllowedInState(skillName, getPipelineMode());
}

function isSkillAllowedInState(skillName, state) {
    if (typeof skillName !== 'string' || skillName.trim().length === 0) return false;
    if (!state || state.mode === 'paused') return false;
    if (state.mode === 'running') return true;
    return Array.isArray(state.allowedSkills) && state.allowedSkills.includes(skillName.trim());
}

// -----------------------------------------------------------------------------
// #3625 — Gate de autorización (CA-2).
//
// Compara `previous` vs `proposed`, decide si se aplica o se rechaza, y emite
// la entry de audit ANTES del write del estado (invariante de orden).
//
// Reglas:
//   - Si no hay removals (sólo adds o sin cambios) → aceptar incluso sin
//     `authorizedBy` (no es el caso peligroso). Igual se emite entry de audit
//     con `authorized_by: null` para que quede registrado.
//   - Si hay removals:
//       * con `authorizedBy` válido → aplicar + audit entry (action: 'write').
//       * sin `authorizedBy` o inválido:
//           - strictGateEnabled() === true → action: 'reject', NO escribir,
//             notificar Telegram, devolver `{ ok: false, rejected: true }`.
//           - strictGateEnabled() === false → action: 'write' pero entry
//             marca `gate_grace: true` para que el operador vea callers no
//             migrados.
//
// La función NO escribe el JSON: devuelve `{ ok, rejected, entry }`. El
// caller decide qué hacer si rejected=true. Pero AÚN cuando rejected=true,
// la audit entry ya está persistida (intención registrada).
// -----------------------------------------------------------------------------

function evaluateAndAudit({ previous, current, source, authorizedBy, justification, intendedAction = 'write', extra }) {
    const diff = audit.computeDiff(previous, current);
    const hasRemovals = diff.removed.length > 0;
    const validation = audit.validateAuthorizedBy(authorizedBy);
    const grace = !strictGateEnabled();

    let action = intendedAction;
    let rejected = false;

    if (hasRemovals && !validation.valid) {
        if (grace) {
            // Período de gracia: aceptar pero marcar.
            action = intendedAction;
        } else {
            action = 'reject';
            rejected = true;
        }
    }

    const extras = { ...(extra || {}) };
    if (grace && hasRemovals && !validation.valid) extras.gate_grace = true;

    const result = audit.appendMutation({
        source,
        action,
        previous,
        current: rejected ? previous : current,  // si rechazado, "current" es lo que QUEDA (sin aplicar).
        authorizedBy,
        justification,
        extra: extras,
    });

    if (rejected) {
        // Alerta Telegram inmediata (CA-5 — pero la conexión es opcional,
        // sólo si notifyTelegram está disponible y no estamos en test).
        try {
            const removedList = diff.removed.map(n => `#${n}`).join(', ');
            const msg = `🛑 [allowlist gate] Removal RECHAZADO sin authorizedBy válido.\n` +
                        `Source: ${source || 'unknown'}\n` +
                        `Removidos (no aplicado): ${removedList}\n` +
                        `Razón: ${validation.reason || 'unknown'}`;
            notifyTelegram(msg);
        } catch { /* notify best-effort */ }
    }

    return { ok: !rejected, rejected, audit: result, diff, validation };
}

/**
 * Activa la pausa parcial con un allowlist de issues.
 * Lista vacía + allowedSkills vacío → elimina el marker (equivalente a clear).
 *
 * #3520 — Write atómico vía tmp+rename. Sustituye al `writeFileSync` directo
 * que dejaba el JSON truncado ante un kill -9 mid-write. Es prerequisito para
 * la transacción multi-archivo de `lib/waves.promoteWaveAtomic`.
 *
 * #3625 — Gate de autorización: opts.authorizedBy + opts.justification.
 * Removals sin authorizedBy válido → REJECTED (audit entry + alerta Telegram).
 *
 * #3680 CA-A15 — opts.allowedSkills: array de nombres de skill habilitados
 * en la ventana (co-existente con allowed_issues). Permite activar la pausa
 * SOLO con skills (sin issues) — caso del harness multi-provider-smoke-test.
 * El gate de autorización sólo audita removals de issues (no de skills), pero
 * la mutación del campo allowed_skills SÍ se persiste atómicamente bajo lock.
 *
 * @param {Array<number|string>} issues
 * @param {{
 *   source?: string,
 *   acceptedDepRisk?: boolean,
 *   depSources?: Object,
 *   authorizedBy?: string,        // #3625: enum cerrado
 *   justification?: string,       // #3625: razón libre (sanitizada)
 *   authorizationTtls?: Object,   // #3625: TTLs por issue heredados (recursive-deps:from-N)
 *   allowedSkills?: string[],     // #3680: skills habilitados (co-existente con issues)
 * }} [opts]
 * @returns {{ok: boolean, rejected?: boolean, allowedIssues: number[], allowedSkills?: string[], msg: string, diff?: object}}
 */
function setPartialPause(issues, opts = {}) {
    const normalized = (Array.isArray(issues) ? issues : [])
        .map(normalizeIssue)
        .filter(Boolean);
    const unique = [...new Set(normalized)].sort((a, b) => a - b);

    // #3680 — normalización paralela de allowedSkills.
    const uniqueSkills = Array.isArray(opts.allowedSkills)
        ? [...new Set(
            opts.allowedSkills
                .filter(s => typeof s === 'string')
                .map(s => s.trim())
                .filter(Boolean)
        )].sort()
        : [];

    // Si tanto issues como skills están vacíos → comportamiento legacy (clear).
    if (unique.length === 0 && uniqueSkills.length === 0) {
        // Delegate al `clearPartialPause` que también pasa por el gate.
        const r = clearPartialPause({
            source: opts.source,
            authorizedBy: opts.authorizedBy,
            justification: opts.justification || 'setPartialPause con lista vacía',
            extra: opts.extra,   // #3742 — preservar contexto del wizard.
        });
        // Normalizar shape al de setPartialPause para compat con callers.
        if (r.rejected) {
            return { ok: false, rejected: true, allowedIssues: readPreviousAllowlist(), allowedSkills: [], msg: 'Mutación rechazada por gate' };
        }
        return {
            ok: true,
            allowedIssues: [],
            allowedSkills: [],
            msg: 'Pausa parcial desactivada (lista vacía)',
        };
    }

    const previous = readPreviousAllowlist();

    // #3625 — Gate + audit ANTES del write (invariante de orden).
    // #3742 — opts.extra viaja al audit entry (recursividad_aplicada,
    // wizard_session_id, etc.) para que el wizard de allowlist produzca una
    // única entry autoritativa con su contexto, sin doble-auditar.
    const gateResult = evaluateAndAudit({
        previous,
        current: unique,
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification,
        intendedAction: 'write',
        extra: opts.extra,
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            allowedIssues: previous,
            msg: `Mutación rechazada por gate: removals sin authorizedBy válido (${gateResult.validation.reason}). ` +
                 `Removidos NO aplicados: ${gateResult.diff.removed.map(i => `#${i}`).join(', ')}`,
            diff: gateResult.diff,
        };
    }

    const data = {
        allowed_issues: unique,
        created_at: new Date().toISOString(),
        source: opts.source || 'unknown',
    };
    // #3680 CA-A15 — allowed_skills es campo aditivo. Sólo lo escribimos si
    // el caller lo proveyó. Los lectores viejos (que no conocen el campo) lo
    // ignoran sin romperse (regla aditiva original del marker, ver header).
    if (uniqueSkills.length > 0) {
        data.allowed_skills = uniqueSkills;
    }
    // #4030 — Metadata estructurada de la ola (aditiva). Sólo se persiste
    // cuando el caller la provee por opts y pasa el saneado fail-closed.
    const waveMeta = sanitizeWaveMetaForWrite(opts);
    if (waveMeta) {
        data.wave_number = waveMeta.wave_number;
        data.wave_name = waveMeta.wave_name;
        if (waveMeta.wave_goal) data.wave_goal = waveMeta.wave_goal;
    }
    if (opts.acceptedDepRisk === true) data.accepted_dep_risk = true;
    if (opts.depSources && typeof opts.depSources === 'object') {
        // Filtrar a las claves que efectivamente terminaron en el allowlist.
        const filtered = {};
        for (const k of Object.keys(opts.depSources)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.depSources[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.dep_sources = filtered;
    }
    // #3625 — TTLs heredados (e.g. de recursive-deps:from-N) viajan en el JSON
    // para que el cron de cleanup los purgue cuando expiren.
    if (opts.authorizationTtls && typeof opts.authorizationTtls === 'object') {
        const filtered = {};
        for (const k of Object.keys(opts.authorizationTtls)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.authorizationTtls[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.authorization_ttls = filtered;
    } else {
        // Heredar TTLs previos sólo para issues que siguen en el allowlist.
        const prev = readPartialFile();
        if (prev && prev.authorization_ttls) {
            const inherited = {};
            for (const k of Object.keys(prev.authorization_ttls)) {
                const n = normalizeIssue(k);
                if (n && unique.includes(n)) {
                    inherited[String(n)] = prev.authorization_ttls[k];
                }
            }
            if (Object.keys(inherited).length > 0) data.authorization_ttls = inherited;
        }
    }
    // CA-2: write atómico (tmp + fsync + rename) bajo lock. Antes era un
    // writeFileSync directo — si dos /wave promote llegaban a la vez, el
    // segundo podía pisar al primero o dejar un JSON truncado si moría
    // a mitad del write.
    return withLockSync(partialFile(), () => {
        atomicWriteFile(partialFile(), JSON.stringify(data, null, 2));
        return {
            ok: true,
            allowedIssues: unique,
            diff: gateResult.diff,
            msg: `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`,
        };
    }, {
        component: 'partial-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Variante atómica que además devuelve un snapshot del estado previo para
 * habilitar rollback transaccional (#3520).
 *
 * Diferencias vs `setPartialPause`:
 *   - Antes de escribir, captura el contenido y SHA-256 del archivo previo
 *     (o `null` si no existía). Permite a `lib/waves.promoteWaveAtomic`
 *     restaurar exactamente el estado anterior sin depender de timestamped
 *     backups en `archived/`.
 *   - Write atómico (tmp + renameSync), idéntico a `setPartialPause`.
 *   - Lista vacía no elimina el marker — escribe `allowed_issues: []` para
 *     que la transacción tenga un estado uniforme (la limpieza la hace el
 *     caller si corresponde a su semántica).
 *
 * #3625 — Mismo gate de autorización: opts.authorizedBy + opts.justification.
 *
 * @param {Array<number|string>} issues
 * @param {{
 *   source?: string,
 *   acceptedDepRisk?: boolean,
 *   depSources?: Object,
 *   authorizedBy?: string,
 *   justification?: string,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   rejected?: boolean,
 *   allowedIssues: number[],
 *   msg: string,
 *   prevBuffer: Buffer|null,
 *   prevSha: string|null,
 *   existedBefore: boolean,
 * }}
 */
function setPartialPauseAtomic(issues, opts = {}) {
    // 1) Snapshot del estado previo (para rollback del caller).
    let prevBuffer = null;
    let prevSha = null;
    let existedBefore = false;
    try {
        prevBuffer = fs.readFileSync(partialFile());
        prevSha = require('crypto').createHash('sha256').update(prevBuffer).digest('hex');
        existedBefore = true;
    } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
    }

    // 2) Normalización y escritura (misma semántica que setPartialPause salvo
    //    que lista vacía no borra — siempre escribe un JSON válido).
    const normalized = (Array.isArray(issues) ? issues : [])
        .map(normalizeIssue)
        .filter(Boolean);
    const unique = [...new Set(normalized)].sort((a, b) => a - b);

    // #3680 CA-A15 — allowed_skills aditivo (igual que setPartialPause).
    const uniqueSkills = Array.isArray(opts.allowedSkills)
        ? [...new Set(
            opts.allowedSkills
                .filter(s => typeof s === 'string')
                .map(s => s.trim())
                .filter(Boolean)
        )].sort()
        : [];

    const previous = readPreviousAllowlist();

    // #3625 — Gate + audit ANTES del write.
    const gateResult = evaluateAndAudit({
        previous,
        current: unique,
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification,
        intendedAction: 'write',
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            allowedIssues: previous,
            msg: `Mutación rechazada por gate: removals sin authorizedBy válido (${gateResult.validation.reason})`,
            prevBuffer,
            prevSha,
            existedBefore,
        };
    }

    const data = {
        allowed_issues: unique,
        created_at: new Date().toISOString(),
        source: opts.source || 'unknown',
    };
    if (uniqueSkills.length > 0) {
        data.allowed_skills = uniqueSkills;
    }
    // #4030 — Metadata estructurada de la ola (aditiva, igual que setPartialPause).
    const waveMeta = sanitizeWaveMetaForWrite(opts);
    if (waveMeta) {
        data.wave_number = waveMeta.wave_number;
        data.wave_name = waveMeta.wave_name;
        if (waveMeta.wave_goal) data.wave_goal = waveMeta.wave_goal;
    }
    if (opts.acceptedDepRisk === true) data.accepted_dep_risk = true;
    if (opts.depSources && typeof opts.depSources === 'object') {
        const filtered = {};
        for (const k of Object.keys(opts.depSources)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.depSources[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.dep_sources = filtered;
    }
    writeAtomic(partialFile(), JSON.stringify(data, null, 2));

    return {
        ok: true,
        allowedIssues: unique,
        msg: unique.length > 0
            ? `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`
            : 'Pausa parcial activa con allowlist vacía (no bloquea)',
        prevBuffer,
        prevSha,
        existedBefore,
    };
}

/**
 * Helper interno: write atómico con tmp + renameSync.
 * No expuesto — uso interno de `setPartialPause` / `setPartialPauseAtomic`.
 *
 * @param {string} targetPath
 * @param {string} content
 */
function writeAtomic(targetPath, content) {
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, targetPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

/**
 * Desactiva la pausa parcial (elimina marker).
 *
 * CA-2: bajo lock para evitar que un unlink pise un write en curso.
 * #3625: clear es removal masivo → exige `authorizedBy` válido. Si no pasa
 * el gate, NO se ejecuta el unlink y queda audit entry `action: 'reject'`.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string }} [opts]
 * @returns {{ok: boolean, rejected?: boolean, existed: boolean}}
 */
function clearPartialPause(opts = {}) {
    const previous = readPreviousAllowlist();

    // Gate + audit antes del unlink.
    const gateResult = evaluateAndAudit({
        previous,
        current: [],
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification || 'clearPartialPause',
        intendedAction: 'clear',
        extra: opts.extra,   // #3742 — contexto del wizard en la entry de clear.
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            existed: fs.existsSync(partialFile()),
        };
    }

    return withLockSync(partialFile(), () => {
        const existed = fs.existsSync(partialFile());
        if (existed) {
            try { fs.unlinkSync(partialFile()); } catch {}
        }
        return { ok: true, existed };
    }, {
        component: 'partial-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Desactiva TODO modo de pausa (full + partial). Usado por /resume.
 *
 * #3625 — Requiere `authorizedBy: 'resume:operator'` por defecto. Sin él,
 * en modo grace se loguea warning; en strict, se rechaza.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string }} [opts]
 * @returns {{removedFull: boolean, removedPartial: boolean, rejected?: boolean}}
 */
function resumeAll(opts = {}) {
    const previous = readPreviousAllowlist();

    // Sólo gateamos la parte partial-pause: el `.paused` no tiene allowlist.
    if (previous.length > 0) {
        const gateResult = evaluateAndAudit({
            previous,
            current: [],
            source: opts.source || 'resume:operator',
            authorizedBy: opts.authorizedBy || 'resume:operator',
            justification: opts.justification || 'resumeAll (full /resume)',
            intendedAction: 'clear',
        });
        if (gateResult.rejected) {
            return { removedFull: false, removedPartial: false, rejected: true };
        }
    }

    let removedFull = false;
    let removedPartial = false;
    if (fs.existsSync(pauseFile())) {
        try { fs.unlinkSync(pauseFile()); removedFull = true; } catch {}
    }
    if (fs.existsSync(partialFile())) {
        try { fs.unlinkSync(partialFile()); removedPartial = true; } catch {}
    }
    return { removedFull, removedPartial };
}

// -----------------------------------------------------------------------------
// #4832 / #5399 — Lectura del ORIGEN de la pausa total (`.paused`), fail-closed.
//
// Distingue una pausa AUTO-GENERADA por corrupción de config.yaml
// (`haltOnConfigCorruption` escribe el marker como JSON
// `{ source: 'config-corruption-halt', ... }`) de una pausa MANUAL del operador
// (marker legacy = ISO plano, o cualquier otro contenido).
//
// Regla fail-closed (SEC / A08 fail-closed): sólo devuelve un `source`
// AUTO-LEVANTABLE cuando el marker parsea como JSON válido **y** `parsed.source`
// pertenece por igualdad exacta a `AUTO_LIFTABLE_SOURCES`. CUALQUIER otro caso
// (ISO plano legacy, JSON malformado, array/null/primitivo, marker gigante,
// `source` distinto, string vacío, archivo ilegible, o inexistente) →
// `manual`/`unknown`, es decir NUNCA auto-recuperable. Esto garantiza que un
// auto-recovery ingenuo jamás pise una pausa que el operador puso a propósito
// (CA-3 de #4832, CA-8/CA-10 de #5399).
//
// #5399 — El retorno se enriquece de forma ADITIVA (`source` y `raw` siguen
// exactamente con la semántica anterior, así que `pulpo.js` y
// `lib/operational-state.js` no rompen):
//   - `rawSource`: el string de autoría LITERAL del marker (o null si no se pudo
//     determinar). Es lo que `preserveFullPause` copia verbatim; devolverlo
//     nunca puede promover autoría porque sale del disco tal cual.
//   - `ts` / `detail` / `preservedFrom`: metadata original del marker.
//   - `undetermined`: motivo por el que la autoría no pudo determinarse
//     (null cuando sí se determinó). CA-6: deja registro.
//
// @returns {{
//   source: 'config-corruption-halt'|'manual'|'unknown',
//   rawSource: string|null, ts: string|null, detail: string|null,
//   preservedFrom: object|null, undetermined: string|null, raw: string|null
// }}
// -----------------------------------------------------------------------------

// #5399 CA-8 (SEC-1) — Allowlist POSITIVA de autorías auto-levantables. La
// pertenencia se evalúa por igualdad exacta contra este conjunto cerrado.
// **Prohibido** decidir el auto-levantado por negación (`source !== 'human'`):
// eso invierte el default y reanuda dispatch que el operador frenó a propósito.
//
// `kernel-cutover-degraded-halt` (`pulpo.js`, #5135) NO entra acá a propósito:
// es una pausa automática cuya NO-recuperación es deliberada (exige rollback
// manual). Ver el test de regresión nombrado en
// `__tests__/restart-preserve-pause-5399.test.js`.
// #5243 — `secrets-health-halt` se suma al set: el halt por secreto faltante es
// auto-generado y su causa es objetivamente verificable en cada ciclo (el
// secreto está o no está), así que reponerlo debe reanudar el dispatch solo.
// Sin esta entrada el auto-recovery de #5243 sería código muerto: el marker que
// escribe `secrets-health.js` se leería como `manual` y la pausa quedaría hasta
// intervención humana aunque el operador ya hubiera repuesto el secreto.
// La ampliación es por PERTENENCIA EXACTA a esta lista cerrada — sigue estando
// prohibido decidir por negación.
const AUTO_LIFTABLE_SOURCES = Object.freeze(['config-corruption-halt', 'secrets-health-halt']);

// #5399 CA-10 (SEC-3) — cap de tamaño ANTES de `JSON.parse`. Un marker de 64KB
// ya es tres órdenes de magnitud más grande que cualquier marker legítimo.
const MAX_PAUSE_MARKER_BYTES = 64 * 1024;

// Caps defensivos de los campos que copiamos verbatim: el marker es un archivo
// que cualquier proceso del host puede escribir, no una fuente confiable.
const MAX_PAUSE_TS_LEN = 64;
const MAX_PAUSE_SOURCE_LEN = 100;

/**
 * ¿Esta autoría habilita el auto-levantado de la pausa total?
 *
 * Pertenencia exacta a `AUTO_LIFTABLE_SOURCES` (CA-8 / SEC-1). Cualquier valor
 * no-string, desconocido o ambiguo → `false` (fail-closed).
 *
 * @param {unknown} source
 * @returns {boolean}
 */
function isAutoLiftableSource(source) {
    return typeof source === 'string' && AUTO_LIFTABLE_SOURCES.includes(source);
}

function readFullPauseOrigin() {
    const empty = {
        source: 'unknown', rawSource: null, ts: null, detail: null,
        preservedFrom: null, undetermined: null, raw: null,
    };
    let raw = null;
    try {
        if (!fs.existsSync(pauseFile())) {
            return { ...empty, undetermined: 'marker_ausente' };
        }
        const st = fs.statSync(pauseFile());
        if (st.size > MAX_PAUSE_MARKER_BYTES) {
            // Marker desproporcionado → fail-closed sin parsear (SEC-3).
            return { ...empty, source: 'manual', undetermined: 'marker_demasiado_grande' };
        }
        raw = fs.readFileSync(pauseFile(), 'utf8');
    } catch {
        // Ilegible → fail-closed (no auto-recuperable).
        return { ...empty, source: 'manual', undetermined: 'marker_ilegible' };
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) {
        // Vacío → manual (fail-closed).
        return { ...empty, source: 'manual', undetermined: 'marker_vacio', raw };
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // No es JSON (ej. ISO plano legacy) → manual (fail-closed).
        return { ...empty, source: 'manual', undetermined: 'marker_legacy_no_json', raw };
    }
    // SEC-3: sólo objeto plano. Array / null / primitivo → fail-closed.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...empty, source: 'manual', undetermined: 'marker_no_es_objeto', raw };
    }
    // SEC-3: lectura CAMPO POR CAMPO. Prohibido `{ ...defaults, ...parsed }` /
    // `Object.assign` / deep-merge: son el vector de prototype pollution vía
    // `__proto__` / `constructor.prototype`.
    const rawSource = (typeof parsed.source === 'string' && parsed.source.length <= MAX_PAUSE_SOURCE_LEN)
        ? parsed.source : null;
    const ts = (typeof parsed.ts === 'string' && parsed.ts.length <= MAX_PAUSE_TS_LEN)
        ? parsed.ts : null;
    const detail = typeof parsed.detail === 'string' ? parsed.detail : null;
    const preservedFrom = (parsed.preservedFrom && typeof parsed.preservedFrom === 'object'
        && !Array.isArray(parsed.preservedFrom)) ? parsed.preservedFrom : null;
    if (isAutoLiftableSource(rawSource)) {
        return { source: rawSource, rawSource, ts, detail, preservedFrom, undetermined: null, raw };
    }
    // JSON válido pero con otro source (o sin source) → manual (fail-closed).
    return {
        source: 'manual',
        rawSource,
        ts,
        detail,
        preservedFrom,
        undetermined: rawSource ? null : 'marker_sin_source',
        raw,
    };
}

/**
 * Activa la pausa TOTAL del pipeline (marker `.paused`). Hermana de
 * `setPartialPause` pero para el halt total — el wizard de pausa (#3741) lo
 * usa para el scope `full`, en vez de escribir `.paused` por su cuenta
 * (prohibido por security A08: el wizard sólo orquesta, la mutación vive en
 * este módulo, dueño del estado de pausa).
 *
 * Invariante de orden (igual que el resto del módulo): audita ANTES de escribir.
 * La pausa total no cambia el allowlist, así que la entry registra
 * `previous == current` con `extra.full_pause: true` para trazabilidad. Write
 * atómico bajo lock del marker `.paused`.
 *
 * #5399 CA-1 — el marker deja de ser un timestamp ISO pelado y pasa a ser el
 * mismo objeto estructurado que escribe `haltOnConfigCorruption`
 * (`{ source, ts, detail }`). Antes de este cambio `opts.source` se recibía y
 * se DESCARTABA: por eso toda pausa del wizard/dashboard quedaba indistinguible
 * de una legacy y se degradaba a autoría desconocida. El campo que decide el
 * auto-levantado sigue siendo `source` (contrato de `readFullPauseOrigin`), y
 * como los sources humanos no están en `AUTO_LIFTABLE_SOURCES`, persistirlos
 * gana trazabilidad sin habilitar ningún auto-levantado nuevo.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string, extra?: Object }} [opts]
 * @returns {{ ok: boolean, existedBefore: boolean, source: string, autoLiftable: boolean }}
 */
function setFullPause(opts = {}) {
    const previous = readPreviousAllowlist();
    const source = typeof opts.source === 'string' && opts.source.trim()
        ? opts.source.trim().slice(0, MAX_PAUSE_SOURCE_LEN)
        : 'unknown';
    // CA-12 (SEC-5/SEC-6): el detalle se sanitiza ANTES de persistirlo, no sólo
    // al auditarlo — el marker lo leen el dashboard y `/status`.
    const detail = audit.sanitizeJustification(opts.justification || '').sanitized;
    audit.appendMutation({
        source: opts.source || 'unknown',
        action: 'write',
        previous,
        current: previous,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification || 'setFullPause',
        extra: { ...(opts.extra || {}), full_pause: true },
    });
    return withLockSync(pauseFile(), () => {
        const existedBefore = fs.existsSync(pauseFile());
        atomicWriteFile(pauseFile(), JSON.stringify({
            source,
            ts: new Date().toISOString(),
            detail,
        }));
        return { ok: true, existedBefore, source, autoLiftable: isAutoLiftableSource(source) };
    }, {
        component: 'full-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Rescata el timestamp de un marker legacy (ISO plano, sin metadatos). Devuelve
 * null si el contenido no es una fecha parseable — nunca inventa un valor.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function legacyIsoFromRaw(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_PAUSE_TS_LEN) return null;
    const t = Date.parse(trimmed);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
}

/**
 * #5399 — Preserva la pausa total vigente A TRAVÉS de un `/restart`.
 *
 * El bug que arregla: `restart.js` conservaba la pausa (correcto: un restart no
 * es un destrabe implícito) pero la reescribía con `new Date().toISOString()`,
 * destruyendo el metadato de origen. Sin autoría, `readFullPauseOrigin` la lee
 * como `manual` y el auto-recovery de #4832 nunca la levanta — el pipeline
 * quedaba pausado para siempre (evidencia real: 1h33 sin despachar el
 * 2026-08-02).
 *
 * Copia VERBATIM `source` + `ts` + `detail` del marker vigente y sólo agrega
 * `preservedFrom`. NUNCA sintetiza ni promueve autoría (CA-9 / SEC-4): los
 * valores salen del disco tal cual, así que humana/desconocida jamás pueden
 * salir auto-levantables.
 *
 * Idempotente frente al re-exec de `restart.js` (#2880): el marker se lee del
 * disco DENTRO del lock, en el momento del write. N re-ejecuciones pisan
 * `preservedFrom` pero dejan `source`/`ts` intactos.
 *
 * Degradación segura: si el lock no se puede adquirir (Pulpo viejo agonizando),
 * NO se escribe ni se borra nada — el marker original queda intacto, que ya es
 * la preservación correcta. Sólo se pierde la anotación de `preservedFrom`.
 *
 * @param {{ authorizedBy?: string }} [opts]
 * @returns {{ ok: boolean, existed: boolean, source?: string, autoLiftable?: boolean,
 *             undetermined?: string|null, lockFailed?: boolean, reason?: string }}
 */
function preserveFullPause(opts = {}) {
    const previous = readPreviousAllowlist();
    const authorizedBy = opts.authorizedBy || 'restart:preserve-pause';
    try {
        return withLockSync(pauseFile(), () => {
            // Dentro del lock: sin TOCTOU entre el read y el write.
            if (!fs.existsSync(pauseFile())) {
                return { ok: false, existed: false, reason: 'sin_pausa_previa' };
            }
            const origin = readFullPauseOrigin();
            // `origin.rawSource` viene LITERAL del disco; `origin.source` viene
            // fail-closed del lector. Copiar el literal cuando existe conserva la
            // autoría exacta (CA-2) y no puede promover nada: si el literal fuera
            // auto-levantable, `origin.source` ya lo sería. Sin literal
            // (marker legacy/ilegible) cae al veredicto fail-closed → 'manual'.
            const inheritedSource = origin.rawSource || origin.source || 'manual';
            const marker = {
                source: inheritedSource,
                // Un marker legacy no tiene `ts`, pero SÍ es (casi siempre) un ISO
                // plano: rescatarlo conserva desde cuándo está pausado el pipeline,
                // que es el dato que el operador mira. Sólo si tampoco parsea como
                // fecha caemos a `now`.
                ts: origin.ts || legacyIsoFromRaw(origin.raw) || new Date().toISOString(),
                // CA-12: sanitizado antes de persistir y de auditar; nunca crudo.
                detail: audit.sanitizeJustification(origin.detail || '').sanitized,
                preservedFrom: { by: 'restart', at: new Date().toISOString() },
            };
            if (origin.undetermined) marker.undetermined = origin.undetermined;
            const autoLiftable = isAutoLiftableSource(marker.source);
            // Invariante del módulo: auditar ANTES de escribir. Preservar la
            // pausa NO toca la allowlist → `previous === current`, sin removals,
            // así que este `authorizedBy` no ensancha el gate de removals.
            audit.appendMutation({
                source: 'restart',
                action: 'write',
                previous,
                current: previous,
                authorizedBy,
                justification: `restart preservo pausa heredada (source=${marker.source}`
                    + `${origin.undetermined ? `, autoria_indeterminada=${origin.undetermined}` : ''})`,
                extra: {
                    full_pause: true,
                    preserved: true,
                    inherited_source: marker.source,
                    inherited_ts: marker.ts,
                    auto_liftable: autoLiftable,
                    authorship_undetermined: origin.undetermined || null,
                },
            });
            atomicWriteFile(pauseFile(), JSON.stringify(marker));
            return {
                ok: true,
                existed: true,
                source: marker.source,
                autoLiftable,
                undetermined: origin.undetermined || null,
            };
        }, {
            component: 'full-pause-lock',
            timeoutMs: LOCK_TIMEOUT_MS,
            maxRetries: LOCK_MAX_RETRIES,
            notify: notifyTelegram,
        });
    } catch (err) {
        // Lock no adquirido: dejamos el marker ORIGINAL intacto (no escribir, no
        // borrar). Sigue siendo preservación correcta — nunca borrado.
        const origin = readFullPauseOrigin();
        let existed = false;
        try { existed = fs.existsSync(pauseFile()); } catch { /* best-effort */ }
        return {
            ok: false,
            existed,
            source: origin.rawSource || origin.source,
            autoLiftable: isAutoLiftableSource(origin.rawSource || origin.source),
            undetermined: origin.undetermined || null,
            lockFailed: true,
            reason: `lock_no_adquirido: ${(err && err.message) || 'desconocido'}`,
        };
    }
}

/**
 * Desactiva la pausa TOTAL (elimina `.paused`). NO toca la pausa parcial
 * (`.partial-pause.json`): el wizard de despausa con scope `full` levanta sólo
 * el halt total. Hermana de `clearPartialPause` para el marker total.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string, extra?: Object }} [opts]
 * @returns {{ ok: boolean, existed: boolean }}
 */
function clearFullPause(opts = {}) {
    const previous = readPreviousAllowlist();
    audit.appendMutation({
        source: opts.source || 'unknown',
        action: 'clear',
        previous,
        current: previous,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification || 'clearFullPause',
        extra: { ...(opts.extra || {}), full_pause: true },
    });
    return withLockSync(pauseFile(), () => {
        const existed = fs.existsSync(pauseFile());
        if (existed) {
            try { fs.unlinkSync(pauseFile()); } catch {}
        }
        return { ok: true, existed };
    }, {
        component: 'full-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

module.exports = {
    getPipelineMode,
    isIssueAllowed,
    isIssueAllowedInState,
    // #3680 CA-A15 — variantes indexadas por skill (hermanas semánticas).
    isSkillAllowed,
    isSkillAllowedInState,
    setPartialPause,
    setPartialPauseAtomic, // #3520
    clearPartialPause,
    resumeAll,
    // #3741 — pausa total gateada (wizard de pausa, scope full).
    setFullPause,
    clearFullPause,
    // #5399 — preservación de la pausa total a través de un /restart (verbatim).
    preserveFullPause,
    // #4832 — lectura fail-closed del origen de la pausa total (auto vs manual).
    readFullPauseOrigin,
    // #5399 CA-8 — allowlist positiva de autorías auto-levantables.
    isAutoLiftableSource,
    AUTO_LIFTABLE_SOURCES,
    MAX_PAUSE_MARKER_BYTES,
    // #3625 — exportados para callers que quieran leer estado raw y para tests.
    readPreviousAllowlist,
    evaluateAndAudit,
    // #4030 — saneado de metadata de ola (expuesto para tests).
    sanitizeWaveMetaForWrite,
    // #5060 — estado del escape hatch de dispatch sin ola. Lo consulta el Pulpo
    // para declarar la causa del wave-stall watchdog (#4708/#4709) cuando el
    // dispatch está detenido por falta de ola y no por halt humano.
    unscopedDispatchEnabled,
    _paths: () => ({ PARTIAL_FILE: partialFile(), PAUSE_FILE: pauseFile() }),
};
