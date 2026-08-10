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
//   - SO-4: ÚNICO criterio de detección = el título canónico `[Split de #N]`
//     que emite `/planner split`. Un título que no matchea → excluido, sin
//     fallback de ningún tipo.
//     DECISIÓN DEL OPERADOR (2026-08-05, ratificada 2026-08-06): el
//     descubrimiento por BODY quedó ELIMINADO. Se había contemplado como segunda
//     vía (`Split de #N` / `Tracked by #N` en el cuerpo), pero contrastado contra
//     los datos reales de la ola los 7 matches por body eran TODOS falsos
//     positivos: una línea de `git log`, el título de otro issue entrecomillado y
//     prosa suelta del estilo "TRAMO 4 del split de #N". En paralelo, el 100 % de
//     los hijos legítimos de la ola matcheaba por título. El body es prosa libre:
//     anclar o refinar el patrón sólo mueve el umbral de falsos positivos, no lo
//     elimina. NO reintroducir esta vía sin una nueva decisión explícita del
//     operador.
//   - SO-5: amplificación acotada. `maxDepth` limita la profundidad transitiva
//     (hijo de hijo) y `maxIncorporations` corta la cantidad total de
//     incorporaciones por corrida. Un actor que cree issues masivamente no puede
//     inflar la ola sin límite; el remanente queda para el ciclo siguiente y se
//     reporta en `truncated`/`reason`.
//   - SO-6: auto-referencia (`hijo === padre`) excluida.
//   - SO-7: ORIGEN CONFIABLE. El repo `intrale/platform` es PÚBLICO con issues
//     habilitados, y el Admission Gate (`.github/workflows/admission-gate.yml`)
//     etiqueta `needs-definition` de forma automática a issues de CUALQUIER
//     autor. El gate de dispatch real del pipeline es la allowlist de pausa
//     parcial (`partial-pause.js` → `allowedIssues.includes(n)`), así que un
//     candidato que llega hasta acá se está escribiendo A SÍ MISMO dentro del
//     gate que lo debería contener. Sin verificación de autor, cualquier persona
//     con cuenta de GitHub podría abrir un issue titulado `[Split de #N]` (N es
//     público) y hacer que el pipeline le ejecute trabajo autónomo tomando su
//     body como consigna (Broken Access Control, OWASP A01:2021).
//     Por eso el autor debe ser CONFIABLE: `authorAssociation ∈ {OWNER, MEMBER,
//     COLLABORATOR}` (mismo criterio que `architect-signoff-gate.js`) o login en
//     la allowlist explícita de `config.yaml` (`desync.split_orphan_trusted_logins`).
//     Campo de autor ausente, desconocido o indeterminado → EXCLUIDO (default-deny).
//     La asociación se consulta EN VIVO a GitHub en el wire-up, así que esto NO
//     reintroduce `authorization_ttls` ni su TTL de 48 h (CA-2 sigue cumplido).
//   - SO-8: LABELS DE BLOQUEO. Un hijo con `needs-human`, `tipo:recomendacion` o
//     `source:recommendation` NO se auto-incorpora. Son issues frenados A
//     PROPÓSITO por decisión humana (`needs-human`) o propuestas que todavía no
//     pasaron el gate de aprobación humana de #2653 (`tipo:recomendacion` /
//     `source:recommendation`). Incorporarlos sumaba el issue a la ola Y a la
//     allowlist, o sea los habilitaba para dispatch: el reconciliador se
//     convertía en un bypass del propio gate que lo debería contener.
//     Medido el 2026-08-07 sobre la ola real: 3 de 11 hijos descubiertos
//     (#5209, #5421, #5462) entraban pese a llevar `needs-human`.
//     El campo `labels` es OBLIGATORIO en el payload: si falta o no es una lista,
//     el candidato se EXCLUYE (default-deny). Es deliberado — un wire-up que se
//     olvide de pedir `labels` desactivaría el guard EN SILENCIO, que es
//     exactamente la clase de regresión que SO-8 viene a cerrar. La exclusión se
//     reporta en `rejectedByLabel`, nunca se descarta sin dejar rastro.
//
// Idempotencia
// ------------
// Un hijo que YA está en la ola activa se excluye del resultado. Por eso dos
// corridas seguidas sin cambios en GitHub devuelven `[]` y el wire-up no escribe
// ni notifica (CA "corrida idempotente").
// =============================================================================

'use strict';

// Formato canónico que emite `/planner split` (`.pipeline/roles/planner.md`):
//   Título: `[Split de #<parent>] <descripción>`
// Se acepta `de`/`of` y espacios laxos, anclado al inicio del título.
const SPLIT_TITLE_RE = /^\s*\[\s*split\s+(?:de|of)\s+#(\d+)\s*\]/i;

// SO-7 — Asociaciones de autor consideradas CONFIABLES. Mismo criterio (y mismo
// razonamiento) que `architect-signoff-gate.js::ALLOWED_AUTHOR_ASSOCIATIONS`:
// `NONE`, `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR` y `MANNEQUIN`
// quedan AFUERA — son exactamente los valores que puede tener un tercero sin
// permisos sobre el repo.
const TRUSTED_AUTHOR_ASSOCIATIONS = Object.freeze([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
]);

// SO-8 — Labels que BLOQUEAN la auto-incorporación. Se comparan en minúsculas.
//   - `needs-human`          → el pipeline lo frenó esperando una decisión humana.
//   - `tipo:recomendacion`   → recomendación de un agente, pendiente de aprobación
//   - `source:recommendation`  humana (gate de #2653). Todavía no es trabajo aprobado.
// Sumar cualquiera de estos a la ola + allowlist equivale a habilitarlos para
// dispatch, salteando el gate que los frenó.
const BLOCKING_LABELS = Object.freeze([
    'needs-human',
    'tipo:recomendacion',
    'source:recommendation',
]);

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
 * Extrae la `authorAssociation` de un issue, normalizada a MAYÚSCULAS, o null.
 *
 * Acepta las dos formas con las que el dato llega según la fuente:
 *   - REST (`gh api /repos/:o/:r/issues`) → `author_association`
 *   - GraphQL / `gh --json` → `authorAssociation`
 * Cualquier otra forma (ausente, no-string, vacía) → null → SO-7 excluye.
 *
 * @param {object} issue
 * @returns {string|null}
 */
function authorAssociationOf(issue) {
    if (!issue || typeof issue !== 'object') return null;
    const raw = issue.authorAssociation !== undefined
        ? issue.authorAssociation
        : issue.author_association;
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toUpperCase();
    return s === '' ? null : s;
}

/**
 * Extrae el login del autor de un issue, normalizado a minúsculas, o null.
 *
 * Acepta: `author.login` (gh `--json author`), `user.login` (REST) y `author`
 * como string suelto. Cualquier otra forma → null.
 *
 * @param {object} issue
 * @returns {string|null}
 */
function authorLoginOf(issue) {
    if (!issue || typeof issue !== 'object') return null;
    const candidates = [
        issue.author && typeof issue.author === 'object' ? issue.author.login : null,
        issue.user && typeof issue.user === 'object' ? issue.user.login : null,
        typeof issue.author === 'string' ? issue.author : null,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim() !== '') return c.trim().toLowerCase();
    }
    return null;
}

/**
 * ¿El issue viene de un ORIGEN CONFIABLE? (SO-7)
 *
 * DEFAULT-DENY: sólo devuelve `true` si puede PROBAR la confianza. Un issue sin
 * campo de autor, con asociación desconocida o con forma inesperada se excluye.
 * Los issues de GitHub son input NO CONFIABLE en un repo público.
 *
 * Criterio (OR):
 *   1. `authorAssociation ∈ TRUSTED_AUTHOR_ASSOCIATIONS`, o
 *   2. login ∈ `opts.trustedLogins` (allowlist explícita de `config.yaml`, para
 *      cuentas de bot que no son miembros de la organización).
 *
 * PURO: no consulta red ni estado. El dato de autor lo trae el wire-up.
 *
 * @param {object} issue
 * @param {object} [opts]
 * @param {Array<string>} [opts.trustedLogins] — allowlist de logins.
 * @returns {boolean}
 */
function isTrustedAuthor(issue, opts = {}) {
    if (!issue || typeof issue !== 'object') return false;

    // 1) Allowlist explícita de logins (case-insensitive, tolera `@usuario`).
    const login = authorLoginOf(issue);
    if (login) {
        const allow = Array.isArray(opts.trustedLogins) ? opts.trustedLogins : [];
        for (const l of allow) {
            if (typeof l !== 'string') continue;
            const norm = l.trim().toLowerCase().replace(/^@/, '');
            if (norm !== '' && norm === login) return true;
        }
    }

    // 2) Asociación del autor con el repo (consultada en vivo por el wire-up).
    const assoc = authorAssociationOf(issue);
    if (assoc && TRUSTED_AUTHOR_ASSOCIATIONS.includes(assoc)) return true;

    return false;                                              // SO-7 default-deny
}

/**
 * Extrae los nombres de labels de un issue, normalizados a minúsculas.
 *
 * Acepta las formas con las que el dato llega según la fuente:
 *   - REST / `search/issues` → `labels: [{ name: 'x' }, ...]`
 *   - `gh --json labels`     → idem
 *   - GraphQL                → `labels: { nodes: [{ name: 'x' }] }`
 *   - forma simplificada     → `labels: ['x', 'y']`
 *
 * DEFAULT-DENY (SO-8): devuelve `{ known: false }` si el campo falta o no tiene
 * una forma reconocible. El caller DEBE excluir al candidato en ese caso; un
 * payload sin `labels` significa "no sé si está bloqueado", no "no está
 * bloqueado". Entradas individuales inválidas dentro de una lista válida se
 * ignoran (no invalidan al resto).
 *
 * @param {object} issue
 * @returns {{ known: boolean, names: string[] }}
 */
function labelsOf(issue) {
    const unknown = { known: false, names: [] };
    if (!issue || typeof issue !== 'object') return unknown;

    let raw = issue.labels;
    // GraphQL: `{ nodes: [...] }`
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.nodes)) {
        raw = raw.nodes;
    }
    if (!Array.isArray(raw)) return unknown;                   // ausente/invalido → SO-8 deny

    const names = [];
    for (const l of raw) {
        let name = null;
        if (typeof l === 'string') name = l;
        else if (l && typeof l === 'object' && typeof l.name === 'string') name = l.name;
        if (name === null) continue;                           // entrada rara → se ignora
        const norm = name.trim().toLowerCase();
        if (norm !== '') names.push(norm);
    }
    return { known: true, names };
}

/**
 * SO-8 — ¿El issue está bloqueado por labels? Devuelve la lista de labels de
 * bloqueo encontrados (vacía si ninguno), o `null` si los labels son
 * INDETERMINADOS (payload sin `labels` → default-deny, el caller excluye).
 *
 * @param {object} issue
 * @param {Array<string>} [blockingLabels] — override (default `BLOCKING_LABELS`).
 * @returns {string[]|null}
 */
function blockingLabelsOf(issue, blockingLabels) {
    const { known, names } = labelsOf(issue);
    if (!known) return null;                                   // indeterminado
    const blockList = (Array.isArray(blockingLabels) ? blockingLabels : BLOCKING_LABELS)
        .filter((l) => typeof l === 'string')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l !== '');
    return names.filter((n) => blockList.includes(n));
}

/**
 * Extrae el padre DECLARADO de un issue, o null si no hay uno unívoco (SO-4).
 *
 * ÚNICO criterio: el título canónico `^[Split de #N]` que emite `/planner split`.
 * El BODY NO se mira (decisión del operador 2026-08-05/06 — ver SO-4 en la
 * cabecera). Cualquier otro formato de título → null (default-deny).
 *
 * @param {object} issue — `{ number, title }`
 * @returns {number|null}
 */
function parentOfSplitOrphan(issue) {
    if (!issue || typeof issue !== 'object') return null;
    const child = toPositiveInt(issue.number);
    if (!child) return null;                                   // SO-1

    const title = typeof issue.title === 'string' ? issue.title : '';
    const m = SPLIT_TITLE_RE.exec(title);
    if (!m) return null;                                       // SO-4: sin título canónico → excluido

    const parent = toPositiveInt(m[1]);
    if (!parent) return null;                                  // SO-1
    if (parent === child) return null;                         // SO-6
    return parent;
}

/**
 * Descubre los hijos de split HUÉRFANOS de la ola activa: issues ABIERTOS cuyo
 * padre declarado pertenece a la ola activa y que todavía no están en ella.
 *
 * Expansión transitiva acotada (SO-5): un hijo incorporado pasa a ser padre
 * válido para la ronda siguiente, hasta `maxDepth` rondas. Así un split de un
 * split queda cubierto en la misma corrida sin depender del ciclo siguiente.
 *
 * @param {Array<object>} issues — issues de GitHub
 *   `{ number, title, state, author|user, author_association, labels }`. El `body`
 *   NO se usa: el único criterio de detección es el título canónico (SO-4).
 *   `labels` es OBLIGATORIO (SO-8): si falta, el candidato se excluye.
 *   NO se asume que estén filtrados: el módulo descarta cerrados, inválidos y de
 *   ORIGEN NO CONFIABLE (SO-7). El wire-up DEBE traer el dato de autor; si falta,
 *   el default-deny excluye todo (fail-closed, no fail-open).
 * @param {object} ctx
 * @param {Array<number|string>} ctx.activeWaveIssues — números de la ola activa.
 * @param {number} [ctx.maxDepth=3] — rondas de expansión transitiva (clamp [1,10]).
 * @param {number} [ctx.maxIncorporations=50] — tope de incorporaciones por corrida
 *   (clamp [1,200]).
 * @param {(issue: object) => boolean} [ctx.isTrustedAuthor] — SO-7: predicado de
 *   origen confiable inyectado por el wire-up. Debe devolver `true` EXACTO para
 *   aceptar. Si tira, el candidato se excluye. Default: criterio propio del módulo.
 * @param {Array<string>} [ctx.trustedLogins] — SO-7: allowlist de logins usada por
 *   el criterio default (ignorada si se inyecta `ctx.isTrustedAuthor`).
 * @param {Array<string>} [ctx.blockingLabels] — SO-8: override de los labels que
 *   bloquean la auto-incorporación (default `BLOCKING_LABELS`).
 * @returns {{
 *   orphans: Array<{ child: number, parent: number }>,
 *   truncated: boolean,
 *   reason: 'max_depth'|'max_incorporations'|null,
 *   rejectedUntrusted: Array<{ child: number, parent: number, login: string|null, association: string|null }>,
 *   rejectedByLabel: Array<{ child: number, parent: number, labels: string[]|null, reason: 'blocking_label'|'labels_unavailable' }>
 * }} `orphans` ordenado por `child` ascendente, sin duplicados.
 *   `rejectedByLabel` (SO-8) lista los candidatos con padre EN ALCANCE excluidos
 *   por llevar un label de bloqueo (`blocking_label`) o por venir sin `labels` en
 *   el payload (`labels_unavailable`). Nunca se descartan en silencio.
 *   `rejectedUntrusted` lista los candidatos que declaraban un padre EN ALCANCE
 *   DE LA OLA (∈ ola activa, o alcanzable transitivamente por un hijo ya
 *   incorporado en esta corrida) pero fueron excluidos por SO-7 — nunca se
 *   descartan en silencio (son intentos potenciales de inyección y el wire-up
 *   los loguea/alerta).
 *   NO incluye a los que declaran un padre FUERA de la ola: ésos ya caen por
 *   SO-2 sin importar quién los haya escrito, así que no representan un intento
 *   de entrar al alcance del pipeline. En un repo PÚBLICO cualquier
 *   `[Split de #N]` de un tercero apuntando a un `N` ajeno dispararía si no una
 *   alerta de seguridad engañosa por ciclo — ruido que erosiona la señal real.
 */
function findSplitOrphans(issues, ctx = {}) {
    const list = Array.isArray(issues) ? issues : [];
    const inWave = new Set(
        (Array.isArray(ctx.activeWaveIssues) ? ctx.activeWaveIssues : [])
            .map(toPositiveInt)
            .filter(Boolean)
    );

    // OJO: se construye FRESCO en cada retorno. Devolver una referencia
    // compartida dejaría que un caller que mute el resultado (p. ej. marcar
    // `truncated`) contamine las corridas siguientes.
    const empty = () => ({
        orphans: [], truncated: false, reason: null,
        rejectedUntrusted: [], rejectedByLabel: [],
    });
    if (list.length === 0 || inWave.size === 0) return empty();

    let maxDepth = Number.isFinite(ctx.maxDepth) ? Math.floor(ctx.maxDepth) : DEFAULT_MAX_DEPTH;
    if (maxDepth < 1) maxDepth = 1;
    if (maxDepth > ABSOLUTE_MAX_DEPTH) maxDepth = ABSOLUTE_MAX_DEPTH;

    let maxIncorporations = Number.isFinite(ctx.maxIncorporations)
        ? Math.floor(ctx.maxIncorporations)
        : DEFAULT_MAX_INCORPORATIONS;
    if (maxIncorporations < 1) maxIncorporations = 1;
    if (maxIncorporations > ABSOLUTE_MAX_INCORPORATIONS) maxIncorporations = ABSOLUTE_MAX_INCORPORATIONS;

    // SO-7 — Predicado de origen confiable. El wire-up puede inyectar el suyo
    // (`ctx.isTrustedAuthor`); si no, se usa el criterio propio del módulo con la
    // allowlist de logins de `ctx.trustedLogins`. Un predicado inyectado que TIRA
    // no puede tumbar el tick del Pulpo: se trata como "no confiable" (excluir).
    // Se exige `=== true` estricto para que un retorno truthy raro (string, 1,
    // objeto) no cuente como confianza probada.
    const trustFn = typeof ctx.isTrustedAuthor === 'function'
        ? ctx.isTrustedAuthor
        : (issue) => isTrustedAuthor(issue, { trustedLogins: ctx.trustedLogins });
    const trusted = (issue) => {
        try {
            return trustFn(issue) === true;
        } catch {
            return false;                                      // SO-7 default-deny
        }
    };

    // Pre-clasificación: candidatos válidos = abiertos, de origen confiable, con
    // padre unívoco y que NO estén ya en la ola (idempotencia). Todo lo demás se
    // descarta acá.
    const candidates = [];
    const seenChildren = new Set();
    // Staging: acá entra TODO el que declara un padre unívoco y no pasa SO-7. El
    // filtro por alcance (padre ∈ ola / alcanzable) se aplica al final, cuando el
    // conjunto `reachable` ya está cerrado — un candidato puede declarar como padre
    // a un hijo que se incorpora recién en la ronda 2, y ése SÍ es un intento real.
    const rejectedStaging = [];
    // SO-8 — Staging de los bloqueados por label. Mismo criterio de reporte que
    // SO-7: se filtra por alcance recién al final, con `reachable` ya cerrado.
    const labelStaging = [];
    for (const issue of list) {
        if (!isOpenIssue(issue)) continue;                     // SO-3
        const child = toPositiveInt(issue && issue.number);
        if (!child) continue;                                  // SO-1
        if (inWave.has(child)) continue;                       // ya en la ola → no-op
        if (seenChildren.has(child)) continue;                 // duplicado en el input
        const parent = parentOfSplitOrphan(issue);
        if (!parent) continue;                                 // SO-4/SO-6
        // SO-7 DESPUÉS del parseo de padre: así sólo reportamos como rechazado a
        // quien REALMENTE intentaba entrar (declaraba un padre), no a los cientos
        // de issues normales del repo que ni matchean el formato de split.
        if (!trusted(issue)) {
            rejectedStaging.push({
                child,
                parent,
                login: authorLoginOf(issue),
                association: authorAssociationOf(issue),
            });
            continue;
        }
        // SO-8 DESPUÉS de SO-7: un autor no confiable es la señal más grave y no
        // debe quedar tapada por el bucket de labels. Un candidato bloqueado por
        // label NO entra al conjunto `reachable`, así que sus propios hijos
        // tampoco se incorporan: si el split padre está frenado por decisión
        // humana, la rama entera queda frenada.
        let blocking;
        try {
            blocking = blockingLabelsOf(issue, ctx.blockingLabels);
        } catch {
            blocking = null;                                   // SO-8 default-deny
        }
        if (blocking === null) {
            labelStaging.push({ child, parent, labels: null, reason: 'labels_unavailable' });
            continue;
        }
        if (blocking.length > 0) {
            labelStaging.push({ child, parent, labels: blocking, reason: 'blocking_label' });
            continue;
        }
        seenChildren.add(child);
        candidates.push({ child, parent });
    }
    if (candidates.length === 0) {
        // Sin candidatos confiables no hay expansión: el alcance es la ola cruda.
        return {
            ...empty(),
            rejectedUntrusted: rejectedStaging.filter((r) => inWave.has(r.parent)),
            rejectedByLabel: labelStaging.filter((r) => inWave.has(r.parent)),
        };
    }

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
    // Sólo se reporta como intento de entrada al que apunta a un padre EN ALCANCE:
    // el resto no habría entrado ni siendo confiable (SO-2), así que alertarlo sería
    // una acusación falsa ("declaran un padre de la ola activa") y ruido por ciclo.
    const rejectedUntrusted = rejectedStaging.filter((r) => reachable.has(r.parent));
    // SO-8 — Mismo filtro por alcance: un hijo bloqueado por label cuyo padre ni
    // siquiera está en la ola no aporta señal (habría caído por SO-2 igual).
    const rejectedByLabel = labelStaging.filter((r) => reachable.has(r.parent));
    return { orphans, truncated, reason, rejectedUntrusted, rejectedByLabel };
}

/**
 * Clasifica el corte de la VENTANA DE DESCUBRIMIENTO del wire-up (#5516, punto 4
 * del alcance del operador).
 *
 * El wire-up pagina la consulta a GitHub con un tope de páginas. Antes, agotar
 * ese tope no marcaba NADA: `truncated` sólo salía de los caps del módulo puro,
 * así que el recorte era SILENCIOSO y se perdían huérfanos reales sin señal
 * (medido el 2026-08-10: 109 de 126 hijos con título canónico quedaban afuera de
 * la ventana de 300, incluida toda la cadena de #5126).
 *
 * Hay truncado cuando:
 *   - GitHub declaró el resultado incompleto (`incomplete_results: true`), o
 *   - agotamos `maxPages` y la ÚLTIMA página vino LLENA (`lastBatchSize ===
 *     pageSize`) ⇒ había más resultados más allá de la ventana.
 *
 * Una última página a medio llenar significa que llegamos al final del conjunto:
 * NO es truncado.
 *
 * PURO: sin red ni estado, para poder testear el punto 4 de verdad.
 *
 * @param {object} p
 * @param {number} p.pagesFetched — páginas efectivamente traídas.
 * @param {number} p.lastBatchSize — tamaño de la última página traída.
 * @param {number} p.pageSize — `per_page` usado.
 * @param {number} p.maxPages — tope de páginas del wire-up.
 * @param {boolean} [p.incompleteResults] — `incomplete_results` de la búsqueda.
 * @returns {{ truncated: boolean, reason: 'discovery_window'|'search_incomplete'|null }}
 */
function classifyDiscoveryWindow(p = {}) {
    const pagesFetched = Number(p.pagesFetched) || 0;
    const lastBatchSize = Number(p.lastBatchSize) || 0;
    const pageSize = Number(p.pageSize) || 0;
    const maxPages = Number(p.maxPages) || 0;

    // El timeout de búsqueda manda: el conjunto es parcial aunque no hayamos
    // agotado las páginas.
    if (p.incompleteResults === true) {
        return { truncated: true, reason: 'search_incomplete' };
    }
    if (pagesFetched >= maxPages && pageSize > 0 && lastBatchSize === pageSize) {
        return { truncated: true, reason: 'discovery_window' };
    }
    return { truncated: false, reason: null };
}

/**
 * Combina el truncado del CLASIFICADOR (caps SO-5 / `max_depth`) con el de la
 * VENTANA de descubrimiento del wire-up. Ambos pueden darse a la vez y los dos
 * importan, así que los motivos se concatenan en vez de pisarse.
 *
 * @param {object} p
 * @param {boolean} [p.moduleTruncated]
 * @param {string|null} [p.moduleReason]
 * @param {boolean} [p.windowTruncated]
 * @param {string|null} [p.windowReason]
 * @returns {{ truncated: boolean, reason: string|null }}
 */
function combineTruncation(p = {}) {
    const moduleTruncated = p.moduleTruncated === true;
    const windowTruncated = p.windowTruncated === true;
    const reason = [
        moduleTruncated ? p.moduleReason : null,
        windowTruncated ? p.windowReason : null,
    ].filter((r) => typeof r === 'string' && r !== '').join('+') || null;
    return { truncated: moduleTruncated || windowTruncated, reason };
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
    TRUSTED_AUTHOR_ASSOCIATIONS,
    BLOCKING_LABELS,
    isTrustedAuthor,
    authorAssociationOf,
    authorLoginOf,
    labelsOf,
    blockingLabelsOf,
    DEFAULT_MAX_DEPTH,
    ABSOLUTE_MAX_DEPTH,
    DEFAULT_MAX_INCORPORATIONS,
    ABSOLUTE_MAX_INCORPORATIONS,
    findSplitOrphans,
    parentOfSplitOrphan,
    groupByParent,
    classifyDiscoveryWindow,
    combineTruncation,
    // Exportados para tests.
    toPositiveInt,
    isOpenIssue,
};
