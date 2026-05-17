// =============================================================================
// commander/multi-provider.js — Cadena de fallback multi-provider para el
// Commander de Telegram (#3258).
//
// CONTEXTO
// --------
// El Commander hoy invocaba a Claude directo en pulpo.js → ejecutarClaude.
// Si Anthropic está caído por cuota o rate-limit, el canal de comunicación
// con el pipeline queda mudo. Este módulo cierra esa promesa:
//
//   1. Antes de spawnear, consulta el runtime `dispatch-with-fallback`
//      (#3198) con `skill: 'telegram-commander'`.
//   2. Si Anthropic está gateado por cuota persistida → resuelve al
//      siguiente provider del array `fallbacks[]` declarado en
//      `agent-models.json` (CA-1 / CA-2 del #3258).
//   3. Sanitiza el input del usuario (SR-4) — patrones de prompt-injection.
//   4. Emite notificación Telegram amigable cuando entra en fallback (CA-5
//      con formato UX-G1, separado del aviso de degradación capability).
//   5. Aplica dedup 5 min en notificaciones repetidas (SR-6) para no spamear
//      durante caídas prolongadas.
//   6. Wire a `data-residency-filter` (SR-1) y emite eventos de audit log
//      con hash-chain (CA-4 / SR-3).
//
// SCOPE PRE-SPAWN
// ---------------
// La decisión del PO en el issue (2026-05-17 00:19) es: el fallback es
// **pre-spawn** solamente. Cuando Anthropic está caído pre-spawn (flag
// persistido por #2974/#3077), pasamos directo al siguiente provider.
// In-flight fallback (5xx/timeout >30s después de spawnear) es out of scope
// y vive en #3275 con security review dedicado.
//
// El budget global de 90s de SR-5 aplicaría al ciclo multi-spawn — en
// pre-spawn solamente el budget efectivo es el HARD_TIMEOUT_MS del spawn
// único (10 min en pulpo.js). Reservamos la primitiva para que #3275 la use.
//
// STUBS DE PROVIDER
// -----------------
// Los providers no-Anthropic (`openai-codex`, `groq`, `gemini-google`,
// `cerebras`) hoy son **stubs** que tiran `_notImplemented` en `buildSpawn`
// (lib/agent-launcher/providers/*.js). El runtime real llega con #3198.
//
// Mientras tanto, la cadena resuelve correctamente al provider (pre-spawn)
// pero el caller debe `try/catch` el `buildSpawn` y caer al canned response
// "no implementado todavía". Este módulo expone `safeBuildSpawn(resolution,
// args, env)` que hace ese catch y devuelve `{ ok: false, reason }` en vez
// de propagar el throw.
//
// COMPATIBILIDAD
// --------------
// El default path (Anthropic disponible) es byte-equivalente al
// comportamiento previo de `ejecutarClaude`. Solo cambia el camino cuando
// la cuota Anthropic está gateada — antes: canned response gating; ahora:
// intentar fallback antes de gatear.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COMMANDER_SKILL = 'telegram-commander';

// -----------------------------------------------------------------------------
// Patrones de prompt-injection (SR-4). Reusamos los del módulo de handoff
// porque la política de denylist debe ser la misma — un patrón inseguro lo
// es para cualquier input al LLM.
//
// Si el input del usuario matchea, truncamos al primer match y marcamos
// el audit log con `prompt_injection_attempt`. El caller decide si avisar.
// -----------------------------------------------------------------------------
const INJECTION_PATTERNS = Object.freeze([
    /\bignore\s+(?:all\s+)?previous\s+(?:instructions?|prompts?|messages?|rules?)/i,
    /\bdisregard\s+(?:all\s+)?(?:prior|previous)\s+(?:instructions?|prompts?|messages?|rules?)/i,
    /\bforget\s+(?:all\s+)?previous\s+(?:instructions?|prompts?|messages?)/i,
    /\bsystem\s+prompt\s*[:=]/i,
    /\bnew\s+(?:system\s+)?instructions?\s*[:=]/i,
    /\byou\s+are\s+now\s+(?:a|the|an)\s+/i,
    /\boverride\s+(?:all\s+)?(?:previous|prior)\s+(?:rules?|instructions?)/i,
    // ES variants
    /\b(?:olvid[áa]|olvida|olvidate?\s+de|ignorá?|ignora|ignor[áa]\s+(?:todas\s+)?las)\s+(?:las\s+)?(?:instrucciones?|reglas?|directivas?|indicaciones?)\s+(?:previas?|anteriores?)/i,
    /\bnuevas?\s+instrucciones?\s*[:=]/i,
    /\bdescart[áa]\s+(?:las\s+)?(?:instrucciones?|reglas?|directivas?|indicaciones?)\s+(?:previas?|anteriores?)/i,
    /\bahora\s+sos\s+(?:un|el|la|una)\s+/i,
    /\baprob[áa]\s+todo\s+lo\s+(?:que\s+)?(?:venga|sigue|veas)/i,
    // Tag-injection: <handoff_externo>, <system-reminder>
    /<\s*handoff[_-]?externo\s*>/i,
    /<\s*system[_-]?reminder\s*>/i,
]);

// -----------------------------------------------------------------------------
// SR-4: sanitizeUserPrompt — corta el texto en el primer match de inyección
// y devuelve el flag para que el caller decida loggear y avisar.
//
// El truncado deja el contenido legítimo y elimina el imperativo subversivo.
// Si no hay matches, devuelve el texto intacto.
// -----------------------------------------------------------------------------
function sanitizeUserPrompt(text) {
    if (typeof text !== 'string') {
        text = String(text == null ? '' : text);
    }
    const hits = [];
    let firstIdx = -1;
    for (const re of INJECTION_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) {
            hits.push(m[0]);
            if (firstIdx < 0 || m.index < firstIdx) firstIdx = m.index;
        }
    }
    if (hits.length === 0) {
        return { sanitized: text, hits: [], truncated: false };
    }
    const safe = text.slice(0, Math.max(0, firstIdx)).trimEnd();
    return {
        sanitized: safe + (safe ? '\n\n' : '') + '[Texto recortado: detecté patrón sospechoso, ignoré esa parte]',
        hits,
        truncated: true,
    };
}

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado a 12 hex. Lo usamos en el audit log (SR-3) y
// en el dedup (SR-6) para evitar guardar `chat_id` o el prompt crudo.
// -----------------------------------------------------------------------------
function hashFor(s) {
    return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex').slice(0, 12);
}

// -----------------------------------------------------------------------------
// resolveCommanderProvider — consulta el runtime `dispatch-with-fallback`
// con `skill: 'telegram-commander'` y devuelve la resolución.
//
// El runtime ya hace todo el trabajo: lee `agent-models.json`, chequea el
// flag de cuota persistido por provider (#3077), itera la chain y emite
// audit log + notificación Telegram cuando salta a fallback (CA-3 / CA-5
// nivel runtime).
//
// Acá solo wrappeamos con el skill name correcto y exponemos overrides
// inyectables para tests.
//
// Devuelve el shape de `resolveSpawnWithFallback`:
//   { provider, model, handler, source, gated, fallbackUsed, primaryProvider,
//     chainTried, crossProvider, depthExceeded }
// -----------------------------------------------------------------------------
function resolveCommanderProvider(opts = {}) {
    const {
        pipelineDir,
        log,
        // inyectables tests
        dispatchModule,
        quotaModule,
        fsImpl,
        now,
        issue,
    } = opts;

    const _dispatch = dispatchModule || require('../agent-launcher/dispatch-with-fallback');
    const _quota = quotaModule || require('../quota-exhausted');

    return _dispatch.resolveSpawnWithFallback({
        skill: COMMANDER_SKILL,
        issue: issue || 'commander-chat',
        pipelineDir,
        fsImpl,
        quotaModule: _quota,
        onLog: typeof log === 'function' ? log : () => {},
        now,
    });
}

// -----------------------------------------------------------------------------
// CA-5 + UX-G1 — formatFallbackNotice
//
// El runtime de dispatch-with-fallback emite una notificación operativa
// genérica (`⚠️ Cross-provider fallback activo\nskill=X\nprimary=...`),
// que es OK para skills del pipeline pero NO para el Commander de Telegram
// — Leo recibe ese mensaje y suena a log, no a conversación.
//
// Reescribimos la notificación al lenguaje natural del canal (UX-G1) y
// agregamos el aviso de capacidad degradada en SEGUNDA LÍNEA con icono
// distinto (SR-8) si el provider efectivo no soporta tool use.
//
// Reglas (UX-G1):
//   - ⚠️ marca el motivo del fallback.
//   - ℹ️ marca degradación de capacidad (no es un error).
//   - NO incluir stack trace, request_id, headers, prompt fragments (SR-7).
//   - Solo el `errorCode` genérico (`rate_limit`, `quota_exhausted`, etc.).
// -----------------------------------------------------------------------------
function formatFallbackNotice({ primaryProvider, fallbackProvider, errorCode, supportsToolUse }) {
    const lines = [];
    const code = String(errorCode || 'quota_exhausted');
    const motive =
        code === 'rate_limit' ? 'rate_limit' :
        code === 'quota_exhausted' ? 'cuota agotada' :
        code === 'timeout' ? 'sin respuesta a tiempo' :
        code === '5xx' ? 'error del servidor' :
        code;
    lines.push(
        `⚠️ Claude no responde (${motive}) — el commander está usando ${fallbackProvider} para esta respuesta.`
    );
    if (supportsToolUse === false) {
        lines.push(
            `ℹ️ Modo conversacional: el commander no puede ejecutar comandos del pipeline en este request.`
        );
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// SR-6 — Dedup window 5 min para notificaciones de fallback.
//
// Caída prolongada de Anthropic genera N requests/min en Telegram con el
// mismo aviso. Dedupeamos por `(chat_id_hash, fallback_provider)` con una
// ventana deslizante. La primera notificación va completa; las siguientes
// dentro de la ventana NO se emiten (silenciosas). Cuando vence la ventana,
// la próxima emisión vuelve al texto completo (no implementamos el
// "resumen contador" de UX-G3 — eso queda para una iteración futura).
//
// Estado persistido en `.pipeline/commander-fallback-dedup.json` (best-effort).
// -----------------------------------------------------------------------------
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_STATE_FILE = 'commander-fallback-dedup.json';

function dedupStatePath(pipelineDir) {
    return path.join(pipelineDir || '.', DEDUP_STATE_FILE);
}

function loadDedupState(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const file = dedupStatePath(pipelineDir);
    if (!_fs.existsSync(file)) return { entries: {} };
    try {
        return JSON.parse(_fs.readFileSync(file, 'utf8'));
    } catch {
        return { entries: {} };
    }
}

function saveDedupState(state, pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const file = dedupStatePath(pipelineDir);
    try {
        _fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Devuelve true si esta combinación (chat_id, fallback_provider) NO fue
 * notificada en los últimos `DEDUP_WINDOW_MS`. Si devuelve true, también
 * actualiza el state para marcarla como recién notificada (lock).
 */
function shouldEmitFallbackNotice({ pipelineDir, chatId, fallbackProvider, now, fsImpl }) {
    if (!fallbackProvider) return false;
    const _now = Number.isFinite(now) ? now : Date.now();
    const cidHash = hashFor(chatId || 'unknown');
    const key = `${cidHash}|${fallbackProvider}`;
    const state = loadDedupState(pipelineDir, fsImpl);
    state.entries = state.entries || {};
    const last = Number(state.entries[key] || 0);
    if (last && _now - last < DEDUP_WINDOW_MS) return false;
    state.entries[key] = _now;
    // GC: borramos entries más viejas que 24h para no crecer indefinido.
    for (const k of Object.keys(state.entries)) {
        if (_now - Number(state.entries[k] || 0) > 24 * 60 * 60 * 1000) {
            delete state.entries[k];
        }
    }
    saveDedupState(state, pipelineDir, fsImpl);
    return true;
}

// -----------------------------------------------------------------------------
// CA-4 + SR-3 — auditCommanderRequest.
//
// Reusamos `lib/audit-log.js` (hash-chain SHA-256, append-only, tamper-evident)
// — NO inventamos archivo nuevo. Por día, escribimos a
// `logs/commander-dispatch-YYYY-MM-DD.jsonl`.
//
// Shape de la entry (per spec del issue 2026-05-17 00:19):
//   { skill, provider_intended, provider_effective, chain_tried[],
//     tokens, cost_usd, latency_ms, request_id, chat_id_hash, prompt_hash,
//     created_at, event }
//
// **Prohibido** loggear el prompt o la respuesta literal. `prompt_hash` es
// SHA-256 truncado a 12 hex (mismo patrón que #3082/#3084).
// -----------------------------------------------------------------------------
function auditFile(pipelineDir, now) {
    const d = now ? new Date(now) : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir || '.', 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

function auditCommanderRequest(opts = {}) {
    const {
        pipelineDir,
        event,
        providerIntended,
        providerEffective,
        chainTried,
        chatId,
        prompt,
        tokens,
        costUsd,
        latencyMs,
        requestId,
        errorCode,
        injectionHits,
        supportsToolUse,
        // inyectables tests
        fsImpl,
        auditLog,
        now,
    } = opts;

    if (!pipelineDir) return false;

    const _audit = auditLog || require('../audit-log');
    const _now = Number.isFinite(now) ? now : Date.now();

    const entry = {
        event: String(event || 'dispatch'),
        skill: COMMANDER_SKILL,
        provider_intended: providerIntended || null,
        provider_effective: providerEffective || null,
        chain_tried: Array.isArray(chainTried) ? chainTried : null,
        tokens: tokens || null,
        cost_usd: typeof costUsd === 'number' ? Number(costUsd.toFixed(6)) : null,
        latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
        request_id: requestId || hashFor(`${_now}-${process.pid}-${Math.random()}`),
        chat_id_hash: hashFor(chatId || 'unknown'),
        prompt_hash: hashFor(prompt || ''),
        error_code: errorCode || null,
        injection_hits: Array.isArray(injectionHits) ? injectionHits.length : 0,
        supports_tool_use: typeof supportsToolUse === 'boolean' ? supportsToolUse : null,
    };

    try {
        const file = auditFile(pipelineDir, _now);
        _audit.appendChained({ file, entry, fsImpl });
        return true;
    } catch {
        return false; // best-effort
    }
}

// -----------------------------------------------------------------------------
// CA-6 — readCommanderStats.
//
// Lee los audit logs de los últimos N días y agrega por provider efectivo.
// Devuelve `{ totalRequests, byProvider: { name: { count, pct } } }`.
//
// Usado por el dashboard para mostrar la distribución multi-provider del
// Commander (slice "Distribución del Commander por provider" — UX-G2).
// -----------------------------------------------------------------------------
function readCommanderStats({ pipelineDir, windowDays, now, fsImpl, auditLog }) {
    const _fs = fsImpl || fs;
    const _audit = auditLog || require('../audit-log');
    const _now = Number.isFinite(now) ? now : Date.now();
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
    const startMs = _now - days * 24 * 60 * 60 * 1000;

    const counts = Object.create(null);
    let total = 0;

    for (let off = 0; off < days; off++) {
        const t = _now - off * 24 * 60 * 60 * 1000;
        const file = auditFile(pipelineDir, t);
        if (!_fs.existsSync(file)) continue;
        let entries = [];
        try {
            entries = _audit.readAll(file, _fs);
        } catch {
            continue;
        }
        for (const e of entries) {
            const created = Number(e.created_at || 0);
            if (created && created < startMs) continue;
            // Solo contamos los eventos de "dispatch" exitosos — los eventos
            // como `prompt_injection_attempt` o `gated_all` no son requests
            // efectivos del Commander.
            if (e.event && e.event !== 'dispatch' && e.event !== 'fallback_used') continue;
            const prov = e.provider_effective || 'unknown';
            counts[prov] = (counts[prov] || 0) + 1;
            total++;
        }
    }

    const byProvider = {};
    for (const prov of Object.keys(counts)) {
        byProvider[prov] = {
            count: counts[prov],
            pct: total > 0 ? Math.round((counts[prov] / total) * 1000) / 10 : 0,
        };
    }
    return { totalRequests: total, byProvider, windowDays: days };
}

// -----------------------------------------------------------------------------
// safeBuildSpawn — wrapper defensivo para `handler.buildSpawn` que captura
// el throw de los stubs no implementados (#3198 pendiente).
//
// Devuelve `{ ok: true, spawnDef }` o `{ ok: false, reason }`. El caller
// (pulpo.js) decide si fallback canned, audit log + Telegram, etc.
// -----------------------------------------------------------------------------
function safeBuildSpawn({ handler, args, cwd, env }) {
    if (!handler || typeof handler.buildSpawn !== 'function') {
        return { ok: false, reason: 'handler_no_buildSpawn' };
    }
    try {
        const spawnDef = handler.buildSpawn({ args, cwd, env });
        return { ok: true, spawnDef };
    } catch (e) {
        return { ok: false, reason: 'not_implemented', message: (e && e.message) || String(e) };
    }
}

// -----------------------------------------------------------------------------
// cannedFallbackUnavailableResponse — Mensaje al usuario cuando el dispatcher
// resolvió un fallback pero el `buildSpawn` del provider stub tira
// `_notImplemented`. Mensaje no técnico, sin paths internos.
// -----------------------------------------------------------------------------
function cannedFallbackUnavailableResponse({ provider }) {
    return (
        `⚠️ Claude no responde y todavía no tengo el provider \`${provider}\` instalado para contestarte. ` +
        `Lo destrabamos cuando se cierre #3198 (runtime de fallback). ` +
        `Mientras tanto, podés usar los comandos directos (/status, /listado, /lanzar) que no dependen de LLM.`
    );
}

// -----------------------------------------------------------------------------
// cannedAllGatedResponse — Mensaje al usuario cuando TODOS los providers de
// la chain están gateados (Anthropic + fallbacks declarados todos quemados).
// -----------------------------------------------------------------------------
function cannedAllGatedResponse() {
    return (
        `🚫 Todos los providers LLM del commander están sin cuota disponible. ` +
        `Los comandos determinísticos (/status, /listado, /lanzar) siguen funcionando. ` +
        `Te aviso cuando se libere alguno.`
    );
}

module.exports = {
    COMMANDER_SKILL,
    INJECTION_PATTERNS,
    DEDUP_WINDOW_MS,

    sanitizeUserPrompt,
    resolveCommanderProvider,
    formatFallbackNotice,
    shouldEmitFallbackNotice,
    auditCommanderRequest,
    readCommanderStats,
    safeBuildSpawn,

    cannedFallbackUnavailableResponse,
    cannedAllGatedResponse,

    // exports internos para tests
    _hashFor: hashFor,
    _auditFile: auditFile,
    _dedupStatePath: dedupStatePath,
    _loadDedupState: loadDedupState,
};
