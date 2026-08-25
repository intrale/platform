'use strict';

// ============================================================================
// #6431 (split de #6423) — Clasificacion de los checks REQUERIDOS de la rama base.
// ============================================================================
//
// Que defecto arregla este modulo. GitHub responde `HTTP 405` +
// `mergeStateStatus=BLOCKED` en dos situaciones que delivery no sabia separar:
//
//   (a) un control se esta ejerciendo de verdad  -> review faltante, check en
//       rojo, hilo de review sin resolver. Escala, y esta bien que escale.
//   (b) el check obligatorio TODAVIA NO REPORTO  -> carrera con la CI. No hay
//       nada que decidir: se espera unos segundos y se reintenta.
//
// El episodio del 2026-08-24 es (b) leido como (a): PR #6416 creado a
// `01:45:02Z`, check requerido verde a `01:45:21Z` (t+19 s), mergeado a mano a
// `10:50:59Z`. Nueve horas de bloqueo humano por una carrera de 19 segundos.
//
// Por que no alcanzaba con mirar `statusCheckRollup`. A t+4 s el rollup del PR
// viene `[]` — GitHub todavia no instancio ningun check. `classifyChecks` (de
// `human-block-triggers.js`) lee ese `[]` como `unknown`, y `unknown` es
// fail-closed => escala. La ausencia de un check solo se puede AFIRMAR contra la
// lista de requeridos del ruleset, nunca contra el vacio del rollup. Ese es el
// delta entero de este modulo: traemos la lista de requeridos y cotejamos.
//
// Disciplina de diseno (la misma de #6012 / #6384, no se inventa nada):
//   - Impuro afuera, puro adentro: dos lectores de red aislados, un clasificador
//     PURO y sincrono que recibe datos ya leidos. La suite corre sin red.
//   - `null` != `[]`: `null` = "no lei" (fail-closed duro), `[]` = "lei y esta
//     vacio" (dato legitimo). Confundirlos es el defecto que este modulo evita.
//   - Enums cerrados por forma: un valor fuera del enum es SENAL AUSENTE, nunca
//     "asumo lo mejor". Los enums se IMPORTAN de `human-block-triggers.js` — no
//     se reescriben, porque dos copias divergen (CA-23).
//   - Fail-closed en cada borde: cualquier duda => `unusable`, que rio abajo
//     significa `gate-block`. El veredicto `pending` (el unico que habilita la
//     espera) se emite solo con evidencia positiva.
//
// SEC-8 — Este modulo NUNCA loguea ni devuelve el JSON crudo del ruleset: trae
// `allowed_actors`, `required_reviewers` y `dismissal_restriction`, que son
// datos de la politica de seguridad del repo. Solo salen `context`,
// `integration_id` y el estado observado.

const gitOps = require('../skills-deterministicos/lib/git-ops');
const {
    CHECK_FAIL_CONCLUSIONS,
    CHECK_PENDING_STATUSES,
    CHECK_FAIL_STATES,
    CHECK_PENDING_STATES,
} = require('./human-block-triggers');

const REQUIRED_CHECKS_VERDICTS = Object.freeze(['pending', 'blocking', 'green', 'unusable']);

// Estados terminales NO bloqueantes. Cerrado a proposito: cualquier otro valor
// cae a `unusable` (SEC-8/CA-21) en vez de contarse como verde por descarte.
const CHECK_GREEN_CONCLUSIONS = Object.freeze(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_GREEN_STATES = Object.freeze(['SUCCESS']);

const DEFAULT_TIMEOUT_MS = 30 * 1000;
// Techo de la pagina de GraphQL. Tiene que coincidir con el `first:` de la
// query: la regla 3 del clasificador compara `contexts.length` contra
// `totalCount`, asi que una pagina incompleta se detecta sola.
const ROLLUP_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// validateBranchName — SEC-11 / CA-12
// ---------------------------------------------------------------------------
//
// `branch` se interpola en el path de `repos/{owner}/{repo}/rules/branches/<b>`.
// Un `..` haria que el cliente HTTP normalice la URL y termine leyendo las
// reglas de OTRO recurso — y rio abajo eso es indistinguible de haber leido las
// correctas: clasificariamos con la politica equivocada sin enterarnos.
//
// Se valida ANTES de llamar a la API (no despues): la llamada con un ref
// deforme no se hace nunca.
function validateBranchName(branch) {
    if (typeof branch !== 'string') return false;
    const b = branch.trim();
    if (!b || b.length > 255) return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false;
    // Segmentos `.` y `..` explicitos (el regex de arriba los deja pasar: son
    // caracteres permitidos). Tambien corta `//`, `/` inicial y `/` final.
    if (b.startsWith('/') || b.endsWith('/')) return false;
    const segments = b.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
    return true;
}

function runGhSafe(ghImpl, args, cwd) {
    const impl = typeof ghImpl === 'function' ? ghImpl : gitOps.runGh;
    try {
        const res = impl(args, { cwd, timeoutMs: DEFAULT_TIMEOUT_MS });
        if (!res || typeof res !== 'object') return { ok: false, cause: 'gh-sin-resultado' };
        if (res.exit_code !== 0) return { ok: false, cause: `gh-exit-${res.exit_code}` };
        let parsed;
        try {
            parsed = JSON.parse(res.stdout);
        } catch {
            return { ok: false, cause: 'json-invalido' };
        }
        if (!parsed || typeof parsed !== 'object') return { ok: false, cause: 'json-no-objeto' };
        return { ok: true, parsed };
    } catch {
        // Excepcion (timeout, spawn, red) = NO lei. Jamas "no hay control".
        return { ok: false, cause: 'excepcion' };
    }
}

// ---------------------------------------------------------------------------
// fetchRequiredContexts — IMPURA #1: el ruleset de la rama BASE
// ---------------------------------------------------------------------------
//
// `GET repos/{owner}/{repo}/rules/branches/<branch>` devuelve las reglas
// EFECTIVAS sobre esa rama y es legible sin permisos de admin (a diferencia de
// `/rulesets`, que si los pide). Verificado por `guru` (G6).
//
// SEC-1/CA-6 — Ruleset ausente, sin `required_status_checks` o con la lista
// VACIA => `ok:false`. "No pude leer que se exige" NUNCA se traduce a "no se
// exige nada": ese fail-open convertiria el modulo en un bypass de la
// proteccion de rama.
function fetchRequiredContexts({ branch, ghImpl = gitOps.runGh, cwd } = {}) {
    if (!validateBranchName(branch)) {
        // CA-12 — sin llamar a la API: el ref deforme no viaja.
        return { ok: false, required: [], cause: 'branch-fuera-de-forma' };
    }
    const res = runGhSafe(
        ghImpl,
        ['api', `repos/{owner}/{repo}/rules/branches/${branch.trim()}`],
        cwd,
    );
    if (!res.ok) return { ok: false, required: [], cause: `ruleset-ilegible:${res.cause}` };
    const rules = res.parsed;
    if (!Array.isArray(rules)) return { ok: false, required: [], cause: 'ruleset-forma-inesperada' };

    // Union de TODAS las reglas de tipo `required_status_checks`: un repo puede
    // tener varias reglas aplicando sobre la misma rama y cada una aporta sus
    // contextos. Quedarse con la primera dejaria requeridos afuera, y un
    // requerido no visto se leeria como "no existe" => fail-open.
    const required = [];
    const vistos = new Set();
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.type !== 'required_status_checks') continue;
        const params = rule.parameters;
        if (!params || typeof params !== 'object') continue;
        const lista = params.required_status_checks;
        if (!Array.isArray(lista)) continue;
        for (const item of lista) {
            if (!item || typeof item !== 'object') continue;
            const context = typeof item.context === 'string' ? item.context.trim() : '';
            if (!context) continue;
            // `integration_id` ausente es legitimo (check sin app asociada) y se
            // representa como `null`, no como `0` ni como `undefined`: el cotejo
            // de SEC-2 distingue "no exige app" de "exige la app 0".
            const integrationId = Number.isInteger(item.integration_id) ? item.integration_id : null;
            const key = `${context} ${integrationId}`;
            if (vistos.has(key)) continue;
            vistos.add(key);
            required.push({ context, integration_id: integrationId });
        }
    }
    if (!required.length) {
        return { ok: false, required: [], cause: 'ruleset-sin-requeridos' };
    }
    return { ok: true, required, cause: null };
}

const ROLLUP_QUERY = [
    'query($owner:String!,$name:String!,$number:Int!){',
    ' repository(owner:$owner,name:$name){ pullRequest(number:$number){',
    '  commits(last:1){ nodes{ commit{ oid',
    `   statusCheckRollup{ contexts(first:${ROLLUP_PAGE_SIZE}){ totalCount nodes{`,
    '    __typename',
    '    ... on CheckRun      { name status conclusion checkSuite{ app{ databaseId slug } } }',
    '    ... on StatusContext { context state }',
    '   }}}',
    '  }}}',
    ' }}}',
].join('\n');

// ---------------------------------------------------------------------------
// fetchRollupWithApps — IMPURA #2: rollup + app + oid, en UNA sola lectura
// ---------------------------------------------------------------------------
//
// A-R8/G5 — Una sola query GraphQL en vez de dos REST. El motivo es atomico, no
// de performance: leer el rollup y el head en momentos distintos reabre la
// ventana TOCTOU que #5420 cerro (leo checks -> alguien pushea -> clasifico con
// los checks del commit viejo). Aca `oid`, `contexts` y `totalCount` salen del
// MISMO snapshot del servidor, y la regla 4 del clasificador coteja ese `oid`
// contra el head sobre el que se evaluaron los gates.
//
// `owner`/`name` los pone el llamador desde su constante de repo esperado
// (`EXPECTED_PR_REPO`), jamas un campo devuelto por GitHub.
// Sin dependencias npm (CA-22): `gh api graphql` es el mismo binario que ya usa
// todo el pipeline (precedente en `lib/product-seed.js`).
function fetchRollupWithApps({ prNumber, ghImpl = gitOps.runGh, cwd, repo } = {}) {
    const n = Number(prNumber);
    if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, oid: null, contexts: null, totalCount: null, cause: 'pr-invalido' };
    }
    const slug = typeof repo === 'string' ? repo.trim() : '';
    const m = slug.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    if (!m) {
        return { ok: false, oid: null, contexts: null, totalCount: null, cause: 'repo-fuera-de-forma' };
    }
    const res = runGhSafe(
        ghImpl,
        [
            'api', 'graphql',
            '-f', `query=${ROLLUP_QUERY}`,
            '-F', `owner=${m[1]}`,
            '-F', `name=${m[2]}`,
            '-F', `number=${n}`,
        ],
        cwd,
    );
    if (!res.ok) return { ok: false, oid: null, contexts: null, totalCount: null, cause: `rollup-ilegible:${res.cause}` };

    // Navegacion defensiva: cualquier nivel ausente es "no lei" (contexts:null),
    // NUNCA "el rollup esta vacio" (contexts:[]). La diferencia decide si el
    // clasificador va a `unusable` o a `pending`.
    const nodes = res.parsed
        && res.parsed.data
        && res.parsed.data.repository
        && res.parsed.data.repository.pullRequest
        && res.parsed.data.repository.pullRequest.commits
        && res.parsed.data.repository.pullRequest.commits.nodes;
    if (!Array.isArray(nodes) || !nodes.length) {
        return { ok: false, oid: null, contexts: null, totalCount: null, cause: 'rollup-forma-inesperada' };
    }
    const commit = nodes[0] && nodes[0].commit;
    if (!commit || typeof commit !== 'object') {
        return { ok: false, oid: null, contexts: null, totalCount: null, cause: 'rollup-forma-inesperada' };
    }
    const oid = typeof commit.oid === 'string' && commit.oid.trim() ? commit.oid.trim() : null;
    const scr = commit.statusCheckRollup;
    // `statusCheckRollup: null` es la respuesta REAL de GitHub cuando el commit
    // todavia no tiene NINGUN check instanciado. Eso es "lei y esta vacio" —
    // exactamente la ventana ciega del episodio — asi que va como `[]`/`0`, no
    // como "no lei".
    if (scr === null || scr === undefined) {
        return { ok: true, oid, contexts: [], totalCount: 0, cause: null };
    }
    const ctxs = scr && scr.contexts;
    if (!ctxs || typeof ctxs !== 'object' || !Array.isArray(ctxs.nodes) || !Number.isInteger(ctxs.totalCount)) {
        return { ok: false, oid, contexts: null, totalCount: null, cause: 'rollup-forma-inesperada' };
    }
    return { ok: true, oid, contexts: ctxs.nodes, totalCount: ctxs.totalCount, cause: null };
}

function upper(v) {
    return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// Estado de UN contexto del rollup ya matcheado con su requerido.
// Devuelve 'failing' | 'pending' | 'green' | 'unusable'.
//
// El orden importa: primero rojo, despues pendiente, despues verde. Un valor
// que no cae en ninguno de los tres enums NO es verde por descarte — es
// `unusable` (SEC-8/CA-21). Tratarlo como verde seria fail-open sobre un estado
// que nadie entendio.
function classifyContextState(node) {
    if (!node || typeof node !== 'object') return 'unusable';
    const conclusion = upper(node.conclusion);
    const status = upper(node.status);
    const state = upper(node.state);

    if (CHECK_FAIL_CONCLUSIONS.includes(conclusion) || CHECK_FAIL_STATES.includes(state)) return 'failing';
    if (CHECK_PENDING_STATUSES.includes(status) || CHECK_PENDING_STATES.includes(state)) return 'pending';
    if (CHECK_GREEN_CONCLUSIONS.includes(conclusion) || CHECK_GREEN_STATES.includes(state)) return 'green';
    // `CheckRun` con `status: COMPLETED` y `conclusion: null` cae aca: completo
    // sin decir como. No es verde.
    return 'unusable';
}

// ---------------------------------------------------------------------------
// classifyRequiredChecks — PURA. El veredicto.
// ---------------------------------------------------------------------------
//
// Orden ESTRICTO: la primera regla que aplica corta. Cada borde es fail-closed
// (`unusable`), y `unusable` rio abajo significa `gate-block` — o sea, el
// comportamiento de HOY. El unico veredicto que relaja algo es `pending`, y se
// emite solo con evidencia positiva de que un requerido conocido todavia no
// reporto.
//
//   1. `required` invalido / vacio            -> unusable (SEC-1)
//   2. `rollup === null` (no leido)           -> unusable    `[]` NO entra aca
//   3. `contexts.length !== totalCount`       -> unusable (A-R5, truncamiento)
//   4. `oid !== headRefOid`                   -> unusable (A-R8, TOCTOU)
//   5. por cada requerido, sub-reglas         -> failing | pending | green | unusable
//   6. algun requerido unusable               -> unusable
//   7. algun requerido failing                -> blocking
//   8. algun requerido pending                -> pending
//   9. todos green                            -> green
//
// `reviewDecision` / `reviewDecisionRead` se reciben SOLO para el `detalle` del
// log: la decision de review pertenece al clasificador de `delivery.js`, que la
// evalua ANTES que a los checks (regla 1 y 2 de su orden estricto). Meterla aca
// crearia dos maquinas para la misma decision, que es el defecto que G3 marco.
function classifyRequiredChecks({
    required,
    rollup,
    totalCount,
    oid,
    headRefOid,
    reviewDecision = null,
    reviewDecisionRead = null,
} = {}) {
    const base = {
        pending: [], failing: [], green: [], detalle: [],
        reviewDecision: reviewDecision || null,
        reviewDecisionRead: reviewDecisionRead === true,
    };
    const out = (verdict, cause, extra = {}) => ({ ...base, ...extra, verdict, cause });

    // Regla 1 — sin lista de requeridos no hay nada que afirmar.
    // Acepta tanto el `{ok, required}` de `fetchRequiredContexts` como el array pelado.
    let lista = required;
    if (lista && typeof lista === 'object' && !Array.isArray(lista)) {
        if (lista.ok !== true) {
            return out('unusable', typeof lista.cause === 'string' && lista.cause ? lista.cause : 'ruleset-ilegible');
        }
        lista = lista.required;
    }
    if (!Array.isArray(lista) || lista.length === 0) {
        return out('unusable', 'ruleset-sin-requeridos');
    }

    // Regla 2 — `null` = no lei. `[]` = lei y esta vacio, y SIGUE de largo:
    // un rollup vacio con requeridos conocidos es justamente el caso del
    // episodio y termina en `pending` por la sub-regla de "0 candidatos".
    if (rollup === null || rollup === undefined || !Array.isArray(rollup)) {
        return out('unusable', 'rollup-no-leido');
    }

    // Regla 3 — A-R5, el peor fail-open del fix: un requerido EN ROJO fuera de
    // pagina se leeria como "ausente" y la regla de ausencia lo convertiria en
    // "pendiente" — un check fallando clasificado como carrera de CI.
    if (!Number.isInteger(totalCount) || rollup.length !== totalCount) {
        return out('unusable', 'truncamiento');
    }

    // Regla 4 — el head se movio entre la lectura de los gates y la del rollup:
    // estos checks son de OTRO arbol. Clasificar con ellos seria mergear con
    // evidencia de un commit que ya no es el que se va a mergear.
    if (oid && headRefOid && String(oid) !== String(headRefOid)) {
        return out('unusable', 'head-movido-entre-lecturas');
    }

    const pending = [];
    const failing = [];
    const green = [];
    const detalle = [];
    let unusableCause = null;

    for (const req of lista) {
        if (!req || typeof req !== 'object' || typeof req.context !== 'string' || !req.context.trim()) {
            unusableCause = unusableCause || 'requerido-forma-inesperada';
            continue;
        }
        const context = req.context.trim();
        const integrationId = Number.isInteger(req.integration_id) ? req.integration_id : null;

        const candidatos = rollup.filter((n) => n && typeof n === 'object'
            && (n.name === context || n.context === context));

        // 0 candidatos => PENDIENTE. Este es el delta entero de #6431: la
        // ausencia se afirma contra la lista del ruleset, no contra el vacio del
        // rollup. Es el caso del episodio (rollup `[]` a t+4 s).
        if (!candidatos.length) {
            pending.push(context);
            detalle.push({ context, integration_id: integrationId, estado: 'AUSENTE' });
            continue;
        }

        // SEC-2/SEC-9.6/CA-7 — Cotejo de app. Un contexto HOMONIMO publicado por
        // otra app no satisface el requerido: cualquiera con una GitHub App
        // instalada podria publicar un `pr-status` verde y saltearse el gate.
        //
        // OJO: `checkSuite.app.databaseId` — el entero. NUNCA `app.id`, que es el
        // node ID opaco (`"MDM6QXBwMTUzNjg="`): compararlo contra un
        // `integration_id` numerico da falso negativo PERMANENTE y convierte el
        // fix entero en un no-op con los tests en verde (A-R1, el riesgo
        // dominante — las fixtures son a mano y no lo atrapan solas).
        let matches = candidatos;
        if (integrationId !== null) {
            matches = candidatos.filter((n) => {
                const app = n.checkSuite && n.checkSuite.app;
                return app && Number.isInteger(app.databaseId) && app.databaseId === integrationId;
            });
        }
        if (!matches.length) {
            // Hay algo con ese nombre pero no es de la app requerida (o no trae
            // app legible). No cuenta como verde NI como ausente: si contara
            // como ausente, esperariamos para siempre por un check que ya
            // reporto; si contara como verde, seria el bypass de SEC-2.
            unusableCause = unusableCause || 'homonimo-sin-app-coincidente';
            detalle.push({ context, integration_id: integrationId, estado: 'HOMONIMO-SIN-APP' });
            continue;
        }

        const estados = matches.map(classifyContextState);
        const estadoObservado = upper(matches[0].conclusion) || upper(matches[0].status) || upper(matches[0].state) || 'SIN-ESTADO';
        detalle.push({ context, integration_id: integrationId, estado: estadoObservado });

        if (estados.includes('unusable')) {
            unusableCause = unusableCause || 'estado-fuera-de-enum';
        } else if (estados.includes('failing')) {
            failing.push(context);
        } else if (estados.includes('pending')) {
            pending.push(context);
        } else {
            green.push(context);
        }
    }

    const res = {
        pending, failing, green, detalle,
        reviewDecision: reviewDecision || null,
        reviewDecisionRead: reviewDecisionRead === true,
    };
    // Reglas 6->9, en ese orden. `unusable` gana sobre todo: si UN requerido no
    // se pudo evaluar, el veredicto del conjunto no es afirmable.
    if (unusableCause) return { ...res, verdict: 'unusable', cause: unusableCause };
    if (failing.length) return { ...res, verdict: 'blocking', cause: 'check-en-rojo' };
    if (pending.length) return { ...res, verdict: 'pending', cause: 'checks-sin-reportar' };
    return { ...res, verdict: 'green', cause: 'todos-verdes' };
}

// ---------------------------------------------------------------------------
// createRequiredChecksReader — encadena las dos impuras + la pura
// ---------------------------------------------------------------------------
//
// SEC-7/D4 — Cachea SOLO la lectura OK del ruleset, y solo por invocacion del
// reader. El rollup NO se cachea nunca: es justo lo que cambia entre esperas, y
// cachearlo haria que las 7 esperas reclasifiquen el mismo dato viejo y el fix
// no converja jamas. Una lectura FALLIDA del ruleset tampoco se cachea: si
// fallo por rate limit, el reintento siguiente tiene que poder leerlo.
function createRequiredChecksReader({ ghImpl = gitOps.runGh, cwd, repo, baseBranch } = {}) {
    let rulesetCache = null;

    return function read({ prNumber, headRefOid } = {}) {
        const logLines = [];
        if (!rulesetCache || rulesetCache.ok !== true) {
            rulesetCache = fetchRequiredContexts({ branch: baseBranch, ghImpl, cwd });
        }
        const ruleset = rulesetCache;
        if (ruleset.ok !== true) {
            // A-R6/CA-20 — La desactivacion NUNCA es muda: si el fix se apaga
            // solo (403, rate limit, gh viejo), queda dicho por que.
            logLines.push(`[delivery] gate merge: no se pudo leer la lista de checks requeridos del ruleset (${ruleset.cause}) — se mantiene el bloqueo fail-closed`);
            rulesetCache = null;  // no cachear el fallo: se reintenta la proxima vuelta
            return {
                verdict: 'unusable', cause: ruleset.cause, pending: [], failing: [], green: [], detalle: [], logLines,
            };
        }

        const rollup = fetchRollupWithApps({ prNumber, ghImpl, cwd, repo });
        if (rollup.ok !== true) {
            logLines.push(`[delivery] gate merge: no se pudo leer el estado de los checks del PR (${rollup.cause}) — se mantiene el bloqueo fail-closed`);
            return {
                verdict: 'unusable', cause: rollup.cause, pending: [], failing: [], green: [], detalle: [], logLines,
            };
        }

        const veredicto = classifyRequiredChecks({
            required: ruleset.required,
            rollup: rollup.contexts,
            totalCount: rollup.totalCount,
            oid: rollup.oid,
            headRefOid,
        });

        // SEC-8/C4 — Solo contexto, app id y estado. Nunca el JSON del ruleset.
        const resumen = (veredicto.detalle || [])
            .map((d) => `${d.context} (app ${d.integration_id === null ? 'n/a' : d.integration_id}): ${d.estado}`)
            .join(', ');
        logLines.push(`[delivery] gate merge: requeridos leidos del ruleset — ${resumen || 'sin contextos'}`);

        return {
            verdict: veredicto.verdict,
            cause: veredicto.cause,
            pending: veredicto.pending,
            failing: veredicto.failing,
            green: veredicto.green,
            detalle: veredicto.detalle,
            logLines,
        };
    };
}

module.exports = {
    fetchRequiredContexts,
    fetchRollupWithApps,
    classifyRequiredChecks,
    validateBranchName,
    createRequiredChecksReader,
    REQUIRED_CHECKS_VERDICTS,
    CHECK_GREEN_CONCLUSIONS,
    CHECK_GREEN_STATES,
    _internal: { classifyContextState, ROLLUP_QUERY },
};
