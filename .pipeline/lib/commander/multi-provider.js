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
//   6. Wire a `data-residency-filter` (SR-1) — `enforceDataResidency()`
//      llama a `loadExclusionsOrThrow()` + `filterPathsForProvider()` antes
//      del spawn no-Anthropic; fail-closed si el sidecar es inválido; emite
//      eventos `data_residency_check` / `data_residency_block` al audit log
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
// ADAPTERS DE PROVIDER (estado 2026-06-02)
// ----------------------------------------
// Los 5 providers (`anthropic`, `openai-codex`, `gemini-google`, `cerebras`,
// `nvidia-nim`) hoy tienen **adapter real** en lib/agent-launcher/providers/*.js
// (PRs #3792/#3793/#3794 cerraron los últimos stubs del histórico #3198).
// `buildSpawn` ya NO tira `_notImplemented` para ninguno de ellos.
//
// `safeBuildSpawn(...)` se mantiene como guardia defensiva: envuelve
// `handler.buildSpawn` y devuelve `{ ok: false, reason }` en vez de propagar
// un throw si un provider futuro volviera a ser stub o el handler fallara.
// El caller decide el canned response sólo en ese caso de borde.
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
// #3343 / CA-SEC-8 — resolveCommanderProviderExcluding
//
// Variante PURA del resolver que excluye un provider específico (el del
// Commander del turno) y resuelve sobre un skill arbitrario (default
// `telegram-sherlock`, la cadena invertida free-first del verifier adversarial).
//
// El requisito de "implementación pura" (sin estado global mutable) lo
// cumplimos pasando un `quotaModule` wrappeado al `resolveSpawnWithFallback`
// que reporta `shouldGateSpawn = true` para el `excludedProvider` y delega
// el resto al `quotaModule` real. Así reutilizamos toda la lógica de
// fallback (cycle protection, depth cap, audit, notify) sin tocar el state
// global (el flag de cuota del provider excluido sigue intacto, no lo
// borramos ni lo seteamos).
//
// Args:
//   - excludedProvider: string del provider del Commander a excluir. Si no
//     coincide con ningún provider del chain, no excluye nada.
//   - skill: nombre del skill alternativo (default 'telegram-sherlock').
//   - issue: para audit log (default 'sherlock-verify').
//
// Devuelve el mismo shape que `resolveCommanderProvider`. Si la chain entera
// queda gateada por la exclusión + cuotas reales, `source: 'all-gated'`,
// `gated: true`.
// -----------------------------------------------------------------------------
const SHERLOCK_SKILL = 'telegram-sherlock';

function resolveCommanderProviderExcluding(excludedProvider, opts = {}) {
    const {
        pipelineDir,
        log,
        skill,
        dispatchModule,
        quotaModule,
        fsImpl,
        now,
        issue,
    } = opts;

    const _dispatch = dispatchModule || require('../agent-launcher/dispatch-with-fallback');
    const _quotaBase = quotaModule || require('../quota-exhausted');

    // Acepta string o array — Sherlock necesita excluir varios cuando va
    // descartando providers no-HTTP-compatibles del chain. Normalizamos
    // a Set<string>.
    const excludedSet = new Set();
    if (typeof excludedProvider === 'string' && excludedProvider) {
        excludedSet.add(excludedProvider);
    } else if (Array.isArray(excludedProvider)) {
        for (const p of excludedProvider) {
            if (typeof p === 'string' && p) excludedSet.add(p);
        }
    }

    // Wrapper PURO: reportamos gateado los excluded; el resto pasa al real.
    // No mutamos _quotaBase ni el filesystem.
    const wrappedQuota = {
        shouldGateSpawn(skillName, q = {}) {
            if (q && excludedSet.has(q.provider)) return true;
            return _quotaBase.shouldGateSpawn(skillName, q);
        },
        sanitizeRawExcerpt: _quotaBase.sanitizeRawExcerpt,
    };

    return _dispatch.resolveSpawnWithFallback({
        skill: skill || SHERLOCK_SKILL,
        issue: issue || 'sherlock-verify',
        pipelineDir,
        fsImpl,
        quotaModule: wrappedQuota,
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
        // CA-AUDIT-1 (#3484) — Campos enriched para análisis cross-provider
        // del Sherlock. Vienen opcionalmente; cuando el caller (sherlock-verifier)
        // los provee, los persistimos al JSONL para auditoría.
        sameProvider,
        sameModel,
        commanderModel,
        sherlockModel,
        transport,
        // #3501 CA-5 — Campos específicos del evento `sherlock_model_swap`.
        // Solo se incluyen cuando el caller (sherlock-verifier) los provee
        // para que el operador pueda filtrar con jq sin parser ad-hoc:
        //   jq 'select(.event=="sherlock_model_swap" and .provider_effective=="gemini-google")'
        swapModelOrigen,
        swapModelDestino,
        swapReason,
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
        // CA-AUDIT-1 (#3484) — 5 campos enriched. Solo se incluyen cuando el
        // caller los provee (caller típico: sherlock-verifier.emitAuditEvent).
        // Para eventos del Commander puro quedan en null/undefined y no
        // afectan el shape canónico.
        same_provider: typeof sameProvider === 'boolean' ? sameProvider : null,
        same_model: typeof sameModel === 'boolean' ? sameModel : null,
        commander_model: commanderModel || null,
        sherlock_model: sherlockModel || null,
        transport: transport || null,
        // #3501 CA-5 — Campos del evento de swap. Para eventos que NO sean
        // `sherlock_model_swap` quedan en null y no afectan el shape canónico.
        swap_model_origen: swapModelOrigen || null,
        swap_model_destino: swapModelDestino || null,
        swap_reason: swapReason || null,
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
// SR-1 — enforceDataResidency.
//
// El gate de data-residency-filter (#3084) sólo aplica a providers
// NO-Anthropic. El commander del Telegram no extrae paths declarativos del
// prompt — al menos hasta #3198, donde los adapters reales podrán parsear
// "leeme X.kt" y enviar su contenido al child. Pero el SR-1 del issue
// (2026-05-17 00:19) exige que **el dispatch verifique empíricamente** el
// filtro antes del spawn no-Anthropic, dejando trazado en el audit log y
// el wiring armado.
//
// Diseño:
//   - Llama a `loadExclusionsOrThrow()` (fail-closed; sin sidecar válido el
//     spawn no-Anthropic se aborta).
//   - Llama a `filterPathsForProvider({ paths, provider, exclusions,
//     defaultPolicy })`. `paths: []` es válido y honra el contrato; cuando
//     #3198 traiga paths reales, este caller los pasará tal cual.
//   - Si `provider !== 'anthropic'` y `blocked.length > 0` → retorna
//     `{ ok: false, reason: 'data_residency_blocked', blocked }`. El caller
//     debe responder canned y NO spawnear.
//   - Si Anthropic, o si `blocked.length === 0` → retorna `{ ok: true }` y
//     el caller continúa.
//   - Emite siempre evento al audit log:
//       * `data_residency_check` cuando pasa.
//       * `data_residency_block` cuando bloquea.
//
// Fail-closed (CA-3 del #3084): si `loadExclusionsOrThrow()` lanza por
// sidecar ausente/inválido y el provider efectivo es no-Anthropic →
// `ok: false, reason: 'sidecar_unavailable'`. Si es Anthropic, el filtro
// no aplica → `ok: true, policy: 'passthrough', sidecar: 'unavailable'`.
// -----------------------------------------------------------------------------
function enforceDataResidency(opts = {}) {
    const {
        pipelineDir,
        provider,
        paths,
        log,
        chatId,
        prompt,
        // inyectables tests
        drfModule,
        auditLog,
        fsImpl,
        now,
    } = opts;

    const _drf = drfModule || require('../data-residency-filter');
    const _paths = Array.isArray(paths) ? paths : [];
    const _provider = String(provider || 'anthropic');
    const _log = typeof log === 'function' ? log : () => {};

    let exclusions;
    let defaultPolicy;
    try {
        const loaded = _drf.loadExclusionsOrThrow();
        exclusions = loaded.exclusions;
        defaultPolicy = loaded.default_policy;
    } catch (e) {
        // Fail-closed: sidecar inválido o ausente.
        if (_provider === 'anthropic' || _provider === 'deterministic') {
            // Anthropic siempre pasa — el filtro no aplica.
            _log('commander', `⚠️ SR-1: sidecar de data-residency no disponible (${e.message}). Anthropic continúa (passthrough).`);
            return {
                ok: true,
                blocked: [],
                allowed: _paths,
                policy: 'passthrough',
                sidecar: 'unavailable',
            };
        }
        _log('commander', `❌ SR-1: sidecar de data-residency no disponible (${e.message}). Bloqueando spawn ${_provider} por fail-closed.`);
        return {
            ok: false,
            reason: 'sidecar_unavailable',
            error: e.message,
            blocked: [],
            allowed: [],
            policy: 'fail_closed',
        };
    }

    let filt;
    try {
        filt = _drf.filterPathsForProvider({
            paths: _paths,
            provider: _provider,
            exclusions,
            defaultPolicy,
        });
    } catch (e) {
        // filterPathsForProvider sólo lanza si los argumentos son inválidos
        // (no debería pasar acá). Fail-closed igual.
        _log('commander', `❌ SR-1: filterPathsForProvider falló (${e.message}). Bloqueando spawn ${_provider} por fail-closed.`);
        return {
            ok: false,
            reason: 'filter_error',
            error: e.message,
            blocked: [],
            allowed: [],
            policy: 'fail_closed',
        };
    }

    const isBlocking = _provider !== 'anthropic' && _provider !== 'deterministic' && filt.blocked.length > 0;

    // Audit log (SR-3) — siempre, sea blocked o no.
    try {
        auditCommanderRequest({
            pipelineDir,
            event: isBlocking ? 'data_residency_block' : 'data_residency_check',
            providerEffective: _provider,
            chatId,
            prompt,
            auditLog,
            fsImpl,
            now,
            // No incluimos contenido literal — solo conteos.
            errorCode: isBlocking ? 'data_residency_blocked' : null,
        });
    } catch { /* best-effort */ }

    if (isBlocking) {
        _log('commander',
            `🚫 SR-1: ${filt.blocked.length} path(s) bloqueados para ${_provider} ` +
            `(patterns=${[...new Set(filt.blocked.map(b => b.pattern))].join(', ')})`);
        return {
            ok: false,
            reason: 'data_residency_blocked',
            blocked: filt.blocked,
            allowed: filt.allowed,
            policy: filt.policy,
        };
    }

    return {
        ok: true,
        blocked: filt.blocked,
        allowed: filt.allowed,
        policy: filt.policy,
    };
}

// -----------------------------------------------------------------------------
// SR-1 — cannedDataResidencyResponse.
//
// Mensaje al usuario cuando el gate de data-residency bloqueó el spawn al
// provider no-Anthropic. NO mencionamos los paths concretos (SR-7) — sólo
// el conteo y el provider efectivo. Sugerencia accionable al final.
// -----------------------------------------------------------------------------
function cannedDataResidencyResponse({ provider, blocked }) {
    const n = Array.isArray(blocked) ? blocked.length : 0;
    return (
        `⚠️ No puedo procesar tu pedido vía \`${provider}\` porque toca ` +
        `${n} archivo${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'} como sensible${n === 1 ? '' : 's'} ` +
        `(secrets, credenciales o auditorías internas). ` +
        `Esperá a que Claude vuelva, o reformulá el pedido sin esos paths.`
    );
}

// -----------------------------------------------------------------------------
// #3434 — runCommanderSpawn (wire post-spawn del parser de errores)
//
// El parser `lib/commander/provider-error-parser.js#parseProviderError` clasifica
// la salida de un spawn LLM del Commander en categorías estructuradas
// (`quota_exhausted | rate_limit | transient_5xx | auth | permanent_failure |
// unknown`). Este wrapper conecta la decisión con dos efectos:
//
//   1. **setFlag**: si `errorClass ∈ {quota_exhausted, rate_limit}` →
//      `quotaModule.setFlag({ provider, errorType, ... })`. El siguiente
//      dispatch consulta el flag y rota al próximo provider de la chain.
//      Para `transient_5xx | auth | permanent_failure | unknown` NO se
//      escribe flag (ver matriz en parser).
//
//   2. **audit log**: emite `auditCommanderRequest()` con `event` derivado
//      del veredicto del parser y `decision` documentando qué se hizo.
//      Esto cierra CA-6 del issue (`chain_tried` refleja realmente todos
//      los providers que se intentaron).
//
// El wrapper es **post-spawn estricto** — el caller decide qué pasar:
//   - `stdout/stderr`: el caller debe pasar SOLO stderr (no stdout) para
//     transport=cli, para evitar el confused-deputy del SR-1. Para
//     transport=api, pasar la respuesta cruda del fetch (JSON/SSE entero).
//   - `provider/transport`: inputs autoritativos. El parser falla cerrado
//     si vienen vacíos o desconocidos.
//   - `timedOut/exitCode/durationMs`: signals del wrapper de spawn. Se
//     pasan tal cual al parser.
//
// El retorno del wrapper incluye el resultado del parser + flags de
// efectos colaterales que el caller PUEDE necesitar (`flagSet: boolean`,
// `auditLogged: boolean`). El caller decide si rotar el spawn al siguiente
// provider en el MISMO turno (out of scope #3434; cubierto por #3275).
// -----------------------------------------------------------------------------
function runCommanderSpawn(opts = {}) {
    const {
        pipelineDir,
        provider,
        transport,
        rawOutput,
        timedOut,
        exitCode,
        durationMs,
        chatId,
        prompt,
        requestId,
        chainTried,
        primaryProvider,
        // inyectables tests
        parserModule,
        quotaModule,
        auditLog,
        fsImpl,
        now,
    } = opts;

    const _parser = parserModule || require('./provider-error-parser');
    const _quota = quotaModule || require('../quota-exhausted');

    // 1. Clasificar via parser.
    const verdict = _parser.parseProviderError(rawOutput, {
        provider,
        transport,
        timedOut,
        exitCode,
        durationMs,
        _quotaModule: _quota,
    });

    // 2. SR-7: persistir flag SOLO para quota_exhausted / rate_limit y
    //    SOLO si el errorType extraído del evidence existe en la
    //    KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER del provider. El parser
    //    ya respetó esa allowlist al clasificar `quota_exhausted` por
    //    shape estructural; para clases derivadas por regex heurístico
    //    usamos un errorType genérico documentado por provider.
    let flagSet = false;
    if (verdict.errorClass === 'quota_exhausted' || verdict.errorClass === 'rate_limit') {
        try {
            const errorType = _selectErrorTypeForFlag(provider, verdict, _quota);
            if (errorType) {
                _quota.setFlag({
                    provider,
                    errorType,
                    rawExcerpt: verdict.evidence,
                    agent: COMMANDER_SKILL,
                });
                flagSet = true;
            }
        } catch (e) {
            // best-effort: si setFlag falla, igual logueamos al audit.
        }
    }

    // 3. Audit log unificado (SR-8).
    let auditLogged = false;
    if (pipelineDir) {
        const decision =
            verdict.errorClass === 'unknown' ? 'ignore' :
            flagSet ? 'flag_set' :
            verdict.shouldFallback ? 'fallback' :
            'ignore';
        try {
            auditCommanderRequest({
                pipelineDir,
                event: 'provider_error_parsed',
                providerEffective: provider,
                providerIntended: primaryProvider || provider,
                chainTried: Array.isArray(chainTried) ? chainTried : null,
                chatId,
                prompt,
                latencyMs: durationMs,
                requestId,
                errorCode: verdict.errorClass,
                auditLog,
                fsImpl,
                now,
                // Sumamos el extracto saneado del evidence para diagnóstico.
                // (no incluimos `raw` para no inflar el log).
            });
            auditLogged = true;
        } catch { /* best-effort */ }
    }

    return {
        ...verdict,
        flagSet,
        auditLogged,
        decision:
            verdict.errorClass === 'unknown' ? 'ignore' :
            flagSet ? 'flag_set' :
            verdict.shouldFallback ? 'fallback' :
            'ignore',
    };
}

// -----------------------------------------------------------------------------
// _selectErrorTypeForFlag — elige un errorType válido de
// KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider] para persistir en el flag.
//
// SR-7: NUNCA persistir un errorType que no esté en la allowlist del
// provider — eso contaminaría el flag y rompería la cross-validation del
// `lib/agent-models-validate.js`. Si no podemos encontrar un valor seguro,
// devolvemos `null` y el caller skipea el setFlag.
//
// Estrategia:
//   1. Si el `evidence` parsea como JSON con shape `error_type` o `type` y
//      ese valor está en la allowlist → usarlo.
//   2. Si no, usar el primer valor de la allowlist como "default safe"
//      del provider.
//   3. Si la allowlist está vacía → null.
// -----------------------------------------------------------------------------
function _selectErrorTypeForFlag(provider, verdict, quotaModule) {
    const allowlist =
        (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
    if (allowlist.length === 0) return null;

    // 1. Intentar extraer del evidence si es JSON.
    try {
        const trimmed = (verdict.evidence || '').trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('data:')) {
            const jsonStr = trimmed.startsWith('data:')
                ? trimmed.replace(/^data:\s*/, '')
                : trimmed;
            const parsed = JSON.parse(jsonStr);
            // Buscar candidate en los shapes conocidos:
            //   - Anthropic stream-json: { type:'result', is_error:true, error_type:'usage_limit_error' }
            //   - OpenAI SSE: { event:'error', data:{ error:{ type, code } } }
            //   - Alt OpenAI: { type:'response.error', error:{ type } }
            //   - API directa: { error:{ type, code } }
            const candidates = [
                parsed.error_type,
                parsed.error && parsed.error.type,
                parsed.error && parsed.error.code,
                parsed.data && parsed.data.error && parsed.data.error.type,
                parsed.data && parsed.data.error && parsed.data.error.code,
                // `parsed.type` solo si NO es marker SSE genérico
                (parsed.type && parsed.type !== 'response.error' && parsed.type !== 'result')
                    ? parsed.type
                    : null,
            ];
            for (const candidate of candidates) {
                if (candidate && allowlist.includes(candidate)) {
                    return candidate;
                }
            }
        }
    } catch { /* fallthrough */ }

    // 2. Default safe = primer elemento de la allowlist del provider.
    return allowlist[0];
}

// -----------------------------------------------------------------------------
// safeBuildSpawn — wrapper defensivo para `handler.buildSpawn` que captura
// un eventual throw (guardia residual; hoy los 5 adapters son reales).
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
// extractFallbackReply — normaliza el stdout de un provider de respaldo a un
// único mensaje conversacional listo para Telegram.
//
// Problema que resuelve: los providers no-Anthropic (codex `exec --json`,
// gemini, cerebras, nvidia) emiten su salida como **JSONL** (un evento por
// línea), NO como texto plano. El path de fallback del commander capturaba el
// `stdout` crudo y lo mandaba tal cual a Telegram — el TTS partía ese stream de
// eventos en una lluvia de audios cortos y técnicos, totalmente heterogéneo con
// la voz del Commander cuando corre sobre Claude.
//
// Codex marca el mensaje final del asistente con un evento
// `item.completed` cuyo `item.type === 'agent_message'` y el texto en
// `item.text`. Concatenamos todos los `agent_message` en orden (por si el
// provider parte la respuesta en varios) y devolvemos sólo eso.
//
// Contrato de salida: { text, parsed }
//   - parsed=true  → extrajimos al menos un agent_message (homogéneo).
//   - parsed=false + text==''  → era JSONL pero sin agent_message: el caller
//     responde canned en lugar de dumpear el stream crudo.
//   - parsed=false + text!=''  → no era JSONL (provider de texto plano):
//     devolvemos el texto tal cual (best-effort, back-compat).
// -----------------------------------------------------------------------------
function extractFallbackReply(stdout) {
    const raw = typeof stdout === 'string' ? stdout : '';
    if (!raw.trim()) return { text: '', parsed: false };

    const messages = [];
    let sawJson = false;
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let obj;
        try { obj = JSON.parse(t); } catch { continue; }
        sawJson = true;
        if (obj && obj.type === 'item.completed' && obj.item
            && obj.item.type === 'agent_message'
            && typeof obj.item.text === 'string') {
            messages.push(obj.item.text);
        }
    }

    if (messages.length > 0) {
        return { text: messages.join('\n\n').trim(), parsed: true };
    }
    // JSONL sin agent_message → vacío: el caller cae al canned y NO dumpea el
    // stream crudo. Texto plano → lo devolvemos tal cual (comportamiento previo).
    if (sawJson) return { text: '', parsed: false };
    return { text: raw.trim(), parsed: false };
}

// -----------------------------------------------------------------------------
// cannedFallbackUnavailableResponse — Mensaje al usuario para el caso de borde
// en que el dispatcher resolvió un fallback pero su `buildSpawn` falla (handler
// roto / binario ausente). Mensaje no técnico, sin paths internos.
// -----------------------------------------------------------------------------
function cannedFallbackUnavailableResponse({ provider }) {
    return (
        `⚠️ Claude no responde y el provider de respaldo \`${provider}\` no arrancó (binario o credencial faltante). ` +
        `Mientras lo reviso, podés usar los comandos directos (/status, /listado, /lanzar) que no dependen de LLM.`
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

// -----------------------------------------------------------------------------
// #3275 — Re-export del módulo de fallback in-flight para tener una sola
// superficie pública en `require('./multi-provider')`. El módulo dedicado
// vive en `./inflight-fallback.js` y tiene su propia suite de tests.
// -----------------------------------------------------------------------------
const inflight = require('./inflight-fallback');
const credPrecheck = require('./credentials-precheck');

module.exports = {
    COMMANDER_SKILL,
    SHERLOCK_SKILL,
    INJECTION_PATTERNS,
    DEDUP_WINDOW_MS,

    sanitizeUserPrompt,
    resolveCommanderProvider,
    resolveCommanderProviderExcluding,
    formatFallbackNotice,
    shouldEmitFallbackNotice,
    auditCommanderRequest,
    readCommanderStats,
    safeBuildSpawn,
    extractFallbackReply,
    enforceDataResidency,
    runCommanderSpawn,

    cannedFallbackUnavailableResponse,
    cannedAllGatedResponse,
    cannedDataResidencyResponse,

    // #3275 — in-flight fallback (re-export del módulo dedicado)
    decideInflightFallback: inflight.decideInflightFallback,
    noteInflightCompleted: inflight.noteInflightCompleted,
    noteLateResponseDiscarded: inflight.noteLateResponseDiscarded,
    formatInflightFallbackNotice: inflight.formatInflightFallbackNotice,
    cannedInflightExhaustedResponse: inflight.cannedInflightExhaustedResponse,
    cannedInflightBudgetTimeoutResponse: inflight.cannedInflightBudgetTimeoutResponse,
    acquireInflightLock: inflight.acquireInflightLock,
    isLateResponseDuplicate: inflight.isLateResponseDuplicate,
    releaseInflightLock: inflight.releaseInflightLock,
    generateRequestId: inflight.generateRequestId,
    INFLIGHT_BUDGET_MS: inflight.DEFAULT_BUDGET_MS,
    MAX_INFLIGHT_FALLBACKS: inflight.MAX_INFLIGHT_FALLBACKS,

    // #3275 — credentials precheck al boot
    precheckCommanderProviderRanking: credPrecheck.precheckCommanderProviderRanking,
    makePrecheckHandle: credPrecheck.makePrecheckHandle,
    formatPrecheckReport: credPrecheck.formatPrecheckReport,

    // exports internos para tests
    _hashFor: hashFor,
    _auditFile: auditFile,
    _dedupStatePath: dedupStatePath,
    _loadDedupState: loadDedupState,
    _selectErrorTypeForFlag,
};
