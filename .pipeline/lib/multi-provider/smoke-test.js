// =============================================================================
// smoke-test.js — Lógica reutilizable del harness multi-provider (#3680 hijo A)
//
// Patrón: funciones puras inyectables (DI igual que dispatch-with-fallback.js).
// El CLI entrypoint (`tools/multi-provider-smoke-test.js`) ensambla el flujo;
// este módulo provee los building blocks testeables aislados.
//
// Building blocks reutilizados (no duplicar lógica):
//   - lib/audit-log.appendChained        → hash-chain SHA-256 append-only.
//   - lib/credentials.isPlaceholderOrEmpty → placeholder detection.
//   - lib/data-residency-filter.filterPathsForProvider → fail-closed por path.
//   - lib/agent-launcher/dispatch-with-fallback.resolveSpawnWithFallback → resolución.
//   - lib/agent-launcher/provider-error-parser.parseProviderError → taxonomía.
//   - lib/partial-pause.{isSkillAllowed,getPipelineMode} → coordinación de ventana.
//
// Decisiones PO heredadas (issue #3680):
//   - Ruling 1: 'N skills LLM' derivado dinámicamente desde agent-models.json
//               (no hardcodear el conteo).
//   - Ruling 2: schema sibling del JSON (.pipeline/multi-provider-coverage.schema.json).
//   - Ruling 3: ventana de pausa válida con `.pausa` total O
//               .partial-pause.json con allowed_skills que contenga
//               'multi-provider-smoke-test'.
//
// Caps inquebrantables (CA-A14):
//   MAX_SPAWNS_PER_RUN = 60
//   MAX_PER_COMBINATION = 1
//   CONCURRENCY = 1 (serializadas)
//   TIMEOUT_PER_SPAWN_MS = 60000
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HARNESS_SKILL_NAME = 'multi-provider-smoke-test';
const SCHEMA_VERSION = '1.0.0';

// Caps inquebrantables (CA-A14)
const MAX_SPAWNS_PER_RUN = 60;
const MAX_PER_COMBINATION = 1;
const CONCURRENCY = 1;
const TIMEOUT_PER_SPAWN_MS = 60000;

// Dummy issue numbers usados en payload sintético (CA-A4, CA-A12)
const DUMMY_ISSUE_NUMBERS = [9999, 10000];

// -----------------------------------------------------------------------------
// bucketize(ms) — CA-A7. NUNCA devuelve ms absolutos; siempre bucket discreto.
// Defense in depth contra timing oracle (REQ-SEC-9).
// -----------------------------------------------------------------------------
function bucketize(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'N/A';
    if (ms <= 100) return '<=100ms';
    if (ms <= 500) return '<=500ms';
    if (ms <= 2000) return '<=2s';
    if (ms <= 10000) return '<=10s';
    return '>10s';
}

// -----------------------------------------------------------------------------
// buildMatrixFromAgentModels(models) — CA-A1.
//
// Deriva dinámicamente la matriz skill × provider desde agent-models.json:
//   - Excluye skills con provider === 'deterministic'.
//   - Cada combinación marcada como 'eligible' = anthropic + cada provider
//     en fallbacks[] del skill.
//   - El resto de providers LLM marcados 'N/A · single-provider por diseño'.
//   - Skills sin fallbacks (ej. refinar) → única columna activa = primary.
//
// Output: array de entries { skill, provider, model, eligible, na_reason }.
// El caller decide si invoca (eligible=true) o no (eligible=false).
// -----------------------------------------------------------------------------
function buildMatrixFromAgentModels(models) {
    if (!models || typeof models !== 'object' || !models.skills || typeof models.skills !== 'object') {
        throw new Error('[smoke-test] buildMatrixFromAgentModels: agent-models.json sin sección "skills".');
    }
    if (!models.providers || typeof models.providers !== 'object') {
        throw new Error('[smoke-test] buildMatrixFromAgentModels: agent-models.json sin sección "providers".');
    }

    // Providers LLM activos = todos los providers declarados, excluyendo 'deterministic'.
    const allProviders = Object.keys(models.providers).filter(p => p !== 'deterministic');

    const matrix = [];
    for (const skillName of Object.keys(models.skills)) {
        const skillCfg = models.skills[skillName] || {};
        const primaryProvider = skillCfg.provider || 'anthropic';

        // Skills determinísticos: excluidos enteros de la matriz.
        if (primaryProvider === 'deterministic') continue;

        // Lista de providers ELIGIBLES para este skill: primary + fallbacks[].provider
        const eligibleProviders = new Set([primaryProvider]);
        const fallbacks = Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];
        for (const fb of fallbacks) {
            if (typeof fb === 'string') eligibleProviders.add(fb);
            else if (fb && typeof fb === 'object' && typeof fb.provider === 'string') {
                eligibleProviders.add(fb.provider);
            }
        }

        // Modelo efectivo por (skill, provider) — model_override del skill si
        // es el primary, model_override del fallback respectivo, o el default
        // del bloque providers[<x>].model.
        for (const providerName of allProviders) {
            const providerDef = models.providers[providerName] || {};
            const defaultModel = providerDef.model || null;

            let modelForCell = null;
            if (providerName === primaryProvider) {
                modelForCell = skillCfg.model_override || skillCfg.model || defaultModel;
            } else {
                const fbMatch = fallbacks.find(fb =>
                    (typeof fb === 'string' && fb === providerName) ||
                    (fb && typeof fb === 'object' && fb.provider === providerName)
                );
                if (fbMatch && typeof fbMatch === 'object' && fbMatch.model_override) {
                    modelForCell = fbMatch.model_override;
                } else if (fbMatch) {
                    modelForCell = defaultModel;
                } else {
                    modelForCell = defaultModel;
                }
            }

            const eligible = eligibleProviders.has(providerName);
            matrix.push({
                skill: skillName,
                provider: providerName,
                model: modelForCell,
                eligible,
                // CA-A1: skills sin fallbacks declarados → resto de columnas
                // marcadas como 'single-provider por diseño'. Skills con
                // fallbacks pero que no incluyen este provider → 'no en
                // fallback chain'.
                na_reason: eligible
                    ? null
                    : (fallbacks.length === 0
                        ? 'N/A · single-provider por diseño'
                        : 'N/A · no en fallback chain'),
            });
        }
    }

    return matrix;
}

// -----------------------------------------------------------------------------
// preCheckCoordinationWindow(state) — CA-A15.
//
// Verifica que el harness puede correr (ventana de pausa válida).
// Acepta:
//   - state.mode === 'paused' (halt total = `.pausa` archivo presente).
//   - state.mode === 'partial_pause' + allowedSkills incluye HARNESS_SKILL_NAME.
//
// Rechaza con razón accionable si no cumple. Pensada para llamarse al boot del
// harness, antes de cualquier spawn.
// -----------------------------------------------------------------------------
function preCheckCoordinationWindow(state) {
    if (!state || typeof state !== 'object') {
        return {
            ok: false,
            reason: 'pipeline_mode_unknown',
            msg: '[smoke-test] No se pudo determinar el modo del pipeline. ' +
                 'Ejecutar en ventana modo descanso o pausa parcial — ver memoria project_modo-descanso.md.',
        };
    }
    if (state.mode === 'paused') {
        return { ok: true, mode: 'paused', msg: 'Pipeline detenido (.pausa) — ventana segura.' };
    }
    if (state.mode === 'partial_pause'
        && Array.isArray(state.allowedSkills)
        && state.allowedSkills.includes(HARNESS_SKILL_NAME)) {
        return {
            ok: true,
            mode: 'partial_pause',
            msg: `Pausa parcial con allowed_skills incluyendo '${HARNESS_SKILL_NAME}' — ventana segura.`,
        };
    }
    return {
        ok: false,
        reason: 'no_safe_window',
        msg: `[smoke-test] El pipeline está '${state.mode}' sin ventana habilitada para ` +
             `'${HARNESS_SKILL_NAME}'. Activar '.pausa' (halt total) O extender ` +
             `'.partial-pause.json' con allowed_skills: ['${HARNESS_SKILL_NAME}']. ` +
             `Ver memoria project_modo-descanso.md.`,
    };
}

// -----------------------------------------------------------------------------
// preCheckProviderCredentials(providers, env, models) — CA-A13.
//
// Verifica que cada provider tiene su(s) credentials_env declarada(s) en
// agent-models.json no-empty + no-placeholder. Si falta, el provider entero
// queda SKIPPED (no FAIL).
//
// Retorna: { perProvider: { provider: { available: bool, missing: string[] } } }
// -----------------------------------------------------------------------------
function preCheckProviderCredentials(providers, env, models, isPlaceholderOrEmptyFn) {
    const isPlaceholder = isPlaceholderOrEmptyFn || ((v) => {
        if (v === null || v === undefined) return true;
        const s = String(v).trim();
        if (s.length === 0) return true;
        return /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i.test(s);
    });
    const _env = env || {};
    const perProvider = {};

    for (const p of providers) {
        const def = (models && models.providers && models.providers[p]) || {};
        const credList = Array.isArray(def.credentials_env) ? def.credentials_env : [];

        // Anthropic se autentica por OAuth de la CLI (no env var) según
        // agent-models-validate.js → si launcher === 'claude', credentials
        // mínimas son "auto" (consideramos disponible).
        if (def.launcher === 'claude') {
            perProvider[p] = { available: true, missing: [], note: 'oauth (CLI)' };
            continue;
        }

        if (credList.length === 0) {
            // Sin credentials declaradas: asumimos disponible (provider no
            // requiere auth — uso interno, scripts deterministic, etc.).
            perProvider[p] = { available: true, missing: [], note: 'sin credentials declaradas' };
            continue;
        }

        const missing = credList.filter(envVar => isPlaceholder(_env[envVar]));
        perProvider[p] = {
            available: missing.length === 0,
            missing,
            note: missing.length === 0 ? 'credenciales presentes' : 'credencial placeholder/ausente',
        };
    }

    return { perProvider };
}

// -----------------------------------------------------------------------------
// preCheckDummyIssues({ghCallFn, timeoutMs}) — CA-A12.
//
// Verifica empíricamente que los issues dummy (9999, 10000) NO existen en
// GitHub. Si en el futuro existieran issues reales con esos números → abort
// con `dummy_issue_numbers_taken`.
//
// Mitiga R6 distinguiendo 'no existe' (HTTP 404) vs 'network error' (DNS,
// timeout). El distinguir lo hace el caller — acá expectamos un callback que
// retorna `{ exists: bool, errorReason: string | null }`.
//
// Si el `ghCallFn` no se inyecta, retorna { ok: true, skipped: true } (modo
// dry-run sin GitHub). Esto es necesario para tests aislados sin red.
// -----------------------------------------------------------------------------
function preCheckDummyIssues({ ghCallFn } = {}) {
    if (typeof ghCallFn !== 'function') {
        return {
            ok: true,
            skipped: true,
            reason: 'no_gh_call_fn_provided',
            msg: 'preCheckDummyIssues: sin ghCallFn inyectado → skip (modo dry-run).',
        };
    }

    const taken = [];
    const errors = [];
    for (const n of DUMMY_ISSUE_NUMBERS) {
        let result;
        try {
            result = ghCallFn(n);
        } catch (e) {
            errors.push({ issue: n, error: e.message });
            continue;
        }
        if (result && result.exists === true) {
            taken.push(n);
        } else if (result && result.errorReason && result.errorReason !== 'not_found') {
            // Mitigación R6 (#3692): network error ≠ 'no existe'.
            errors.push({ issue: n, error: result.errorReason });
        }
    }

    if (taken.length > 0) {
        return {
            ok: false,
            reason: 'dummy_issue_numbers_taken',
            msg: `[smoke-test] Issues dummy ${taken.join(',')} existen en GitHub. ` +
                 `Re-numerar DUMMY_ISSUE_NUMBERS en lib/multi-provider/smoke-test.js o coordinar con PO.`,
        };
    }
    if (errors.length > 0) {
        return {
            ok: false,
            reason: 'network_or_unknown_error',
            msg: `[smoke-test] No se pudo verificar issues dummy por error de red/desconocido: ` +
                 errors.map(e => `#${e.issue} (${e.error})`).join(', ') +
                 `. NO degradar — abortar y reintentar cuando la red esté disponible.`,
            errors,
        };
    }
    return { ok: true, msg: `Dummy issues ${DUMMY_ISSUE_NUMBERS.join(',')} verificados libres.` };
}

// -----------------------------------------------------------------------------
// buildSyntheticPayload() — CA-A4.
//
// Genera un payload 100% sintético, in-memory, sin leer del repo. Issues 9999
// y 10000 se usan SÓLO como números de referencia en contexto fake. No hay
// llamada a gh issue view; no se persiste el payload.
// -----------------------------------------------------------------------------
function buildSyntheticPayload() {
    const issuePrimary = DUMMY_ISSUE_NUMBERS[0];
    const issueSecondary = DUMMY_ISSUE_NUMBERS[1];
    return {
        // Texto plano, ascii-safe, sin secrets ni paths reales del repo.
        prompt: [
            `[smoke-test sintético #${issuePrimary}]`,
            'Probe minimal para verificar provider responde con shape well-formed.',
            'Sin acciones de archivo, sin gh CLI, sin context real del proyecto.',
            `Referencia secundaria: #${issueSecondary} (también sintético).`,
        ].join('\n'),
        // Paths sintéticos pasables por data-residency-filter. Si el filter
        // los bloquea para algún provider non-Anthropic, la combinación va
        // a FAIL con error_class = 'data_residency_blocked' (CA-A5).
        paths: [
            `docs/smoke-test-fake-${issuePrimary}.md`,
            `docs/smoke-test-fake-${issueSecondary}.md`,
        ],
        meta: {
            issue_primary: issuePrimary,
            issue_secondary: issueSecondary,
            synthetic: true,
        },
    };
}

// -----------------------------------------------------------------------------
// classify(input) — CA-A6.
//
// Mapea (exit_code, latency_bucket, stderr_lines, parser_output) al veredicto
// PASS / WARN / FAIL.
//
// Tabla de verdad:
//   exit_code != 0 OR timeout OR quota_exhausted OR auth → FAIL
//   exit_code == 0 + parser detecta error permanent_failure → FAIL
//   exit_code == 0 + bucket en {<=100ms, <=500ms, <=2s} + sin stderr warnings → PASS
//   exit_code == 0 + bucket {<=10s, >10s} OR stderr warnings → WARN
//   exit_code == 0 + parser_output.errorClass === 'unknown' → WARN (R5 mitigación)
//
// Nota R5: aceptamos 'unknown' como WARN (no FAIL) para v1 — es diagnóstico,
// no gate productivo. Documentado en CA-A22 como deuda.
// -----------------------------------------------------------------------------
function classify({ exit_code, latency_bucket, stderr_lines, parser_output, timed_out, baseline_divergence } = {}) {
    // 1. FAIL hard: exit != 0, timeout, o parser detecta clase grave.
    if (timed_out === true) {
        return { status: 'FAIL', error_class: 'timeout', reason: 'spawn timeout' };
    }
    if (exit_code !== 0) {
        let errorClass = 'unknown';
        if (parser_output && parser_output.errorClass) {
            errorClass = parser_output.errorClass;
        }
        return {
            status: 'FAIL',
            error_class: errorClass,
            reason: `exit_code=${exit_code} (${errorClass})`,
        };
    }
    if (parser_output && parser_output.errorClass === 'quota_exhausted') {
        return { status: 'FAIL', error_class: 'quota_exhausted', reason: 'parser detectó quota exhausted' };
    }
    if (parser_output && parser_output.errorClass === 'auth') {
        return { status: 'FAIL', error_class: 'auth', reason: 'parser detectó auth error' };
    }
    if (parser_output && parser_output.errorClass === 'permanent_failure') {
        return { status: 'FAIL', error_class: 'permanent_failure', reason: 'parser detectó permanent failure' };
    }
    if (parser_output && parser_output.errorClass === 'parser_well_formed_violation') {
        return { status: 'FAIL', error_class: 'parser_well_formed_violation', reason: 'output no well-formed' };
    }

    // 2. WARN: degradación detectada pero exit OK.
    const slowBuckets = ['<=10s', '>10s'];
    const stderrHasWarnings = Array.isArray(stderr_lines) && stderr_lines.some(line => {
        const s = String(line || '').toLowerCase();
        return s.includes('warn') || s.includes('warning') || s.includes('deprecat');
    });

    if (slowBuckets.includes(latency_bucket)) {
        return { status: 'WARN', error_class: 'baseline_divergence', reason: `latencia en bucket ${latency_bucket}` };
    }
    if (stderrHasWarnings) {
        return { status: 'WARN', error_class: 'baseline_divergence', reason: 'warnings en stderr' };
    }
    if (baseline_divergence === true) {
        return { status: 'WARN', error_class: 'baseline_divergence', reason: 'divergencia vs baseline anthropic' };
    }
    // R5 — 'unknown' es WARN para diagnóstico, no FAIL.
    if (parser_output && parser_output.errorClass === 'unknown') {
        return { status: 'WARN', error_class: 'unknown', reason: 'parser no clasificó (revisar manualmente)' };
    }

    // 3. PASS: exit 0 + bucket rápido + sin stderr warnings + sin divergencia.
    return { status: 'PASS', error_class: null, reason: 'output well-formed dentro de baseline' };
}

// -----------------------------------------------------------------------------
// sha256Hex(data) — helper estable para evidence_hash.
// -----------------------------------------------------------------------------
function sha256Hex(data) {
    return crypto.createHash('sha256').update(String(data || ''), 'utf8').digest('hex');
}

// -----------------------------------------------------------------------------
// makeRunId(now) — identificador único para correlacionar entradas del audit
// con la matriz del coverage.json. Mitiga R7 (rotación diaria del JSONL).
// -----------------------------------------------------------------------------
function makeRunId(now) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const nonce = crypto.randomBytes(4).toString('hex');
    return `run-${ts}-${nonce}`;
}

// -----------------------------------------------------------------------------
// auditLogFilePath(pipelineDir, dateOverride) — path del audit log diario.
// Formato: .pipeline/audit/multi-provider-smoke-test-YYYY-MM-DD.jsonl
// -----------------------------------------------------------------------------
function auditLogFilePath(pipelineDir, dateOverride) {
    const d = dateOverride instanceof Date ? dateOverride : new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir, 'audit', `multi-provider-smoke-test-${y}-${m}-${day}.jsonl`);
}

// -----------------------------------------------------------------------------
// enforceCap(state, kind) — CA-A14. Throw con audit entry esperada en el
// caller si se excede algún cap.
//
// kind ∈ { 'spawns_per_run', 'per_combination' }
//
// state estructura:
//   { spawns_total: number, per_combo: { 'skill::provider': count } }
// -----------------------------------------------------------------------------
function enforceCap(state, kind, comboKey) {
    if (kind === 'spawns_per_run') {
        if ((state.spawns_total || 0) >= MAX_SPAWNS_PER_RUN) {
            const e = new Error(`[smoke-test] cap_exceeded: spawns_per_run >= ${MAX_SPAWNS_PER_RUN}`);
            e.code = 'cap_exceeded';
            e.cap = 'spawns_per_run';
            e.limit = MAX_SPAWNS_PER_RUN;
            throw e;
        }
    } else if (kind === 'per_combination') {
        const c = (state.per_combo && state.per_combo[comboKey]) || 0;
        if (c >= MAX_PER_COMBINATION) {
            const e = new Error(`[smoke-test] cap_exceeded: per_combination ${comboKey} >= ${MAX_PER_COMBINATION}`);
            e.code = 'cap_exceeded';
            e.cap = 'per_combination';
            e.limit = MAX_PER_COMBINATION;
            e.combo = comboKey;
            throw e;
        }
    } else {
        throw new Error(`[smoke-test] enforceCap kind desconocido: ${kind}`);
    }
}

// -----------------------------------------------------------------------------
// summarizeMatrix(entries) — produce el objeto `summary` del coverage.json.
// -----------------------------------------------------------------------------
function summarizeMatrix(entries) {
    const summary = { pass: 0, warn: 0, fail: 0, skipped: 0, na: 0, total_combinations: entries.length };
    const skillsSeen = new Set();
    const providersSeen = new Set();
    for (const e of entries) {
        skillsSeen.add(e.skill);
        providersSeen.add(e.provider);
        switch (e.status) {
            case 'PASS':    summary.pass++; break;
            case 'WARN':    summary.warn++; break;
            case 'FAIL':    summary.fail++; break;
            case 'SKIPPED': summary.skipped++; break;
            case 'N/A':     summary.na++; break;
            default: /* shape-unexpected: ignorar — el schema lo detecta luego */ break;
        }
    }
    summary.skills_llm_count = skillsSeen.size;
    summary.providers_llm_count = providersSeen.size;
    return summary;
}

// -----------------------------------------------------------------------------
// Iconografía de estado (CA-10 / guideline UX #1 y #5).
//
// Vocabulario único compartido con el dashboard de coverage
// (.pipeline/views/dashboard/multi-provider-coverage.js). El operador ve el
// mismo lenguaje visual en dashboard + reporte markdown + Telegram.
// -----------------------------------------------------------------------------
const STATUS_ICON = {
    PASS: '✅',
    WARN: '⚠️',
    FAIL: '❌',
    SKIPPED: '⏭️',
    'N/A': '—',
};

function statusIcon(status) {
    return STATUS_ICON[status] || '?';
}

// Leyenda al pie de la tabla — WCAG 1.4.1: el ícono nunca reemplaza la palabra.
const STATUS_LEGEND = 'Leyenda: ✅ PASS · ⚠️ WARN · ❌ FAIL · ⏭️ SKIPPED · — N/A';

// -----------------------------------------------------------------------------
// providerChainForSkill(skillCfg) — devuelve la cadena ordenada de providers
// de un skill: [primary, ...fallbacks]. Acepta fallbacks como string o
// { provider }. No inventa providers: respeta el orden de agent-models.json.
// -----------------------------------------------------------------------------
function providerChainForSkill(skillCfg) {
    const cfg = skillCfg || {};
    const primary = cfg.provider || 'anthropic';
    const chain = [primary];
    const fallbacks = Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [];
    for (const fb of fallbacks) {
        if (typeof fb === 'string') chain.push(fb);
        else if (fb && typeof fb === 'object' && typeof fb.provider === 'string') chain.push(fb.provider);
    }
    return chain;
}

// -----------------------------------------------------------------------------
// overallForStatuses(statuses) — CA-3.
//
// Colapsa la cadena de statuses de un skill a un veredicto único:
//   - PASS    si al menos un provider de la cadena está PASS.
//   - FAIL    si hay algún FAIL y ningún PASS.
//   - WARN    si hay algún WARN y ningún PASS/FAIL (degradado pero respondió).
//   - SKIPPED si todos son SKIPPED / N/A.
//
// Los tres casos nombrados por CA-3 (PASS con ≥1 PASS, SKIPPED con todos
// SKIPPED/N-A, FAIL en otro caso) se cumplen idénticos; WARN-only se surface
// como WARN en vez de diluirlo en FAIL, para no reportar como caído un skill
// cuyos providers respondieron con degradación.
// -----------------------------------------------------------------------------
function overallForStatuses(statuses) {
    const list = Array.isArray(statuses) ? statuses : [];
    if (list.includes('PASS')) return 'PASS';
    if (list.includes('FAIL')) return 'FAIL';
    if (list.includes('WARN')) return 'WARN';
    return 'SKIPPED';
}

// -----------------------------------------------------------------------------
// computeOverallBySkill(coverage, models) — building block compartido por el
// renderer markdown y el reporte Telegram. Pura, sin I/O.
//
// Devuelve un array (una entrada por skill de agent-models.json, en orden de
// declaración) con:
//   { skill, chain, statuses, overall, deterministic }
//
// - `chain`: providers en orden (default primero).
// - `statuses`: status de cada provider de la cadena, leído de coverage.matrix.
//   Si el par (skill, provider) no está en la matriz → 'N/A'.
// - `deterministic`: true si el skill es determinístico (no LLM). Estos no
//   aparecen en coverage.matrix; se muestran igual (CA-2 pide una fila por
//   cada skill) pero no cuentan para el denominador de "skills OK".
// -----------------------------------------------------------------------------
function computeOverallBySkill(coverage, models) {
    if (!models || typeof models !== 'object' || !models.skills || typeof models.skills !== 'object') {
        throw new Error('[smoke-test] computeOverallBySkill: agent-models.json sin sección "skills".');
    }
    const matrix = (coverage && Array.isArray(coverage.matrix)) ? coverage.matrix : [];

    // Índice (skill -> provider -> status) desde la matriz canónica.
    const bySkill = new Map();
    for (const cell of matrix) {
        if (!cell || typeof cell.skill !== 'string' || typeof cell.provider !== 'string') continue;
        if (!bySkill.has(cell.skill)) bySkill.set(cell.skill, {});
        bySkill.get(cell.skill)[cell.provider] = cell.status || 'N/A';
    }

    const rows = [];
    for (const skill of Object.keys(models.skills)) {
        const cfg = models.skills[skill] || {};
        const chain = providerChainForSkill(cfg);
        const deterministic = (cfg.provider || 'anthropic') === 'deterministic';
        const cellStatuses = bySkill.get(skill) || {};
        const statuses = chain.map(p => cellStatuses[p] || 'N/A');
        rows.push({ skill, chain, statuses, overall: overallForStatuses(statuses), deterministic });
    }
    return rows;
}

// -----------------------------------------------------------------------------
// renderPerAgentMarkdown(coverage, models) — CA-1, CA-2, CA-3, CA-10.
//
// Función PURA (sin I/O, sin Date.now()/Math.random()). Consume
// coverage.matrix + models.skills y produce una tabla markdown alineada
// (monospace-friendly para Telegram) con una fila por skill:
//
//   skill | default | fallback1 | ... | fallbackN | overall
//
// El número de columnas de fallback es dinámico = máximo de fallbacks entre
// todos los skills, para nunca ocultar un provider de la cadena (el Gherkin
// pide "cada fila muestra default, fallbacks y overall"). Las celdas muestran
// ícono + palabra (WCAG 1.4.1). Al pie, la leyenda.
//
// NO reconstruye la matriz: sólo lee status desde el coverage ya generado por
// el CLI. Nunca toca error_detail crudo ni cuerpos de respuesta — sólo status,
// que es un enum controlado (PASS/WARN/FAIL/SKIPPED/N/A). Por construcción el
// output no puede contener secrets.
// -----------------------------------------------------------------------------
function renderPerAgentMarkdown(coverage, models) {
    const rows = computeOverallBySkill(coverage, models);

    const maxFallbacks = rows.reduce((m, r) => Math.max(m, Math.max(0, r.chain.length - 1)), 0);
    const header = ['skill', 'default'];
    for (let i = 1; i <= maxFallbacks; i++) header.push(`fallback${i}`);
    header.push('overall');

    const cell = (status) => status ? `${statusIcon(status)} ${status}` : '—';

    const tableRows = rows.map(r => {
        const cols = [r.skill];
        // default + fallbacks alineados a la posición de la cadena.
        for (let i = 0; i < 1 + maxFallbacks; i++) {
            cols.push(i < r.statuses.length ? cell(r.statuses[i]) : '—');
        }
        cols.push(cell(r.overall));
        return cols;
    });

    // Anchos por columna (longitud de string; alineación aproximada en presencia
    // de emojis, limitación conocida de monospace en Telegram).
    const widths = header.map((h, i) => {
        let w = h.length;
        for (const tr of tableRows) w = Math.max(w, String(tr[i] || '').length);
        return w;
    });
    const pad = (s, i) => String(s || '').padEnd(widths[i], ' ');

    const lines = [];
    lines.push('| ' + header.map((h, i) => pad(h, i)).join(' | ') + ' |');
    lines.push('| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |');
    for (const tr of tableRows) {
        lines.push('| ' + tr.map((c, i) => pad(c, i)).join(' | ') + ' |');
    }
    lines.push('');
    lines.push(STATUS_LEGEND);
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// renderTelegramReport(coverage, models, opts) — CA-11 + guidelines UX #2/#3.
//
// Función PURA. Compone el texto del mensaje Telegram con jerarquía F-pattern:
//   (a) titular con veredicto accionable: "N/M skills OK · X FAIL · Y SKIPPED".
//   (b) FAILs primero y agrupados (skill × provider: error_class).
//   (c) tabla por-agente en bloque monospace (```), para preservar alineación
//       en móvil (Telegram no renderiza tablas markdown).
//   (d) timestamp + ruta local al artifact JSON al final.
//
// opts:
//   - generatedAt: string ISO (inyectado; la función no llama Date.now()).
//   - artifactPath: ruta LOCAL al coverage.json (nunca URL firmada — CA-8).
//
// El denominador de "skills OK" excluye skills determinísticos (no LLM), que
// no pueden PASS por diseño (alineado con el ejemplo UX "14/19").
// -----------------------------------------------------------------------------
function renderTelegramReport(coverage, models, opts) {
    const options = opts || {};
    const rows = computeOverallBySkill(coverage, models);
    const llmRows = rows.filter(r => !r.deterministic);

    const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIPPED: 0 };
    for (const r of llmRows) counts[r.overall] = (counts[r.overall] || 0) + 1;
    const totalLlm = llmRows.length;

    // FAILs accionables: celdas FAIL de la matriz (skill × provider: error_class).
    const matrix = (coverage && Array.isArray(coverage.matrix)) ? coverage.matrix : [];
    const failCells = matrix
        .filter(c => c && c.status === 'FAIL')
        .map(c => `❌ ${c.skill} × ${c.provider}: ${c.error_class || 'unknown'}`);

    const lines = [];
    lines.push('🔎 *Smoke test multi-provider*');
    lines.push(`${counts.PASS}/${totalLlm} skills OK · ${counts.FAIL} FAIL · ${counts.WARN} WARN · ${counts.SKIPPED} SKIPPED`);
    if (failCells.length > 0) {
        lines.push('');
        lines.push('*FAILs:*');
        for (const f of failCells.slice(0, 15)) lines.push(f);
        if (failCells.length > 15) lines.push(`… y ${failCells.length - 15} más (ver artifact)`);
    }
    lines.push('');
    lines.push('```');
    lines.push(renderPerAgentMarkdown(coverage, models));
    lines.push('```');
    if (options.generatedAt) lines.push(`🕒 ${options.generatedAt}`);
    if (options.artifactPath) lines.push(`📄 ${options.artifactPath}`);
    return { text: lines.join('\n'), counts, totalLlm, failCount: failCells.length };
}

module.exports = {
    // Constantes públicas
    HARNESS_SKILL_NAME,
    SCHEMA_VERSION,
    MAX_SPAWNS_PER_RUN,
    MAX_PER_COMBINATION,
    CONCURRENCY,
    TIMEOUT_PER_SPAWN_MS,
    DUMMY_ISSUE_NUMBERS,

    // API pública
    bucketize,
    buildMatrixFromAgentModels,
    preCheckCoordinationWindow,
    preCheckProviderCredentials,
    preCheckDummyIssues,
    buildSyntheticPayload,
    classify,
    enforceCap,
    summarizeMatrix,
    auditLogFilePath,
    sha256Hex,
    makeRunId,

    // Render por-agente (#3785)
    STATUS_ICON,
    STATUS_LEGEND,
    statusIcon,
    providerChainForSkill,
    overallForStatuses,
    computeOverallBySkill,
    renderPerAgentMarkdown,
    renderTelegramReport,
};
