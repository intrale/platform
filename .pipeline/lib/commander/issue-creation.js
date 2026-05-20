// =============================================================================
// commander/issue-creation.js — Delegación a /doc y /planner cuando el
// Telegram Commander recibe un pedido de creación de issue (#3250).
//
// CONTEXTO
// --------
// Antes de este módulo, el Commander armaba el body del issue a mano con su
// propio LLM, generando inventario inconsistente (labels distintos a los de
// `/doc` por consola, splits sin dependencias, etc.). Este módulo cierra esa
// brecha:
//
//   1. Detección heurística del intent (`detectIssueCreationIntent`) — usada
//      pre-LLM para gatear SEC-5 (provider activo ≠ anthropic) y para
//      registrar el evento en el audit log.
//   2. Sanitización del input (`sanitizeIssueCreationInput`, SEC-3) — trunca a
//      4000 chars y strip de caracteres de control / ANSI escape antes de
//      pasarlo a la sesión de Claude que invocará el Skill tool.
//   3. Audit log JSONL (`logSkillInvocation`, SEC-4) — registra cada
//      invocación de skill en `.pipeline/logs/commander-skill-audit.jsonl` con
//      la forma declarada en los criterios de aceptación.
//   4. Validación de sender (`isSenderAllowed`, SEC-2) — defensa en
//      profundidad si el bot token leakea. Por defecto permite todo (env
//      `TELEGRAM_ALLOWED_USER_IDS` vacía); cuando está poblada, sólo
//      procesamos pedidos de quienes están en la lista.
//   5. Bloqueo cuando el provider efectivo ≠ anthropic (SEC-5) — los
//      providers free (Cerebras/Gemini/NVIDIA NIM) no tienen Skill tool
//      habilitado en el harness; intentar `/doc` o `/planner` allí sería un
//      fallback silencioso de calidad degradada.
//
// SCOPE
// -----
// Este módulo NO invoca skills por sí mismo: la invocación real corre dentro
// de la sesión Claude del Commander (en `ejecutarClaude` → Skill tool). Acá
// vivimos las decisiones pre-spawn (gate, sanitización, prompt bloqueo) y
// post-spawn (audit log con el resultado).
//
// COMPATIBILIDAD
// --------------
// Si el usuario no menciona creación de issues, el flujo del Commander es
// idéntico al previo. Sólo cambia cuando hay intent — y entonces aplicamos
// el cinturón nuevo (allowlist skill, gate provider, audit dedicado).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Reutilizamos el redactor del módulo `redact-read` para SEC-C (#3418):
// los errores que se reenvían al operador via Telegram pueden contener
// tokens (AWS keys, JWT, PATs de gh, etc.) que viajan en stack traces.
// Redactamos ANTES de truncar para no exponerlos en ningún chunk visible.
let _redactReadOutput = null;
try {
    _redactReadOutput = require('./redact-read').redactReadOutput;
} catch {
    // En entornos de test el módulo puede no estar disponible; degradamos a
    // passthrough — el truncado a 200 chars sigue aplicando.
    _redactReadOutput = (input) => ({ text: input || '', redactedCount: 0 });
}

// -----------------------------------------------------------------------------
// Allowlist de skills invocables desde Telegram para creación de issues.
// SEC-1: cualquier otro skill (delivery, builder, reset, qa, ghostbusters,
// auth, etc.) está PROHIBIDO desde un pedido de creación de issue. El prompt
// declara esto al LLM en mayúsculas; este módulo provee el list canónico
// para inspección runtime.
//
// #3418 SEC-A: la ampliación de patterns NO debe agregar nuevos skills acá.
// El test `commander-issue-creation.test.js` verifica con snapshot la igualdad
// estricta `['doc', 'planner']`.
// -----------------------------------------------------------------------------
const ALLOWED_SKILLS_FOR_ISSUE_CREATION = Object.freeze(['doc', 'planner']);

// Intents que devuelve `detectIssueCreationIntent`.
const INTENT_NONE = 'none';
const INTENT_CREATE_SIMPLE = 'create_simple';
const INTENT_CREATE_SPLIT = 'create_split';

// Conjunto cerrado de intents matchables — usado para validar que el
// `prevContext` viene con un valor que reconocemos antes de habilitar
// patterns continuativos.
const MATCHED_INTENTS = Object.freeze([INTENT_CREATE_SIMPLE, INTENT_CREATE_SPLIT]);

// -----------------------------------------------------------------------------
// #3418 SEC-D — Enum cerrado para `skill_result` del audit log. Valores:
//   ok                     — Skill se invocó y al menos 1 issue se creó.
//   error                  — Skill arrancó pero no se creó nada (gh rechazó,
//                            args inválidos detectados post-hoc, etc.).
//   blocked                — SEC-2/SEC-5 cortaron antes del spawn (sender no
//                            autorizado, provider ≠ anthropic).
//   timeout                — El watchdog de 60s mató al Skill (CA-3).
//   launching_no_complete  — El LLM dijo "Launching skill: ..." pero nunca
//                            emitió el evento `tool_use` (sin reloj para el
//                            watchdog, sin issue creado).
//   invalid_args           — Skill se invocó con args malformados (detectable
//                            por gh o por el propio handler del Skill).
// -----------------------------------------------------------------------------
const SKILL_RESULT_OK = 'ok';
const SKILL_RESULT_ERROR = 'error';
const SKILL_RESULT_BLOCKED = 'blocked';
const SKILL_RESULT_TIMEOUT = 'timeout';
const SKILL_RESULT_LAUNCHING_NO_COMPLETE = 'launching_no_complete';
const SKILL_RESULT_INVALID_ARGS = 'invalid_args';

const SKILL_RESULT_ENUM = Object.freeze([
    SKILL_RESULT_OK,
    SKILL_RESULT_ERROR,
    SKILL_RESULT_BLOCKED,
    SKILL_RESULT_TIMEOUT,
    SKILL_RESULT_LAUNCHING_NO_COMPLETE,
    SKILL_RESULT_INVALID_ARGS,
]);

// -----------------------------------------------------------------------------
// Heurísticas en español para detectar el intent del usuario ANTES de armar
// el prompt al LLM. Conservadoras: si dudamos, devolvemos INTENT_NONE y el
// LLM decide normalmente (sin gate adicional). Si matchean, gateamos SEC-5
// y enriquecemos el audit log con `skill_invoked` esperado.
//
// El orden importa: chequeamos primero las pistas de épico/split porque
// "creá un épico para X y Y" también matchea "creá un issue".
// -----------------------------------------------------------------------------
const SPLIT_PATTERNS = Object.freeze([
    /\b(?:cre[áa]\s+(?:un\s+)?[eé]pico|levantar\s+(?:un\s+)?[eé]pico|arm[áa]\s+(?:un\s+)?[eé]pico)/i,
    /\b(?:divid[íi]\s+|dividir|splitea?[rl]?|separ[áa]\s+en\s+\w+\s+y\s+\w+)/i,
    /\besto\s+(?:hay\s+que|deber[íi]a|conviene)\s+(?:dividir|splite)/i,
    /\b(?:toca|abarca|cubre)\s+(?:varios|m[uú]ltiples)\s+m[oó]dulos/i,
]);

const SIMPLE_PATTERNS = Object.freeze([
    /\bcre[áa]\s+(?:un\s+)?(?:issue|ticket|historia|tarea)\b/i,
    /\blevant[áa]\s+(?:un[a]?\s+)?(?:issue|ticket|historia|tarea)\b/i,
    /\b(?:hace\s+falta|necesito|me\s+falta)\s+(?:un\s+)?(?:issue|ticket|historia|tarea)\b/i,
    /\barm[áa]\s+(?:un\s+)?(?:issue|ticket|historia)\b/i,
    /\babr[íi]\s+(?:un\s+)?(?:issue|ticket)\b/i,
    /\bgener[áa]\s+(?:un\s+)?(?:issue|ticket|historia)\b/i,
]);

// -----------------------------------------------------------------------------
// #3418 CA-1 — Patterns continuativos: frases que SOLO clasifican como intent
// de creación cuando el turno previo del operador en la misma conversación ya
// tenía un intent matched. Esta capa cubre frases ambiguas o con erratas que
// no se detectaban antes (`Realos cuatro`, `Reintentá creándolo`, `Los cuatro
// y agregálos`, `creálos`, `esos cuatro`).
//
// SEC-B (security): habilitar continuativos sin contexto reforzador abre
// falsos positivos peligrosos (`reintentá el build`, `los 4 PRs que mergeé`,
// `creálos como tasks en taskwarrior`). Por eso `detectIssueCreationIntent`
// SOLO los evalúa cuando `prevContext.intent` es CREATE_SIMPLE o CREATE_SPLIT.
//
// El veredicto de un continuativo hereda el tipo del previo: si el turno
// anterior fue SPLIT, el continuativo también clasifica como SPLIT (porque
// la frase referencia el mismo lote). Si fue SIMPLE, el continuativo es
// SIMPLE — salvo que el texto agregue marcadores de split explícitos.
// -----------------------------------------------------------------------------
const CONTINUATION_PATTERNS = Object.freeze([
    // Pronombres + verbo de creación: "creálos", "armálos", "levantálos",
    // "abrílos", "generálos". Cubre `Realos cuatro` (errata por `Creálos`)
    // gracias a la rama opcional `re?[aá]los`.
    /\b(?:cre[áa]|arm[áa]|levant[áa]|abr[íi]|gener[áa]|re[áa]l?)los\b/i,
    // Gerundio + lo/los: "creándolo", "creándolos", "armándolos",
    // "levantándolos", "abriéndolos", "generándolos". Cubre "Reintentá
    // creándolos" — frase típica del operador.
    /\b(?:cre[áa]ndolos?|arm[áa]ndolos?|levant[áa]ndolos?|abri[ée]ndolos?|gener[áa]ndolos?)\b/i,
    // "creá los 4", "armá los cuatro", "levantá esos N", "abrí esos cuatro"
    /\b(?:cre[áa]|arm[áa]|levant[áa]|abr[íi]|gener[áa])\s+(?:los|esos|esas|las)\s+(?:\d+|cuatro|tres|cinco|seis|siete|ocho|nueve|diez|todos|todas)\b/i,
    // Referencia directa: "los 4", "los cuatro", "esos N", "esas tres".
    // Aplica solo con contexto previo de creación matched.
    /\b(?:los|esos|esas|las)\s+(?:\d+|cuatro|tres|cinco|seis|siete|ocho|nueve|diez)\b/i,
    // Reintentos explícitos: "reintentá creándolos", "reintentá la creación",
    // "reintitaba creándolo" (errata frecuente del operador). El verbo
    // "reintent[áa]" sin objeto NO matchea — exigimos compañía de un verbo
    // o sustantivo de creación.
    /\breintit?[aáeé](?:b[aá])?\b/i,
    // Agregalos / sumalos a la ola actual: el operador suele decir "agregálos"
    // o "sumálos" cuando ya quedó claro que vienen issues nuevos.
    /\b(?:agreg[áa]|sum[áa])los\b/i,
]);

// Patterns que SIEMPRE devuelven INTENT_NONE aunque hayan matcheado un
// continuativo (anti-falsos-positivos). Se aplican como filtro POSTERIOR:
// si el texto match un negativo, se descarta cualquier matching previo.
//
// Ejemplos cubiertos:
//   "reintentá el build"           → build, no issues
//   "los 4 PRs que mergeé"         → PRs, no issues
//   "creálos como tasks en taskwarrior" → taskwarrior, no GitHub
//   "los 4 daemons gradle"         → procesos, no issues
//   "esos cuatro tests fallando"   → tests, no issues
const ADVERSARIAL_NEGATIVE_PATTERNS = Object.freeze([
    /\b(?:build|builds|compilaci[oó]n|gradle|daemon|daemons)\b/i,
    /\b(?:pr|prs|pull\s+request|pull\s+requests|merge|mergeo|mergeado)\b/i,
    /\btask(?:warrior|s)?\b/i,
    /\b(?:test|tests|spec|specs)\b/i,
    /\b(?:deploy|deployment|despliegue|release|releases)\b/i,
    /\b(?:commit|commits|rebase|cherry-?pick)\b/i,
    /\b(?:branch|branches|rama|ramas)\b/i,
]);

/**
 * Devuelve `{ intent, matched }` clasificando el texto consolidado del usuario.
 * `intent` es uno de `INTENT_NONE | INTENT_CREATE_SIMPLE | INTENT_CREATE_SPLIT`.
 * `matched` es el patrón que disparó la clasificación (o null si NONE).
 *
 * @param {string} text       Texto a clasificar.
 * @param {object} prevContext (opcional) `{ intent: 'create_simple'|'create_split'|... }`
 *   del turno anterior. Habilita CONTINUATION_PATTERNS (SEC-B). Sin esto, los
 *   continuativos NUNCA matchean — comportamiento backward-compat.
 */
function detectIssueCreationIntent(text, prevContext) {
    if (typeof text !== 'string' || !text.trim()) {
        return { intent: INTENT_NONE, matched: null };
    }

    // Capa 1: patterns explícitos (siempre activos, no requieren contexto).
    for (const re of SPLIT_PATTERNS) {
        if (re.test(text)) return { intent: INTENT_CREATE_SPLIT, matched: re.source };
    }
    for (const re of SIMPLE_PATTERNS) {
        if (re.test(text)) return { intent: INTENT_CREATE_SIMPLE, matched: re.source };
    }

    // Capa 2: continuativos (SOLO con contexto reforzador del turno previo).
    const prevIntent = prevContext && typeof prevContext === 'object' ? prevContext.intent : null;
    const prevWasMatched = prevIntent && MATCHED_INTENTS.includes(prevIntent);
    if (!prevWasMatched) {
        return { intent: INTENT_NONE, matched: null };
    }

    // Anti-falsos-positivos: si el texto contiene términos de dominio
    // ajenos (build, PR, test, deploy, etc.) descartamos aunque haya
    // matched un continuativo.
    for (const neg of ADVERSARIAL_NEGATIVE_PATTERNS) {
        if (neg.test(text)) {
            return { intent: INTENT_NONE, matched: null };
        }
    }

    for (const re of CONTINUATION_PATTERNS) {
        if (re.test(text)) {
            // El continuativo hereda el intent del turno previo (si el split
            // estaba en curso, sigue siendo split). Si la frase actual
            // contiene marcadores de split explícitos, escalamos a split.
            const inheritsSplit = prevIntent === INTENT_CREATE_SPLIT
                || /\b(?:divid|splite|separ[áa]\s+en)\b/i.test(text);
            return {
                intent: inheritsSplit ? INTENT_CREATE_SPLIT : INTENT_CREATE_SIMPLE,
                matched: re.source,
                continuation: true,
            };
        }
    }
    return { intent: INTENT_NONE, matched: null };
}

// -----------------------------------------------------------------------------
// SEC-3 — Sanitización del input antes de pasarlo al Skill tool.
//   - Truncar a 4000 chars (limita prompt-injection blast radius y token-DoS).
//   - Strip de caracteres de control (NUL, BEL, etc.) y secuencias ANSI escape
//     (CSI / OSC) que podrían confundir el render del prompt o esconder
//     instrucciones ocultas.
//   - NO escapamos comillas/backticks: el Skill tool ya los maneja como string
//     literal y escaparlos rompería casos legítimos ("creá un issue para arreglar
//     el bug del backtick en el parser").
// -----------------------------------------------------------------------------
const MAX_INPUT_CHARS = 4000;

// Control chars peligrosos: NUL, BS, BEL, VT, FF, SO, SI, DLE..US.
// Preservamos \t (0x09), \n (0x0a), \r (0x0d) — esos son ASCII printable-like.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// ANSI escape: CSI ESC [ ... letra, OSC ESC ] ... BEL/ST, ESC + char simple.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

function sanitizeIssueCreationInput(text) {
    if (typeof text !== 'string') return { sanitized: '', truncated: false, strippedControls: 0 };
    // Strip ANSI primero (puede contener bytes que el control-chars chequea
    // después).
    let s = text.replace(ANSI_ESCAPE_RE, '');
    const beforeControls = s.length;
    s = s.replace(CONTROL_CHARS_RE, '');
    const strippedControls = beforeControls - s.length;
    const wasTooLong = s.length > MAX_INPUT_CHARS;
    if (wasTooLong) s = s.slice(0, MAX_INPUT_CHARS);
    return { sanitized: s, truncated: wasTooLong, strippedControls };
}

// -----------------------------------------------------------------------------
// SEC-2 — Validación de sender. Por defecto allowlist vacía → permitimos todo
// (backward compat con el comportamiento previo, donde sólo el chat_id del
// bot validaba indirectamente). Si la env `TELEGRAM_ALLOWED_USER_IDS` está
// poblada (comma-separated user IDs numéricos), filtramos.
//
// Comportamiento defensivo:
//   - IDs no numéricos en la lista se ignoran (log silencioso).
//   - `fromId` undefined/null → rechazado si la allowlist está poblada.
//   - Si la env está mal formada (todos los tokens no numéricos), tratamos
//     como vacía para no romper la app con un misconfig.
// -----------------------------------------------------------------------------
function getAllowedSenderIds(env = process.env) {
    const raw = env && env.TELEGRAM_ALLOWED_USER_IDS;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const out = [];
    for (const tok of raw.split(',')) {
        const t = tok.trim();
        if (!t) continue;
        const n = Number(t);
        if (Number.isFinite(n) && Number.isInteger(n) && n > 0) out.push(n);
    }
    return out;
}

function isSenderAllowed(fromId, allowlist) {
    if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
    if (fromId === null || fromId === undefined) return false;
    const n = Number(fromId);
    if (!Number.isFinite(n)) return false;
    return allowlist.includes(n);
}

// -----------------------------------------------------------------------------
// SEC-4 — Audit log JSONL de invocaciones de skill desde el Commander.
//
// Path: `<pipelineDir>/logs/commander-skill-audit.jsonl`.
// Una línea JSON por intento. Convive con `commander-audit-YYYY-MM-DD.jsonl`
// del módulo multi-provider (#3258) pero el shape es diferente — este es
// específico de creación de issues vía Skill tool.
// -----------------------------------------------------------------------------
function _resolveAuditPath(pipelineDir) {
    const dir = path.join(pipelineDir, 'logs');
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch { /* best-effort */ }
    return path.join(dir, 'commander-skill-audit.jsonl');
}

/**
 * Append una línea JSON al audit log.
 *
 * Campos esperados (ver criterios PO + #3418 SEC-D):
 *   timestamp, from { id, username }, input_text, input_text_truncated,
 *   skill_invoked, skill_args, skill_result (enum cerrado, ver
 *   `SKILL_RESULT_ENUM`), issue_created, duration_ms, provider,
 *   error (opcional, redactado pre-truncate por SEC-C), timeout_ms
 *   (cuando `skill_result === 'timeout'`).
 *
 * Cualquier campo `undefined` se omite del JSON resultante. El método es
 * best-effort: si falla la escritura, loggea y sigue.
 *
 * NOTAS DE SEGURIDAD
 * ------------------
 * - SEC-C: `error` y `inputText` se redactan con `redactReadOutput` ANTES de
 *   truncarse. El módulo redact-read cubre AWS keys, JWT, gh PATs, gemini
 *   keys, Telegram tokens y `password|secret|token=...` genéricos.
 * - SEC-D: `skill_result` se valida contra `SKILL_RESULT_ENUM`. Valores fuera
 *   del enum se loggean como `error` y el campo se omite del JSONL para no
 *   inflar el forense con valores libres.
 * - SEC-E: la escritura es `appendFileSync` (sync, no async) — bajo timeout
 *   sigue garantizando que la línea queda atómica y completa.
 */
function logSkillInvocation({
    pipelineDir,
    timestamp,
    from,
    inputText,
    inputTextTruncated,
    skillInvoked,
    skillArgs,
    skillResult,
    issueCreated,
    durationMs,
    provider,
    error,
    senderAllowed,
    intent,
    timeoutMs,
}, opts = {}) {
    if (!pipelineDir) return false;
    const filePath = _resolveAuditPath(pipelineDir);
    const line = {};
    line.timestamp = timestamp || new Date().toISOString();
    if (from && typeof from === 'object') {
        const fromOut = {};
        if (from.id !== undefined && from.id !== null) fromOut.id = from.id;
        if (from.username) fromOut.username = from.username;
        if (Object.keys(fromOut).length > 0) line.from = fromOut;
    }
    if (inputText !== undefined) {
        // SEC-C: redactar ANTES de truncar el preview. Si la entrada contiene
        // un token, queremos que no quede expuesto ni en los primeros 200
        // chars.
        const redacted = _redactReadOutput(String(inputText));
        line.input_text = redacted.text.slice(0, 200);
        line.input_text_truncated = !!inputTextTruncated;
    }
    if (skillInvoked) line.skill_invoked = skillInvoked;
    if (skillArgs !== undefined) line.skill_args = String(skillArgs).slice(0, 500);
    if (skillResult) {
        // SEC-D: validar contra enum cerrado. Valor inválido → loggeamos
        // alerta y omitimos del JSONL (no escribimos basura).
        if (SKILL_RESULT_ENUM.includes(skillResult)) {
            line.skill_result = skillResult;
        } else {
            try {
                if (opts.log) opts.log('commander', `audit log: skill_result inválido "${skillResult}" (enum=${SKILL_RESULT_ENUM.join('|')}) — campo omitido`);
            } catch { /* swallow */ }
        }
    }
    if (issueCreated !== undefined && issueCreated !== null) line.issue_created = issueCreated;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) line.duration_ms = Math.round(durationMs);
    if (provider) line.provider = provider;
    if (error) {
        // SEC-C: redactar ANTES de truncar a 500. El módulo redact-read maneja
        // tokens, JWT, paths con credenciales embebidas, etc.
        const redacted = _redactReadOutput(String(error));
        line.error = redacted.text.slice(0, 500);
    }
    if (senderAllowed !== undefined) line.sender_allowed = !!senderAllowed;
    if (intent) line.intent = intent;
    // SEC-D / CA-3: `timeout_ms` SOLO cuando aplica al watchdog del Skill.
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        line.timeout_ms = Math.round(timeoutMs);
    }
    try {
        fs.appendFileSync(filePath, JSON.stringify(line) + '\n');
        return true;
    } catch (e) {
        try {
            if (opts.log) opts.log('commander', `audit log error: ${e.message}`);
        } catch { /* swallow */ }
        return false;
    }
}

// -----------------------------------------------------------------------------
// SEC-5 — Mensaje canned cuando el provider activo ≠ anthropic. Lo invocamos
// pre-LLM para evitar que un fallback a Cerebras/Gemini/NVIDIA NIM termine creando
// un issue de calidad degradada. El copy sigue la guideline UX del análisis
// del issue (lenguaje natural, accionable).
// -----------------------------------------------------------------------------
function formatBlockedByProviderResponse({ provider }) {
    const prov = provider && provider !== 'anthropic' ? ` (failover a ${provider})` : '';
    return [
        '🚧 No puedo crear issues ahora mismo — el cerebro principal está caído' + prov + '.',
        'Reintentá más tarde o creá manual por consola: /doc nueva ...',
    ].join('\n');
}

// -----------------------------------------------------------------------------
// CA-5 — Mensajes de error cuando el Skill falla. Variantes por causa según
// la guideline UX. El kind viene del caller (timeout, quota, gh_error, generic,
// no_skill_invoked, launching_no_complete, invalid_args).
//
// #3418 SEC-C — el `error` se redacta con `redactReadOutput` ANTES de truncar
// a 200 chars. Cubre AWS keys, JWT, gh PATs, gemini keys, Telegram tokens y
// `password|secret|token=...` genéricos que puedan venir en stack traces.
// -----------------------------------------------------------------------------
function formatSkillFailureResponse({ kind, error }) {
    // SEC-C: redactar PRIMERO, truncar después.
    const errRedacted = error ? _redactReadOutput(String(error)).text : '';
    const errShort = errRedacted.slice(0, 200);
    switch (kind) {
        case 'timeout':
            return '⏱️ Tardó demasiado y no se creó el issue. Reintentá en un rato o usá /doc nueva por consola.';
        case 'quota':
            return '🔌 El cerebro del Commander está saturado ahora. No se creó nada. Reintentá o usá consola.';
        case 'gh_error':
            return `🐙 GitHub rechazó la creación${errShort ? ': ' + errShort : ''}. Reintentá o revisá manualmente.`;
        case 'no_skill_invoked':
            return `❌ La creación falló: el Commander no invocó /doc ni /planner como se esperaba. No se creó nada. Reintentá o usá consola.`;
        case 'launching_no_complete':
            return `❌ El Commander anunció /doc pero no llegó a invocarlo. No se creó nada. Reintentá explícitamente con /doc nueva <título>.`;
        case 'invalid_args':
            return `❌ El Skill /doc recibió argumentos inválidos${errShort ? ': ' + errShort : ''}. No se creó nada. Reformulá el pedido o usá /doc nueva por consola.`;
        default:
            return `❌ La creación falló${errShort ? ': ' + errShort : ''}. No se creó nada. Reintentá o creá manual por consola con /doc nueva ...`;
    }
}

// -----------------------------------------------------------------------------
// Bloque de instrucciones a inyectar en el `userPrompt` del Commander cuando
// el flujo entra al texto libre. Describe en mayúsculas las reglas
// inquebrantables (CA-1, CA-2, CA-3, CA-4, CA-5 + SEC-1).
//
// Se mantiene como string puro (sin template-literal-interpolation) para que
// no acepte input del usuario por accidente — la única forma de personalizarlo
// es desde código.
// -----------------------------------------------------------------------------
function buildIssueCreationPromptBlock() {
    return [
        '',
        'REGLA ESPECÍFICA — CREACIÓN DE ISSUES (obligatoria, sin excepciones):',
        '',
        '1. Si el usuario pide crear UN issue ("creá un issue para X", "levantá una historia de Y", "hace falta un ticket de Z"):',
        '   - INVOCÁ Skill(skill="doc", args="nueva <descripción exacta>").',
        '   - NO uses gh issue create directo. NO armes el body vos.',
        '',
        '2. Si el usuario pide un épico, dividir trabajo grande, o menciona multi-módulo ("creá un épico", "esto hay que dividirlo en X y Y", "separá en backend y app"):',
        '   - INVOCÁ Skill(skill="planner", args="split ...") si ya existe un issue padre.',
        '   - INVOCÁ Skill(skill="planner", args="proponer ...") si Leo pide ideas nuevas.',
        '',
        '3. ALLOWLIST DE SKILLS PARA ESTE FLOW: los únicos skills permitidos desde un pedido de creación de issue son `doc` y `planner`. CUALQUIER OTRO skill (`delivery`, `builder`, `reset`, `qa`, `ghostbusters`, `auth`, etc.) está PROHIBIDO acá. Si el usuario pide algo que requiera otro skill, respondele que ese pedido no se procesa por este canal.',
        '',
        '4. Si el Skill falla, timeoutea, o retorna error:',
        '   - REPORTÁ a Telegram: "❌ La creación falló: <error>. No se creó nada. Reintentá o creá manual por consola con /doc nueva ...".',
        '   - NO armes el issue vos mismo como fallback. NUNCA. NO USES `gh issue create` directo.',
        '',
        '5. Si el Skill tuvo éxito: validá con `gh issue view <N> --json labels,assignees,projectItems` que el issue tiene labels base (`area:*`, `priority:*`, `size:*`, `enhancement|bug|chore`, `needs-definition|Ready`), assignee `leitolarreta` y está agregado al Project V2. Si falta alguno, reportá inconsistencia a Telegram (pero NO toques el issue).',
        '',
        '6. Para SPLIT (Skill planner split): el reporte a Telegram debe incluir título del padre, lista de hijos con número/título/`size:*`, y la cadena de dependencias declarada (`blocked:dependencies` del padre apuntando a los hijos). Formato sugerido (puzzle piece + bullets):',
        '   🧩 Split listo para #<padre> — <título corto>',
        '   Hijos creados:',
        '   • #<N> — <título> · size:<X>',
        '   Dependencias declaradas: el padre queda con blocked:dependencies → <#h1, #h2, ...>.',
        '',
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Inspección post-LLM: dado el texto de respuesta del Commander, intentar
// extraer (a) cuántos issues nuevos se crearon y sus números, (b) si se
// invocó `doc` o `planner` o nada explícito. Heurística defensiva: el LLM
// puede formatear la respuesta de varias formas pero las menciones de
// `#NNNN creado` y `Skill(skill="..."` son patrones razonables.
//
// #3418 CA-3 — Detección de `launching_no_complete`:
// El bug original era que cuando el LLM emitía texto tipo "Launching skill:
// doc" pero NUNCA llegaba a invocar la tool real, la heurística devolvía
// `skillResult: 'unknown'` y el operador no se enteraba de que la creación
// había fallado. Ahora reconocemos ese marcador textual y permitimos que el
// caller distinga ese caso para mapearlo a `SKILL_RESULT_LAUNCHING_NO_COMPLETE`.
// -----------------------------------------------------------------------------

// Marcadores que el LLM (Claude Code) imprime cuando ANUNCIA la invocación
// de un Skill antes de emitir el evento `tool_use`. Si vemos uno de estos
// y `issuesCreated === []`, el caller debería mapear a launching_no_complete.
const LAUNCHING_MARKER_RE = /\b(?:Launching|Invocando|Lanzando)\s+(?:skill|el\s+skill)\s*:?\s*\/?(doc|planner)\b/i;

function inspectResponseForOutcome(responseText) {
    if (typeof responseText !== 'string' || !responseText) {
        return { issuesCreated: [], skillsMentioned: [], launchingDetected: false };
    }
    const issuesCreated = [];
    // Pattern 1: "#NNNN creado" / "#NNNN created" / "#NNNN listo" — caso simple
    // donde el verbo viene pegado al número.
    const issueRe = /#(\d{2,6})\s+(?:creado|created|listo)/gi;
    let m;
    while ((m = issueRe.exec(responseText)) !== null) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && !issuesCreated.includes(n)) issuesCreated.push(n);
    }
    // Pattern 2: contexto de split — formato "🧩 Split listo... Hijos creados:
    // • #NNNN — título · size:X". Acá `creado` está al final de la línea, no
    // pegado al número. Si la respuesta menciona marcadores de split, sumamos
    // TODOS los #NNNN de la respuesta (heurística defensiva — el audit log
    // sirve para forense, no para auditar el output exacto).
    if (/(?:hijos\s+creados|🧩|split\s+listo)/i.test(responseText)) {
        const allIssues = /#(\d{2,6})\b/g;
        let m2;
        while ((m2 = allIssues.exec(responseText)) !== null) {
            const n = Number(m2[1]);
            if (Number.isFinite(n) && !issuesCreated.includes(n)) issuesCreated.push(n);
        }
    }
    const skillsMentioned = [];
    if (/\b\/?doc\b/i.test(responseText)) skillsMentioned.push('doc');
    if (/\b\/?planner\b/i.test(responseText)) skillsMentioned.push('planner');

    // #3418 CA-3: detectar marcador textual de "Launching ..." para que el
    // caller pueda decidir entre launching_no_complete vs error.
    const launchingDetected = LAUNCHING_MARKER_RE.test(responseText);

    return { issuesCreated, skillsMentioned, launchingDetected };
}

/**
 * Helper de inferencia de `skill_result` a partir del outcome inspeccionado
 * y los flags de runtime (toolUseEmitted, toolResultEmitted, timedOut).
 *
 * #3418 SEC-D — único punto que mapea el estado runtime al enum cerrado.
 * Centraliza la lógica para que tests y producción se mantengan en sync.
 *
 * @param {object} args
 *   - outcome: salida de `inspectResponseForOutcome`
 *   - toolUseEmitted: boolean — el child emitió `tool_use:Skill`
 *   - toolResultEmitted: boolean — llegó el `tool_use_result` correspondiente
 *   - timedOut: boolean — el watchdog 60s disparó kill
 * @returns {string} valor del enum SKILL_RESULT_*
 */
function inferSkillResult({ outcome, toolUseEmitted, toolResultEmitted, timedOut } = {}) {
    if (timedOut) return SKILL_RESULT_TIMEOUT;
    if (outcome && Array.isArray(outcome.issuesCreated) && outcome.issuesCreated.length > 0) {
        return SKILL_RESULT_OK;
    }
    // Caso watchdog: tool_use llegó pero el result no — distinto de
    // launching_no_complete (donde NUNCA hubo evento estructurado).
    if (toolUseEmitted && !toolResultEmitted) return SKILL_RESULT_TIMEOUT;
    // Caso bug del issue: el LLM dijo "Launching ..." pero nunca emitió
    // tool_use. Sin issuesCreated y con marcador textual → launching_no_complete.
    if (outcome && outcome.launchingDetected) return SKILL_RESULT_LAUNCHING_NO_COMPLETE;
    // Caso clásico: ni invocó ni creó nada → error duro (no `unknown`).
    return SKILL_RESULT_ERROR;
}

module.exports = {
    ALLOWED_SKILLS_FOR_ISSUE_CREATION,
    INTENT_NONE,
    INTENT_CREATE_SIMPLE,
    INTENT_CREATE_SPLIT,
    MATCHED_INTENTS,
    MAX_INPUT_CHARS,

    // #3418 SEC-D — enum cerrado de skill_result
    SKILL_RESULT_OK,
    SKILL_RESULT_ERROR,
    SKILL_RESULT_BLOCKED,
    SKILL_RESULT_TIMEOUT,
    SKILL_RESULT_LAUNCHING_NO_COMPLETE,
    SKILL_RESULT_INVALID_ARGS,
    SKILL_RESULT_ENUM,

    detectIssueCreationIntent,
    sanitizeIssueCreationInput,
    getAllowedSenderIds,
    isSenderAllowed,
    logSkillInvocation,
    formatBlockedByProviderResponse,
    formatSkillFailureResponse,
    buildIssueCreationPromptBlock,
    inspectResponseForOutcome,
    inferSkillResult,

    // exports internos para tests
    _resolveAuditPath,
    _SPLIT_PATTERNS: SPLIT_PATTERNS,
    _SIMPLE_PATTERNS: SIMPLE_PATTERNS,
    _CONTINUATION_PATTERNS: CONTINUATION_PATTERNS,
    _ADVERSARIAL_NEGATIVE_PATTERNS: ADVERSARIAL_NEGATIVE_PATTERNS,
    _LAUNCHING_MARKER_RE: LAUNCHING_MARKER_RE,
};
