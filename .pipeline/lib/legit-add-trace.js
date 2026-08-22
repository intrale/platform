// =============================================================================
// legit-add-trace.js — Predicado de "origen legítimo y reciente" de una suma a
// la allowlist (issue #4439, CA-3 / SEC-4439-1..4).
//
// Por qué existe
// --------------
// El detector de desync (`desync-detector.js`) clasifica como `ambiguo` toda
// divergencia con un issue ABIERTO extra en la allowlist que no está en la ola
// activa (fail-safe OWASP A08, #3518/#4350). Eso protege contra una
// manipulación externa de `.partial-pause.json`, pero también dispara un
// human-block espurio cuando la divergencia la generó el propio flujo del
// Commander (`/wave add`) entre sus dos writes.
//
// Este módulo decide, POR ISSUE, si un extra de la allowlist tiene una traza
// LEGÍTIMA y RECIENTE en el audit encadenado de #3625 — la única fuente de
// verdad no forjable (append-only + hash-chain SHA-256, `partial-pause-audit`).
// El consumidor (`pulpo.js`) usa el resultado para auto-resincronizar SOLO el
// subconjunto trazable hacia `waves.json` (aditivo), dejando el resto en
// human-block.
//
// Reglas de seguridad (SEC-4439-1..4)
// -----------------------------------
//   - SEC-4439-1: la traza se deriva EXCLUSIVAMENTE del audit encadenado
//     (`partial-pause-audit.tail`), nunca de un campo escribible de los JSON de
//     estado. Un atacante que manipula `.partial-pause.json` NO puede fabricar
//     una entry de audit válida sin romper la cadena de hashes.
//   - SEC-4439-2: binding POR NÚMERO DE ISSUE exacto (`diff.added` incluye N),
//     no "hubo un wave-add reciente". Una suma legítima de N NO legitima un M
//     ajeno inyectado en la misma ventana.
//   - SEC-4439-3: TTL corto y explícito (default 3 ciclos de dispatch). Fuera
//     de ventana → excluido → ambiguo → human-block.
//   - SEC-4439-4: fail-safe por defecto. Cualquier indeterminación (audit
//     ilegible, `authorized_by` fuera del enum, timestamp inválido, issue
//     cerrado) → excluir del set legítimo.
//
// Este módulo es PURO respecto del estado de pausa: NO escribe waves.json ni
// .partial-pause.json. Sólo LEE el audit y devuelve el subconjunto legítimo.
// =============================================================================

'use strict';

const partialPauseAudit = require('./partial-pause-audit');

// Un "ciclo de dispatch" del Pulpo ≈ poll_interval_seconds (default 30s).
const DEFAULT_DISPATCH_CYCLE_MS = 30 * 1000;
// TTL default: 3 ciclos de dispatch (SEC-4439-3, ≤ 2-3 ciclos recomendado).
const DEFAULT_TTL_MS = 3 * DEFAULT_DISPATCH_CYCLE_MS;

// Enum cerrado de autorías que legitiman una suma automática (subconjunto del
// enum de #3625). SOLO estas dos: el operador humano (`commander:leo`) y la
// suma coherente de `/wave add` / promoción de ola (`wave-promote`). El resto
// del enum de autorización (restart:rollback, pulpo:cleanup, etc.) NO habilita
// auto-resync: representan operaciones que no deberían dejar un extra abierto.
const VALID_AUTH = Object.freeze(new Set(['wave-promote', 'commander:leo']));

// Ventana de entries del audit a inspeccionar. Amplia (se filtra por TTL);
// suficiente para no perder la entry reciente aún con tráfico intermedio.
const AUDIT_TAIL_WINDOW = 50;

/**
 * Devuelve el subconjunto de `candidates` cuya suma a la allowlist tiene una
 * traza legítima y reciente en el audit encadenado. Cualquier fallo o
 * indeterminación excluye al candidato (fail-safe SEC-4439-4).
 *
 * @param {number[]} candidates — issues extra en la allowlist (probe.added).
 * @param {object} [opts]
 * @param {number} [opts.now] — timestamp ms (default Date.now()). Inyectable en tests.
 * @param {number} [opts.ttlMs] — ventana de validez (default DEFAULT_TTL_MS).
 * @param {(n:number)=>boolean|undefined} [opts.isClosed] — predicado de cierre.
 *   Si devuelve `true` para N, se excluye (no tiene sentido resyncar un cerrado).
 * @param {(n:number)=>object[]} [opts.auditReader] — reader inyectable (tests).
 *   Recibe el tamaño de ventana y devuelve las entries; default `audit.tail`.
 * @returns {number[]} subconjunto legítimo, ordenado ascendente y sin duplicados.
 */
function isLegitimateRecentAdd(candidates, opts = {}) {
    const list = Array.isArray(candidates)
        ? candidates
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n) && n > 0)
        : [];
    if (list.length === 0) return [];

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMs = (Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
    const isClosed = typeof opts.isClosed === 'function' ? opts.isClosed : null;

    let entries;
    try {
        entries = typeof opts.auditReader === 'function'
            ? opts.auditReader(AUDIT_TAIL_WINDOW)
            : partialPauseAudit.tail(AUDIT_TAIL_WINDOW);
    } catch {
        // Audit ilegible → nada es legítimo (SEC-4439-4).
        return [];
    }
    if (!Array.isArray(entries)) return [];

    const legit = new Set();
    for (const n of list) {
        // Fail-safe: un issue cerrado no se resincroniza a la ola (SEC-4439-5).
        if (isClosed && isClosed(n) === true) continue;
        const hit = entries.find((e) =>
            e &&
            e.action === 'write' &&                                  // sólo aplicaciones reales, no rejects/clears
            VALID_AUTH.has(e.authorized_by) &&                       // enum cerrado (SEC-4439-1)
            e.diff && Array.isArray(e.diff.added) && e.diff.added.includes(n) && // binding por issue (SEC-4439-2)
            Number.isFinite(Date.parse(e.timestamp)) &&
            Date.parse(e.timestamp) >= now - ttlMs                   // dentro de TTL (SEC-4439-3)
        );
        if (hit) legit.add(n);
    }
    return [...legit].sort((a, b) => a - b);
}

// =============================================================================
// #5882 — Predicado HERMANO, en la dirección OPUESTA.
//
// `isLegitimateRecentAdd` (arriba) opera sobre `probe.added`: extras en la
// ALLOWLIST que faltan en la ola, y busca su traza en `partial-pause-audit`.
// Este opera sobre `probe.removed`: issues presentes en la OLA que faltan en la
// allowlist, y su traza vive en `wave-audit`. Son direcciones opuestas y no se
// pueden unificar: distinto probe, distinto audit, distinta reparación.
//
// Por qué se enumera por `(event, source)` y NUNCA por `actor`
// -----------------------------------------------------------
// Los `actor` COLISIONAN entre rutas con superficies de confianza distintas:
//
//   | Ruta                                   | actor          | source                          |
//   |----------------------------------------|----------------|---------------------------------|
//   | Promoción del operador (la legítima)   | `from` Telegram| telegram-commander/wave-add     |
//   | Resync aditivo automático              | wave-promote   | wave-promote:resync-additive    |
//   | Auto-incorporación de hijos de split   | wave-promote   | split-github-reconcile          |
//
// Discriminar por `actor` obligaría a elegir entre aceptar `wave-promote` — y
// que entre de rebote `split-github-reconcile`, convirtiendo "crear un issue en
// GitHub" en despacho automático de agentes — o aceptar el `from` de Telegram,
// que es string libre no enumerable. Ninguna de las dos es aceptable.
//
// Por eso `wave-audit` persiste `source` por entry (#5882) y acá se enumera un
// set CERRADO de `source` válidos. Ampliarlo es una decisión declarada, nunca un
// efecto colateral de agregar una ruta nueva.
// =============================================================================

// SOLO la promoción explícita del operador legitima una reparación aditiva de la
// allowlist. `wave-promote:resync-additive` y `split-github-reconcile` quedan
// EXCLUIDOS a propósito: comparten `actor` pero uno de ellos nace de una
// superficie EXTERNA (issue creado en GitHub).
const VALID_WAVE_ADD_SOURCES = Object.freeze(new Set(['telegram-commander/wave-add']));

// Reader por default del audit de olas. Devuelve las últimas `limit` entries.
function defaultWaveAuditReader(limit) {
    // eslint-disable-next-line global-require
    const waveAudit = require('./wave-audit');
    const all = waveAudit.readAllEvents();
    if (!Array.isArray(all)) return [];
    return all.slice(-limit);
}

/**
 * Devuelve el subconjunto de `candidates` (issues de la ola activa AUSENTES de
 * la allowlist) cuya promoción tiene una traza legítima y reciente en el audit
 * encadenado de olas. Cualquier fallo o indeterminación excluye al candidato.
 *
 * @param {number[]} candidates — faltantes en la allowlist (probe.removed).
 * @param {object} [opts]
 * @param {number} [opts.now] — timestamp ms (default Date.now()). Inyectable en tests.
 * @param {number} [opts.ttlMs] — ventana de validez (default DEFAULT_TTL_MS).
 * @param {(n:number)=>boolean|undefined} [opts.isClosed] — predicado de cierre.
 * @param {(limit:number)=>object[]} [opts.waveAuditReader] — reader de wave-audit (tests).
 * @param {(limit:number)=>object[]} [opts.auditReader] — reader de partial-pause-audit (tests).
 * @returns {number[]} subconjunto legítimo, ordenado ascendente y sin duplicados.
 */
function isLegitimateRecentWaveAdd(candidates, opts = {}) {
    const list = Array.isArray(candidates)
        ? candidates
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n) && n > 0)
        : [];
    if (list.length === 0) return [];

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMs = (Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
    const isClosed = typeof opts.isClosed === 'function' ? opts.isClosed : null;

    let waveEntries;
    let ppEntries;
    try {
        waveEntries = typeof opts.waveAuditReader === 'function'
            ? opts.waveAuditReader(AUDIT_TAIL_WINDOW)
            : defaultWaveAuditReader(AUDIT_TAIL_WINDOW);
        ppEntries = typeof opts.auditReader === 'function'
            ? opts.auditReader(AUDIT_TAIL_WINDOW)
            : partialPauseAudit.tail(AUDIT_TAIL_WINDOW);
    } catch {
        // Audit ilegible → nada es legítimo (fail-safe SEC-4439-4).
        return [];
    }
    if (!Array.isArray(waveEntries) || !Array.isArray(ppEntries)) return [];

    const legit = new Set();
    for (const n of list) {
        // Fail-safe: no tiene sentido habilitar el dispatch de un cerrado.
        if (isClosed && isClosed(n) === true) continue;

        const hit = waveEntries.find((e) => (
            e
            && e.event === 'issue_added'
            && VALID_WAVE_ADD_SOURCES.has(e.source)          // enum cerrado (event, source)
            && Number(e.issue) === n                         // binding POR ISSUE
            && Number.isFinite(Date.parse(e.timestamp))
            && Date.parse(e.timestamp) >= now - ttlMs        // dentro de TTL
        ));
        if (!hit) continue;

        // Anti-replay: si el operador SACÓ N de la allowlist DESPUÉS de la
        // traza de promoción, la última intención humana gana. Reparar acá
        // sería pisar una remoción deliberada con una traza vieja todavía
        // dentro del TTL. `partial-pause-audit.computeDiff` ya persiste
        // `{added, removed}` en cada entry, así que esto lee un campo existente.
        const hitTs = Date.parse(hit.timestamp);
        const deshecho = ppEntries.some((e) => (
            e
            && e.action === 'write'
            && e.diff && Array.isArray(e.diff.removed) && e.diff.removed.includes(n)
            && Number.isFinite(Date.parse(e.timestamp))
            && Date.parse(e.timestamp) > hitTs
        ));
        if (deshecho) continue;

        legit.add(n);
    }
    return [...legit].sort((a, b) => a - b);
}

module.exports = {
    isLegitimateRecentAdd,
    // #5882 — hermano en dirección ola → allowlist.
    isLegitimateRecentWaveAdd,
    VALID_AUTH,
    VALID_WAVE_ADD_SOURCES,
    DEFAULT_TTL_MS,
    DEFAULT_DISPATCH_CYCLE_MS,
    AUDIT_TAIL_WINDOW,
};
