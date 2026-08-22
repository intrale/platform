'use strict';

// =============================================================================
// doc-create.js — Creación determinística de issues desde el Telegram Commander
// (issue #3819).
//
// CONTEXTO / CAUSA RAÍZ
// ---------------------
// El flujo previo de creación de issues por Telegram delegaba en el skill
// `/doc` invocado por el LLM (Claude) vía la Skill tool dentro de
// `ejecutarClaude` (pulpo.js). El cuelgue reportado (2026-06-04, ElevenLabs)
// encaja con el estado `launching_no_complete`: el LLM ANUNCIA que va a
// invocar `/doc` ("analizando y procesando…") pero NUNCA emite el evento
// `tool_use`. El watchdog de 60s sólo arma el reloj cuando aparece el
// `tool_use:Skill` (pulpo.js `pendingSkillCalls.set(...)`), así que en ese
// estado el watchdog jamás dispara y sólo corta el HARD_TIMEOUT de 10 min,
// percibido como cuelgue silencioso.
//
// SOLUCIÓN (Opción B del issue)
// -----------------------------
// Este módulo arma la "ficha" del issue de forma 100% determinística — sin
// spawnear ningún LLM anidado en runtime — por lo que NO HAY NADA QUE SE PUEDA
// COLGAR. Cada subproceso `gh` corre con timeout duro acotado. El resultado es
// siempre uno de dos estados explícitos: issue creado (con labels base,
// assignee, Project V2, audit log) o error reportado — nunca un cuelgue.
//
// La detección de intent, sanitización (SEC-3), allowlist de sender (SEC-1/2),
// el audit log JSONL (SEC-4) y el enum cerrado `skill_result` se reusan de
// `issue-creation.js`. La detección de duplicados se reusa de
// `duplicate-detector.js`. El alta en Project V2 se reusa de
// `.claude/hooks/add-to-project-status.js`.
//
// SEGURIDAD
// - Todo subproceso usa `execFileSync` con argv array (JAMÁS shell-concat) +
//   timeout duro. No hay interpolación de input del operador en una shell.
// - El input ya viene sanitizado (SEC-3) desde el caller; igual re-sanitizamos
//   defensivamente acá para que el módulo sea seguro si se invoca directo.
// - El título y body se derivan del texto plano; `gh` los recibe como argv,
//   por lo que no hay riesgo de inyección de flags (usamos `--` y campos
//   explícitos).
// =============================================================================

const path = require('path');
const { execFileSync } = require('child_process');

const issueCreation = require('./issue-creation');

// Timeout duro por subproceso `gh`/node (ms). Acotado para que el camino
// completo nunca supere ~3x este valor. Configurable por env para entornos
// lentos (CI), pero con piso defensivo.
const GH_TIMEOUT_MS = Math.max(
    5000,
    Number(process.env.COMMANDER_DOC_GH_TIMEOUT_MS) || 30000
);

const REPO = process.env.COMMANDER_DOC_REPO || 'intrale/platform';
const ASSIGNEE = 'leitolarreta';

// -----------------------------------------------------------------------------
// Inferencia determinística de labels
// -----------------------------------------------------------------------------

// Mapa keyword → area. El primer match (en orden) gana. Si nada matchea se usa
// `DEFAULT_AREA`. La fase de definición del pipeline puede re-etiquetar: por
// eso el issue se crea con `needs-definition` (ver inferAdmission).
const AREA_KEYWORDS = [
    ['area:pipeline', /\b(pipeline|pulpo|dashboard|commander|watchdog|hook|rebote|intake|outtake|worktree)\b/i],
    ['area:infra', /\b(infra|infraestructura|ci\/?cd|github actions|deploy|build|gradle|aws|lambda|cognito|dynamo)\b/i],
    ['area:pagos', /\b(pago|pagos|checkout|cobro|tarjeta|mercado\s?pago)\b/i],
    ['area:productos', /\b(producto|productos|catálogo|catalogo)\b/i],
    ['area:pedidos', /\b(pedido|pedidos|orden|ordenes|órdenes)\b/i],
    ['area:carrito', /\b(carrito|cart)\b/i],
    ['area:delivery', /\b(delivery|reparto|repartidor|envío|envio)\b/i],
    ['area:seguridad', /\b(seguridad|2fa|autenticaci[oó]n|login|permiso|permisos|token|jwt)\b/i],
    ['area:notificaciones', /\b(notificaci[oó]n|notificaciones|push)\b/i],
    ['area:perfil', /\b(perfil|profile)\b/i],
    ['area:onboarding', /\b(onboarding|registro|alta de usuario)\b/i],
    ['area:direcciones', /\b(direcci[oó]n|direcciones)\b/i],
    ['area:ubicacion', /\b(ubicaci[oó]n|geolocalizaci[oó]n|mapa|mapas)\b/i],
    ['area:comunicacion', /\b(chat|mensajer[ií]a|comunicaci[oó]n)\b/i],
    ['area:configuracion', /\b(configuraci[oó]n|settings|ajustes)\b/i],
    ['area:dashboard', /\b(panel|dashboard del negocio)\b/i],
];

// Área por defecto cuando ningún keyword matchea. La fase de definición
// re-etiqueta; `area:infra` es el contenedor más neutro para pedidos del
// operador (la mayoría toca tooling/infra).
const DEFAULT_AREA = 'area:infra';

const APP_KEYWORDS = [
    ['app:client', /\b(cliente|consumidor|comprador|usuario final|app cliente)\b/i],
    ['app:business', /\b(negocio|comercio|business|vendedor|app negocios?)\b/i],
    ['app:delivery', /\b(repartidor|delivery|reparto|app repartos?)\b/i],
];

const BUG_RE = /\b(bug|error|falla|fallo|crash|roto|rota|no funciona|no anda|se cuelga|se rompe|arreglar|fix(?:ear)?)\b/i;

const PRIORITY_HIGH_RE = /\b(urgente|cr[ií]tico|cr[ií]tica|bloqueante|importante|prioridad alta)\b/i;
const PRIORITY_LOW_RE = /\b(menor|nice to have|cuando puedas|baja prioridad|sin apuro)\b/i;

const SIZE_SMALL_RE = /\b(simple|chico|chica|peque[ñn]o|peque[ñn]a|trivial|r[aá]pido|menor)\b/i;
const SIZE_LARGE_RE = /\b(épico|epico|grande|complejo|compleja|refactor masivo|multi-?m[oó]dulo)\b/i;

// "Ready" sólo si el operador lo dice explícito; default `needs-definition`
// para que la fase de definición lo enriquezca (codebase analysis, PO/UX/QA).
const READY_RE = /\b(ya est[aá] listo|listo para (?:dev|desarrollo|implementar)|ready|sin definici[oó]n necesaria)\b/i;

/**
 * Infiere las labels base de forma determinística a partir del texto libre.
 * Garantiza SIEMPRE: un `area:*`, una `priority:*`, un `size:*`,
 * `bug|enhancement` y `needs-definition|Ready` (los 5 requeridos por el CA).
 *
 * @param {string} text  Descripción libre del pedido (ya sanitizada).
 * @returns {{ labels: string[], area: string, app: string[], type: string,
 *             priority: string, size: string, admission: string }}
 */
function inferLabels(text) {
    const t = String(text || '');

    let area = DEFAULT_AREA;
    for (const [label, re] of AREA_KEYWORDS) {
        if (re.test(t)) { area = label; break; }
    }

    const app = [];
    for (const [label, re] of APP_KEYWORDS) {
        if (re.test(t)) app.push(label);
    }

    const type = BUG_RE.test(t) ? 'bug' : 'enhancement';

    let priority = 'priority:medium';
    if (PRIORITY_HIGH_RE.test(t)) priority = 'priority:high';
    else if (PRIORITY_LOW_RE.test(t)) priority = 'priority:low';

    let size = 'size:medium';
    if (SIZE_LARGE_RE.test(t)) size = 'size:large';
    else if (SIZE_SMALL_RE.test(t)) size = 'size:small';

    const admission = READY_RE.test(t) ? 'Ready' : 'needs-definition';

    // Orden estable y sin duplicados.
    const labels = [area, ...app, type, priority, size, admission];
    return {
        labels: [...new Set(labels)],
        area,
        app,
        type,
        priority,
        size,
        admission,
    };
}

// -----------------------------------------------------------------------------
// Derivación de título y body estandarizado
// -----------------------------------------------------------------------------

const MAX_TITLE_LEN = 80;

/**
 * Deriva un título conciso a partir del texto libre: primera oración / línea,
 * sin verbos imperativos de pedido al inicio ("creá un issue para…"), capada a
 * MAX_TITLE_LEN. Nunca vacío.
 *
 * @param {string} text
 * @returns {string}
 */
function deriveTitle(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();

    // Sacar el preámbulo de pedido ("creá un issue para/de", "levantá una
    // historia de", "hace falta un ticket de", etc.) para que el título sea el
    // QUÉ, no el pedido.
    t = t.replace(
        /^(?:cre[aá](?:me)?|lev[aá]nt[aá]|hace falta|necesito|arm[aá]|abr[ií]|generá|genera)\s+(?:un[ao]?\s+)?(?:issue|historia|ticket|tarea|bug|tarjeta)\s+(?:para|de|que|sobre|:)?\s*/i,
        ''
    );

    // Primera oración (corte en . ! ? o salto de línea). Sacamos la
    // puntuación final para que el título no termine en punto.
    const firstSentence = t.split(/(?<=[.!?])\s|\n/)[0] || t;
    let title = (firstSentence.trim() || t).replace(/[.!?]+$/, '').trim();

    if (title.length > MAX_TITLE_LEN) {
        title = title.slice(0, MAX_TITLE_LEN - 1).replace(/\s+\S*$/, '').trim() + '…';
    }
    // Capitalizar la primera letra.
    if (title.length > 0) title = title[0].toUpperCase() + title.slice(1);
    // Fallback final defensivo (no debería ocurrir tras sanitización).
    return title || 'Nuevo issue creado desde Telegram';
}

/**
 * Arma el body estandarizado. Como el camino determinístico NO analiza el
 * codebase (eso lo hace la fase de definición del pipeline), las secciones de
 * detalle quedan marcadas como "pendiente de definición" — preservando la
 * estructura estándar que aporta `/doc` pero sin inventar contenido.
 *
 * @param {object} args
 * @param {string} args.description  Texto libre original (sanitizado).
 * @param {string} args.from         Quién lo pidió (para trazabilidad).
 * @param {string[]} args.labels     Labels inferidas (para la nota técnica).
 * @returns {string}
 */
function buildBody({ description, from, labels }) {
    const desc = String(description || '').trim();
    const who = from ? String(from) : 'el operador';
    const labelList = (labels || []).map((l) => `\`${l}\``).join(', ');

    return [
        '## Objetivo',
        '',
        desc,
        '',
        '## Contexto',
        '',
        `Issue creado desde el Telegram Commander (camino determinístico, issue #3819) a pedido de ${who}.`,
        'Las secciones de detalle técnico se completan en la fase de definición del pipeline',
        '(análisis de codebase, criterios PO/UX/QA, escenarios Gherkin).',
        '',
        '## Cambios requeridos',
        '',
        '_Pendiente de definición — la fase de definición del pipeline completa los archivos/módulos afectados._',
        '',
        '## Criterios de aceptación',
        '',
        '- [ ] _Pendiente de definición._',
        '',
        '## Notas técnicas',
        '',
        `Labels base asignadas automáticamente: ${labelList || '_ninguna_'}.`,
        'Creado por el módulo determinístico `doc-create.js` (sin LLM en runtime) para garantizar cero cuelgues.',
        '',
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Backlog destino en Project V2 según labels de app
// -----------------------------------------------------------------------------

function resolveBacklog(app) {
    if (Array.isArray(app)) {
        if (app.includes('app:client')) return 'Backlog CLIENTE';
        if (app.includes('app:business')) return 'Backlog NEGOCIO';
        if (app.includes('app:delivery')) return 'Backlog DELIVERY';
    }
    return 'Backlog Tecnico';
}

// -----------------------------------------------------------------------------
// Runners por defecto (inyectables para test)
// -----------------------------------------------------------------------------

function _defaultGhCreate({ title, body, labels, repo, ghPath }) {
    const args = [
        'issue', 'create',
        '--repo', repo,
        '--title', title,
        '--body', body,
        '--label', labels.join(','),
        '--assignee', ASSIGNEE,
    ];
    const out = execFileSync(ghPath || 'gh', args, {
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    // `gh issue create` imprime la URL del issue creado.
    const url = String(out).trim().split('\n').pop().trim();
    const m = /\/issues\/(\d+)/.exec(url);
    return { url, issueNumber: m ? Number(m[1]) : null };
}

function _defaultAddToProject({ issueNumber, backlog }) {
    const script = path.join(
        __dirname, '..', '..', '..', '.claude', 'hooks', 'add-to-project-status.js'
    );
    const out = execFileSync(process.execPath, [script, String(issueNumber), backlog], {
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    return JSON.parse(String(out).trim().split('\n').pop());
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Crea un issue de forma determinística (sin LLM). NUNCA se cuelga: cada
 * subproceso tiene timeout duro y cualquier excepción se mapea a
 * `{ status: 'error' }`. Siempre escribe una línea de audit log.
 *
 * @param {object} args
 * @param {string} args.description       Texto libre del pedido (será sanitizado).
 * @param {object|string} [args.from]     Sender (id/username) para audit + trazabilidad.
 * @param {string} args.pipelineDir       Dir del pipeline (para el audit JSONL).
 * @param {boolean} [args.force]          Forzar creación aunque haya duplicado.
 * @param {string} [args.ghPath]          Path al binario gh.
 * @param {string} [args.repo]            Repo override (default intrale/platform).
 *
 * Inyectables para test:
 * @param {function} [args.runDuplicateCheck]  (title, body) => Promise<{level,score,topMatch,matches}>|{hasDuplicate,matches}
 * @param {function} [args.runGhCreate]        ({title,body,labels,repo,ghPath}) => {url,issueNumber}
 * @param {function} [args.runAddToProject]    ({issueNumber,backlog}) => result
 * @param {function} [args.logAudit]           (entry, opts) => void
 * @param {function} [args.now]                () => epoch ms
 * @param {function} [args.log]                (tag, msg) => void
 *
 * @returns {Promise<{ status: 'created'|'duplicate'|'error',
 *             issueNumber?: number, url?: string, title?: string,
 *             labels?: string[], backlog?: string, matches?: object[],
 *             topMatch?: object, partialDuplicate?: object,
 *             error?: string, durationMs: number }>}
 */
async function createIssue(args = {}) {
    const log = typeof args.log === 'function' ? args.log : () => {};
    const now = typeof args.now === 'function' ? args.now : () => Date.now();
    const logAudit = typeof args.logAudit === 'function'
        ? args.logAudit
        : (entry, opts) => issueCreation.logSkillInvocation(entry, opts);

    const startedAt = now();
    const fromObj = (args.from && typeof args.from === 'object') ? args.from : undefined;

    // SEC-3 defensivo: re-sanitizar el input aunque el caller ya lo haya hecho.
    const san = issueCreation.sanitizeIssueCreationInput(String(args.description || ''));
    const description = san.sanitized;

    const audit = (extra) => {
        try {
            logAudit({
                pipelineDir: args.pipelineDir,
                from: fromObj,
                inputText: args.description,
                inputTextTruncated: !!san.truncated,
                skillInvoked: 'doc',
                provider: 'anthropic',
                intent: issueCreation.INTENT_CREATE_SIMPLE,
                senderAllowed: true,
                durationMs: now() - startedAt,
                ...extra,
            }, { log });
        } catch (e) {
            log('commander', `doc-create audit log falló (best-effort): ${e.message}`);
        }
    };

    // Guard: descripción vacía tras sanitizar.
    if (!description || description.trim().length === 0) {
        audit({
            skillResult: issueCreation.SKILL_RESULT_INVALID_ARGS,
            error: 'descripcion_vacia',
        });
        return { status: 'error', error: 'descripcion_vacia', durationMs: now() - startedAt };
    }

    const title = deriveTitle(description);
    const inferred = inferLabels(description);
    const labels = inferred.labels;
    const body = buildBody({ description, from: fromObj && (fromObj.username || fromObj.id), labels });
    const backlog = resolveBacklog(inferred.app);
    const repo = args.repo || REPO;

    // --- Detección de duplicados semántica (#4110: swap a semantic-dedup) ---
    // CA-2: este es uno de los 4 puntos de entrada que invocan el MISMO service
    // (`semantic-dedup.checkSemanticDuplicate`). El service es async y razona por
    // `level` ('alta'|'parcial'|'ninguna'), no por `hasDuplicate`.
    let partialDup = null;
    if (!args.force) {
        try {
            // `runDuplicateCheck` queda inyectable (tests/regresión). El default
            // ahora es el service semántico, async, con firma (title, body).
            const dupFn = typeof args.runDuplicateCheck === 'function'
                ? args.runDuplicateCheck
                : (t, b) => require('../semantic-dedup').checkSemanticDuplicate(t, b, { limit: 50 });
            // `await` tolera tanto el service async como inyecciones síncronas
            // de los tests (un valor no-promesa se resuelve igual).
            const dup = await dupFn(title, body);
            // Retrocompat: si la inyección vieja devuelve `{hasDuplicate}` sin
            // `level`, lo mapeamos a 'alta'/'ninguna' (CA-3 conserva el contrato).
            const level = dup
                ? (dup.level || (dup.hasDuplicate ? 'alta' : 'ninguna'))
                : 'ninguna';
            if (level === 'alta') {
                // CA-3: similitud alta → NO se crea, se comunica el vínculo al
                // existente (consistente con formatDuplicateAlert: nivel + score %).
                log('commander', `doc-create: duplicado semántico (alta) de "${title}" — no se crea`);
                audit({
                    skillResult: issueCreation.SKILL_RESULT_BLOCKED,
                    error: 'duplicate_detected',
                });
                return {
                    status: 'duplicate',
                    title,
                    matches: dup.matches || [],
                    topMatch: dup.topMatch || null,
                    score: typeof dup.score === 'number' ? dup.score : undefined,
                    durationMs: now() - startedAt,
                };
            }
            if (level === 'parcial') {
                // CA-4: similitud parcial → NO se bloquea la creación; se anota el
                // ajuste para comunicar qué se solapa y por qué se creó igual.
                partialDup = {
                    matches: dup.matches || [],
                    topMatch: dup.topMatch || null,
                    score: typeof dup.score === 'number' ? dup.score : undefined,
                };
                log('commander', `doc-create: duplicado semántico (parcial) de "${title}" — se crea con aviso`);
            }
            // level === 'ninguna' → flujo normal sin interrupciones.
        } catch (e) {
            // A04 (fail-open en dirección NO destructiva): la detección de
            // duplicados NUNCA bloquea la creación. Si el service falla (sin red,
            // gh caído, circuit-breaker), seguimos adelante y lo dejamos en audit.
            log('commander', `doc-create: dup-check falló (no bloquea, fail-open): ${e.message}`);
        }
    }

    // --- Creación del issue (gh, con timeout duro) ---
    let created;
    try {
        const createFn = typeof args.runGhCreate === 'function'
            ? args.runGhCreate
            : _defaultGhCreate;
        created = createFn({ title, body, labels, repo, ghPath: args.ghPath });
    } catch (e) {
        log('commander', `doc-create: gh issue create falló: ${e.message}`);
        audit({
            skillResult: issueCreation.SKILL_RESULT_ERROR,
            error: `gh_create_failed:${e.message}`,
        });
        return { status: 'error', error: `gh_create_failed:${e.message}`, durationMs: now() - startedAt };
    }

    if (!created || !created.issueNumber) {
        audit({
            skillResult: issueCreation.SKILL_RESULT_SKILL_FAILED,
            error: 'gh_create_no_issue_number',
        });
        return {
            status: 'error',
            error: 'gh_create_no_issue_number',
            url: created && created.url,
            durationMs: now() - startedAt,
        };
    }

    // --- Alta en Project V2 (best-effort: no invalida la creación) ---
    let projectOk = false;
    try {
        const addFn = typeof args.runAddToProject === 'function'
            ? args.runAddToProject
            : _defaultAddToProject;
        const res = addFn({ issueNumber: created.issueNumber, backlog });
        projectOk = !!(res && (res.status === 'ok' || res.itemId));
    } catch (e) {
        log('commander', `doc-create: alta en Project V2 falló (best-effort): ${e.message}`);
    }

    audit({
        skillResult: issueCreation.SKILL_RESULT_SUCCESS,
        issueCreated: created.issueNumber,
    });

    return {
        status: 'created',
        issueNumber: created.issueNumber,
        url: created.url,
        title,
        labels,
        backlog,
        projectAdded: projectOk,
        // CA-4: si hubo solapamiento parcial, se informa junto a la creación.
        partialDuplicate: partialDup || undefined,
        durationMs: now() - startedAt,
    };
}

/**
 * Deriva el sufijo " (similitud X%)" para un match. El service semántico no
 * pone `score` en `topMatch`, así que cae al `score` top-level del resultado.
 * Copy operador-facing sin jerga interna (G1): nunca "Jaccard"/"LLM-judge".
 *
 * @param {object} item — match con `score` opcional.
 * @param {number} [fallbackScore] — score top-level del resultado.
 * @returns {string} sufijo formateado o '' si no hay score utilizable.
 */
function matchPercent(item, fallbackScore) {
    const raw = (item && typeof item.score === 'number') ? item.score
        : (typeof fallbackScore === 'number' ? fallbackScore : null);
    if (raw == null || !Number.isFinite(raw)) return '';
    return ` (similitud ${(raw * 100).toFixed(0)}%)`;
}

/**
 * Formatea el mensaje a Telegram según el resultado de `createIssue`. Siempre
 * devuelve un string accionable — nunca vacío.
 */
function formatResultMessage(result) {
    if (!result || typeof result !== 'object') {
        return '❌ No pude procesar la creación del issue. Reintentá en un momento.';
    }
    switch (result.status) {
        case 'created': {
            const proj = result.projectAdded ? '' : '\n⚠️ No pude agregarlo al Project V2 — revisalo manual.';
            // CA-4: solapamiento parcial → se creó igual, pero se avisa con qué
            // se cruza (copy sin jerga: "similitud X%", G1).
            let partial = '';
            const pd = result.partialDuplicate;
            const pdTop = pd && ((pd.matches || [])[0] || pd.topMatch);
            if (pdTop) {
                const pct = matchPercent(pdTop, pd && pd.score);
                partial = `\nℹ️ Se solapa parcialmente con #${pdTop.number} "${pdTop.title}"${pct}. Lo creé igual; revisá si conviene ajustarlo para no duplicar contenido.`;
            }
            return [
                `✅ Issue #${result.issueNumber} creado: ${result.title}`,
                `🏷️ Labels: ${(result.labels || []).join(', ')}`,
                `📋 Backlog: ${result.backlog}`,
                result.url ? `🔗 ${result.url}` : '',
            ].filter(Boolean).join('\n') + proj + partial;
        }
        case 'duplicate': {
            // CA-3: alta similitud → no se creó, se vincula al existente.
            // Copy sin jerga interna (G1): "similitud X%", nunca "Jaccard".
            const top = (result.matches || [])[0] || result.topMatch;
            const detail = top
                ? `\n• #${top.number} "${top.title}"${matchPercent(top, result.score)}`
                : '';
            return [
                `⚠️ No creé el issue: ya existe uno muy parecido.${detail}`,
                'Si igual querés crearlo, pedímelo con "forzar" / "es distinto".',
            ].join('\n');
        }
        case 'error':
        default:
            return `❌ La creación falló: ${result.error || 'error desconocido'}. No se creó nada. Reintentá o usá /doc nueva por consola.`;
    }
}

module.exports = {
    createIssue,
    formatResultMessage,
    // exports internos para test
    inferLabels,
    deriveTitle,
    buildBody,
    resolveBacklog,
    AREA_KEYWORDS,
    DEFAULT_AREA,
    GH_TIMEOUT_MS,
    _defaultGhCreate,
    _defaultAddToProject,
};
