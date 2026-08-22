// =============================================================================
// partial-pause-mutes.js — Silenciado PERSISTENTE y POR CASO de la alerta de
// "pausa parcial trabada" (issue #5978).
//
// El problema que resuelve
// -----------------------
// Hasta #5978 el botón "🎯 Seguir sólo con el issue original" marcaba
// `accepted_dep_risk: true` en el marker de pausa parcial, y ese flag no
// suprimía NADA: la única barrera contra la re-alerta era un cooldown temporal
// que vive en un `Map` en memoria del Pulpo (`pulpo.js` →
// `partialPauseDepsAlertCache`). Un restart lo reseteaba y el ruido volvía.
// Peor: como `keep-original` ya llamaba a `markDepRiskAccepted`, "mantener
// bloqueado" y "no volver a avisar" habrían hecho exactamente lo mismo.
//
// Este módulo aporta el modelo de datos que faltaba: un store propio, indexado
// por la firma `<issue>:<dep1,dep2,...>` que `partial-pause-deps.alertSignature`
// ya produce de forma estable (deps ordenadas y numerizadas).
//
// Por qué un archivo propio y no ampliar `accepted_dep_risk`
// ---------------------------------------------------------
// `accepted_dep_risk` es un booleano GLOBAL del marker: mezcla "riesgo asumido
// a nivel ola" con "ruido silenciado a nivel caso". Convertirlo en un mapa
// metería un concepto nuevo dentro de `.partial-pause.json`, que es el archivo
// más delicado del pipeline y que además tiene su propio lock: cada silenciado
// pasaría a competir por contención con el dispatch. Store separado, lock
// separado, cero contención sobre el marker.
//
// El invariante que gobierna todo el módulo: FAIL-OPEN HACIA EL AVISO
// -------------------------------------------------------------------
// Un error de lectura JAMÁS puede traducirse en silencio. Es preferible una
// alerta de más que un issue trabado invisible: la alerta es ruido, el silencio
// por accidente es un pipeline parado que nadie ve. Por eso `isMuted()` no
// tiene ni un camino de código que devuelva `true` ante estado ausente,
// corrupto, ilegible o de shape inesperado — y por eso no propaga excepciones
// hacia el barrido del Pulpo.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const { withLockSync } = require('./file-lock');
const { atomicWriteFile } = require('./waves');
const { alertSignature } = require('./partial-pause-deps');

// Tope defensivo: el store lo escribe un humano apretando botones, así que su
// cardinalidad real es de decenas. Un archivo con miles de entradas significa
// que algo lo está escribiendo en loop; recortamos en lectura antes de que el
// barrido pague el costo, sin borrar nada del disco (diagnosticable a mano).
const MAX_ENTRIES = 500;

function pipelineDir() {
    // Mismo override que `partial-pause.js`: los tests apuntan a un tmpdir.
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function mutesFile() {
    return path.join(pipelineDir(), 'state', 'partial-pause-mutes.json');
}

function normalizeIssue(issue) {
    const n = Number(String(issue == null ? '' : issue).replace(/^#/, '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeDeps(deps) {
    if (!Array.isArray(deps)) return [];
    const out = new Set();
    for (const d of deps) {
        const n = normalizeIssue(d);
        if (n) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Firma canónica del caso. Delegada a `partial-pause-deps.alertSignature` a
 * propósito: si el store armara la suya, el día que el barrido cambie de
 * formato el silencio dejaría de matchear en silencio (el peor modo de falla
 * posible para este módulo).
 *
 * @returns {string|null} `null` si el caso no es firmable (issue inválido o
 *          sin deps: sin deps no hay alerta que silenciar).
 */
function signatureOf(issue, deps) {
    const i = normalizeIssue(issue);
    const d = normalizeDeps(deps);
    if (!i || d.length === 0) return null;
    return alertSignature(i, d);
}

/**
 * Lee el store. NUNCA tira y NUNCA devuelve algo que no sea un objeto plano:
 * archivo ausente, JSON roto, array, `null` o string ⇒ `{}` (⇒ nada silenciado
 * ⇒ se alerta). Ver el invariante fail-open del encabezado.
 */
function readMutes() {
    try {
        const file = mutesFile();
        if (!fs.existsSync(file)) return {};
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        let n = 0;
        for (const [sig, entry] of Object.entries(parsed)) {
            if (n >= MAX_ENTRIES) break;
            // Una entrada con shape inesperado se descarta individualmente: un
            // registro podrido no puede silenciar (ni desilenciar) a los demás.
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            if (typeof sig !== 'string' || !sig.includes(':')) continue;
            out[sig] = entry;
            n++;
        }
        return out;
    } catch {
        return {};
    }
}

/**
 * Escribe el store bajo lock + rename atómico (mismo patrón que
 * `partial-pause.js`). El lock es sobre el archivo propio del store: no toca
 * el del marker de pausa parcial.
 */
function writeMutes(map) {
    const file = mutesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLockSync(file, () => {
        atomicWriteFile(file, JSON.stringify(map, null, 2));
        return true;
    }, { component: 'partial-pause-mutes' });
}

/**
 * ¿Está silenciada ESTA firma exacta?
 *
 * El silencio NO se hereda: si aparece una dep nueva o se resuelve una, la
 * firma cambia y esto devuelve `false` ⇒ el aviso vuelve. Es deliberado — el
 * operador dijo "no me avises por este caso", no "no me avises nunca por este
 * issue", y un caso con deps distintas es una situación distinta.
 *
 * @returns {boolean} `false` ante cualquier duda (fail-open hacia el aviso).
 */
function isMuted(issue, deps) {
    try {
        const sig = signatureOf(issue, deps);
        if (!sig) return false;
        return !!readMutes()[sig];
    } catch {
        return false;
    }
}

/**
 * Silencia el caso `(issue, deps)`.
 *
 * NO toca `allowed_issues` ni `accepted_dep_risk`: ésa es justamente la
 * diferencia semántica con `keep-original`, que asume el riesgo de las deps
 * abiertas y sigue avisando.
 *
 * El audit se emite ANTES de escribir el estado (mismo orden que
 * `partial-pause.js`): si el proceso muere en el medio queda la intención
 * registrada y el estado sin cambiar — recuperable. Al revés quedaría una
 * mutación sin trazabilidad.
 *
 * @param {object} args
 * @param {number|string} args.issue
 * @param {Array<number|string>} args.deps  — deps faltantes que arman la firma.
 * @param {string} args.authorizedBy        — YA validado contra el enum por el caller.
 * @param {string} [args.operatorRef]       — identidad fina (from.id), va al audit.
 * @param {number} [args.wave]
 * @param {string} [args.source]
 * @param {function} [args.appendMutation]  — inyectable para tests.
 * @returns {{ok:boolean, signature?:string, entry?:object, alreadyMuted?:boolean, reason?:string}}
 */
function mute({ issue, deps, authorizedBy, operatorRef, wave, source, appendMutation } = {}) {
    const i = normalizeIssue(issue);
    if (!i) return { ok: false, reason: 'invalid_issue' };
    const d = normalizeDeps(deps);
    // Sin deps no hay firma: silenciar "todo lo que le pase a #N" es
    // exactamente el silencio de más que el issue prohíbe. Error explícito.
    if (d.length === 0) return { ok: false, reason: 'no_deps' };
    const sig = alertSignature(i, d);

    const current = readMutes();
    if (current[sig]) {
        // Idempotente: el `callback_data` de Telegram no tiene nonce ni TTL, así
        // que el mismo botón se puede apretar dos veces. Re-silenciar no es un
        // error, pero tampoco se re-escribe (ni se re-audita) el mismo hecho.
        return { ok: true, signature: sig, entry: current[sig], alreadyMuted: true };
    }

    const entry = {
        issue: i,
        deps: d,
        muted_at: new Date().toISOString(),
        muted_by: source || 'telegram-partial-pause-deps',
    };
    if (operatorRef) entry.operator_ref = String(operatorRef).slice(0, 64);
    if (Number.isInteger(Number(wave)) && Number(wave) > 0) entry.wave = Number(wave);

    const audit = appendMutation || require('./partial-pause-audit').appendMutation;
    try {
        // `previous`/`current` son la allowlist en el contrato del audit, y
        // `mute-case` NO la muta: van idénticos (vacíos) a propósito, para que
        // el diff no tenga `added`/`removed` y la entry no se confunda con una
        // mutación de allowlist. Lo específico del caso va en `extra`.
        audit({
            source: 'partial-pause-mutes',
            action: 'write',
            previous: [],
            current: [],
            authorizedBy,
            justification: `Operador silenció la re-alerta del caso ${sig}`
                + (operatorRef ? ` [operador ${String(operatorRef).slice(0, 64)}]` : ''),
            extra: {
                mute_signature: sig,
                mute_issue: i,
                mute_deps: d,
                mute_operator_ref: entry.operator_ref || null,
                mute_action: 'mute-case',
            },
        });
    } catch (e) {
        // Sin audit no se muta: el CA exige que cada silenciado quede en la
        // hash-chain. Un silencio sin rastro es exactamente el agujero
        // operativo que este issue vino a cerrar.
        return { ok: false, reason: `audit_failed:${e.message}` };
    }

    const next = { ...current, [sig]: entry };
    try {
        writeMutes(next);
    } catch (e) {
        return { ok: false, reason: `write_failed:${e.message}` };
    }
    return { ok: true, signature: sig, entry };
}

/**
 * Reactiva el aviso de una firma. Es la salida del estado silenciado (CA del PO:
 * un estado en el que se entra por un botón y se sale editando un JSON a mano
 * es una trampa operativa).
 *
 * De-escalación pura: su peor consecuencia es una alerta de más, así que un
 * fallo de audit no la bloquea (a diferencia de `mute`, que sin rastro no muta).
 */
function unmute(signature, { authorizedBy, operatorRef, appendMutation } = {}) {
    const sig = String(signature == null ? '' : signature).trim();
    if (!sig) return { ok: false, reason: 'invalid_signature' };
    const current = readMutes();
    if (!current[sig]) return { ok: true, existed: false, signature: sig };

    const entry = current[sig];
    const audit = appendMutation || require('./partial-pause-audit').appendMutation;
    try {
        audit({
            source: 'partial-pause-mutes',
            action: 'clear',
            previous: [],
            current: [],
            authorizedBy,
            justification: `Operador reactivó el aviso del caso ${sig}`
                + (operatorRef ? ` [operador ${String(operatorRef).slice(0, 64)}]` : ''),
            extra: {
                mute_signature: sig,
                mute_issue: entry.issue || null,
                mute_deps: entry.deps || [],
                mute_action: 'unmute-case',
            },
        });
    } catch { /* de-escalación: el audit es deseable, no bloqueante */ }

    const next = { ...current };
    delete next[sig];
    try {
        writeMutes(next);
    } catch (e) {
        return { ok: false, reason: `write_failed:${e.message}` };
    }
    return { ok: true, existed: true, signature: sig, entry };
}

/**
 * Silencios vigentes, como array ordenado por firma (determinístico: el banner
 * del dashboard no puede reordenar filas entre polls).
 */
function listMutes() {
    const map = readMutes();
    return Object.keys(map).sort().map(sig => ({ signature: sig, ...map[sig] }));
}

/**
 * Purga los silencios que ya no corresponden a un caso vivo.
 *
 * Se limpia cuando el issue sale de la ola (no está en `allowedIssues`) o
 * cuando ya no tiene deps faltantes (`activeSignatures` no lo contiene). En
 * ambos casos la entrada es basura que sólo puede silenciar de más si el caso
 * reaparece más tarde con la misma firma.
 *
 * @param {object} args
 * @param {number[]} [args.allowedIssues]    — allowlist vigente. Si no se pasa,
 *        no se poda por ola (evita barrer todo por un argumento olvidado).
 * @param {string[]} [args.activeSignatures] — firmas con deps faltantes ahora.
 * @returns {{pruned:string[], kept:number}}
 */
function pruneStale({ allowedIssues, activeSignatures } = {}) {
    const current = readMutes();
    const sigs = Object.keys(current);
    if (sigs.length === 0) return { pruned: [], kept: 0 };

    const allowed = Array.isArray(allowedIssues) ? new Set(normalizeDeps(allowedIssues)) : null;
    const active = Array.isArray(activeSignatures) ? new Set(activeSignatures) : null;

    const pruned = [];
    const next = {};
    for (const sig of sigs) {
        const entry = current[sig];
        const issue = normalizeIssue(entry && entry.issue);
        if (allowed && (!issue || !allowed.has(issue))) { pruned.push(sig); continue; }
        if (active && !active.has(sig)) { pruned.push(sig); continue; }
        next[sig] = entry;
    }
    if (pruned.length === 0) return { pruned: [], kept: sigs.length };
    try {
        writeMutes(next);
    } catch {
        // No se pudo podar: se mantiene lo que hay. Reintenta el próximo barrido.
        return { pruned: [], kept: sigs.length };
    }
    return { pruned, kept: Object.keys(next).length };
}

/**
 * Decisión de alertar para UN caso del barrido. Vive acá y no inline en
 * `pulpo.js` porque `pulpo.js` es un daemon que no se puede `require()` desde
 * un test: dejar la decisión adentro habría significado testear una RÉPLICA de
 * la lógica, que es exactamente como una regresión pasa desapercibida.
 *
 * Orden deliberado: el silencio del operador se evalúa ANTES del cooldown. Son
 * dos barreras distintas y el cooldown NO se elimina — sigue siendo la segunda
 * barrera para el caso no silenciado ("no spamees cada 5 minutos" es otra cosa
 * que "el operador dijo que no le avises más").
 *
 * @param {object} args
 * @param {boolean} args.isMutedSignature — la firma está en el store de silencios.
 * @param {number} [args.lastAlertTs]     — última alerta emitida para esa firma (ms).
 * @param {number} args.now               — ms.
 * @param {number} args.cooldownMs
 * @returns {{alert:boolean, action:'suppressed_by_mute'|'detected_within_cooldown'|'alert_sent'}}
 */
function decideAlert({ isMutedSignature, lastAlertTs, now, cooldownMs } = {}) {
    if (isMutedSignature) return { alert: false, action: 'suppressed_by_mute' };
    if (now - (lastAlertTs || 0) < cooldownMs) {
        return { alert: false, action: 'detected_within_cooldown' };
    }
    return { alert: true, action: 'alert_sent' };
}

module.exports = {
    isMuted,
    decideAlert,
    mute,
    unmute,
    listMutes,
    pruneStale,
    readMutes,
    signatureOf,
    mutesFile,
    MAX_ENTRIES,
};
