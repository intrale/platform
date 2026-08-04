// =============================================================================
// split-orphan-reconciler.js — Descubrimiento DESDE GITHUB de hijos de split
// huérfanos de la ola activa (issue #5516).
//
// Por qué existe
// --------------
// Toda la cadena de auto-incorporación de hijos de split arranca leyendo la
// ALLOWLIST de pausa parcial, nunca GitHub:
//
//   - `allowlist-recursive-promote.js` (#3625) promueve los hijos a
//     `.partial-pause.json`, pero SÓLO se dispara desde el hook post-skill-success
//     del Commander (`intent=split`). Un split hecho por un agente `/planner`
//     lanzado por el Pulpo no pasa por ese hook: sus hijos nunca entran a la
//     allowlist ni registran provenance.
//   - `legit-add-trace.js` (#4439) y `split-provenance.js` (#4525) sólo evalúan
//     issues que YA aparecen como extra en la allowlist (`probe.added` del
//     desync-detector). Si el hijo nunca tocó la allowlist, es invisible.
//   - La provenance de #4525 vive en `authorization_ttls` con TTL de 48 h; con el
//     mapa vacío (estado real del 2026-08-03) el default-deny degrada a bloqueo.
//
// Nadie preguntaba nunca: "¿hay issues ABIERTOS cuyo padre declarado sea #N con
// N ∈ ola activa?". Ese es exactamente el hueco que cierra este módulo.
//
// Incidente que lo motiva: 2026-08-03, Ola 9.4 frenada por 13 issues huérfanos
// (#5458–#5463, #5419–#5421, #5203–#5205, #4890) que trancaban en cascada a
// #5451, #5452, #5453, #5428, #5401, #5126 y #5112.
//
// Contrato de diseño
// ------------------
//   - PURO: recibe la lista de issues y la ola como PARÁMETROS. Sin red, sin
//     `gh`, sin lectura de estado, sin escritura. El I/O vive en el wire-up
//     (`pulpo.js`), igual que `split-provenance.js`.
//   - NO consulta `authorization_ttls` ni depende de su TTL de 48 h (CA-2).
//   - Default-deny: cualquier indeterminación EXCLUYE al candidato.
//
// Reglas de seguridad (los issues de GitHub son INPUT NO CONFIABLE)
// ------------------------------------------------------------------
//   - SO-1: el número de padre extraído del título/body se sanitiza a entero > 0
//     antes de usarse. Nunca se confía en el texto libre.
//   - SO-2: el padre DEBE pertenecer a la ola activa. Un padre fuera de la ola
//     nunca auto-incorpora (default-deny estricto, CA "padre fuera de la ola").
//   - SO-3: sólo issues ABIERTOS. Un hijo cerrado se excluye (no reabre olas ni
//     reintroduce trabajo terminado).
//   - SO-4: título malformado / sin referencia de padre parseable → excluido.
//     Si título y body declaran padres distintos, MANDA EL TÍTULO (formato
//     canónico que emite `/planner split`); si el título no matchea y el body
//     declara MÁS DE UN padre posible, es ambiguo → excluido.
//   - SO-5: amplificación acotada. `maxDepth` limita la profundidad transitiva
//     (hijo de hijo) y `maxIncorporations` corta la cantidad total de
//     incorporaciones por corrida. Un actor que cree issues masivamente no puede
//     inflar la ola sin límite; el remanente queda para el ciclo siguiente y se
//     reporta en `truncated`/`reason`.
//   - SO-6: auto-referencia (`hijo === padre`) excluida.
//
// Idempotencia
// ------------
// Un hijo que YA está en la ola activa se excluye del resultado. Por eso dos
// corridas seguidas sin cambios en GitHub devuelven `[]` y el wire-up no escribe
// ni notifica (CA "corrida idempotente").
// =============================================================================

'use strict';

const { parseProvenanceRefs } = require('./partial-pause-deps');

// Formato canónico que emite `/planner split` (`.pipeline/roles/planner.md`):
//   Título: `[Split de #<parent>] <descripción>`
// Se acepta `de`/`of` y espacios laxos, anclado al inicio del título.
const SPLIT_TITLE_RE = /^\s*\[\s*split\s+(?:de|of)\s+#(\d+)\s*\]/i;

// SO-5 — Caps absolutos de amplificación. Los overrides se clampean acá.
const DEFAULT_MAX_DEPTH = 3;
const ABSOLUTE_MAX_DEPTH = 10;
const DEFAULT_MAX_INCORPORATIONS = 50;
const ABSOLUTE_MAX_INCORPORATIONS = 200;

/**
 * Normaliza un valor a entero > 0, o null (SO-1: no confía en el input).
 * @param {*} v
 * @returns {number|null}
 */
function toPositiveInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
    if (typeof v === 'string') {
        const s = v.trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
}

/**
 * ¿El issue está ABIERTO? (SO-3)
 * GitHub devuelve `state` como `OPEN`/`CLOSED` (GraphQL) u `open`/`closed`
 * (REST/`gh --json`). Cualquier otro valor (ausente, desconocido) NO cuenta
 * como abierto: default-deny.
 * @param {object} issue
 * @returns {boolean}
 */
function isOpenIssue(issue) {
    if (!issue || typeof issue !== 'object') return false;
    const state = issue.state;
    if (typeof state !== 'string') return false;
    return state.trim().toLowerCase() === 'open';
}

/**
 * Extrae el padre DECLARADO de un issue, o null si no hay uno unívoco (SO-4).
 *
 * Precedencia:
 *   1. Título `^[Split de #N]` — formato canónico de `/planner split`.
 *   2. Body: referencias de procedencia (`Split de #N` / `Tracked by #N`) vía
 *      `partial-pause-deps.parseProvenanceRefs`. Se acepta SÓLO si el body
 *      declara exactamente UN padre distinto; dos o más = ambiguo → null.
 *
 * @param {object} issue — `{ number, title, body }`
 * @returns {number|null}
 */
function parentOfSplitOrphan(issue) {
    if (!issue || typeof issue !== 'object') return null;
    const child = toPositiveInt(issue.number);
    if (!child) return null;                                   // SO-1

    // 1) Título canónico (manda sobre el body).
    const title = typeof issue.title === 'string' ? issue.title : '';
    const m = SPLIT_TITLE_RE.exec(title);
    if (m) {
        const parent = toPositiveInt(m[1]);
        if (!parent) return null;                              // SO-1
        if (parent === child) return null;                     // SO-6
        return parent;
    }

    // 2) Body: referencia explícita de padre (mismo patrón que usa el resto del
    //    pipeline). Ambigüedad (>1 padre candidato) → default-deny.
    const body = typeof issue.body === 'string' ? issue.body : '';
    if (!body) return null;
    let refs;
    try {
        refs = parseProvenanceRefs(body);
    } catch {
        return null;                                           // parser falló → excluir
    }
    const candidates = [...(refs || [])]
        .map(toPositiveInt)
        .filter((n) => n && n !== child);                      // SO-1 + SO-6
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) return null;                      // SO-4: ambiguo o vacío
    return unique[0];
}

/**
 * Descubre los hijos de split HUÉRFANOS de la ola activa: issues ABIERTOS cuyo
 * padre declarado pertenece a la ola activa y que todavía no están en ella.
 *
 * Expansión transitiva acotada (SO-5): un hijo incorporado pasa a ser padre
 * válido para la ronda siguiente, hasta `maxDepth` rondas. Así un split de un
 * split queda cubierto en la misma corrida sin depender del ciclo siguiente.
 *
 * @param {Array<object>} issues — issues de GitHub `{ number, title, body, state }`.
 *   NO se asume que estén filtrados: el módulo descarta cerrados e inválidos.
 * @param {object} ctx
 * @param {Array<number|string>} ctx.activeWaveIssues — números de la ola activa.
 * @param {number} [ctx.maxDepth=3] — rondas de expansión transitiva (clamp [1,10]).
 * @param {number} [ctx.maxIncorporations=50] — tope de incorporaciones por corrida
 *   (clamp [1,200]).
 * @returns {{
 *   orphans: Array<{ child: number, parent: number }>,
 *   truncated: boolean,
 *   reason: 'max_depth'|'max_incorporations'|null
 * }} `orphans` ordenado por `child` ascendente, sin duplicados.
 */
function findSplitOrphans(issues, ctx = {}) {
    const list = Array.isArray(issues) ? issues : [];
    const inWave = new Set(
        (Array.isArray(ctx.activeWaveIssues) ? ctx.activeWaveIssues : [])
            .map(toPositiveInt)
            .filter(Boolean)
    );

    const empty = { orphans: [], truncated: false, reason: null };
    if (list.length === 0 || inWave.size === 0) return empty;

    let maxDepth = Number.isFinite(ctx.maxDepth) ? Math.floor(ctx.maxDepth) : DEFAULT_MAX_DEPTH;
    if (maxDepth < 1) maxDepth = 1;
    if (maxDepth > ABSOLUTE_MAX_DEPTH) maxDepth = ABSOLUTE_MAX_DEPTH;

    let maxIncorporations = Number.isFinite(ctx.maxIncorporations)
        ? Math.floor(ctx.maxIncorporations)
        : DEFAULT_MAX_INCORPORATIONS;
    if (maxIncorporations < 1) maxIncorporations = 1;
    if (maxIncorporations > ABSOLUTE_MAX_INCORPORATIONS) maxIncorporations = ABSOLUTE_MAX_INCORPORATIONS;

    // Pre-clasificación: candidatos válidos = abiertos, con padre unívoco y que
    // NO estén ya en la ola (idempotencia). Todo lo demás se descarta acá.
    const candidates = [];
    const seenChildren = new Set();
    for (const issue of list) {
        if (!isOpenIssue(issue)) continue;                     // SO-3
        const child = toPositiveInt(issue && issue.number);
        if (!child) continue;                                  // SO-1
        if (inWave.has(child)) continue;                       // ya en la ola → no-op
        if (seenChildren.has(child)) continue;                 // duplicado en el input
        const parent = parentOfSplitOrphan(issue);
        if (!parent) continue;                                 // SO-4/SO-6
        seenChildren.add(child);
        candidates.push({ child, parent });
    }
    if (candidates.length === 0) return empty;

    // Expansión por rondas: cada ronda incorpora los candidatos cuyo padre ya
    // está en el conjunto "alcanzable desde la ola activa" (SO-2).
    const reachable = new Set(inWave);
    const orphans = [];
    const taken = new Set();
    let truncated = false;
    let reason = null;

    // Cada ronda es un NIVEL BFS puro: los hijos incorporados en la ronda N sólo
    // habilitan a sus propios hijos en la ronda N+1. Por eso el staging
    // (`nextLevel`) se mergea a `reachable` recién al cerrar la ronda — si se
    // mutara `reachable` dentro de la pasada, la profundidad efectiva
    // dependería del ORDEN del array de entrada (un nieto listado después del
    // hijo entraría en la misma ronda, uno listado antes no). Determinismo.
    let fixpoint = false;
    for (let round = 0; round < maxDepth; round++) {
        const nextLevel = [];
        for (const c of candidates) {
            if (taken.has(c.child)) continue;
            if (!reachable.has(c.parent)) continue;            // SO-2: padre fuera → deny
            if (orphans.length >= maxIncorporations) {         // SO-5
                truncated = true;
                reason = 'max_incorporations';
                break;
            }
            taken.add(c.child);
            nextLevel.push(c.child);
            orphans.push(c);
        }
        if (truncated) break;
        if (nextLevel.length === 0) { fixpoint = true; break; } // punto fijo alcanzado
        for (const n of nextLevel) reachable.add(n);
    }

    // Truncado por PROFUNDIDAD sólo si agotamos las rondas sin llegar al punto
    // fijo Y todavía queda algún candidato cuyo padre YA es alcanzable. Un
    // candidato pendiente con padre fuera de la ola no es truncado: es
    // default-deny (SO-2) y no debe reportarse como tal.
    if (!truncated && !fixpoint) {
        const pendingReachable = candidates.some((c) => !taken.has(c.child) && reachable.has(c.parent));
        if (pendingReachable) {
            truncated = true;
            reason = 'max_depth';
        }
    }

    orphans.sort((a, b) => a.child - b.child);
    return { orphans, truncated, reason };
}

/**
 * Agrupa el resultado de `findSplitOrphans` por padre. Útil para declarar la
 * dependencia `padre → [hijos]` en una sola llamada a `waves.addDependency`.
 *
 * @param {Array<{child:number,parent:number}>} orphans
 * @returns {Array<{ parent: number, children: number[] }>} ordenado por padre asc.
 */
function groupByParent(orphans) {
    const map = new Map();
    for (const o of (Array.isArray(orphans) ? orphans : [])) {
        const parent = toPositiveInt(o && o.parent);
        const child = toPositiveInt(o && o.child);
        if (!parent || !child) continue;
        if (!map.has(parent)) map.set(parent, new Set());
        map.get(parent).add(child);
    }
    return [...map.entries()]
        .map(([parent, children]) => ({ parent, children: [...children].sort((a, b) => a - b) }))
        .sort((a, b) => a.parent - b.parent);
}

module.exports = {
    SPLIT_TITLE_RE,
    DEFAULT_MAX_DEPTH,
    ABSOLUTE_MAX_DEPTH,
    DEFAULT_MAX_INCORPORATIONS,
    ABSOLUTE_MAX_INCORPORATIONS,
    findSplitOrphans,
    parentOfSplitOrphan,
    groupByParent,
    // Exportados para tests.
    toPositiveInt,
    isOpenIssue,
};
