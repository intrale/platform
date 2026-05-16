// =============================================================================
// dispatch-with-fallback.js — Consumer runtime del array `skill.fallbacks[]`.
//
// Issue: #3198 (consumer runtime de skill.fallbacks).
//
// Hasta este módulo, el campo `skills.<name>.fallbacks: []` de
// `agent-models.json` estaba **soportado en schema + validado + editable
// desde UI + diffeable** (PR #3177 entregó la cadena) pero NO había consumer
// en runtime. Si el provider primario quedaba gateado por cuota agotada,
// el archivo de trabajo volvía a `pendiente/` y se quedaba esperando reset,
// sin intentar con los providers declarados como fallback.
//
// Este módulo cierra esa promesa: cuando `shouldGateSpawn(skill, {provider})`
// bloquearía al primario, iteramos `fallbacks[]` y devolvemos la primera
// resolución no-gated.
//
// ARQUITECTURA
// -----------
// El dispatcher corre **pre-spawn**, en el mismo punto del flow que el gate
// global (pulpo.js → bloque `shouldGateSpawn`). Es pasivo: NO cambia el
// flow del happy path (primario disponible) — sólo entra en juego cuando
// hay flag de cuota activo para el provider primario del skill.
//
// El gate del pulpo evoluciona de:
//   if (shouldGateSpawn(skill, { provider: primary })) → mover a pendiente/.
// a:
//   const r = resolveSpawnWithFallback({...});
//   if (r.gated) → mover a pendiente/, sino spawn con r.provider/r.model.
//
// POLÍTICA DUAL (§4.1 doc canónico)
// ---------------------------------
// - **Cross-MODELO** (mismo provider, distinto modelo): N/A en este PR. El
//   array `fallbacks[]` lista provider names — no soporta cross-modelo
//   per-skill. Cross-modelo se hace via `model_override` + selector
//   autónomo (`docs/pipeline-multi-provider.md` §4.3, fuera del scope #3198).
// - **Cross-PROVIDER** (provider distinto del primario): EL OPT-IN HUMANO ES
//   LA DECLARACIÓN DEL ARRAY EN AGENT-MODELS.JSON. La UI dashboard #3177
//   permite agregar/quitar fallbacks con confirmación humana — esa edición
//   ES la aprobación. No agregamos doble barrera porque rompería la promesa
//   "configurá fallbacks y el pipeline sigue funcionando" del issue.
//
//   La defensa adicional (S-6 del análisis de security) es:
//     1) audit log con hash-chain SHA-256 (`logs/cross-provider-dispatch-*.jsonl`)
//     2) notificación Telegram via queue de archivos (sin LLM en el camino)
//     3) cap de profundidad MAX_FALLBACK_DEPTH (5)
//     4) anti-cycle con `Set<providerName>` ya intentados
//     5) skip si el fallback comparte el provider gated (mismo flag scope).
//
// DEFENSAS DE SEGURIDAD (S-1 a S-9 del análisis security en el issue)
// -------------------------------------------------------------------
// S-1: Detección de cuota delegada a `quotaModule.shouldGateSpawn` —
//      reutilizamos shape estructural, NUNCA matcheamos por substring.
// S-2: Aislamiento de credenciales — este módulo NO arma env del child. El
//      caller (pulpo.js) ya invoca `env-isolation` con el provider resuelto,
//      así que cuando devolvemos un fallback el env queda construido a
//      partir del handler del fallback, no del primario.
// S-3: Validación del nombre del provider — invocamos `getProviderHandler`
//      contra la tabla hardcoded; el boot-time validator ya garantiza que
//      cada item del array está en `providers`.
// S-4: Path traversal en flag de pending — N/A acá (no escribimos pending
//      flag por skill: el opt-in es la presencia del array en config).
// S-5: Cycle/depth limit — MAX_FALLBACK_DEPTH=5 + Set<providerName> ya intentados.
// S-6: Sanitización del audit log — passthrough a `audit-log.appendChained`,
//      que ya redacta con hash-chain. raw_excerpt pasa por
//      `quotaModule.sanitizeRawExcerpt` antes de ir al log.
// S-7: Política dual — opt-in vía presencia del array (decisión PO).
// S-8: Quota flag scoping — el fallback NO limpia el flag del primario.
//      `clearFlag` ya respeta scope per-provider (#3077 CA-8).
// S-9: Telegram via filesystem queue — escribimos a
//      `.pipeline/servicios/telegram/pendiente/<ts>.json`, NO curl directo.
//
// SIN dependencias externas (Node puro: fs, path, crypto via audit-log).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveProviderForSkill, getProviderHandler } = require('./resolve-provider');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// S-5: cap de profundidad de la chain para evitar recursión patológica.
// 5 es generoso para la mayoría de configs (Anthropic → OpenAI → Gemini → ...).
const MAX_FALLBACK_DEPTH = 5;

// Sub-directorio donde se encola la notificación Telegram (servicio drainer
// la procesa fuera del path crítico del pulpo).
const TELEGRAM_QUEUE_SUBDIR = path.join('servicios', 'telegram', 'pendiente');

// Audit log dedicado al dispatch con fallback. Día rotación natural para
// trazabilidad por fecha de incidente.
function dispatchAuditFile(pipelineDir, now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir, 'logs', `cross-provider-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

// -----------------------------------------------------------------------------
// readAgentModelsRaw — lectura defensiva idéntica a resolve-provider.js pero
// exportable, porque acá necesitamos el `skills.<name>.fallbacks` además del
// resolved primary.
// -----------------------------------------------------------------------------
function readAgentModelsRaw(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(modelsPath)) return null;
        return JSON.parse(_fs.readFileSync(modelsPath, 'utf8'));
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// enqueueTelegramNotice — encola un mensaje en la queue de archivos del
// servicio Telegram (S-9). NUNCA hace fetch/curl directo: el drainer fuera
// del path crítico lo procesa.
//
// Best-effort: errores de IO se silencian para no romper el pipeline (el
// dispatcher NUNCA debe ser causa de crash).
// -----------------------------------------------------------------------------
function enqueueTelegramNotice({ pipelineDir, fsImpl, text, meta }) {
    const _fs = fsImpl || fs;
    if (!pipelineDir || !text) return false;
    try {
        const queueDir = path.join(pipelineDir, TELEGRAM_QUEUE_SUBDIR);
        _fs.mkdirSync(queueDir, { recursive: true });
        // Nombre con timestamp + pid para evitar colisiones entre procesos
        // concurrentes (caller puede ser pulpo + un script de mantenimiento).
        const fname = `cross-provider-${Date.now()}-${process.pid}.json`;
        const payload = JSON.stringify({
            type: 'cross-provider-fallback',
            text,
            meta: meta || {},
            queued_at: new Date().toISOString(),
        }, null, 2);
        _fs.writeFileSync(path.join(queueDir, fname), payload, { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// auditAppend — append-only entry al audit log dedicado con hash-chain.
//
// El módulo `lib/audit-log.js` (#3082) ya provee `appendChained` con SHA-256
// chain. Lo reusamos para no duplicar el patrón. Sanitización del
// raw_excerpt se delega a `quotaModule.sanitizeRawExcerpt` (S-6).
//
// Best-effort: errores de IO se silencian (S-6 / best-effort idéntico al
// detector de cuota).
// -----------------------------------------------------------------------------
function auditAppend({ pipelineDir, fsImpl, entry, sanitize, auditLog, now }) {
    if (!pipelineDir || !entry) return false;
    try {
        const _audit = auditLog || require('../audit-log');
        const file = dispatchAuditFile(pipelineDir, now ? new Date(now) : undefined);
        const safe = {
            ...entry,
            raw_excerpt: typeof sanitize === 'function'
                ? sanitize(entry.raw_excerpt)
                : (entry.raw_excerpt || ''),
        };
        _audit.appendChained({ file, entry: safe, fsImpl });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// resolveSpawnWithFallback — resuelve el provider efectivo para el spawn,
// consultando el primary y, si está gated, iterando `fallbacks[]`.
//
// Contrato:
//   input: {
//     skill,                     // nombre del skill (string)
//     issue,                     // número del issue (informativo, para audit)
//     pipelineDir,               // .pipeline path (para leer agent-models.json y escribir audit)
//     fsImpl,                    // override fs (tests)
//     quotaModule,               // require('../quota-exhausted')
//     primaryResolver,           // override resolveProviderForSkill (tests)
//     providerHandlerResolver,   // override getProviderHandler (tests)
//     auditLog,                  // override require('../audit-log') (tests)
//     notify,                    // override enqueueTelegramNotice (tests)
//     onLog,                     // callback(level, message) — logging del caller (best-effort)
//     now,                       // Date.now() override (tests)
//   }
//
//   output: {
//     provider,               // provider efectivo a usar para el spawn
//     model,                  // model resolvido (puede ser null si N/A)
//     handler,                // handler del provider efectivo
//     source,                 // 'primary' | 'fallback' | 'all-gated'
//     gated,                  // true si NO se puede spawnear (primary y todos los fallbacks gated)
//     fallbackUsed,           // { index, provider } si source === 'fallback', sino null
//     primaryProvider,        // provider primario originalmente resuelto
//     chainTried,             // [providerName, ...] orden de intentos
//     crossProvider,          // true si el fallback elegido es de otro provider que el primary
//     depthExceeded,          // true si la chain superó MAX_FALLBACK_DEPTH
//   }
//
// REGLAS
// ------
// 1. Si el primario NO está gateado → devolver primary (source: 'primary').
// 2. Si está gateado y el skill no tiene `fallbacks[]` → devolver primary +
//    gated:true (caller mueve a pendiente/).
// 3. Iterar `fallbacks[]` en orden, hasta MAX_FALLBACK_DEPTH:
//    a. Si el fallback se repite (cycle) → skip + audit.
//    b. Si el fallback no está en la tabla hardcoded de handlers → skip + audit.
//    c. Si el fallback == primary → skip (defense in depth, validator ya
//       lo prohíbe pero blindamos).
//    d. Si el fallback también está gateado (mismo provider o flag scoped
//       a ese provider) → skip + audit.
//    e. Si está libre → devolver fallback (source: 'fallback') + audit +
//       notificar Telegram.
// 4. Si la chain se agota sin candidato → source: 'all-gated' + gated:true.
// 5. Si la chain supera MAX_FALLBACK_DEPTH → cortar + audit "depth_exceeded"
//    + tratar como all-gated.
// -----------------------------------------------------------------------------
function resolveSpawnWithFallback(opts = {}) {
    const {
        skill,
        issue,
        pipelineDir,
        fsImpl,
        quotaModule,
        primaryResolver,
        providerHandlerResolver,
        auditLog,
        notify,
        onLog,
        now,
    } = opts;

    const log = typeof onLog === 'function' ? onLog : () => {};
    const _resolveProvider = primaryResolver || resolveProviderForSkill;
    const _resolveHandler = providerHandlerResolver || getProviderHandler;
    const _notify = notify || enqueueTelegramNotice;
    const _now = Number.isFinite(now) ? now : Date.now();

    // -------------------------------------------------------------------------
    // 1. Resolver el provider primario.
    // -------------------------------------------------------------------------
    const primary = _resolveProvider(skill, { pipelineDir, fsImpl });
    const primaryProvider = primary && primary.provider;

    // Si no hay quotaModule, devolvemos el primary sin gate (modo legacy).
    if (!quotaModule || typeof quotaModule.shouldGateSpawn !== 'function') {
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
        };
    }

    // Skills determinísticos no se gatean — devolvemos el primary tal cual.
    if (primary.provider === 'deterministic') {
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
        };
    }

    const primaryGated = quotaModule.shouldGateSpawn(skill, {
        provider: primaryProvider,
        now: _now,
    });

    if (!primaryGated) {
        // Happy path: primary disponible.
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
        };
    }

    // -------------------------------------------------------------------------
    // 2. Primary gateado → consultar fallbacks[] del skill.
    // -------------------------------------------------------------------------
    const models = readAgentModelsRaw(pipelineDir, fsImpl);
    const skillCfg = (models && models.skills && models.skills[skill]) || null;
    const fallbacks = skillCfg && Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];

    const chainTried = [primaryProvider];
    const sanitize = quotaModule.sanitizeRawExcerpt || ((s) => String(s || ''));

    if (fallbacks.length === 0) {
        // Sin fallbacks declarados → comportamiento previo (gate clásico).
        auditAppend({
            pipelineDir, fsImpl, sanitize, auditLog, now: _now,
            entry: {
                event: 'gated_no_fallbacks',
                skill,
                issue: issue || null,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                fallbacks_declared: 0,
                raw_excerpt: `skill=${skill} provider=${primaryProvider} no_fallbacks`,
            },
        });
        return {
            ...primary,
            source: 'all-gated',
            gated: true,
            fallbackUsed: null,
            primaryProvider,
            chainTried,
            crossProvider: false,
            depthExceeded: false,
        };
    }

    // -------------------------------------------------------------------------
    // 3. Iterar fallbacks en orden.
    // -------------------------------------------------------------------------
    const tried = new Set([primaryProvider]);
    let depthExceeded = false;

    for (let i = 0; i < fallbacks.length; i++) {
        if (i >= MAX_FALLBACK_DEPTH) {
            depthExceeded = true;
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'depth_exceeded',
                    skill,
                    issue: issue || null,
                    primary_provider: primaryProvider,
                    max_depth: MAX_FALLBACK_DEPTH,
                    declared_length: fallbacks.length,
                    raw_excerpt: `chain_length=${fallbacks.length} max=${MAX_FALLBACK_DEPTH}`,
                },
            });
            log('lanzamiento', `⚠️ ${skill}:#${issue} chain de fallbacks superó MAX_FALLBACK_DEPTH=${MAX_FALLBACK_DEPTH}, corto.`);
            break;
        }

        const fbName = fallbacks[i];

        // 3.a — cycle/anti-duplicate
        if (tried.has(fbName)) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_cycle_skipped',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    raw_excerpt: `already_tried=${Array.from(tried).join(',')}`,
                },
            });
            continue;
        }
        tried.add(fbName);
        chainTried.push(fbName);

        // 3.b — handler debe existir (defense in depth; validator ya lo
        // chequea al boot pero blindamos en runtime para que un agent-models.json
        // editado a mano con nombre inválido NO crashee el dispatcher).
        let fbHandler;
        try {
            fbHandler = _resolveHandler(fbName);
        } catch (e) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_unknown_provider',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    raw_excerpt: `error=${e.message}`,
                },
            });
            log('lanzamiento', `⚠️ ${skill}:#${issue} fallback "${fbName}" desconocido (índice ${i}), salto.`);
            continue;
        }

        // 3.c — defense in depth: fallback == primary (validator lo prohíbe).
        if (fbName === primaryProvider) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_duplicates_primary',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: 'duplicate_primary',
                },
            });
            continue;
        }

        // 3.d — el fallback también puede estar gateado (otro flag activo).
        const fbGated = quotaModule.shouldGateSpawn(skill, {
            provider: fbName,
            now: _now,
        });
        if (fbGated) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_also_gated',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: `fallback_${fbName}_gated_too`,
                },
            });
            continue;
        }

        // 3.e — candidato libre. Resolver model para el fallback.
        const fbProviderDef = (models && models.providers && models.providers[fbName]) || null;
        const fbModel = (skillCfg && skillCfg.model_override)
            || (fbProviderDef && fbProviderDef.model)
            || (models && models.defaults && models.defaults.model)
            || null;

        // Audit + notify (S-6 / S-9).
        auditAppend({
            pipelineDir, fsImpl, sanitize, auditLog, now: _now,
            entry: {
                event: 'fallback_selected',
                skill,
                issue: issue || null,
                fallback_index: i,
                fallback_provider: fbName,
                fallback_model: fbModel,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                cross_provider: true,
                chain_tried: chainTried,
                raw_excerpt: `primary=${primaryProvider} gated, fallback=${fbName} libre`,
            },
        });

        const notice =
            `⚠️ Cross-provider fallback activo\n` +
            `skill=${skill} issue=${issue || '?'}\n` +
            `primary=${primaryProvider} (gated)\n` +
            `fallback=${fbName} (índice ${i})\n` +
            `model=${fbModel || 'n/a'}`;
        try {
            _notify({
                pipelineDir,
                fsImpl,
                text: notice,
                meta: {
                    skill,
                    issue: issue || null,
                    primary_provider: primaryProvider,
                    fallback_provider: fbName,
                    fallback_index: i,
                    fallback_model: fbModel,
                },
            });
        } catch { /* best-effort */ }

        log('lanzamiento', `↪️ ${skill}:#${issue} primary=${primaryProvider} gated, usando fallback="${fbName}" (índice ${i})`);

        return {
            provider: fbName,
            model: fbModel,
            handler: fbHandler,
            source: 'fallback',
            gated: false,
            fallbackUsed: { index: i, provider: fbName },
            primaryProvider,
            chainTried,
            crossProvider: true,
            depthExceeded: false,
        };
    }

    // -------------------------------------------------------------------------
    // 4. Chain agotada sin candidato libre.
    // -------------------------------------------------------------------------
    auditAppend({
        pipelineDir, fsImpl, sanitize, auditLog, now: _now,
        entry: {
            event: 'chain_exhausted',
            skill,
            issue: issue || null,
            primary_provider: primaryProvider,
            chain_tried: chainTried,
            depth_exceeded: depthExceeded,
            raw_excerpt: `all_gated chain=${chainTried.join('->')}`,
        },
    });
    log('lanzamiento', `🚫 ${skill}:#${issue} chain de fallbacks agotada (primario + ${fallbacks.length} fallbacks gated o inválidos).`);

    return {
        ...primary,
        source: 'all-gated',
        gated: true,
        fallbackUsed: null,
        primaryProvider,
        chainTried,
        crossProvider: false,
        depthExceeded,
    };
}

module.exports = {
    resolveSpawnWithFallback,
    enqueueTelegramNotice,
    dispatchAuditFile,
    MAX_FALLBACK_DEPTH,
    TELEGRAM_QUEUE_SUBDIR,
    // exposed for tests
    _readAgentModelsRaw: readAgentModelsRaw,
    _auditAppend: auditAppend,
};
