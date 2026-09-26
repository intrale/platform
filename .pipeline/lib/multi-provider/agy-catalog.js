// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// agy-catalog.js — Cruce de los ids de modelo de Antigravity contra el catálogo
// REAL del CLI (`agy models`).
//
// Issue: #6858 (split de #6856) — los 9 skills con Gemini en su cadena de
// fallback declaraban `gemini-3-flash-preview`, un id del Gemini CLI gratuito
// (retirado) que NO existe en Antigravity. Con el provider encendido todo spawn
// hubiera muerto sin trabajo con `--model` inválido (mismo modo de falla que la
// migración de NVIDIA, #5887). Este módulo es la verificación AUTOMÁTICA que
// pide el CA-2: cruza lo configurado contra el catálogo que devuelve el CLI y
// falla si divergen — no un chequeo hecho a mano una sola vez.
//
// Qué cruza (`collectConfiguredGeminiModels` + `crossCheck`):
//   config  — providers['antigravity'].model, .alternative_models[],
//             skills.*.model_override y skills.*.fallbacks[].model_override
//             cuando el provider del eslabón es antigravity.
//   barrera 1 — ALLOWED_MODELS_BY_LAUNCHER['antigravity']  (agent-models-validate.js)
//   barrera 2 — CATALOG['antigravity'][].id                (model-catalog.js)
//   (La tercera, PROVIDER_MODELS_ALLOWLIST de completion-client.js, se retiró
//   en #6861 junto con el shim HTTP de AI Studio: antigravity es spawn puro.)
//
// Semántica del veredicto:
//   dead     — id configurado o allowlisted que el CLI NO devuelve. Es un
//              defecto real (mataría agentes) ⇒ `ok:false`.
//   unlisted — id que el CLI devuelve y ninguna barrera conoce. NO es defecto:
//              Antigravity puede publicar modelos nuevos sin que el pipeline
//              tenga que adoptarlos. Se reporta como aviso para que el operador
//              decida (⇒ no baja `ok`). Así un modelo nuevo del vendor nunca
//              dispara un rollback del pipeline por el smoke test.
//
// Fuente: `agy models` escribe a stdout una línea `id<TAB>label` por modelo y
// un spinner a stderr. Tarda ~3 s (va a red), por eso hay caché en memoria con
// TTL. Nunca se cruza contra un catálogo HTTP de Google: el de AI Studio (que
// el pipeline pingeaba hasta #6861) es OTRO catálogo, donde los ids retirados
// SÍ existen — cruzar contra él es lo que dejó pasar el defecto original.
//
// Dónde corre:
//   - test  → lib/__tests__/agy-catalog.test.js (offline con fixture + en vivo
//             si el binario está instalado).
//   - smoke → paso 4 de .pipeline/smoke-test.sh (`node agy-catalog.js --check`).
//   - CLI   → `node .pipeline/lib/multi-provider/agy-catalog.js [--check] [--json]`
//
// Seguridad: el binario se resuelve igual que el handler (ANTIGRAVITY_BIN → ubicación
// oficial → PATH), se ejecuta con execFile (sin shell) y argv fijo `['models']`.
// Los ids que devuelve el CLI se filtran por AGY_MODEL_ID_RE antes de entrar a
// cualquier comparación o log (una línea rara de stdout no llega a Telegram).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const PROVIDER = 'antigravity';
const AGY_MODELS_ARGS = Object.freeze(['models']);
const AGY_MODELS_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
// Mismo alfabeto que health-alerts.sanitizeModelId, sin `/` (Antigravity no
// usa ids con vendor prefix).
const AGY_MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

// -----------------------------------------------------------------------------
// resolveAgyBin(env) — misma cascada que providers/antigravity.js::detectLauncher
// pero sobre un `env` inyectable (el módulo no lee process.env a escondidas).
// -----------------------------------------------------------------------------
function resolveAgyBin(env, fsImpl) {
    const e = env || {};
    const _fs = fsImpl || fs;
    if (typeof e.ANTIGRAVITY_BIN === 'string' && e.ANTIGRAVITY_BIN.length > 0) {
        return { cmd: e.ANTIGRAVITY_BIN, kind: 'configured-native' };
    }
    const local = e.LOCALAPPDATA;
    if (typeof local === 'string' && local.length > 0) {
        const windowsBin = path.join(local, 'agy', 'bin', 'agy.exe');
        if (_fs.existsSync(windowsBin)) return { cmd: windowsBin, kind: 'native-exe' };
    }
    return { cmd: 'agy', kind: 'path-fallback' };
}

// -----------------------------------------------------------------------------
// parseAgyModelsOutput(stdout) → [{ id, label }]
//
// Tolerante a ruido: líneas vacías, el spinner "Fetching available models..."
// (si alguna versión lo mandara a stdout), CR de Windows y columnas extra se
// descartan. Sólo entra lo que parece un id válido.
// -----------------------------------------------------------------------------
function parseAgyModelsOutput(stdout) {
    if (typeof stdout !== 'string' || stdout.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.replace(/\[[0-9;]*[A-Za-z]/g, '').trim();
        if (!line) continue;
        const [idRaw, ...rest] = line.split('\t');
        const id = (idRaw || '').trim();
        if (!AGY_MODEL_ID_RE.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: rest.join('\t').trim() || id });
    }
    return out;
}

// -----------------------------------------------------------------------------
// fetchAgyModels(opts) → { ok, models, ids, error, bin, fetchedAt, fromCache }
//
// opts.env            env a usar para resolver el binario (default process.env)
// opts.execFileSync   inyectable para tests (default child_process.execFileSync)
// opts.timeoutMs      default 30 s
// opts.cacheTtlMs     default 10 min; 0 desactiva la caché
// opts.fresh          true ⇒ ignora la caché
//
// Nunca lanza: un CLI ausente, sin red o con salida vacía devuelve `ok:false`
// con `error` tipado (`cli_unavailable` | `cli_failed` | `empty_catalog`).
// -----------------------------------------------------------------------------
let _cache = { at: 0, result: null };

function fetchAgyModels(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now() : Date.now();
    const ttl = Number.isFinite(o.cacheTtlMs) ? o.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
    if (!o.fresh && ttl > 0 && _cache.result && (now - _cache.at) < ttl) {
        return { ..._cache.result, fromCache: true };
    }
    const env = o.env || process.env;
    const exec = o.execFileSync || childProcess.execFileSync;
    const bin = resolveAgyBin(env, o.fsImpl);
    let stdout = '';
    try {
        stdout = exec(bin.cmd, AGY_MODELS_ARGS.slice(), {
            encoding: 'utf8',
            timeout: Number.isFinite(o.timeoutMs) ? o.timeoutMs : AGY_MODELS_TIMEOUT_MS,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            env,
            maxBuffer: 1024 * 1024,
        });
    } catch (e) {
        const code = e && e.code;
        const error = (code === 'ENOENT' || code === 'EACCES') ? 'cli_unavailable' : 'cli_failed';
        return {
            ok: false, error, models: [], ids: [], bin: bin.cmd, kind: bin.kind,
            detail: String((e && e.message) || e).slice(0, 300), fetchedAt: now, fromCache: false,
        };
    }
    const models = parseAgyModelsOutput(stdout);
    const result = {
        ok: models.length > 0,
        error: models.length > 0 ? null : 'empty_catalog',
        models,
        ids: models.map((m) => m.id),
        bin: bin.cmd,
        kind: bin.kind,
        fetchedAt: now,
        fromCache: false,
    };
    if (result.ok && ttl > 0) _cache = { at: now, result };
    return result;
}

function _resetCacheForTesting() { _cache = { at: 0, result: null }; }

// -----------------------------------------------------------------------------
// collectConfiguredGeminiModels(agentModels) → Map<id, string[]> (id → fuentes)
//
// Las 4 fuentes de #5888 restringidas al provider antigravity. Cada id se
// anota con TODAS las rutas donde aparece para que el mensaje de error sea
// accionable ("qué archivo, qué skill").
// -----------------------------------------------------------------------------
function collectConfiguredGeminiModels(agentModels) {
    const out = new Map();
    const add = (id, source) => {
        if (typeof id !== 'string' || id.length === 0) return;
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(source);
    };
    const cfg = agentModels && typeof agentModels === 'object' ? agentModels : {};
    const provider = cfg.providers && cfg.providers[PROVIDER];
    if (provider && typeof provider === 'object') {
        add(provider.model, `providers.${PROVIDER}.model`);
        if (Array.isArray(provider.alternative_models)) {
            provider.alternative_models.forEach((m, i) => add(m, `providers.${PROVIDER}.alternative_models[${i}]`));
        }
    }
    const skills = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
    for (const [skill, def] of Object.entries(skills)) {
        if (!def || typeof def !== 'object') continue;
        if (def.provider === PROVIDER) {
            add(def.model_override, `skills.${skill}.model_override`);
            // `model` es alias de compatibilidad de #6271.
            add(def.model, `skills.${skill}.model`);
        }
        if (Array.isArray(def.fallbacks)) {
            def.fallbacks.forEach((fb, i) => {
                if (fb && fb.provider === PROVIDER) {
                    add(fb.model_override, `skills.${skill}.fallbacks[${i}].model_override`);
                    add(fb.model, `skills.${skill}.fallbacks[${i}].model`);
                }
            });
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// loadBarriers() → { validate: string[], catalog: string[] }
//
// Lazy require para que el CLI y los tests puedan cargar este módulo con el
// grafo chico. #6861: la barrera `completion` (PROVIDER_MODELS_ALLOWLIST) se
// retiró con el shim HTTP; quedan las dos que gobiernan el spawn.
// -----------------------------------------------------------------------------
function loadBarriers() {
    const validate = require('../agent-models-validate').ALLOWED_MODELS_BY_LAUNCHER[PROVIDER] || [];
    const catalog = (require('./model-catalog').CATALOG[PROVIDER] || []).map((m) => m.id);
    return { validate: validate.slice(), catalog: catalog.slice() };
}

function loadAgentModels(pipelineDir) {
    const file = path.join(pipelineDir || path.join(__dirname, '..', '..'), 'agent-models.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// -----------------------------------------------------------------------------
// crossCheck({ catalogIds, agentModels, barriers }) → veredicto
//
//   ok        false sólo si hay `dead`.
//   dead      [{ id, sources[] }] — configurado/allowlisted pero ausente del CLI.
//   unlisted  [{ id, missingFrom[] }] — en el CLI pero ausente de alguna barrera.
//   summary   línea humana para logs / smoke test.
// -----------------------------------------------------------------------------
function crossCheck(opts) {
    const o = opts || {};
    const catalog = new Set(Array.isArray(o.catalogIds) ? o.catalogIds.filter((x) => typeof x === 'string') : []);
    const barriers = o.barriers || loadBarriers();
    const configured = o.agentModels ? collectConfiguredGeminiModels(o.agentModels) : new Map();

    // id → fuentes, uniendo config + barreras.
    const sources = new Map();
    const add = (id, src) => {
        if (!sources.has(id)) sources.set(id, []);
        sources.get(id).push(src);
    };
    for (const [id, srcs] of configured) srcs.forEach((s) => add(id, `agent-models.json:${s}`));
    for (const id of barriers.validate) add(id, 'ALLOWED_MODELS_BY_LAUNCHER (agent-models-validate.js)');
    for (const id of barriers.catalog) add(id, 'CATALOG (model-catalog.js)');

    const dead = [];
    for (const [id, srcs] of sources) {
        if (!catalog.has(id)) dead.push({ id, sources: srcs });
    }
    dead.sort((a, b) => a.id.localeCompare(b.id));

    const unlisted = [];
    const barrierNames = [['validate', 'ALLOWED_MODELS_BY_LAUNCHER'], ['catalog', 'CATALOG']];
    for (const id of catalog) {
        const missingFrom = barrierNames
            .filter(([key]) => !barriers[key].includes(id))
            .map(([, name]) => name);
        if (missingFrom.length > 0) unlisted.push({ id, missingFrom });
    }
    unlisted.sort((a, b) => a.id.localeCompare(b.id));

    const configuredCount = configured.size;
    const ok = dead.length === 0;
    const summary = ok
        ? `OK: ${configuredCount} id(s) configurados y ${sources.size} id(s) en total (config + 2 barreras) `
            + `están en el catálogo de agy (${catalog.size} modelos)`
            + (unlisted.length ? `; ${unlisted.length} id(s) del CLI sin adoptar (aviso, no bloquea)` : '')
        : `FALLA: ${dead.length} id(s) NO existen en el catálogo de agy (${catalog.size} modelos): `
            + dead.map((d) => `${d.id} ← ${d.sources.join(' | ')}`).join('; ')
            + '. Corregir con un id de `agy models` (pin explícito, nunca alias).';

    return { ok, provider: PROVIDER, dead, unlisted, configured: [...configured.keys()].sort(), catalogSize: catalog.size, summary };
}

// -----------------------------------------------------------------------------
// checkAgainstCli(opts) → { ok, reason, fetch, check }
//
// Orquesta fetch + crossCheck. `reason`:
//   'ok' | 'dead_models' | 'cli_unavailable' | 'cli_failed' | 'empty_catalog'
// Con el CLI ausente devuelve `ok:false, reason:'cli_unavailable'` y deja que el
// caller decida (el smoke test lo trata como aviso: sin agy instalado no hay
// provider que encender, así que no hay nada que pueda romperse).
// -----------------------------------------------------------------------------
function checkAgainstCli(opts) {
    const o = opts || {};
    const fetched = fetchAgyModels(o);
    if (!fetched.ok) return { ok: false, reason: fetched.error, fetch: fetched, check: null };
    const agentModels = o.agentModels || loadAgentModels(o.pipelineDir);
    const check = crossCheck({ catalogIds: fetched.ids, agentModels, barriers: o.barriers });
    return { ok: check.ok, reason: check.ok ? 'ok' : 'dead_models', fetch: fetched, check };
}

// -----------------------------------------------------------------------------
// CLI: node agy-catalog.js [--check] [--json] [--fresh]
//   exit 0 → catálogo OK (o CLI ausente sin --check)
//   exit 1 → hay ids muertos
//   exit 2 → --check y el CLI no está disponible / falló
// -----------------------------------------------------------------------------
function main(argv) {
    const args = new Set(argv || []);
    const res = checkAgainstCli({ fresh: args.has('--fresh') });
    if (args.has('--json')) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.check) {
        process.stdout.write(`[agy-catalog] ${res.check.summary}\n`);
        for (const u of res.check.unlisted) {
            process.stdout.write(`[agy-catalog]   aviso: ${u.id} está en agy models pero falta en ${u.missingFrom.join(', ')}\n`);
        }
    } else {
        process.stdout.write(`[agy-catalog] no se pudo leer el catálogo: ${res.reason} (${res.fetch.bin}) ${res.fetch.detail || ''}\n`);
    }
    if (res.reason === 'dead_models') return 1;
    if (res.reason !== 'ok') return args.has('--check') ? 2 : 0;
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    PROVIDER,
    AGY_MODEL_ID_RE,
    AGY_MODELS_ARGS,
    DEFAULT_CACHE_TTL_MS,
    resolveAgyBin,
    parseAgyModelsOutput,
    fetchAgyModels,
    collectConfiguredGeminiModels,
    loadBarriers,
    loadAgentModels,
    crossCheck,
    checkAgainstCli,
    main,
    _resetCacheForTesting,
};
