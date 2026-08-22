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

// #4413 (A02) — redacción en origen de todo campo de texto libre nuevo de la
// ruta de balanceo antes de que llegue al audit log. `selection_reason` es un
// enum acotado por el balancer, pero lo pasamos igual por `redactSecretValue`
// (defensa en profundidad: si alguna vez arrastra texto libre, no viajan
// secretos). Carga perezosa para no penalizar el require en callers que no
// tocan la ruta de balanceo.
let _redact = null;
function redactModule() {
    if (_redact === null) {
        try { _redact = require('../redact'); } catch { _redact = false; }
    }
    return _redact || null;
}

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
        // #4412 (Parte 2/3) — insumos del balanceo ponderado (todos opcionales;
        // con el feature flag OFF por default este camino es un no-op).
        requestText,
        requiresToolUse,
        balancerModule,
        resolveProviderModule,
        agentModelsReader,
        requestClassifyModule,
        balancerStore,
        // #4413 — stickiness por conversación (opcional; sólo relevante con el
        // balanceo ON). `chatId` se hashea dentro del balancer con `hashFor`.
        chatId,
        stickinessModule,
    } = opts;

    const _dispatch = dispatchModule || require('../agent-launcher/dispatch-with-fallback');
    const _quota = quotaModule || require('../quota-exhausted');
    const _log = typeof log === 'function' ? log : () => {};

    // #4412 — branch del balancer ANTES de la cadena estricta. Con
    // `balancing.enabled=false` (default) o 0 providers sanos devuelve null y
    // caemos al `resolveSpawnWithFallback` de siempre (CA-7 regresión cero /
    // CA-8 fallback estricto). Cualquier error del balancer degrada al camino
    // estricto: el balanceo NUNCA puede dejar mudo al Commander.
    try {
        const balanced = _resolveViaBalancer({
            pipelineDir,
            fsImpl,
            now,
            log: _log,
            quotaModule: _quota,
            requestText,
            requiresToolUse,
            balancerModule,
            resolveProviderModule,
            agentModelsReader,
            requestClassifyModule,
            balancerStore,
            chatId,
            stickinessModule,
        });
        if (balanced) return balanced;
    } catch (e) {
        _log('commander', `⚠️ #4412 balanceo degradó a orden estricto: ${(e && e.message) || e}`);
    }

    // #4413 CA-9 — la cadena estricta no produce metadata de balanceo; la
    // normalizamos a null para que el shape sea idéntico al balanceado (CA-1) y
    // el audit persista siempre las 3 claves aditivas (null en el camino OFF).
    const strict = _dispatch.resolveSpawnWithFallback({
        skill: COMMANDER_SKILL,
        issue: issue || 'commander-chat',
        pipelineDir,
        fsImpl,
        quotaModule: _quota,
        onLog: _log,
        now,
    });
    return _normalizeBalancerMeta(strict);
}

// -----------------------------------------------------------------------------
// #4565 (rebote rev-1) — ¿la cadena de fallback del commander está ENTERAMENTE
// gateada? Chequeo READ-ONLY para el gate de cuota del pulpo (pre-ejecutarClaude).
//
// El bug del rebote: el gate consultaba solo si el PRIMARIO (Anthropic) estaba
// agotado y, de estarlo, respondía canned determinístico ANTES de que el
// dispatcher pudiera resolver un fallback sano (viola CA-3). La autoridad real
// sobre "¿hay algún provider para procesar texto libre?" es la resolución de la
// cadena completa: `resolveSpawnWithFallback(...).gated` es true SOLO cuando el
// primario y TODOS los fallbacks están gateados.
//
// Reusamos `resolveSpawnWithFallback` (la MISMA lógica que usa `ejecutarClaude`
// vía `resolveCommanderProvider`) pero silenciando TODO side-effect: sin escritura
// de audit (`auditLog` no-op), sin notice a Telegram (`notify` no-op) y sin logs
// (`onLog` no-op). NO pasamos por el balancer (`_resolveViaBalancer`) para no
// tocar contadores/stickiness: la determinación de "gated" es idéntica en ambos
// caminos (si la cadena estricta encuentra un sano, el balanceo también; si la
// estricta reporta all-gated, el balanceo devuelve null → cae a la estricta).
//
// Fail-open: ante cualquier error devuelve `false` (NO bloquear). Nunca queremos
// que un bug del resolver deje mudo al commander con canned cuando podría haber
// un provider sano; `ejecutarClaude` re-resuelve y decide con su propio manejo.
// -----------------------------------------------------------------------------
function isCommanderChainGated(opts = {}) {
    const { pipelineDir, fsImpl, quotaModule, now, dispatchModule } = opts;
    try {
        const _dispatch = dispatchModule || require('../agent-launcher/dispatch-with-fallback');
        const res = _dispatch.resolveSpawnWithFallback({
            skill: COMMANDER_SKILL,
            issue: 'commander-gate-check',
            pipelineDir,
            fsImpl,
            quotaModule: quotaModule || require('../quota-exhausted'),
            now,
            onLog: () => {},                          // sin logs
            notify: () => {},                         // sin notice a Telegram
            auditLog: { appendChained: () => {} },    // sin escritura de audit
            recordEpisode: false,                     // #6179 — sin tocar el episodio
        });
        return !!(res && res.gated);
    } catch {
        return false; // fail-open: nunca pre-emptir con canned por un bug propio
    }
}

// -----------------------------------------------------------------------------
// #4870 — ¿el commander está en "modo reducido"? READ-ONLY.
//
// Modo reducido = TODOS los providers PAGOS (billing:'paid' → Anthropic, Codex)
// están gateados por cuota, PERO queda al menos un provider FREE sano en la chain
// (billing:'free' → Gemini, Cerebras, NVIDIA NIM). En ese estado el Commander NO
// ejecuta acciones: responde un aviso advisory (cannedReducedModeResponse) y NO
// spawnea el free (decisión de PO D1 — least-privilege, no quema free tier).
//
// La distinción con `isCommanderChainGated` es clave (CA-5): si la chain está
// ENTERAMENTE gateada (ni pagos ni frees sanos) → `res.gated === true` → NO es
// modo reducido (es "todos caídos" → canned all-providers-failed existente).
// Modo reducido SOLO cuando la resolución NO está gated pero el candidato
// resuelto es `providerBilling === 'free'` (los pagos gateados dejaron un free
// sano como candidato).
//
// Estado DERIVADO EN VIVO de la resolución de cuota por-provider (los flags se
// limpian al resetear la ventana): sin flag sticky persistido (SEC-REQ-3). Al
// recuperarse un pago, el próximo dispatch resuelve a pago y sale solo (CA-4).
//
// Reusa el patrón read-only silenciado de `isCommanderChainGated` (sin audit,
// sin notice, sin logs, sin balancer). Fail-open: ante cualquier error devuelve
// `false` (nunca dejar mudo al Commander por un bug propio).
// -----------------------------------------------------------------------------
function isReducedMode(opts = {}) {
    const { pipelineDir, fsImpl, quotaModule, now, dispatchModule } = opts;
    try {
        const _dispatch = dispatchModule || require('../agent-launcher/dispatch-with-fallback');
        const res = _dispatch.resolveSpawnWithFallback({
            skill: COMMANDER_SKILL,
            issue: 'commander-reduced-check',
            pipelineDir,
            fsImpl,
            quotaModule: quotaModule || require('../quota-exhausted'),
            now,
            onLog: () => {},                          // sin logs
            notify: () => {},                         // sin notice a Telegram
            auditLog: { appendChained: () => {} },    // sin escritura de audit
            recordEpisode: false,                     // #6179 — sin tocar el episodio
        });
        return !!(res && !res.gated && res.providerBilling === 'free');
    } catch {
        return false; // fail-open: nunca advisory-lock por un bug propio
    }
}

// -----------------------------------------------------------------------------
// #4870 — shouldRespondReducedMode: decisión COMBINADA de si el Commander debe
// responder en modo reducido. Función PURA (combina el gate de rollout de
// config con el estado derivado en vivo) para que CA-7 (enabled:false → flujo
// idéntico al actual, regresión cero) sea unit-testeable sin arrancar el pulpo.
//
// `config` = bloque `reduced_mode` de config.yaml ({ enabled, kill_switch }).
// Con `enabled !== true` (default OFF) o `kill_switch === true` devuelve false
// SIN consultar la resolución de cuota — regresión cero + corte de emergencia.
// Sólo cuando el rollout está activo consulta `isReducedMode(...)`.
// -----------------------------------------------------------------------------
function shouldRespondReducedMode(opts = {}) {
    const { config, ...rest } = opts;
    const cfg = config || {};
    if (cfg.enabled !== true) return false;      // rollout OFF → flujo actual
    if (cfg.kill_switch === true) return false;  // corte de emergencia
    return isReducedMode(rest);
}

// #4413 — asegura que una resolución exponga las 3 claves de metadata de
// balanceo (weight/quotaPct/selectionReason). Si ya vienen (camino balanceado),
// no las pisa; si no (camino estricto), las agrega en null. Aditivo: preserva
// el resto del shape. Devuelve el mismo objeto (o uno vacío si `res` es falsy).
function _normalizeBalancerMeta(res) {
    if (!res || typeof res !== 'object') return res;
    if (!('weight' in res)) res.weight = null;
    if (!('quotaPct' in res)) res.quotaPct = null;
    if (!('selectionReason' in res)) res.selectionReason = null;
    // #4870 — default fail-safe para el shape simétrico: cualquier resolución que
    // no traiga `providerBilling` (paths legacy sin quotaModule) queda 'free'.
    if (!('providerBilling' in res)) res.providerBilling = 'free';
    return res;
}

// -----------------------------------------------------------------------------
// #4412 (Parte 2/3 de #4363) — Integración del selector ponderado de providers.
//
// `_resolveViaBalancer` consulta `lib/commander/provider-balancer.js` (Parte 1,
// #4411) SOLO cuando el skill `telegram-commander` tiene `balancing.enabled=true`
// en `agent-models.json`. Construye la `chain` a partir de `provider` (primario)
// + `fallbacks[]` (NO expande launchers — req A01 / SEC-1), llama al selector y,
// si devuelve un provider sano, arma el MISMO shape de retorno que
// `resolveSpawnWithFallback` (CA-1). Devuelve `null` cuando el flag está OFF, el
// balancer no elige nadie (0 sanos, CA-8), o el helper de clasificación tool/chat
// no está disponible (degradación segura, CA-7).
// -----------------------------------------------------------------------------
const BALANCER_STATE_FILE = 'commander-balancer-state.json';

function balancerStatePath(pipelineDir) {
    return path.join(pipelineDir || '.', BALANCER_STATE_FILE);
}

// Claves peligrosas que JAMÁS deben terminar como contadores (anti
// prototype-pollution, SEC-3). El allowlist por `chain` ya las excluye, pero
// las dejamos explícitas como defensa en profundidad.
const DANGEROUS_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Lee `commander-balancer-state.json` (best-effort). Devuelve
 * `{ counters: {} }` ante ausencia, JSON inválido o shape inesperado (default
 * seguro, contadores en 0 — mismo patrón fail-soft del resto del módulo). Los contadores
 * se filtran por `allowSet`: SOLO providers presentes en la chain sobreviven;
 * cualquier clave espuria del archivo (incl. `__proto__`) se ignora.
 */
function loadBalancerState(pipelineDir, fsImpl, allowSet) {
    const _fs = fsImpl || fs;
    const allow = allowSet instanceof Set
        ? allowSet
        : new Set(Array.isArray(allowSet) ? allowSet : []);
    const safe = { counters: {} };
    const file = balancerStatePath(pipelineDir);
    let parsed;
    try {
        if (!_fs.existsSync(file)) return safe;
        parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
    } catch {
        return safe; // default seguro, nunca crashear el dispatch (SEC-3 / CA-6)
    }
    const rawCounters = parsed && typeof parsed === 'object'
        && parsed.counters && typeof parsed.counters === 'object'
        ? parsed.counters
        : {};
    for (const k of Object.keys(rawCounters)) {
        if (DANGEROUS_KEYS.includes(k)) continue;
        if (!allow.has(k)) continue; // allowlist contra fallbacks[] (SEC-3)
        const v = Number(rawCounters[k]);
        if (Number.isFinite(v)) safe.counters[k] = v;
    }
    return safe;
}

function saveBalancerState(counters, pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const file = balancerStatePath(pipelineDir);
    try {
        _fs.writeFileSync(file, JSON.stringify({ counters: counters || {} }, null, 2), 'utf8');
        return true;
    } catch {
        return false; // best-effort: la persistencia fallida no rompe la selección
    }
}

/**
 * Construye el `store` SWRR que consume `provider-balancer.js` (`readState()` /
 * `writeState(state)` con shape `{ current: {...} }`). Adapta el archivo persistido
 * (`{ counters }`) al contrato del balancer y re-aplica el allowlist en ambas
 * direcciones (lectura y escritura) para blindar contra prototype-pollution.
 */
function makeBalancerStore(pipelineDir, fsImpl, allowSet) {
    const allow = allowSet instanceof Set
        ? allowSet
        : new Set(Array.isArray(allowSet) ? allowSet : []);
    return {
        readState() {
            const st = loadBalancerState(pipelineDir, fsImpl, allow);
            return { current: st.counters };
        },
        writeState(state) {
            const cur = (state && state.current && typeof state.current === 'object')
                ? state.current
                : {};
            const out = {};
            for (const k of Object.keys(cur)) {
                if (DANGEROUS_KEYS.includes(k)) continue;
                if (!allow.has(k)) continue;
                const v = Number(cur[k]);
                if (Number.isFinite(v)) out[k] = v;
            }
            saveBalancerState(out, pipelineDir, fsImpl);
        },
    };
}

function _resolveViaBalancer(ctx = {}) {
    const {
        pipelineDir,
        fsImpl,
        now,
        log,
        quotaModule,
        requestText,
        requiresToolUse,
        balancerModule,
        resolveProviderModule,
        agentModelsReader,
        requestClassifyModule,
        balancerStore,
        // #4413 (Parte 3/3) — stickiness por conversación. `chatId` se hashea
        // acá con `hashFor` (nunca se materializa crudo); `stickinessModule` es
        // inyectable en tests.
        chatId,
        stickinessModule,
    } = ctx;
    const _fs = fsImpl || fs;
    const _log = typeof log === 'function' ? log : () => {};

    // 1. Config del skill telegram-commander desde agent-models.json.
    const _rp = resolveProviderModule || require('../agent-launcher/resolve-provider');
    const models = typeof agentModelsReader === 'function'
        ? agentModelsReader(pipelineDir, _fs)
        : _rp.readAgentModels(pipelineDir, _fs);
    if (!models || models.__readError) return null;
    const skillCfg = (models.skills && models.skills[COMMANDER_SKILL]) || null;
    if (!skillCfg) return null;

    // 2. Feature flag. OFF por default → regresión cero (CA-7).
    const balCfg = skillCfg.balancing;
    if (!balCfg || balCfg.enabled !== true) return null;

    // 3. Clasificación tool-vs-chat. Si el helper no está disponible en runtime,
    //    degradación segura a orden estricto (CA-7).
    let needsToolUse;
    if (typeof requiresToolUse === 'boolean') {
        needsToolUse = requiresToolUse;
    } else {
        let rc;
        try {
            rc = requestClassifyModule || require('./request-classify');
        } catch {
            rc = null;
        }
        if (!rc || typeof rc.isToolUseRequest !== 'function') {
            _log('commander', '↩️ #4412 clasificador tool-vs-chat no disponible — orden estricto.');
            return null;
        }
        try {
            needsToolUse = rc.isToolUseRequest(requestText) === true;
        } catch {
            return null;
        }
    }

    // 4. Chain = primario + fallbacks[] (SOLO nombres ya declarados; NO expande
    //    la superficie de lanzamiento — req A01 / SEC-1).
    const primaryProvider = skillCfg.provider || 'anthropic';
    const fallbackEntries = Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];
    const chain = [primaryProvider];
    for (const fb of fallbackEntries) {
        const name = typeof fb === 'string'
            ? fb
            : (fb && typeof fb === 'object' && typeof fb.provider === 'string' ? fb.provider : null);
        if (name && !chain.includes(name)) chain.push(name);
    }
    if (chain.length < 2) return null; // sin alternativas reales → orden estricto

    // 5. modelsMeta para el gate de tool-use (fail-closed en el balancer).
    const modelsMeta = {};
    if (models.providers && typeof models.providers === 'object') {
        for (const p of chain) {
            const def = models.providers[p];
            if (def && typeof def === 'object') {
                modelsMeta[p] = { supports_tool_use: def.supports_tool_use === true };
            }
        }
    }

    // 6. Store SWRR best-effort con allowlist anti prototype-pollution.
    const allowSet = new Set(chain);
    const store = balancerStore || makeBalancerStore(pipelineDir, _fs, allowSet);

    // 7. Deps compartidas por el balancer (candidatos + pesos + SWRR).
    const _balancer = balancerModule || require('./provider-balancer');
    const deps = {
        modelsMeta,
        store,
        now: typeof now === 'function' ? now : undefined,
        // shouldGateSpawn del quotaModule efectivo (test inyecta el fake).
        shouldGateSpawn: quotaModule && typeof quotaModule.shouldGateSpawn === 'function'
            ? (skill, q) => quotaModule.shouldGateSpawn(skill, q)
            : undefined,
        config: {
            quality_bias: Number.isFinite(balCfg.quality_bias) ? balCfg.quality_bias : undefined,
            min_primary_quota_pct: Number.isFinite(balCfg.min_primary_quota_pct)
                ? balCfg.min_primary_quota_pct
                : undefined,
        },
    };

    // 8. Stickiness por conversación (D3, #4413). El balanceo es POR
    //    CONVERSACIÓN, no por request: consultamos el provider pegado al
    //    `chat_id_hash` ANTES de reelegir. Sólo lo reusamos si sigue en el
    //    conjunto de candidatos SANOS del balancer (no gateado, con credencial,
    //    tool-use compatible) — si se gateó o expiró la ventana, se fuerza
    //    reelección (nunca pinnea a un provider caído). El hash blinda la PII:
    //    `hashFor(chatId)` nunca materializa el `chat_id` crudo.
    const _stick = stickinessModule || require('./provider-stickiness');
    const chatIdHash = hashFor(chatId || 'unknown');
    const nowMs = typeof now === 'function'
        ? now()
        : (Number.isFinite(now) ? now : Date.now());
    const windowMs = Number.isFinite(balCfg.stickiness_window_ms) && balCfg.stickiness_window_ms > 0
        ? balCfg.stickiness_window_ms
        : undefined; // undefined → default del módulo (30 min)

    let picked = null;

    let sticky = null;
    try {
        sticky = _stick.getStickyProvider({ chatIdHash, now: nowMs, windowMs });
    } catch { sticky = null; }

    if (sticky) {
        let candidates = [];
        try {
            candidates = _balancer._buildCandidateSet({
                chain, requiresToolUse: needsToolUse, pipelineDir, deps,
            });
        } catch { candidates = []; }
        const cand = Array.isArray(candidates)
            ? candidates.find((c) => c && c.provider === sticky)
            : null;
        if (cand) {
            // Recuperar el peso del sticky para la auditoría (mismo cálculo que
            // usaría el SWRR). No avanzamos el contador SWRR: reusar el sticky
            // es justamente saltear la rotación por-request.
            let weightVal = null;
            try {
                const weighted = _balancer._computeWeights(candidates, deps.config || {});
                const w = Array.isArray(weighted)
                    ? weighted.find((x) => x && x.provider === sticky)
                    : null;
                if (w && Number.isFinite(w.weight)) weightVal = w.weight;
            } catch { weightVal = null; }
            picked = {
                provider: sticky,
                weight: weightVal,
                quotaPct: cand.quotaPct == null ? null : cand.quotaPct,
                reason: 'stickiness',
            };
            _log('commander', `📌 #4413 stickiness: conversación pegada a "${sticky}" (ventana activa).`);
        } else {
            _log('commander', `📌 #4413 stickiness: "${sticky}" ya no está sano — reelección forzada (D3).`);
        }
    }

    if (!picked) {
        // Reelección ponderada: conversación nueva, ventana expirada o sticky
        // gateado. El provider elegido queda pegado para los próximos turnos.
        picked = _balancer.selectProvider({
            chain, requiresToolUse: needsToolUse, pipelineDir, deps,
        });
        if (picked && picked.provider) {
            try {
                _stick.setStickyProvider({ chatIdHash, provider: picked.provider, now: nowMs });
            } catch { /* best-effort: la stickiness nunca rompe el dispatch */ }
        }
    }

    // 9. 0 sanos → null → cadena estricta (CA-8).
    if (!picked || !picked.provider) return null;

    return _buildBalancedResolution({
        picked,
        models,
        skillCfg,
        chain,
        primaryProvider,
        fallbackEntries,
        resolveProviderModule: _rp,
        log: _log,
    });
}

/**
 * Arma el shape canónico de `resolveSpawnWithFallback` para el provider que
 * eligió el balancer. Devuelve `null` si el provider elegido no tiene handler
 * registrado (defense in depth: cae a orden estricto). Las claves del objeto
 * espejan EXACTAMENTE las de la resolución estricta (primario o fallback) para
 * que el shape de retorno no cambie (CA-1).
 */
function _buildBalancedResolution(args = {}) {
    const {
        picked, models, skillCfg, chain, primaryProvider, fallbackEntries,
        resolveProviderModule, log,
    } = args;
    const _rp = resolveProviderModule || require('../agent-launcher/resolve-provider');
    const _log = typeof log === 'function' ? log : () => {};
    const provider = picked.provider;

    let handler;
    try {
        handler = _rp.getProviderHandler(provider); // valida contra tabla hardcoded
    } catch {
        _log('commander', `↩️ #4412 provider "${provider}" sin handler — orden estricto.`);
        return null;
    }
    const mode = _rp.resolvePermissionMode(models, provider);
    const defaultModel = (models.defaults && models.defaults.model) || null;
    const isPrimary = provider === primaryProvider;

    // #4413 CA-9 — metadata ADITIVA de la decisión de ruteo para la auditoría.
    // El caller (pulpo) la pasa a `auditCommanderRequest`. En el camino estricto
    // (OFF) estas claves no existen → el audit las persiste como null.
    // #4870 — `providerBilling` del provider elegido, para mantener el shape
    // idéntico al del camino estricto (que lo expone vía dispatch). FAIL-SAFE:
    // default 'free' si el provider no declara `billing`.
    const _pickedBillingDef = (models.providers && models.providers[provider]) || null;
    const balMeta = {
        weight: Number.isFinite(picked.weight) ? picked.weight : null,
        quotaPct: Number.isFinite(picked.quotaPct) ? picked.quotaPct : null,
        selectionReason: picked.reason ? String(picked.reason) : null,
        providerBilling: (_pickedBillingDef && _pickedBillingDef.billing === 'paid') ? 'paid' : 'free',
    };

    // #6271 — el camino estricto expone `models_by_provider` (mapa
    // {provider: model} de toda la cadena declarada) porque delega en
    // `resolveProviderForSkill`. El camino balanceado arma su objeto a mano, asi
    // que la clave hay que espejarla explicitamente o el shape OFF/ON diverge
    // (#4412 CA-1 exige claves IDENTICAS). El mapa NO depende del eslabon que
    // eligio el balancer: describe la cadena declarada completa, igual que en OFF.
    // Defensivo: si el modulo inyectado no expone el helper (fake parcial en
    // tests), degradamos a {} — la clave existe igual y el shape no se rompe.
    const modelsByProvider = typeof _rp.resolveModelsByProvider === 'function'
        ? _rp.resolveModelsByProvider(models, COMMANDER_SKILL)
        : {};

    if (isPrimary) {
        // Espejo EXACTO del shape estricto-primario (…resolveProviderForSkill +
        // metadatos de dispatch). Mismas claves que el retorno OFF (CA-1).
        const model = skillCfg.model_override || skillCfg.model || defaultModel;
        return {
            provider,
            model,
            models_by_provider: modelsByProvider,
            mode,
            handler,
            source: 'balanced',
            interactive_supported: skillCfg.interactive_supported === true,
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
            skipReasons: [],
            ...balMeta,
        };
    }

    // Provider de fallback elegido por peso: espejo del shape estricto-fallback.
    const entry = fallbackEntries.find((fb) =>
        (typeof fb === 'object' && fb ? fb.provider : fb) === provider);
    const override = entry && typeof entry === 'object' ? entry.model_override : null;
    const provDef = (models.providers && models.providers[provider]) || null;
    const model = override || (provDef && provDef.model) || defaultModel;
    const idx = chain.indexOf(provider) - 1; // índice en fallbacks[]

    return {
        provider,
        model,
        models_by_provider: modelsByProvider,
        handler,
        mode,
        source: 'balanced',
        gated: false,
        fallbackUsed: { index: idx, provider },
        primaryProvider,
        chainTried: chain.slice(0, chain.indexOf(provider) + 1),
        crossProvider: true,
        depthExceeded: false,
        disqualifyReason: 'balancer_selected',
        skipReasons: [],
        ...balMeta,
    };
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
//     OJO: el default NO es neutro — resuelve sobre la cadena de Sherlock, que
//     tiene sus propios `model_override`. Todo caller que necesite la cadena del
//     Commander DEBE pasar `skill: COMMANDER_SKILL` explícitamente.
//   - issue: para audit log (default 'sherlock-verify').
//   - notify / auditLog: passthrough a `resolveSpawnWithFallback`. El resolver
//     es puro respecto del ESTADO de cuota, pero NO respecto de sus EFECTOS de
//     reporte: en el camino `fallback_selected` encola un aviso de Telegram con
//     ids internos (`skill=`, `provider=`, `model=`) y escribe el audit del
//     dispatch. Un caller que sólo CONSULTA la cadena (sin spawnear) debe
//     neutralizar ambos — ver #5456.
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
        notify,
        auditLog,
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
        notify,
        auditLog,
    });
}

// -----------------------------------------------------------------------------
// #5456 — resolveCommanderProviderQuiet
//
// Consulta SÓLO-LECTURA de la cadena del Commander excluyendo un provider.
// Pensada para los call sites que necesitan saber "quién atiende el próximo
// intento" para armar copy visible, SIN que la consulta se confunda con un
// dispatch real.
//
// Neutraliza los dos efectos de reporte de `resolveSpawnWithFallback`:
//   - `notify`: evitaría una TERCERA salida al operador en el mismo turno, con
//     ids internos de provider/model/skill (CA-1 y CA-3 de #5456).
//   - `auditLog`: no hubo spawn, así que un `fallback_selected` en el audit del
//     dispatch sería una entrada falsa.
//
// Y fija `skill`/`issue` en la cadena del COMMANDER: el default del resolver es
// la de Sherlock, que tiene otros `model_override` y sólo coincide en orden por
// casualidad.
// -----------------------------------------------------------------------------
const _AUDIT_NOOP = { appendChained: () => {} };
const _NOTIFY_NOOP = () => false;

function resolveCommanderProviderQuiet(excludedProvider, opts = {}) {
    return resolveCommanderProviderExcluding(excludedProvider, {
        ...opts,
        skill: COMMANDER_SKILL,
        issue: opts.issue || 'commander-chat',
        notify: _NOTIFY_NOOP,
        auditLog: _AUDIT_NOOP,
        // #6179 — tercer efecto a neutralizar: una consulta que persiste el
        // episodio haría que el despacho REAL siguiente lea "no cambió nada" y
        // se calle. No hubo spawn, así que no hay episodio que registrar.
        recordEpisode: false,
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
    // #6179 D9 — el enum de motivos es CERRADO y cae a un literal genérico,
    // nunca al `code` crudo. Mientras el único call site lo hardcodeaba el `else`
    // era inofensivo; ahora que la causa se deriva de verdad, ese `else` sería un
    // punto de interpolación de texto de origen externo (CA-9).
    const MOTIVES = Object.freeze({
        rate_limit: 'límite de pedidos por minuto',
        quota_exhausted: 'cuota agotada',
        timeout: 'sin respuesta a tiempo',
        '5xx': 'error del servidor',
    });
    const motive = Object.prototype.hasOwnProperty.call(MOTIVES, code)
        ? MOTIVES[code]
        : 'motivo no confirmado';
    // #6179 — `fallbackProvider` se interpolaba CRUDO acá: un id interno
    // (`cerebras`, `nvidia-nim`) viajaba tal cual al chat. Todo copy visible que
    // nombre un proveedor pasa por `publicProviderLabel` (SEC-5), que es
    // fail-closed: lo que no está en la allowlist pública cae al genérico.
    const motorLabel = publicProviderLabel(fallbackProvider, 'un motor de respaldo');
    lines.push(
        `⚠️ Claude no responde (${motive}) — el commander está usando ${motorLabel} para esta respuesta.`
    );
    if (supportsToolUse === false) {
        lines.push(
            `ℹ️ Modo conversacional: el commander no puede ejecutar comandos del pipeline en este request.`
        );
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// #4870 + #5456 — Mapping CERRADO de proveedores pagos → etiqueta pública.
//
// ÚNICA fuente de las etiquetas que ve el operador. Todo copy visible que
// nombre un proveedor DEBE pasar por acá: un id interno (`openai-codex`,
// `anthropic`) nunca se interpola crudo y un proveedor desconocido cae a un
// término genérico en vez de filtrar su nombre interno (CA-1 de #5456).
//
// Vivía dentro del bloque de #4870; se subió acá para que #5456 lo reutilice
// sin duplicar el vocabulario (dos allowlists divergentes = una filtra).
// -----------------------------------------------------------------------------
const _PAID_PROVIDER_LABELS = Object.freeze({
    'anthropic': 'Anthropic',
    'openai-codex': 'Codex',
});

/**
 * Traduce un id interno de proveedor a su etiqueta pública. Fail-closed: lo
 * que no está en la allowlist NO se interpola, se devuelve `fallbackLabel`.
 *
 * @param {string} provider       id interno del proveedor.
 * @param {string|null} fallbackLabel  valor para proveedores fuera de la allowlist.
 * @returns {string|null}
 */
function publicProviderLabel(provider, fallbackLabel = null) {
    const key = String(provider == null ? '' : provider).trim().toLowerCase();
    // #6179 D8 / #5667 — `_PAID_PROVIDER_LABELS` es un objeto literal congelado,
    // así que hereda `Object.prototype`: con el lookup `[key] || fallback`,
    // `publicProviderLabel('constructor')` devolvía la Function `Object`, que
    // interpolada en un template manda `function Object() { [native code] }` al
    // chat. `hasOwnProperty` cierra la herencia. Este issue le agrega un call
    // site nuevo a esta función: no se cierra una fuga abriendo otra.
    return Object.prototype.hasOwnProperty.call(_PAID_PROVIDER_LABELS, key)
        ? _PAID_PROVIDER_LABELS[key]
        : fallbackLabel;
}

// -----------------------------------------------------------------------------
// #5456 — formatMidTurnQuotaResponse — RESPUESTA REACTIVA del turno perdido.
//
// Contexto (#5424 / #5455): el CLI de Anthropic, al cortar por límite SEMANAL,
// emite el aviso como TEXTO del frame final `type:result`. Sin este formatter
// ese texto crudo — con hora de reset, jerga de la cuenta y wording de
// Anthropic — viajaba tal cual a Telegram como si fuera la respuesta del
// Commander. El operador quedaba sin saber que su turno se había perdido.
//
// Esta salida es DISTINTA del aviso proactivo (`formatEpisodeNotice` +
// `fallback-episode-state.recordDispatch`) y las dos deben convivir sin pisarse:
//
//   - REACTIVA (esta): contesta EL turno que se perdió. Se emite SIEMPRE, una
//     vez por cada turno afectado. NUNCA se deduplica — dedupear una respuesta
//     deja al operador sin contestación (mismo criterio que #4870).
//   - PROACTIVA (`formatEpisodeNotice`): avisa que el canal pasó a otro motor.
//     Esa SÍ se deduplica, ahora por EPISODIO (#6179) en vez de por la ventana
//     de 5 min de `shouldEmitFallbackNotice`, que se borró con este issue.
//
// Contrato del copy:
//   - CA-2: admite explícitamente que el turno no se completó y pide reenviar.
//   - CA-1: vocabulario de allowlist cerrada (`Anthropic` / `Codex`). Sin ids
//     internos, sin `errorType`, sin TTL, sin `resets_at`, sin metadata de la
//     cuenta y sin una sola palabra del payload crudo.
//   - CA-5: pasa por `redactSecretValue` (defensa en profundidad, igual #4870).
//
// Función PURA: no lee filesystem, no consulta el dedup, no escribe estado.
// Por eso es segura de llamar una vez por turno sin efectos acumulativos.
// -----------------------------------------------------------------------------
function formatMidTurnQuotaResponse({ primaryProvider, fallbackProvider } = {}) {
    const primary = publicProviderLabel(primaryProvider, null);
    const fallback = publicProviderLabel(fallbackProvider, null);

    // Fuera de la allowlist el copy degrada a una frase genérica: preferimos
    // ser vagos antes que interpolar un id interno desconocido.
    const causa = primary ? `la cuota semanal de ${primary}` : 'la cuota semanal del proveedor principal';
    const proximo = fallback
        ? `Ya quedo apuntando a ${fallback} para el próximo intento`
        : 'Voy a intentar con otro proveedor en el próximo intento';

    const text =
        `⚠️ Se agotó ${causa} y este turno se perdió — no llegué a completarlo.\n` +
        `${proximo}: reenviame el mensaje y lo retomo desde ahí.`;

    const r = redactModule();
    if (r && typeof r.redactSecretValue === 'function') {
        try { return r.redactSecretValue(text); } catch { /* fall-through */ }
    }
    return text;
}

// #5456 — Enum ESTABLE del audit log para el turno perdido por cuota semanal.
// Es el único identificador que el cierre del intento puede escribir: el
// `errorType` real (`weekly_limit_content_channel`) queda server-side en el
// audit de `quota-exhausted.js`, no en el dispatch del Commander.
const QUOTA_MIDTURN_ERROR_CODE = 'quota_exhausted_midturn';

// =============================================================================
// #6179 — formatEpisodeNotice: el copy del aviso por EPISODIO.
//
// Reemplaza a `shouldEmitFallbackNotice` (ventana de 5 min por
// `chat_id + fallback_provider`), que se BORRÓ en este issue. Aquella ventana
// era una de las TRES políticas que competían por avisar lo mismo, y dejar dos
// vivas garantiza que el ruido vuelva por la que quedó (CA-3). La decisión de
// emitir es ahora responsabilidad exclusiva de
// `lib/fallback-episode-state.js:recordDispatch`; esta función sólo redacta.
//
// Función PURA: sin I/O, sin `Date.now()` adentro (el reloj entra por `opts`),
// sin ids de proveedor ni de modelo, sin `errorCode` crudo y sin una sola letra
// del `raw_excerpt` o del mensaje de error del proveedor (CA-9 / SEC-4).
//
// El vocabulario visible NO vive acá: sale entero de
// `.pipeline/assets/copy/fallback-episode/copy.json`, que es el entregable de
// UX y la fuente única. Se `require`-ea en vez de inlinearse justamente para
// que no pueda desincronizarse en el primer retoque.
// =============================================================================

const EPISODE_TIERS = Object.freeze([
    'respaldo_pago', 'gratuito_con_herramientas', 'gratuito_sin_herramientas',
]);
const EPISODE_CAUSES = Object.freeze([
    'reposo', 'cuota', 'transitoria', 'auth', 'desconocida',
]);
const EPISODE_EVENTOS = Object.freeze([
    'entra_respaldo', 'baja_escalon', 'vuelve_principal', 'sostenido',
]);

/** Texto de última instancia si el asset de copy no está disponible. */
const EPISODE_COPY_UNAVAILABLE =
    '⚠️ El pipeline pasó a trabajar con un motor de respaldo.\n' +
    'No pude cargar el detalle del aviso. Conviene que mires el estado de los motores.';

let _episodeCopyCache;
/**
 * Carga fail-soft del copy. Si el asset faltara, `multi-provider.js` TIENE que
 * seguir cargando: es el módulo del Commander y un throw acá dejaría al pipeline
 * mudo (regla #1 del rol — el pipeline no puede morir).
 */
function episodeCopy() {
    if (_episodeCopyCache !== undefined) return _episodeCopyCache;
    try {
        _episodeCopyCache = require('../../assets/copy/fallback-episode/copy.json');
    } catch {
        _episodeCopyCache = null;
    }
    return _episodeCopyCache;
}

/** Lookup fail-closed: nunca hereda de `Object.prototype` (D8 / #5667). */
function episodePick(obj, key, fallback) {
    if (!obj || typeof obj !== 'object') return fallback;
    const k = String(key == null ? '' : key);
    return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : fallback;
}

function episodeLapso(COPY, ms, claves) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return COPY.antiguedad[claves.cero];
    if (min < 60) return COPY.antiguedad[claves.min].replace('{N}', String(min));
    const horas = Math.floor(min / 60);
    if (horas >= 24) {
        return COPY.antiguedad[claves.dia]
            .replace('{D}', String(Math.floor(horas / 24)))
            .replace('{H}', String(horas % 24));
    }
    // Un lapso redondo se dice "6 h", nunca "6 h 0 min": el aviso tiene que
    // sonar a alguien avisando, no a un reloj volcando campos (UX, decisión 7).
    if (min % 60 === 0) return COPY.antiguedad[claves.horaExacta].replace('{H}', String(horas));
    return COPY.antiguedad[claves.hora]
        .replace('{H}', String(horas))
        .replace('{M}', String(min % 60));
}

const _ANTIG_KEYS = {
    cero: 'menos_de_un_minuto', min: 'minutos',
    hora: 'horas', horaExacta: 'horas_exactas', dia: 'dias',
};
const _DURAC_KEYS = {
    cero: 'duracion_menos_de_un_minuto', min: 'duracion_minutos',
    hora: 'duracion_horas', horaExacta: 'duracion_horas_exactas', dia: 'duracion_dias',
};

/**
 * Redacta el aviso de un episodio.
 *
 * Responde las cuatro preguntas de CA-4 en orden fijo — qué cambió · por qué ·
 * desde cuándo · qué consecuencia práctica tiene — y sólo pide acción cuando
 * existe una (CA-7).
 *
 * Describe el ESCALÓN de capacidad, nunca el id del proveedor (CA-5): al
 * operador no le sirve saber que corre con `cerebras`, le sirve saber que el
 * pipeline no puede ejecutar comandos. Un nombre propio sólo aparecería si
 * `publicProviderLabel` lo devolviera desde la allowlist pública, y esa
 * allowlist tiene dos entradas, ambas de proveedores pagos, por diseño.
 *
 * @param {object} episode  `{ evento, tier, cause, since, heartbeatMs }`
 * @param {object} [opts]   `{ now }` — epoch ms. El reloj NO se lee adentro.
 * @returns {string} texto plano listo para Telegram (`plain: true`).
 */
function formatEpisodeNotice(episode, opts) {
    const COPY = episodeCopy();
    if (!COPY) return EPISODE_COPY_UNAVAILABLE;

    const ep = (episode && typeof episode === 'object') ? episode : {};
    const now = (opts && Number.isFinite(opts.now)) ? opts.now : 0;
    const since = Number.isFinite(ep.since) ? ep.since : now;
    const transcurrido = Math.max(0, now - since);

    const evento = EPISODE_EVENTOS.includes(ep.evento) ? ep.evento : 'entra_respaldo';
    // Un tier fuera del enum se trata como el escalón MÁS degradado: describir
    // de menos una degradación es peor que describirla de más (UX, decisión 8).
    const tier = EPISODE_TIERS.includes(ep.tier) ? ep.tier : 'gratuito_sin_herramientas';
    // `null` es el caso legítimo "no se pudo determinar" de CA-12.
    const cause = EPISODE_CAUSES.includes(ep.cause) ? ep.cause : 'desconocida';

    const d = new Date(since);
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    // Vuelta a la normalidad: 3 líneas. No lleva motivo ni consecuencia porque
    // no hay ninguna que comunicar.
    if (evento === 'vuelve_principal') {
        return COPY.plantillas.normalidad
            .replace('{MARCADOR}', COPY.marcadores.normalidad)
            .replace('{TITULAR}', COPY.titulares.vuelve_principal)
            .replace('{DURACION}', episodeLapso(COPY, transcurrido, _DURAC_KEYS))
            .replace('{CIERRE}', COPY.cierres.normalidad);
    }

    // Destacado cuando el operador tiene algo que decidir (CA-12) o cuando el
    // escalón no puede ejecutar comandos.
    const requiereMirada = cause === 'auth' || cause === 'desconocida';
    const destacado = requiereMirada || tier === 'gratuito_sin_herramientas';
    // Directriz de UX en `validacion`: `auth`/`desconocida` NUNCA degradan a la
    // lectura de heartbeat. Si el cruce `sostenido` + `auth` fuera alcanzable, el
    // marcador tiene que seguir siendo el destacado y el cierre tiene que
    // CONSERVAR el pedido de acción, no reemplazarlo por "te vuelvo a avisar".
    // `recordDispatch` además garantiza que no lo emite (esas causas notifican
    // por despacho y no llegan al heartbeat); esto es la segunda barrera.
    const marcador = (evento === 'sostenido' && !requiereMirada)
        ? COPY.marcadores.sostenido
        : (destacado ? COPY.marcadores.destacado : COPY.marcadores.degradacion);

    let cierre;
    if (cause === 'auth') {
        // El aviso de credenciales explica su propia repetición: CA-12 obliga a
        // notificar en cada despacho, y sin decirlo el operador ve volver la
        // ráfaga y concluye que la historia no funcionó (UX, decisión 5).
        cierre = COPY.cierres.auth;
    } else if (cause === 'desconocida') {
        cierre = COPY.cierres.desconocida;
    } else if (evento === 'sostenido') {
        const ventana = episodeLapso(
            COPY,
            Number.isFinite(ep.heartbeatMs) ? ep.heartbeatMs : 6 * 3600 * 1000,
            _DURAC_KEYS,
        );
        cierre = COPY.cierres.sostenido.replace('{VENTANA}', ventana);
    } else {
        cierre = COPY.cierres.sin_accion;
    }

    const titular = episodePick(
        episodePick(COPY.titulares, evento, COPY.titulares.entra_respaldo),
        tier,
        COPY.titulares.entra_respaldo.gratuito_sin_herramientas,
    );

    return COPY.plantillas.degradacion
        .replace('{MARCADOR}', marcador)
        .replace('{TITULAR}', titular)
        .replace('{MOTIVO}', episodePick(COPY.motivos, cause, COPY.motivos.desconocida))
        .replace('{HORA}', hora)
        .replace('{ANTIGUEDAD}', episodeLapso(COPY, transcurrido, _ANTIG_KEYS))
        .replace('{CONSECUENCIA}', episodePick(COPY.consecuencias, tier, COPY.consecuencias.gratuito_sin_herramientas))
        .replace('{CIERRE}', cierre);
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

// #4413 A02 — redacta `selection_reason` en origen antes de persistirlo al
// audit. Devuelve null cuando no hay valor (mantiene el patrón "null si no
// aplica" del resto de campos enriched). Si `redact.js` no está disponible en
// runtime, degrada a String() truncado (nunca deja pasar el objeto crudo).
function _redactSelectionReason(selectionReason) {
    if (selectionReason == null || selectionReason === '') return null;
    const raw = String(selectionReason);
    const r = redactModule();
    if (r && typeof r.redactSecretValue === 'function') {
        try { return r.redactSecretValue(raw); } catch { /* fall-through */ }
    }
    return raw;
}

// -----------------------------------------------------------------------------
// #4438 CA-3 — redactSkipReasons.
//
// Normaliza y REDACTA la lista de eslabones evaluados (`skipReasons[]` de
// `resolveSpawnWithFallback`, #3823) antes de que su `details` viaje al audit
// log o al chat de Telegram/dashboard. `details` puede arrastrar el error/stack
// real de un provider LLM (API keys, headers `Authorization`, URLs con tokens),
// así que TODO texto libre pasa por `redactRagContent` (requisito de security).
//
// Estructura de cada entrada: `{ provider, reason, details }`.
//   - `provider`/`reason` son enums acotados → se preservan tal cual (String).
//   - `details` es texto libre → SIEMPRE redactado. Si `redact.js` no está
//     disponible en runtime, fail-closed: se descarta el detalle (null) en vez
//     de dejar pasar el crudo.
// -----------------------------------------------------------------------------
function redactSkipReasons(skipReasons) {
    if (!Array.isArray(skipReasons) || skipReasons.length === 0) return [];
    const r = redactModule();
    const redactText = (s) => {
        if (s == null) return null;
        const raw = String(s);
        if (r && typeof r.redactRagContent === 'function') {
            try { return r.redactRagContent(raw); } catch { /* fail-closed */ }
        }
        // Sin módulo de redacción disponible: no arriesgamos exponer secretos.
        return null;
    };
    return skipReasons
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
            provider: s.provider ? String(s.provider) : null,
            reason: s.reason ? String(s.reason) : null,
            details: redactText(s.details),
        }));
}

// -----------------------------------------------------------------------------
// #4438 CA-1/CA-2 — planChainAdvance.
//
// Decisión PURA y testeable del retry post-spawn del Commander (el cuerpo de
// `advanceOrGiveUp` en `pulpo.js`). Separa la LÓGICA de decisión de los efectos
// (spawnear el siguiente / auditar / responder canned) para poder cubrir sus 4
// ramas con `node --test` sin arrancar el pulpo entero.
//
// Causa raíz que corrige (confirmada por guru): el retry re-resolvía la cadena
// excluyendo SÓLO los providers no-anthropic ya spawneados. Por el TOCTOU del
// flag global de cuota de anthropic (otro agente lo limpia entre el pick y el
// retry), el resolver devolvía `anthropic` como primario libre y el guard lo
// descartaba → fallo total sin recorrer gemini/cerebras/nvidia.
//
// Fix: el set de exclusión es la UNIÓN de `triedNonAnthropic` + el/los
// primario(s) gateado(s) del TURNO (`primaryProvider`, típicamente anthropic).
// Basarse en el estado del turno —no en re-leer el flag mutable compartido—
// evita el TOCTOU. Con anthropic excluido, el resolver recorre siempre el resto
// de la cadena free.
//
// Contrato:
//   opts = {
//     failedProvider,        // string — provider que acaba de fallar
//     triedNonAnthropic,     // Set|Array<string> — providers no-anthropic ya spawneados
//     primaryProvider,       // string — primario del turno (gateado), default 'anthropic'
//     resolveExcluding,      // fn(excludeArray) => resolution — inyectable (tests)
//   }
// Devuelve:
//   { action: 'retry', next, exclude }                       // escalar al siguiente
//   { action: 'giveup', next, exclude, chainEvaluated, resolveError }  // cadena agotada
// -----------------------------------------------------------------------------
function planChainAdvance(opts = {}) {
    const {
        failedProvider,
        triedNonAnthropic,
        primaryProvider,
        resolveExcluding,
    } = opts;

    const tried = new Set(
        triedNonAnthropic instanceof Set
            ? triedNonAnthropic
            : (Array.isArray(triedNonAnthropic) ? triedNonAnthropic : [])
    );
    // Excluir SIEMPRE el/los primario(s) gateado(s) del turno, no sólo los
    // non-anthropic ya intentados. Unión (no reemplazo): no se pierde ningún
    // provider ya fallido.
    const gatedPrimaries = [primaryProvider || 'anthropic'];
    const exclude = Array.from(new Set([...tried, ...gatedPrimaries]));

    let next = null;
    let resolveError = null;
    try {
        next = typeof resolveExcluding === 'function' ? resolveExcluding(exclude) : null;
    } catch (e) {
        resolveError = e;
    }

    // Rama de escalado: hay un provider sano, distinto de anthropic (ya excluido
    // arriba, el guard queda como defensa en profundidad coherente) y no
    // reintentado todavía.
    if (next && !next.gated && next.provider
        && next.provider !== 'anthropic'
        && !tried.has(next.provider)) {
        return { action: 'retry', next, exclude, chainEvaluated: [], resolveError: null };
    }

    // Cadena agotada: propagamos los eslabones evaluados (`skipReasons[]`) para
    // la telemetría CA-3. Se redactan aguas abajo (audit / canned).
    const chainEvaluated = (next && Array.isArray(next.skipReasons)) ? next.skipReasons : [];
    return { action: 'giveup', next, exclude, chainEvaluated, resolveError };
}

function auditCommanderRequest(opts = {}) {
    const {
        pipelineDir,
        event,
        providerIntended,
        providerEffective,
        chainTried,
        // #4438 CA-3 — TODOS los eslabones evaluados de la cadena (no sólo los
        // spawneados) con su motivo de descarte (`skipReasons[]`). Se REDACTA en
        // origen antes de persistir (details puede traer error/stack de provider
        // con secretos). Null cuando no se provee (shape canónico preservado).
        chainEvaluated,
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
        // #3846 — campos del evento `sherlock_independent_evidence_collected`.
        // Solo presentes cuando el collector de evidencia independiente corrió;
        // para el resto de eventos quedan en null y no afectan el shape canónico.
        sourcesChecked,
        findingsCount,
        // #4413 CA-9 (A09) — campos ADITIVOS de la decisión de ruteo balanceado.
        // Solo los provee el caller cuando el dispatch salió del balancer
        // ponderado (#4411/#4412); para el resto de eventos quedan en null y no
        // afectan el shape canónico ni el hash-chain (mismo patrón enriched
        // #3484/#3501/#3846). `selectionReason` es texto acotado (enum del
        // balancer) pero se redacta en origen (A02).
        weight,
        quotaPct,
        selectionReason,
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
        // #3846 — evidencia independiente. Null para eventos que no la usan.
        sources_checked: Array.isArray(sourcesChecked) ? sourcesChecked : null,
        findings_count: Number.isFinite(findingsCount) ? findingsCount : null,
        // #4413 CA-9 — decisión de ruteo del balanceo ponderado. Estrictamente
        // aditivos al FINAL del entry: null cuando el dispatch no salió del
        // balancer (preserva shape canónico y hash-chain — req A09/A08).
        weight: Number.isFinite(weight) ? weight : null,
        quota_pct: Number.isFinite(quotaPct) ? quotaPct : null,
        selection_reason: _redactSelectionReason(selectionReason),
        // #4438 CA-3 — cadena COMPLETA evaluada + motivo (redactado). Null para
        // eventos que no la proveen (preserva shape canónico y hash-chain).
        chain_evaluated: Array.isArray(chainEvaluated) && chainEvaluated.length
            ? redactSkipReasons(chainEvaluated)
            : null,
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
// Hay DOS formatos de salida según el provider:
//
//   A) JSONL streaming (Codex `exec --json`): un evento por línea. El mensaje
//      final del asistente es un `item.completed` con `item.type ===
//      'agent_message'` y el texto en `item.text`. Concatenamos todos los
//      `agent_message` en orden (por si el provider parte la respuesta).
//
//   B) Objeto JSON único (Gemini `-o json`: `{ session_id, response, stats }`).
//      NO es JSONL — es un solo objeto, frecuentemente pretty-printed en varias
//      líneas. El texto conversacional vive en `response`; `session_id` y
//      `stats` (tokens, latencia) son metadata técnica que NO debe llegar a
//      Telegram. Antes de este fix (#gemini-clean), al no matchear el path A,
//      el caller dumpeaba el JSON crudo entero — session_id arriba, el mensaje
//      sepultado en el medio y un bloque de stats al final, totalmente
//      heterogéneo con la voz del Commander sobre Claude.
//
// Contrato de salida: { text, parsed }
//   - parsed=true  → extrajimos el mensaje conversacional (homogéneo).
//   - parsed=false + text==''  → era JSON estructurado pero sin mensaje útil:
//     el caller responde canned en lugar de dumpear el stream crudo.
//   - parsed=false + text!=''  → no era JSON (provider de texto plano):
//     devolvemos el texto tal cual (best-effort, back-compat).
//
// #4353 CA-4 — campo `reason` (ADITIVO, back-compat: los callers históricos
// sólo leen `.text`/`.parsed`). Clasifica el vacío como fallo RECUPERABLE para
// que el walk de cadena avance al siguiente eslabón en vez de tomarlo como una
// respuesta válida vacía o cortar seco:
//   - 'empty_output'  → stdout totalmente vacío (provider no emitió nada).
//   - 'malformed_body'→ hubo JSON estructurado pero sin mensaje conversacional
//                       (caso Cerebras HTTP 200 sin `content`/`response`/`choices`).
//   - null            → hay texto útil (`text` no vacío).
// El caller (pulpo.js#runNonAnthropic) YA avanza al siguiente provider ante
// `text===''` (advanceOrGiveUp 'empty_output'); `reason` sólo agrega
// observabilidad/telemetría sin cambiar la decisión de walk.
// -----------------------------------------------------------------------------
function extractFallbackReply(stdout) {
    const raw = typeof stdout === 'string' ? stdout : '';
    if (!raw.trim()) return { text: '', parsed: false, reason: 'empty_output' };

    // --- Path A: JSONL streaming (Codex) — agent_message por línea ---
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
        return { text: messages.join('\n\n').trim(), parsed: true, reason: null };
    }

    // --- Path B: objeto JSON único (Gemini y similares HTTP) ---
    // Un JSONL multi-evento NO parsea como objeto único (el recovery de
    // primer-{ a último-} produce JSON inválido), así que este path sólo
    // dispara para una respuesta de objeto genuino y no pisa el path A.
    const single = _parseSingleJsonObject(raw);
    if (single) {
        const reply = _extractReplyFromObject(single);
        if (reply && reply.trim()) {
            return { text: reply.trim(), parsed: true, reason: null };
        }
        // Objeto JSON conocido pero sin texto conversacional (ej: payload de
        // error, o el caso Cerebras HTTP 200 sin `content`) → vacío: el caller
        // avanza al siguiente provider en vez de dumpear el JSON crudo. #4353
        // CA-4: es un fallo RECUPERABLE (`malformed_body`), no una respuesta
        // válida vacía.
        return { text: '', parsed: false, reason: 'malformed_body' };
    }

    // JSONL sin agent_message → vacío: el caller avanza al siguiente eslabón y
    // NO dumpea el stream crudo (#4353 CA-4: recuperable). Texto plano → lo
    // devolvemos tal cual (comportamiento previo, back-compat).
    if (sawJson) return { text: '', parsed: false, reason: 'malformed_body' };
    return { text: raw.trim(), parsed: false, reason: null };
}

// -----------------------------------------------------------------------------
// _parseSingleJsonObject — parsea el stdout como UN objeto JSON. Tolera prefijo
// o sufijo de ruido (warnings de stderr mezclados, líneas parciales) recortando
// del primer `{` al último `}`. Devuelve el objeto o null. Mismo criterio
// robusto que `providers/gemini-google.js#_parseGeminiJson`, replicado acá para
// no acoplar el commander a un provider puntual.
// -----------------------------------------------------------------------------
function _parseSingleJsonObject(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    try {
        const o = JSON.parse(trimmed);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch { /* sigue */ }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try {
            const o = JSON.parse(trimmed.slice(first, last + 1));
            return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
        } catch { /* nada */ }
    }
    return null;
}

// -----------------------------------------------------------------------------
// _extractReplyFromObject — saca SÓLO el texto conversacional de un objeto JSON
// de respuesta, descartando metadata técnica (session_id, stats, usage, etc.).
//
// Conservador a propósito: matchea los campos de contenido conocidos. Si el
// objeto es un payload de error (sin campo de contenido) devuelve '' para que
// el caller caiga al canned en vez de filtrar el mensaje de error crudo.
// -----------------------------------------------------------------------------
function _extractReplyFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    // Gemini `-o json`: { session_id, response, stats }
    if (typeof obj.response === 'string') return obj.response;
    // Variantes genéricas de providers HTTP que devuelven un objeto plano.
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    // Shape estilo OpenAI: { choices: [ { message: { content } } | { text } ] }
    if (Array.isArray(obj.choices) && obj.choices[0] && typeof obj.choices[0] === 'object') {
        const c = obj.choices[0];
        if (c.message && typeof c.message.content === 'string') return c.message.content;
        if (typeof c.text === 'string') return c.text;
    }
    return '';
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
//
// #4306 CA-6 — el mensaje histórico decía siempre "sin cuota disponible", lo
// cual era engañoso cuando la cadena se agotó por credenciales/inactividad y
// NO por cuota. Aceptamos opcionalmente la `resolution` del dispatcher
// (`{ reason, skipReasons }`) para redactar la causa real. Sin argumento,
// preserva el texto histórico (backward-compat).
//
// REQ-SEC-4: nunca logueamos valores de credenciales — solo causa/estado.
// -----------------------------------------------------------------------------
function cannedAllGatedResponse(resolution = null) {
    const skipReasons = (resolution && Array.isArray(resolution.skipReasons))
        ? resolution.skipReasons
        : [];
    const reason = resolution && typeof resolution.reason === 'string'
        ? resolution.reason
        : null;

    const hasQuota = skipReasons.some((s) => s && s.reason === 'quota_exhausted');
    const allBySchedule = reason === 'todos_inactivos_por_horario'
        || (resolution && resolution.allInactiveBySchedule === true);

    // Causa NO-cuota: credenciales, inactividad por horario, health, etc.
    if (!hasQuota && (skipReasons.length > 0 || allBySchedule)) {
        if (allBySchedule) {
            return (
                `🕒 Todos los providers LLM del commander están fuera de su ventana de actividad ahora mismo. ` +
                `Los comandos determinísticos (/status, /listado, /lanzar) siguen funcionando. ` +
                `Te aviso cuando alguno entre en horario.`
            );
        }
        return (
            `🚫 Ningún provider LLM del commander está disponible (sin credenciales o desactivados), no por falta de cuota. ` +
            `Los comandos determinísticos (/status, /listado, /lanzar) siguen funcionando. ` +
            `Te aviso cuando se recupere alguno.`
        );
    }

    return (
        `🚫 Todos los providers LLM del commander están sin cuota disponible. ` +
        `Los comandos determinísticos (/status, /listado, /lanzar) siguen funcionando. ` +
        `Te aviso cuando se libere alguno.`
    );
}

// -----------------------------------------------------------------------------
// #3887 — cannedAllProvidersFailedResponse — ÚLTIMA OPCIÓN.
//
// A diferencia de `cannedAllGatedResponse` (que habla de "sin cuota", el caso
// pre-spawn donde la cadena entera está gateada por cuota), este mensaje cubre
// el caso en que se INTENTÓ spawnear y TODOS los providers Y todos los modelos
// de fallback FALLARON en runtime (spawn error, ENAMETOOLONG, env-isolation,
// timeout, empty_output, etc.). Es el último eslabón: cuando no queda ningún
// LLM con el que generar la respuesta, al menos le avisamos a Leo que no se le
// puede contestar y por qué — para que NUNCA quede mudo sin saber qué pasó.
//
// #4440 — CA-1/CA-2: el copy visible ya NO afirma "fallaron TODOS los providers"
// salvo verificación server-side (`verifiedAllFailed === true`) y NO expone
// nombres de providers, modelos, timers ni la lista de intentos.
//
// `chainTried` se sigue aceptando por backward-compat de firma (los 3 callers en
// pulpo.js lo pasan) pero NO se interpola al operador — su detalle solo viaja a
// los logs/audit server-side, nunca al canal.
//
// Estados (CA-4):
//  - `verifiedAllFailed === false` (default): imposibilidad NO verificada
//    (p.ej. caso pre-spawn donde nunca se intentó la cadena completa). Copy
//    honesto SIN afirmar falla total.
//  - `verifiedAllFailed === true`: se intentó spawnear y efectivamente se agotó
//    toda la cadena. Recién acá el copy puede afirmar que no hay IA disponible
//    (siempre sin nombrar providers/modelos/timers).
//
// Variación anti-robot (feedback_telegram-messages-natural.md): rota entre
// variantes con `requestId` como semilla determinística. `requestId` es opcional.
// -----------------------------------------------------------------------------
// #6144 — el copy fijo de arriba se reemplazó por un mensaje construido a partir
// de la CAUSA DOMINANTE de la caída (cupo agotado / fuera de horario / caída
// temporal / problema de acceso), con las cuatro partes que pide CA-1: qué pasó,
// qué sigue funcionando, qué pasó con el pedido, y cuándo vuelve si es estimable.
// Toda la redacción vive en `provider-down-notice.js` (fuente de verdad de UX en
// `assets/audio/provider-down/copy.json`); acá sólo queda el cableado.
//
// CLASIFICACIÓN INYECTADA, NO AMBIENTE — decisión deliberada:
//
// La receta del architect proponía que esta función llamara a `classifyPauseCause`
// por default. Verificado empíricamente que eso rompe CA-25: `classifyPauseCause`
// hace `readFileSync` del snapshot de salud, así que el copy pasaría a depender
// del estado de la máquina donde corren los tests. Y el copy de la causa `auth`
// ("Hay un problema de acceso que necesita tu intervención") NO satisface la
// aserción vigente `/no.*(tengo|puedo).*IA|IA/i` de
// `commander-inflight-fallback.test.js` — que CA-25 prohíbe modificar. Con
// clasificación ambiente, esos tests quedan verdes o rojos según qué diga el
// snapshot en ese momento: exactamente el tipo de test flaky que la red de
// seguridad de la anonimización no puede permitirse.
//
// Con `classify` inyectado la función vuelve a ser PURA por default: sin
// `classify` no hay lectura de disco y el copy es el genérico, determinístico.
// Los 3 callers de `pulpo.js` inyectan el clasificador, así que CA-2 se cumple
// en producción; y el fail-closed a genérico de CA-19 sale gratis para cualquier
// caller que no lo haga (incluido `pulpo.js:16899`, que no tiene `chainTried`).
function cannedAllProvidersFailedResponse({ chainTried, verifiedAllFailed = false, requestId, classify } = {}) {
    // `chainTried` ahora SÍ se usa — pero SÓLO como entrada de clasificación
    // server-side. NUNCA se interpola al operador (CA-2 de #4440, CA-6 de #6144):
    // el módulo de copy sólo lee `dominantCause`, `stale`, `degraded` y
    // `providers[].rest` del resultado, nunca la cadena ni etiquetas de provider.
    let classification = null;
    if (typeof classify === 'function') {
        try {
            classification = classify(Array.isArray(chainTried) ? chainTried : []);
        } catch {
            classification = null; // fail-closed → copy genérico (CA-19)
        }
    }
    return providerDownNotice.buildDownNoticeText(classification, { verifiedAllFailed, requestId });
}

// -----------------------------------------------------------------------------
// #4870 — cannedReducedModeResponse — aviso advisory del MODO REDUCIDO.
//
// Se emite cuando TODOS los pagos (billing:'paid') están gateados por cuota pero
// queda un free sano en la chain (isReducedMode === true). Decisión de PO D1:
// canned determinístico, NO se spawnea el free (least-privilege, no quema free
// tier, no expone datos del pipeline al TOS de un free externo).
//
// Contrato del copy (CA-3 + guidelines UX):
//  - Explicita textualmente "modo reducido" y "sin ejecución de acciones".
//  - Estado primero (primera línea) — el operador lo lee en 1 segundo.
//  - Indica qué pagos están caídos EN LENGUAJE DE OPERADOR (Anthropic / Codex),
//    SIN nombres de modelos, timers ni términos internos (gated/chain/billing).
//  - Cierra con la salida automática (CA-4): retoma solo al recuperar un pago.
//  - Tono calmo (degradación controlada, no alarma), español, auto-contenido.
//
// SEC-REQ-4: el copy NO interpola secrets ni valores de `credentials_env`; aun
// así pasa por `redactSecretValue` (defensa en profundidad, belt-and-suspenders).
// -----------------------------------------------------------------------------
// #5456 — `_PAID_PROVIDER_LABELS` se movió arriba (junto a `publicProviderLabel`)
// para que la respuesta reactiva de cuota comparta la MISMA allowlist cerrada.
function cannedReducedModeResponse({ downProviders } = {}) {
    // Mapear nombres internos de los pagos caídos a etiquetas de operador. Se
    // ignora cualquier nombre desconocido (nunca se filtra un nombre crudo).
    const labels = (Array.isArray(downProviders) ? downProviders : [])
        .map((p) => publicProviderLabel(p, null))
        .filter(Boolean);
    const uniq = [...new Set(labels)]; // dedup preservando orden
    const causa = uniq.length === 0
        ? 'los proveedores pagos'
        : (uniq.length === 1 ? uniq[0] : uniq.join(' y '));

    const text =
        `🟡 Estamos en modo reducido — sin ejecución de acciones.\n` +
        `Se agotó la cuota de ${causa}, así que por este canal no estoy avanzando tareas del pipeline (dev/build/QA). ` +
        `Los comandos determinísticos (/status, /listado, /lanzar) siguen funcionando. ` +
        `Retomo la ejecución normal apenas se recupere un proveedor pago, sin que tengas que hacer nada.`;

    const r = redactModule();
    if (r && typeof r.redactSecretValue === 'function') {
        try { return r.redactSecretValue(text); } catch { /* fall-through */ }
    }
    return text;
}

// -----------------------------------------------------------------------------
// #3275 — Re-export del módulo de fallback in-flight para tener una sola
// superficie pública en `require('./multi-provider')`. El módulo dedicado
// vive en `./inflight-fallback.js` y tiene su propia suite de tests.
// -----------------------------------------------------------------------------
const inflight = require('./inflight-fallback');
const credPrecheck = require('./credentials-precheck');
// #6144 — copy + guion de voz + cooldown del aviso de cadena caída.
const providerDownNotice = require('./provider-down-notice');

module.exports = {
    COMMANDER_SKILL,
    SHERLOCK_SKILL,
    INJECTION_PATTERNS,
    // #5456 — enum estable del audit para el turno perdido por cuota semanal.
    QUOTA_MIDTURN_ERROR_CODE,

    sanitizeUserPrompt,
    resolveCommanderProvider,
    resolveCommanderProviderExcluding,
    resolveCommanderProviderQuiet,
    // #4565 (rebote rev-1) — gate de cuota read-only: ¿toda la cadena gateada?
    isCommanderChainGated,
    // #4870 — modo reducido read-only: pagos gateados pero free sano.
    isReducedMode,
    shouldRespondReducedMode,
    formatFallbackNotice,
    // #6179 — copy del aviso por EPISODIO. Reemplaza a `shouldEmitFallbackNotice`,
    // borrado en este issue: la decisión de emitir vive en
    // `lib/fallback-episode-state.js:recordDispatch` (política única, CA-3).
    formatEpisodeNotice,
    // #5456 — respuesta REACTIVA del turno perdido por cuota semanal. Pura e
    // INDEPENDIENTE de la política de episodio: no se deduplica nunca.
    formatMidTurnQuotaResponse,
    publicProviderLabel,
    auditCommanderRequest,
    readCommanderStats,
    safeBuildSpawn,
    extractFallbackReply,
    enforceDataResidency,
    runCommanderSpawn,

    cannedFallbackUnavailableResponse,
    cannedAllGatedResponse,
    cannedAllProvidersFailedResponse,
    // #6144 — re-export del aviso de cadena caída: el guion hablado, la
    // resolución del clip pregrabado, el cooldown y la orquestación del envío
    // de voz. `pulpo.js` los consume desde acá para no requerir dos módulos.
    buildDownNoticeText: providerDownNotice.buildDownNoticeText,
    buildDownNoticeAudioText: providerDownNotice.buildDownNoticeAudioText,
    resolveFallbackClip: providerDownNotice.resolveFallbackClip,
    shouldEmitDownAudio: providerDownNotice.shouldEmitDownAudio,
    sendDownNoticeAudio: providerDownNotice.sendDownNoticeAudio,
    cannedDataResidencyResponse,
    // #4870 — aviso advisory del modo reducido (canned determinístico D1).
    cannedReducedModeResponse,

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
    // #4329 — exponer el budget EFECTIVO (env-resuelto + clampeado), no solo el
    // default literal, para que refleje overrides por COMMANDER_TURN_BUDGET_MS.
    INFLIGHT_BUDGET_MS: inflight.TURN_BUDGET_MS,
    MAX_INFLIGHT_FALLBACKS: inflight.MAX_INFLIGHT_FALLBACKS,

    // #3275 — credentials precheck al boot
    precheckCommanderProviderRanking: credPrecheck.precheckCommanderProviderRanking,
    makePrecheckHandle: credPrecheck.makePrecheckHandle,
    formatPrecheckReport: credPrecheck.formatPrecheckReport,

    // #4412 (Parte 2/3) — integración del balanceo de providers.
    _resolveViaBalancer,
    _buildBalancedResolution,
    _balancerStatePath: balancerStatePath,
    _loadBalancerState: loadBalancerState,
    _saveBalancerState: saveBalancerState,
    _makeBalancerStore: makeBalancerStore,
    BALANCER_STATE_FILE,

    // #4413 (Parte 3/3) — stickiness por conversación (re-export del módulo
    // dedicado) + redacción de selection_reason.
    stickiness: require('./provider-stickiness'),
    _redactSelectionReason,

    // #4438 — retry post-spawn del Commander: decisión pura + redacción CA-3.
    planChainAdvance,
    redactSkipReasons,

    // exports internos para tests
    _hashFor: hashFor,
    _auditFile: auditFile,
    _selectErrorTypeForFlag,
    _parseSingleJsonObject,
    _extractReplyFromObject,
};
