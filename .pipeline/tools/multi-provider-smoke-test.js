#!/usr/bin/env node
// =============================================================================
// multi-provider-smoke-test.js — CLI harness multi-provider (#3680 hijo A).
//
// Entrypoint Node puro. Itera matriz skill × provider, persiste matriz
// canónica (.pipeline/multi-provider-coverage.json), deja audit hash-chain,
// dispara sign-off Telegram (queue de filesystem) y crea issues automáticos
// por FAIL (con metadata segura, sin raw output).
//
// Uso:
//   node .pipeline/tools/multi-provider-smoke-test.js                          # matriz completa
//   node .pipeline/tools/multi-provider-smoke-test.js --skill=guru             # solo guru × *
//   node .pipeline/tools/multi-provider-smoke-test.js --provider=cerebras       # solo * × cerebras
//   node .pipeline/tools/multi-provider-smoke-test.js --skill=qa --provider=gemini-google
//   node .pipeline/tools/multi-provider-smoke-test.js --dry-run                # sin invocar providers
//                                                                              # (genera coverage con stub PASS)
//   node .pipeline/tools/multi-provider-smoke-test.js --no-telegram            # no encolar sign-off
//   node .pipeline/tools/multi-provider-smoke-test.js --no-create-issues       # no crear issues por FAIL
//
// Requisitos operativos:
//   - Ventana de pausa válida: `.pausa` (halt total) O `.partial-pause.json`
//     con `allowed_skills` incluyendo `multi-provider-smoke-test`.
//   - Issues dummy 9999 y 10000 NO deben existir en GitHub.
//
// FORCE_PROVIDER_OVERRIDE: el harness lo setea como env del child (per-spawn),
// nunca en process.env del padre. Validator boot-time en pulpo.js aborta si
// está en el env del padre del pipeline productivo (CA-A9).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const COVERAGE_JSON_PATH = path.join(PIPELINE_DIR, 'multi-provider-coverage.json');
const COVERAGE_SCHEMA_PATH = path.join(PIPELINE_DIR, 'multi-provider-coverage.schema.json');

const smoke = require('../lib/multi-provider/smoke-test');
const auditLog = require('../lib/audit-log');
const credentials = require('../lib/credentials');
const partialPause = require('../lib/partial-pause');
const dataResidency = require('../lib/data-residency-filter');

// -----------------------------------------------------------------------------
// CLI args (parser mínimo — sin yargs/commander para evitar deps).
// -----------------------------------------------------------------------------
function parseArgs(argv) {
    const out = { skill: null, provider: null, dryRun: false, noTelegram: false, noCreateIssues: false };
    for (const raw of argv) {
        if (raw.startsWith('--skill=')) out.skill = raw.slice('--skill='.length);
        else if (raw.startsWith('--provider=')) out.provider = raw.slice('--provider='.length);
        else if (raw === '--dry-run') out.dryRun = true;
        else if (raw === '--no-telegram') out.noTelegram = true;
        else if (raw === '--no-create-issues') out.noCreateIssues = true;
        else if (raw === '-h' || raw === '--help') {
            process.stdout.write(`Uso: node .pipeline/tools/multi-provider-smoke-test.js [opciones]
Opciones:
  --skill=<name>        Filtrar a un único skill.
  --provider=<name>     Filtrar a un único provider LLM.
  --dry-run             No invocar providers; generar coverage con PASS stub.
  --no-telegram         No encolar sign-off Telegram.
  --no-create-issues    No crear issues automáticos por FAIL.
  -h, --help            Esta ayuda.
\n`);
            process.exit(0);
        }
    }
    return out;
}

const cliArgs = parseArgs(process.argv.slice(2));

function log(msg) {
    process.stderr.write(`[${new Date().toISOString()}] [smoke-test] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Boot — fail-fast checks (orden importante).
// -----------------------------------------------------------------------------

// 1. Hidratar credenciales (mismo patrón que restart.js).
credentials.loadIntoEnv({ logger: log });

// 2. Coordinación de ventana (CA-A15).
const pipelineMode = partialPause.getPipelineMode();
const coord = smoke.preCheckCoordinationWindow(pipelineMode);
if (!coord.ok) {
    process.stderr.write(`[smoke-test] FATAL ${coord.msg}\n`);
    process.exit(2);
}
log(coord.msg);

// 3. Leer agent-models.json + construir matriz dinámica.
let agentModels;
try {
    agentModels = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, 'agent-models.json'), 'utf8'));
} catch (e) {
    process.stderr.write(`[smoke-test] FATAL no se pudo leer agent-models.json: ${e.message}\n`);
    process.exit(2);
}

const fullMatrix = smoke.buildMatrixFromAgentModels(agentModels);
log(`Matriz construida: ${fullMatrix.length} combinaciones (skills LLM × providers LLM).`);

// 4. Filtrar por CLI args (si vienen).
const filteredMatrix = fullMatrix.filter(cell =>
    (cliArgs.skill === null || cell.skill === cliArgs.skill) &&
    (cliArgs.provider === null || cell.provider === cliArgs.provider)
);
if (filteredMatrix.length === 0) {
    process.stderr.write(`[smoke-test] FATAL filtros --skill/--provider no matchean ninguna combinación.\n`);
    process.exit(2);
}
log(`Tras filtros CLI: ${filteredMatrix.length} combinaciones.`);

// 5. Credenciales por provider (CA-A13).
const providersInMatrix = [...new Set(filteredMatrix.map(c => c.provider))];
const creds = smoke.preCheckProviderCredentials(
    providersInMatrix,
    process.env,
    agentModels,
    credentials.isPlaceholderOrEmpty
);
for (const [p, info] of Object.entries(creds.perProvider)) {
    log(`Credenciales ${p}: ${info.available ? 'OK' : 'MISSING'} (${info.note}${info.missing.length ? ', faltan: ' + info.missing.join(',') : ''})`);
}

// 6. Pre-check de issues dummy (R6 — mitigamos diferenciando errores).
//    En dry-run o cuando no hay gh disponible saltamos (test friendly).
function ghCheckIssue(n) {
    const { spawnSync } = require('node:child_process');
    const res = spawnSync('gh', ['api', `repos/intrale/platform/issues/${n}`, '--jq', '.number'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
    });
    if (res.error) {
        // ENOENT (no gh) → tratamos como skip (no se puede verificar).
        if (res.error.code === 'ENOENT') return { exists: false, errorReason: 'gh_cli_not_available' };
        return { exists: false, errorReason: res.error.code || 'spawn_error' };
    }
    if (res.status === 0) return { exists: true, errorReason: null };
    // gh api retorna != 0 con 404 cuando el issue no existe.
    const stderr = String(res.stderr || '').toLowerCase();
    if (stderr.includes('not found') || stderr.includes('http 404')) {
        return { exists: false, errorReason: 'not_found' };
    }
    return { exists: false, errorReason: stderr.slice(0, 100) || 'unknown_gh_failure' };
}

const dummyCheck = cliArgs.dryRun
    ? { ok: true, skipped: true, msg: 'Skipped (--dry-run)' }
    : smoke.preCheckDummyIssues({ ghCallFn: ghCheckIssue });
if (!dummyCheck.ok) {
    process.stderr.write(`[smoke-test] FATAL ${dummyCheck.msg}\n`);
    process.exit(2);
}
log(dummyCheck.msg);

// -----------------------------------------------------------------------------
// Run loop — serializado (concurrencia = 1), con caps.
// -----------------------------------------------------------------------------

const runStartMs = Date.now();
const runId = smoke.makeRunId(runStartMs);
const auditFile = smoke.auditLogFilePath(PIPELINE_DIR);
const capState = { spawns_total: 0, per_combo: {} };
const coverageEntries = [];

// Hash SHA-256 del agent-models.json para trazabilidad (drift detection).
const agentModelsRaw = fs.readFileSync(path.join(PIPELINE_DIR, 'agent-models.json'), 'utf8');
const agentModelsSha = require('node:crypto').createHash('sha256').update(agentModelsRaw, 'utf8').digest('hex');

// Cargar exclusions de data-residency (CA-A5). Si no se puede, fail-closed
// para non-Anthropic — todas las celdas non-Anthropic quedan FAIL con
// error_class 'data_residency_blocked'.
let exclusionsBundle = null;
let residencyBootError = null;
try {
    exclusionsBundle = dataResidency.loadExclusionsOrThrow();
} catch (e) {
    residencyBootError = e.message;
    log(`WARN data-residency exclusions no disponibles: ${e.message.slice(0, 120)}`);
}

const synthetic = smoke.buildSyntheticPayload();

// Combinación-única-no-eligible primero (entries N/A se setean sin invocar).
// Eligibles después en orden estable.
function isCellEligibleForRun(cell, creds) {
    if (!cell.eligible) return { run: false, status: 'N/A', reason: cell.na_reason };
    // Provider con credencial faltante → SKIPPED (no FAIL).
    const credInfo = creds.perProvider[cell.provider];
    if (!credInfo || !credInfo.available) {
        return { run: false, status: 'SKIPPED', reason: `credencial ${cell.provider}: ${credInfo ? credInfo.note : 'desconocida'}` };
    }
    return { run: true };
}

for (const cell of filteredMatrix) {
    const comboKey = `${cell.skill}::${cell.provider}`;
    const decision = isCellEligibleForRun(cell, creds);

    // N/A o SKIPPED sin spawn.
    if (!decision.run) {
        coverageEntries.push({
            skill: cell.skill,
            provider: cell.provider,
            model: cell.model,
            status: decision.status,
            latency_bucket: 'N/A',
            error_class: null,
            evidence_hash: null,
            reason: decision.reason || null,
        });
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: {
                    event: decision.status === 'N/A' ? 'cell_na' : 'cell_skipped',
                    run_id: runId,
                    skill: cell.skill,
                    provider: cell.provider,
                    model: cell.model,
                    reason: decision.reason || null,
                    ts: new Date().toISOString(),
                },
            });
        } catch (e) {
            log(`WARN audit append failed (${cell.skill}/${cell.provider}): ${e.message}`);
        }
        continue;
    }

    // Caps inquebrantables (CA-A14).
    try {
        smoke.enforceCap(capState, 'spawns_per_run');
        smoke.enforceCap(capState, 'per_combination', comboKey);
    } catch (capErr) {
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: {
                    event: 'cap_exceeded',
                    run_id: runId,
                    cap: capErr.cap,
                    limit: capErr.limit,
                    combo: capErr.combo || null,
                    ts: new Date().toISOString(),
                },
            });
        } catch {}
        process.stderr.write(`[smoke-test] FATAL ${capErr.message}\n`);
        process.exit(3);
    }

    // CA-A5: filtrar paths del payload por provider (non-Anthropic).
    let pathsFilterResult = { allowed: synthetic.paths.slice(), blocked: [] };
    if (cell.provider !== 'anthropic' && exclusionsBundle) {
        try {
            pathsFilterResult = dataResidency.filterPathsForProvider({
                paths: synthetic.paths,
                provider: cell.provider,
                exclusions: exclusionsBundle.exclusions,
                defaultPolicy: exclusionsBundle.default_policy,
            });
        } catch (e) {
            // Fail-closed: si el filter throws, asumimos blocked.
            pathsFilterResult = { allowed: [], blocked: synthetic.paths.map(p => ({ path: p, motivo: 'filter_error: ' + e.message, pattern: null })) };
        }
    } else if (cell.provider !== 'anthropic' && residencyBootError) {
        pathsFilterResult = { allowed: [], blocked: synthetic.paths.map(p => ({ path: p, motivo: 'residency_boot_error: ' + residencyBootError, pattern: null })) };
    }

    let entry;
    if (pathsFilterResult.blocked.length > 0) {
        // CA-A5: data-residency blocked → FAIL inmediato sin invocar.
        entry = {
            skill: cell.skill,
            provider: cell.provider,
            model: cell.model,
            status: 'FAIL',
            latency_bucket: 'N/A',
            error_class: 'data_residency_blocked',
            evidence_hash: null,
            reason: `paths bloqueados por data-residency: ${pathsFilterResult.blocked.map(b => b.motivo).slice(0, 3).join('; ')}`,
        };
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: {
                    event: 'data_residency_blocked',
                    run_id: runId,
                    skill: cell.skill,
                    provider: cell.provider,
                    blocked_count: pathsFilterResult.blocked.length,
                    ts: new Date().toISOString(),
                },
            });
        } catch {}
    } else if (cliArgs.dryRun) {
        // Dry-run: sin invocar provider, todas las eligibles van a PASS con bucket fastest.
        const stubHash = smoke.sha256Hex(`dry-run::${cell.skill}::${cell.provider}::${runId}`);
        entry = {
            skill: cell.skill,
            provider: cell.provider,
            model: cell.model,
            status: 'PASS',
            latency_bucket: '<=100ms',
            error_class: null,
            evidence_hash: `sha256:${stubHash}`,
            reason: 'dry-run (provider no invocado)',
        };
        capState.spawns_total++;
        capState.per_combo[comboKey] = (capState.per_combo[comboKey] || 0) + 1;
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: {
                    event: 'spawn_dry_run',
                    run_id: runId,
                    skill: cell.skill,
                    provider: cell.provider,
                    model: cell.model,
                    exit_code: 0,
                    latency_bucket: '<=100ms',
                    status: 'PASS',
                    raw_excerpt_hash: `sha256:${stubHash}`,
                    ts: new Date().toISOString(),
                },
            });
        } catch (e) {
            log(`WARN audit append failed dry-run: ${e.message}`);
        }
    } else {
        // Invocación real (no implementada en este hijo A para providers reales —
        // requiere wrappers de #3198 que aún están stub para gemini/cerebras/nvidia).
        // Por ahora marcamos SKIPPED con razón explícita para no romper la matriz.
        // Cuando #3198 entregue los wrappers reales, este bloque se reemplaza
        // por dispatch real via resolveSpawnWithFallback con FORCE_PROVIDER_OVERRIDE.
        capState.spawns_total++;
        capState.per_combo[comboKey] = (capState.per_combo[comboKey] || 0) + 1;
        entry = {
            skill: cell.skill,
            provider: cell.provider,
            model: cell.model,
            status: 'SKIPPED',
            latency_bucket: 'N/A',
            error_class: null,
            evidence_hash: null,
            reason: 'wrappers reales de providers non-Anthropic pendientes en #3198. Re-correr con --dry-run para validar el shape de la matriz.',
        };
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: {
                    event: 'cell_skipped_no_wrapper',
                    run_id: runId,
                    skill: cell.skill,
                    provider: cell.provider,
                    ts: new Date().toISOString(),
                },
            });
        } catch {}
    }
    coverageEntries.push(entry);
}

// -----------------------------------------------------------------------------
// Persistir coverage.json (canónico).
// -----------------------------------------------------------------------------
const summary = smoke.summarizeMatrix(coverageEntries);
const coverage = {
    $schema: './multi-provider-coverage.schema.json',
    _doc: 'docs/pipeline/multi-provider-coverage.md',
    version: smoke.SCHEMA_VERSION,
    generated_at: new Date(runStartMs).toISOString(),
    run_id: runId,
    agent_models_source_sha256: agentModelsSha,
    matrix: coverageEntries,
    summary,
};
if (residencyBootError) {
    coverage.warnings = [`data-residency exclusions no disponibles al boot: ${residencyBootError}`];
}

// Validar contra schema antes de escribir (mismo patrón que agent-models-validate).
try {
    const Ajv = require('ajv/dist/2020');
    // strict:false porque usamos `format: date-time` informativo (no exigimos
    // validación de format, sólo schema structural); patrón análogo al de
    // data-residency-filter.
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = JSON.parse(fs.readFileSync(COVERAGE_SCHEMA_PATH, 'utf8'));
    const validate = ajv.compile(schema);
    if (!validate(coverage)) {
        process.stderr.write(`[smoke-test] FATAL coverage.json no valida contra schema:\n${JSON.stringify(validate.errors, null, 2)}\n`);
        process.exit(4);
    }
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        log(`WARN ajv no disponible — skip validación de schema (instalá 'ajv' si querés gating fail-fast).`);
    } else {
        process.stderr.write(`[smoke-test] FATAL validación schema: ${e.message}\n`);
        process.exit(4);
    }
}

// Write atómico (tmp + rename).
const tmpPath = `${COVERAGE_JSON_PATH}.tmp.${process.pid}.${Date.now()}`;
try {
    fs.writeFileSync(tmpPath, JSON.stringify(coverage, null, 2));
    fs.renameSync(tmpPath, COVERAGE_JSON_PATH);
} catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    process.stderr.write(`[smoke-test] FATAL write coverage.json: ${e.message}\n`);
    process.exit(5);
}
log(`coverage.json escrito (${coverageEntries.length} entries, summary=${JSON.stringify(summary)})`);

// -----------------------------------------------------------------------------
// Sign-off Telegram (CA-A18) + issues automáticos por FAIL (CA-A20).
// -----------------------------------------------------------------------------
const failIssues = [];
const failEntries = coverageEntries.filter(e => e.status === 'FAIL');

if (!cliArgs.noCreateIssues && failEntries.length > 0) {
    const { spawnSync } = require('node:child_process');
    for (const fe of failEntries) {
        const title = `[multi-provider-smoke-test] FAIL: ${fe.skill} × ${fe.provider}`;
        const body = [
            `**skill**: \`${fe.skill}\``,
            `**provider**: \`${fe.provider}\``,
            `**model**: \`${fe.model || 'n/a'}\``,
            `**error_class**: \`${fe.error_class || 'unknown'}\``,
            `**latency_bucket**: \`${fe.latency_bucket}\``,
            `**evidence_hash**: \`${fe.evidence_hash || 'n/a'}\``,
            `**run_id**: \`${runId}\``,
            ``,
            `**audit_log**: \`${auditFile.replace(PIPELINE_DIR, '.pipeline')}\``,
            ``,
            `_Body generado por harness multi-provider-smoke-test. Raw output del provider NO incluido (REQ-SEC-10 / CA-A20)._`,
        ].join('\n');
        const res = spawnSync('gh', [
            'issue', 'create',
            '--title', title,
            '--body', body,
            '--label', 'bug',
            '--label', 'area:pipeline',
            '--label', 'tipo:recomendacion',
            '--label', 'needs-human',
            '--label', 'priority:high',
        ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
        if (res.status === 0) {
            const out = String(res.stdout || '').trim();
            const match = out.match(/issues\/(\d+)/);
            failIssues.push({ number: match ? Number(match[1]) : null, url: out, title });
        } else {
            log(`WARN no se pudo crear issue de FAIL ${fe.skill}×${fe.provider}: ${res.stderr || res.error || 'unknown'}`);
        }
    }
}

if (!cliArgs.noTelegram) {
    const queueDir = path.join(PIPELINE_DIR, 'servicios', 'telegram', 'pendiente');
    try { fs.mkdirSync(queueDir, { recursive: true }); } catch {}
    const dropfile = path.join(queueDir, `${Date.now()}-smoke-test-signoff.json`);
    const tts_text = `Smoke test multi-provider terminó: ${summary.pass} PASS, ${summary.warn} WARN, ${summary.fail} FAIL, ${summary.skipped} SKIPPED, ${summary.na} N/A. ` +
        (failIssues.length ? `${failIssues.length} issue${failIssues.length > 1 ? 's' : ''} auto-creado${failIssues.length > 1 ? 's' : ''} por los FAIL.` : 'Sin FAILs detectados.');
    const payload = {
        type: 'multi_provider_smoke_test_signoff',
        run_id: runId,
        summary,
        warn_details: coverageEntries.filter(e => e.status === 'WARN').slice(0, 5).map(e => `${e.skill} × ${e.provider}: ${e.reason || 'sin razón'}`),
        fail_details: failEntries.slice(0, 5).map(e => `${e.skill} × ${e.provider}: ${e.error_class || 'unknown'}`),
        fail_issues: failIssues,
        run_audit_log: auditFile.replace(PIPELINE_DIR, '.pipeline'),
        coverage_json: COVERAGE_JSON_PATH.replace(PIPELINE_DIR, '.pipeline'),
        tts: true,
        tts_text,
        generated_at: new Date().toISOString(),
    };
    try {
        fs.writeFileSync(dropfile, JSON.stringify(payload, null, 2));
        log(`Sign-off Telegram encolado: ${path.basename(dropfile)}`);
    } catch (e) {
        log(`WARN encolado Telegram falló: ${e.message}`);
    }
}

// Resumen final a stdout para CLI consumers (CI, scripts).
process.stdout.write(JSON.stringify({
    ok: true,
    run_id: runId,
    summary,
    coverage_path: COVERAGE_JSON_PATH,
    audit_file: auditFile,
    fail_issues: failIssues,
}, null, 2) + '\n');
process.exit(0);
