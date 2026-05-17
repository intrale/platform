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
//      providers free (Groq/Cerebras/Gemini) no tienen Skill tool habilitado
//      en el harness; intentar `/doc` o `/planner` allí sería un fallback
//      silencioso de calidad degradada.
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

// -----------------------------------------------------------------------------
// Allowlist de skills invocables desde Telegram para creación de issues.
// SEC-1: cualquier otro skill (delivery, builder, reset, qa, ghostbusters,
// auth, etc.) está PROHIBIDO desde un pedido de creación de issue. El prompt
// declara esto al LLM en mayúsculas; este módulo provee el list canónico
// para inspección runtime.
// -----------------------------------------------------------------------------
const ALLOWED_SKILLS_FOR_ISSUE_CREATION = Object.freeze(['doc', 'planner']);

// Intents que devuelve `detectIssueCreationIntent`.
const INTENT_NONE = 'none';
const INTENT_CREATE_SIMPLE = 'create_simple';
const INTENT_CREATE_SPLIT = 'create_split';

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

/**
 * Devuelve `{ intent, matched }` clasificando el texto consolidado del usuario.
 * `intent` es uno de `INTENT_NONE | INTENT_CREATE_SIMPLE | INTENT_CREATE_SPLIT`.
 * `matched` es el patrón que disparó la clasificación (o null si NONE).
 */
function detectIssueCreationIntent(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { intent: INTENT_NONE, matched: null };
    }
    for (const re of SPLIT_PATTERNS) {
        if (re.test(text)) return { intent: INTENT_CREATE_SPLIT, matched: re.source };
    }
    for (const re of SIMPLE_PATTERNS) {
        if (re.test(text)) return { intent: INTENT_CREATE_SIMPLE, matched: re.source };
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
 * Campos esperados (ver criterios PO):
 *   timestamp, from { id, username }, input_text, input_text_truncated,
 *   skill_invoked, skill_args, skill_result ('ok'|'error'|'blocked'),
 *   issue_created, duration_ms, provider, error (opcional)
 *
 * Cualquier campo `undefined` se omite del JSON resultante. El método es
 * best-effort: si falla la escritura, loggea y sigue.
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
        // Preview corto en audit log; el texto completo va al historial del
        // commander-history.jsonl. Acá guardamos los primeros 200 chars para
        // tener contexto forense sin inflar el JSONL.
        line.input_text = String(inputText).slice(0, 200);
        line.input_text_truncated = !!inputTextTruncated;
    }
    if (skillInvoked) line.skill_invoked = skillInvoked;
    if (skillArgs !== undefined) line.skill_args = String(skillArgs).slice(0, 500);
    if (skillResult) line.skill_result = skillResult;
    if (issueCreated !== undefined && issueCreated !== null) line.issue_created = issueCreated;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) line.duration_ms = Math.round(durationMs);
    if (provider) line.provider = provider;
    if (error) line.error = String(error).slice(0, 500);
    if (senderAllowed !== undefined) line.sender_allowed = !!senderAllowed;
    if (intent) line.intent = intent;
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
// pre-LLM para evitar que un fallback a Groq/Cerebras/Gemini termine creando
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
// la guideline UX. El kind viene del caller (timeout, quota, gh_error, generic).
// -----------------------------------------------------------------------------
function formatSkillFailureResponse({ kind, error }) {
    const errShort = error ? String(error).slice(0, 200) : '';
    switch (kind) {
        case 'timeout':
            return '⏱️ Tardó demasiado y no se creó el issue. Reintentá en un rato o usá /doc nueva por consola.';
        case 'quota':
            return '🔌 El cerebro del Commander está saturado ahora. No se creó nada. Reintentá o usá consola.';
        case 'gh_error':
            return `🐙 GitHub rechazó la creación${errShort ? ': ' + errShort : ''}. Reintentá o revisá manualmente.`;
        case 'no_skill_invoked':
            return `❌ La creación falló: el Commander no invocó /doc ni /planner como se esperaba. No se creó nada. Reintentá o usá consola.`;
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
// -----------------------------------------------------------------------------
function inspectResponseForOutcome(responseText) {
    if (typeof responseText !== 'string' || !responseText) {
        return { issuesCreated: [], skillsMentioned: [] };
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
    return { issuesCreated, skillsMentioned };
}

module.exports = {
    ALLOWED_SKILLS_FOR_ISSUE_CREATION,
    INTENT_NONE,
    INTENT_CREATE_SIMPLE,
    INTENT_CREATE_SPLIT,
    MAX_INPUT_CHARS,

    detectIssueCreationIntent,
    sanitizeIssueCreationInput,
    getAllowedSenderIds,
    isSenderAllowed,
    logSkillInvocation,
    formatBlockedByProviderResponse,
    formatSkillFailureResponse,
    buildIssueCreationPromptBlock,
    inspectResponseForOutcome,

    // exports internos para tests
    _resolveAuditPath,
    _SPLIT_PATTERNS: SPLIT_PATTERNS,
    _SIMPLE_PATTERNS: SIMPLE_PATTERNS,
};
