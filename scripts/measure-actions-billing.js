#!/usr/bin/env node
// =============================================================================
// measure-actions-billing.js — Medidor de minutos facturables de GitHub Actions
// (#7594, spike "costo de privatizar los repositorios").
//
// Por qué existe: en repos públicos la API de timing (`/actions/runs/{id}/timing`)
// devuelve 0 ms facturables, así que el costo de pasar un repo a privado no se
// puede leer: hay que derivarlo de la duración real de cada job.
//
// Método (CA-1):
//   - Una consulta de runs POR DÍA (`created=YYYY-MM-DD`) para no chocar con el
//     tope silencioso de 1000 resultados de la API con filtros. Si un día trae
//     más de 1000, se parte en tramos de 2 horas.
//   - Por run: `/actions/runs/{id}/jobs?filter=all` (incluye reintentos).
//   - Por job: ceil((completed_at − started_at) / 60 s) × multiplicador del
//     runner (Linux 1, Windows 2, macOS 10). `started_at` es posterior a la
//     cola, así que la espera NO se cuenta. Jobs `skipped` o sin timestamps → 0.
//
// Seguridad (RS-5):
//   - No lee credenciales: usa la sesión que ya tenga `gh` (o GH_TOKEN del
//     entorno). El binario se resuelve con `resolveGhBin()`.
//   - Las respuestas crudas se cachean en `--raw` (por default en el tmp del
//     sistema); el script se niega a escribirlas dentro del repo.
//   - El resumen (`--out`) contiene sólo agregados: repo/workflow/minutos/p50/p95.
//   - Los precios NO están en el código: se leen de `--pricing <json>`.
//
// Uso:
//   node scripts/measure-actions-billing.js --repos platform,kernel --days 30 \
//        --pricing docs/pipeline/evidence/7594/pricing.json \
//        --out docs/pipeline/evidence/7594 [--raw <dir-fuera-del-repo>] [--owner intrale]
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// Multiplicadores de consumo de minutos incluidos por sistema operativo.
const RUNNER_MULTIPLIERS = Object.freeze({ linux: 1, windows: 2, macos: 10 });

// -----------------------------------------------------------------------------
// Funciones puras (exportadas, testeadas en measure-actions-billing.test.js)
// -----------------------------------------------------------------------------

/** Sistema operativo del runner a partir de `job.labels`. */
function runnerOs(labels) {
    const list = Array.isArray(labels) ? labels : [];
    for (const raw of list) {
        const l = String(raw || '').toLowerCase();
        if (l.startsWith('ubuntu') || l === 'linux') return 'linux';
        if (l.startsWith('windows')) return 'windows';
        if (l.startsWith('macos')) return 'macos';
    }
    return 'unknown';
}

/** Multiplicador del runner: 1 Linux / 2 Windows / 10 macOS; desconocido → 1. */
function runnerMultiplier(labels) {
    const osName = runnerOs(labels);
    return RUNNER_MULTIPLIERS[osName] || 1;
}

/** Segundos reales de ejecución del job (sin cola); 0 si no corrió. */
function jobRawSeconds(job) {
    if (!job || job.conclusion === 'skipped') return 0;
    if (!job.started_at || !job.completed_at) return 0;
    const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
    if (!Number.isFinite(ms) || ms < 0) return 0;
    return ms / 1000;
}

/**
 * Minutos facturables de un job: ceil al minuto × multiplicador del runner.
 * Mínimo 1 minuto (× multiplicador) para un job que corrió.
 */
function billableMinutes(job) {
    if (!job || job.conclusion === 'skipped') return 0;
    if (!job.started_at || !job.completed_at) return 0;
    const secs = jobRawSeconds(job);
    const minutes = Math.max(1, Math.ceil(secs / 60));
    return minutes * runnerMultiplier(job.labels);
}

/** Percentil por rango más cercano (nearest-rank). Lista vacía → 0. */
function percentile(values, p) {
    const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Agrega runs normalizados: `[{ repo, workflow, run_attempt, jobs: [...] }]`.
 * Devuelve `{ repos: { repo: { workflows: { wf: {...} }, totals } }, totals, unknown_runner }`.
 * p50/p95 son de minutos facturables POR RUN (suma de sus jobs, todos los attempts).
 */
function aggregate(runs) {
    const repos = {};
    let unknownRunner = 0;
    const emptyStats = () => ({
        runs: 0, jobs: 0, raw_min: 0, billable_min: 0,
        billable_by_os: { linux: 0, windows: 0, macos: 0 },
        raw_by_os: { linux: 0, windows: 0, macos: 0 },
        retried_runs: 0, unknown_runner: 0, _perRun: [],
    });
    for (const run of runs || []) {
        const repo = run.repo || 'unknown';
        const wf = run.workflow || 'unknown';
        repos[repo] = repos[repo] || { workflows: {} };
        const st = repos[repo].workflows[wf] = repos[repo].workflows[wf] || emptyStats();
        st.runs += 1;
        if ((run.run_attempt || 1) > 1) st.retried_runs += 1;
        let runBillable = 0;
        for (const job of run.jobs || []) {
            const b = billableMinutes(job);
            const secs = jobRawSeconds(job);
            if (b === 0 && secs === 0) continue; // skipped / nunca corrió
            let osName = runnerOs(job.labels);
            if (osName === 'unknown') { st.unknown_runner += 1; unknownRunner += 1; osName = 'linux'; }
            st.jobs += 1;
            st.raw_min += secs / 60;
            st.billable_min += b;
            st.billable_by_os[osName] += b;
            st.raw_by_os[osName] += secs / 60;
            runBillable += b;
        }
        st._perRun.push(runBillable);
    }
    const totals = { runs: 0, jobs: 0, raw_min: 0, billable_min: 0,
        billable_by_os: { linux: 0, windows: 0, macos: 0 }, raw_by_os: { linux: 0, windows: 0, macos: 0 } };
    for (const repo of Object.keys(repos)) {
        const rt = { runs: 0, jobs: 0, raw_min: 0, billable_min: 0,
            billable_by_os: { linux: 0, windows: 0, macos: 0 }, raw_by_os: { linux: 0, windows: 0, macos: 0 } };
        for (const wf of Object.keys(repos[repo].workflows)) {
            const st = repos[repo].workflows[wf];
            st.p50_min = percentile(st._perRun, 50);
            st.p95_min = percentile(st._perRun, 95);
            delete st._perRun;
            st.raw_min = round2(st.raw_min);
            for (const k of Object.keys(st.raw_by_os)) st.raw_by_os[k] = round2(st.raw_by_os[k]);
            for (const t of [rt, totals]) {
                t.runs += st.runs; t.jobs += st.jobs; t.raw_min += st.raw_min; t.billable_min += st.billable_min;
                for (const k of Object.keys(t.billable_by_os)) {
                    t.billable_by_os[k] += st.billable_by_os[k];
                    t.raw_by_os[k] += st.raw_by_os[k];
                }
            }
        }
        rt.raw_min = round2(rt.raw_min);
        repos[repo].totals = rt;
    }
    totals.raw_min = round2(totals.raw_min);
    for (const k of Object.keys(totals.raw_by_os)) totals.raw_by_os[k] = round2(totals.raw_by_os[k]);
    return { repos, totals, unknown_runner: unknownRunner };
}

/**
 * Ranking de workflows por minutos facturables (todos los repos).
 * `[{ repo, workflow, billable_min, pct, p50_min, p95_min, runs }]` ordenado desc.
 */
function rankWorkflows(agg, top = 5) {
    const rows = [];
    const total = (agg && agg.totals && agg.totals.billable_min) || 0;
    for (const repo of Object.keys((agg && agg.repos) || {})) {
        for (const [wf, st] of Object.entries(agg.repos[repo].workflows)) {
            rows.push({ repo, workflow: wf, runs: st.runs, jobs: st.jobs,
                billable_min: st.billable_min, raw_min: st.raw_min,
                pct: total > 0 ? round2((st.billable_min / total) * 100) : 0,
                p50_min: st.p50_min, p95_min: st.p95_min });
        }
    }
    rows.sort((a, b) => b.billable_min - a.billable_min);
    return rows.slice(0, top);
}

function jobMatches(run, job, rule) {
    if (rule.workflow && run.workflow !== rule.workflow) return false;
    if (rule.workflows && !rule.workflows.includes(run.workflow)) return false;
    if (rule.job && job.name !== rule.job) return false;
    return true;
}

/**
 * Estima el ahorro MEDIDO de cada optimización candidata sobre los runs reales.
 * Reglas soportadas (en orden; un job consumido por una regla no se re-cuenta):
 *   - `schedule`:    { type, workflow, job, runs_per_day } — el job deja de correr por
 *                    evento y pasa a `schedule`; ahorro = medido − runs_per_day × días × p50 del job.
 *   - `concurrency`: { type, workflow } — `cancel-in-progress` por (workflow, rama, evento):
 *                    cada job se trunca cuando arranca un run más nuevo del mismo grupo.
 *   - `consolidate`: { type, workflows } — los jobs de esos workflows del mismo commit
 *                    corren como pasos de UN job: ceil(Σ segundos) en vez de Σ ceil.
 * Devuelve `[{ id, type, label, measured_min, after_min, saving_min }]`.
 */
function estimateOptimizations(runs, rules, { days = 30 } = {}) {
    const consumed = new Set();
    const keyOf = (run, job, i) => `${run.repo}|${run.id}|${job.id != null ? job.id : i}|${job.run_attempt || run.run_attempt || 1}`;
    const out = [];
    for (const rule of rules || []) {
        let measured = 0;
        let after = 0;
        if (rule.type === 'schedule') {
            const durations = [];
            for (const run of runs || []) {
                (run.jobs || []).forEach((job, i) => {
                    if (!jobMatches(run, job, rule)) return;
                    const b = billableMinutes(job);
                    if (b === 0) return;
                    measured += b; durations.push(b); consumed.add(keyOf(run, job, i));
                });
            }
            after = Math.min(measured, (rule.runs_per_day || 1) * days * percentile(durations, 50));
        } else if (rule.type === 'concurrency') {
            const groups = {};
            for (const run of runs || []) {
                if (rule.workflow && run.workflow !== rule.workflow) continue;
                const g = `${run.repo}|${run.workflow}|${run.head_branch || ''}|${run.event || ''}`;
                (groups[g] = groups[g] || []).push(run);
            }
            for (const list of Object.values(groups)) {
                list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
                list.forEach((run, idx) => {
                    const next = list[idx + 1];
                    const cutoff = next ? Date.parse(next.created_at) : Infinity;
                    (run.jobs || []).forEach((job, i) => {
                        const k = keyOf(run, job, i);
                        if (consumed.has(k)) return;
                        const b = billableMinutes(job);
                        if (b === 0) return;
                        consumed.add(k);
                        measured += b;
                        const start = Date.parse(job.started_at);
                        const end = Date.parse(job.completed_at);
                        if (start >= cutoff) return; // cancelado antes de arrancar → 0
                        const trimmed = Object.assign({}, job, { completed_at: new Date(Math.min(end, cutoff)).toISOString() });
                        after += billableMinutes(trimmed);
                    });
                });
            }
        } else if (rule.type === 'consolidate') {
            const bySha = {};
            for (const run of runs || []) {
                (run.jobs || []).forEach((job, i) => {
                    if (!jobMatches(run, job, rule)) return;
                    const k = keyOf(run, job, i);
                    if (consumed.has(k)) return;
                    const b = billableMinutes(job);
                    if (b === 0) return;
                    consumed.add(k);
                    measured += b;
                    const g = `${run.repo}|${run.head_sha || run.id}|${job.run_attempt || run.run_attempt || 1}`;
                    const acc = bySha[g] = bySha[g] || { secs: 0, mult: 1 };
                    acc.secs += jobRawSeconds(job);
                    acc.mult = Math.max(acc.mult, runnerMultiplier(job.labels));
                });
            }
            for (const acc of Object.values(bySha)) after += Math.max(1, Math.ceil(acc.secs / 60)) * acc.mult;
        } else {
            continue;
        }
        out.push({ id: rule.id || rule.type, type: rule.type, label: rule.label || '',
            measured_min: Math.round(measured), after_min: Math.round(after),
            saving_min: Math.max(0, Math.round(measured - after)) });
    }
    return out;
}

/** Normaliza la cantidad de minutos de una ventana de `days` días a 30 días. */
function monthly(value, days) {
    if (!days || days <= 0) return value;
    return (value * 30) / days;
}

/**
 * Costo USD de minutos por SKU (sin cuota incluida): minutos reales por SO × tarifa.
 * `rawBillableByOs` son minutos facturables (redondeados por job) SIN multiplicador.
 */
function grossMinutesUsd(unmultipliedByOs, pricing) {
    const rates = pricing.per_minute_usd;
    let usd = 0;
    for (const k of ['linux', 'windows', 'macos']) usd += (unmultipliedByOs[k] || 0) * (rates[k] || 0);
    return usd;
}

/**
 * Proyecta los 4 escenarios de costo mensual (CA-2).
 * @param {object} agg        salida de `aggregate` (una ventana de `opts.days` días)
 * @param {object} pricing    tarifas (ver docs/pipeline/evidence/7594/pricing.json)
 * @param {object} opts       { days, storage: { artifacts_gb, cache_gb_by_repo: {repo: gb} },
 *                              active_committers, saving_min }
 * Cada escenario: { id, label, billable_min, included_min, excess_min, minutes_usd,
 *   storage_usd, seats_usd, ghas_usd, control_perdido, total_usd }.
 */
function projectScenarios(agg, pricing, opts = {}) {
    const days = opts.days || 30;
    const totals = (agg && agg.totals) || { billable_min: 0, billable_by_os: {} };
    const billableMonth = monthly(totals.billable_min || 0, days);
    // Minutos por SKU sin multiplicador (para cotizar a tarifa real de cada SO).
    const unmult = {};
    for (const k of ['linux', 'windows', 'macos']) {
        unmult[k] = monthly((totals.billable_by_os && totals.billable_by_os[k]) || 0, days) / RUNNER_MULTIPLIERS[k];
    }
    const grossUsd = grossMinutesUsd(unmult, pricing);
    const storage = opts.storage || {};
    const artifactsGb = storage.artifacts_gb || 0;
    const cacheByRepo = storage.cache_gb_by_repo || {};
    const committers = opts.active_committers || 0;
    const ghasPerCommitter = (pricing.ghas.secret_protection_usd_committer_month || 0)
        + (pricing.ghas.code_security_usd_committer_month || 0);
    const cacheFreeGb = pricing.storage.cache_free_gb_per_repo || 0;
    const cacheRate = pricing.storage.cache_usd_gb_month || 0;
    const cacheExcessUsd = Object.values(cacheByRepo)
        .reduce((acc, gb) => acc + Math.max(0, gb - cacheFreeGb) * cacheRate, 0);
    const seats = pricing.seats || 0;
    const lost = pricing.control_perdido_sin_ghas || 'Se pierde: code scanning / secret scanning + push protection';

    function privateScenario(id, label, planKey, billable, withGhas) {
        const plan = pricing.plans[planKey];
        const included = plan.included_minutes || 0;
        const excess = Math.max(0, billable - included);
        // El excedente se cotiza a tarifa por SKU, prorrateado sobre el total medido.
        const minutesUsd = billableMonth > 0 ? grossUsd * (excess / billableMonth) : 0;
        const storageUsd = Math.max(0, artifactsGb - (plan.included_storage_gb || 0)) * (pricing.storage.artifacts_usd_gb_month || 0)
            + cacheExcessUsd;
        const seatsUsd = seats * (plan.seat_usd_month || 0);
        const ghasUsd = withGhas && plan.ghas_available ? committers * ghasPerCommitter : 0;
        const controlPerdido = withGhas && plan.ghas_available ? '' : lost;
        return { id, label, billable_min: Math.round(billable), included_min: included,
            excess_min: Math.round(excess), minutes_usd: round2(minutesUsd), storage_usd: round2(storageUsd),
            seats_usd: round2(seatsUsd), ghas_usd: round2(ghasUsd), control_perdido: controlPerdido,
            total_usd: round2(minutesUsd + storageUsd + seatsUsd + ghasUsd) };
    }

    const optimized = Math.max(0, billableMonth - monthly(opts.saving_min || 0, days));
    return [
        { id: 'public', label: 'Seguir público', billable_min: 0, included_min: 0, excess_min: 0,
            minutes_usd: 0, storage_usd: 0, seats_usd: 0, ghas_usd: 0,
            control_perdido: '', ghas_note: 'Code scanning y secret scanning gratis en públicos', total_usd: 0 },
        privateScenario('private_free', 'Privado · Free', 'free', billableMonth, false),
        privateScenario('private_team', 'Privado · Team (+ GHAS)', 'team', billableMonth, true),
        privateScenario('private_team_optimized', 'Privado · Team optimizado (+ GHAS)', 'team', optimized, true),
    ];
}

/** Costo de UN run de un workflow de release (runner caro), a tarifa por SKU. */
function releaseRunCost(jobs, pricing) {
    let billable = 0;
    const unmult = { linux: 0, windows: 0, macos: 0 };
    for (const job of jobs || []) {
        const b = billableMinutes(job);
        if (b === 0) continue;
        billable += b;
        const o = runnerOs(job.labels);
        const k = o === 'unknown' ? 'linux' : o;
        unmult[k] += b / RUNNER_MULTIPLIERS[k];
    }
    return { billable_min: billable, usd: round2(grossMinutesUsd(unmult, pricing)) };
}

// -----------------------------------------------------------------------------
// I/O (no se ejecuta al hacer require desde los tests)
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
            opts[argv[i].substring(2)] = argv[++i];
        } else if (argv[i].startsWith('--')) {
            opts[argv[i].substring(2)] = true;
        }
    }
    return {
        owner: opts.owner || 'intrale',
        repos: String(opts.repos || 'platform').split(',').map(s => s.trim()).filter(Boolean),
        days: Math.max(1, parseInt(opts.days, 10) || 30),
        out: opts.out ? path.resolve(opts.out) : path.join(os.tmpdir(), 'measure-actions-billing'),
        raw: opts.raw ? path.resolve(opts.raw) : path.join(os.tmpdir(), 'measure-actions-billing', 'raw'),
        pricing: opts.pricing || '',
        rules: opts.rules || '',
        releaseWorkflows: String(opts['release-workflows'] || '').split(',').map(s => s.trim()).filter(Boolean),
        minRemaining: parseInt(opts['min-remaining'], 10) || 1000,
        calibrate: opts.calibrate || '',
    };
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function makeGh({ minRemaining }) {
    const ghBin = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'gh-bin.js')).resolveGhBin();
    let calls = 0;
    function raw(args) {
        return execFileSync(ghBin, ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
    }
    function throttle() {
        calls += 1;
        if (calls % 25 !== 1) return;
        try {
            const core = JSON.parse(raw(['rate_limit'])).resources.core;
            if (core.remaining < minRemaining) {
                const waitMs = Math.max(0, core.reset * 1000 - Date.now()) + 5000;
                process.stderr.write(`[rate-limit] remaining=${core.remaining} < ${minRemaining}: durmiendo ${Math.round(waitMs / 1000)} s\n`);
                sleepMs(waitMs);
            }
        } catch (e) {
            process.stderr.write(`[rate-limit] no se pudo consultar: ${e.message}\n`);
        }
    }
    return {
        json(endpoint) { throttle(); return JSON.parse(raw([endpoint])); },
        lines(endpoint, jq) {
            throttle();
            const out = raw(['--paginate', endpoint, '--jq', jq]);
            return out.split('\n').filter(Boolean).map(l => JSON.parse(l));
        },
        get calls() { return calls; },
    };
}

function cached(file, fn) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const val = fn();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(val));
    return val;
}

const RUN_JQ = '.workflow_runs[] | {id, name, path, event, status, conclusion, head_branch, head_sha, run_attempt, created_at}';
const JOB_JQ = '.jobs[] | {id, name, run_attempt, status, conclusion, started_at, completed_at, labels}';

function listRunsForDay(gh, owner, repo, day, rawDir) {
    return cached(path.join(rawDir, owner, repo, 'runs', `${day}.json`), () => {
        const probe = gh.json(`repos/${owner}/${repo}/actions/runs?created=${day}&per_page=1`);
        const ranges = [];
        if ((probe.total_count || 0) > 1000) {
            for (let h = 0; h < 24; h += 2) {
                const a = `${day}T${String(h).padStart(2, '0')}:00:00Z`;
                const b = `${day}T${String(h + 1).padStart(2, '0')}:59:59Z`;
                ranges.push(`${a}..${b}`);
            }
        } else if (probe.total_count > 0) {
            ranges.push(day);
        }
        const runs = [];
        for (const r of ranges) runs.push(...gh.lines(`repos/${owner}/${repo}/actions/runs?created=${r}&per_page=100`, RUN_JQ));
        return runs;
    });
}

function listJobs(gh, owner, repo, runId, rawDir) {
    return cached(path.join(rawDir, owner, repo, 'jobs', `${runId}.json`),
        () => gh.lines(`repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`, JOB_JQ));
}

function measureStorage(gh, owner, repo) {
    let cacheBytes = 0;
    try { cacheBytes = gh.json(`repos/${owner}/${repo}/actions/cache/usage`).active_caches_size_in_bytes || 0; } catch (_) { /* repo sin Actions */ }
    let artifactBytes = 0;
    let artifacts = 0;
    try {
        const sizes = gh.lines(`repos/${owner}/${repo}/actions/artifacts?per_page=100`,
            '.artifacts[] | select(.expired == false) | .size_in_bytes');
        artifacts = sizes.length;
        artifactBytes = sizes.reduce((a, b) => a + b, 0);
    } catch (_) { /* repo sin Actions */ }
    const GB = 1024 ** 3;
    return { cache_gb: round2(cacheBytes / GB), artifacts_gb: round2(artifactBytes / GB), artifacts_vigentes: artifacts };
}

function activeCommitters(gh, owner, repo) {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    try {
        const ids = gh.lines(`repos/${owner}/${repo}/commits?since=${since}&per_page=100`,
            '.[] | (.author.login // .commit.author.email)');
        return new Set(ids.filter(Boolean)).size;
    } catch (_) { return 0; }
}

function lastCompletedRunJobs(gh, owner, repo, workflowFile, rawDir) {
    const res = gh.json(`repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?status=completed&per_page=20`);
    const run = (res.workflow_runs || []).find(r => r.conclusion === 'success') || (res.workflow_runs || [])[0];
    if (!run) return null;
    return { run_id: run.id, created_at: run.created_at, jobs: listJobs(gh, owner, repo, run.id, rawDir) };
}

function windowDays(days) {
    const out = [];
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (let i = days; i >= 1; i--) out.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
    return out;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (isInside(opts.raw, REPO_ROOT)) {
        console.error(`--raw (${opts.raw}) está dentro del repo: las respuestas crudas no se versionan (RS-5).`);
        process.exit(2);
    }
    if (!opts.pricing || !fs.existsSync(opts.pricing)) {
        console.error('Falta --pricing <json> con las tarifas vigentes (no hay precios hardcodeados).');
        process.exit(2);
    }
    const pricing = JSON.parse(fs.readFileSync(opts.pricing, 'utf8'));
    const rules = opts.rules && fs.existsSync(opts.rules) ? JSON.parse(fs.readFileSync(opts.rules, 'utf8')) : (pricing.optimization_rules || []);
    const gh = makeGh(opts);
    const days = windowDays(opts.days);
    const runs = [];
    for (const repo of opts.repos) {
        for (const day of days) {
            const dayRuns = listRunsForDay(gh, opts.owner, repo, day, opts.raw).filter(r => r.status === 'completed');
            for (const r of dayRuns) {
                const jobs = listJobs(gh, opts.owner, repo, r.id, opts.raw);
                runs.push({ repo, id: r.id, workflow: r.name, event: r.event, head_branch: r.head_branch,
                    head_sha: r.head_sha, run_attempt: r.run_attempt, created_at: r.created_at, jobs });
            }
            process.stderr.write(`[${repo}] ${day}: ${dayRuns.length} runs (llamadas API: ${gh.calls})\n`);
        }
    }
    const agg = aggregate(runs);
    const storage = { by_repo: {}, artifacts_gb: 0, cache_gb_by_repo: {} };
    let committers = 0;
    for (const repo of opts.repos) {
        const s = measureStorage(gh, opts.owner, repo);
        storage.by_repo[repo] = s;
        storage.artifacts_gb = round2(storage.artifacts_gb + s.artifacts_gb);
        storage.cache_gb_by_repo[repo] = s.cache_gb;
        committers = Math.max(committers, activeCommitters(gh, opts.owner, repo));
    }
    const optimizations = estimateOptimizations(runs, rules, { days: opts.days });
    const savingMin = optimizations.reduce((a, o) => a + o.saving_min, 0);
    const scenarios = projectScenarios(agg, pricing, { days: opts.days, storage, active_committers: committers, saving_min: savingMin });
    const releases = [];
    for (const spec of opts.releaseWorkflows) {
        const [repo, file] = spec.includes(':') ? spec.split(':') : [opts.repos[0], spec];
        try {
            const last = lastCompletedRunJobs(gh, opts.owner, repo, file, opts.raw);
            if (!last) { releases.push({ repo, workflow_file: file, note: 'sin runs completados' }); continue; }
            const cost = releaseRunCost(last.jobs, pricing);
            releases.push({ repo, workflow_file: file, last_run_at: last.created_at,
                jobs: last.jobs.filter(j => billableMinutes(j) > 0).length, runner_os: [...new Set(last.jobs.map(j => runnerOs(j.labels)))],
                billable_min: cost.billable_min, usd_por_release: cost.usd });
        } catch (e) {
            releases.push({ repo, workflow_file: file, note: `error: ${e.message.split('\n')[0]}` });
        }
    }
    let calibration = null;
    if (opts.calibrate) {
        // Todo el histórico del repo privado: el número a comparar con el billing real.
        const all = gh.lines(`repos/${opts.owner}/${opts.calibrate}/actions/runs?per_page=100`, RUN_JQ)
            .filter(r => r.status === 'completed');
        const calRuns = all.map(r => ({ repo: opts.calibrate, id: r.id, workflow: r.name, run_attempt: r.run_attempt,
            jobs: listJobs(gh, opts.owner, opts.calibrate, r.id, opts.raw) }));
        const cagg = aggregate(calRuns);
        calibration = { repo: opts.calibrate, runs: cagg.totals.runs, jobs: cagg.totals.jobs,
            raw_min: cagg.totals.raw_min, billable_min: cagg.totals.billable_min,
            desde: all.length ? all[all.length - 1].created_at : null, hasta: all.length ? all[0].created_at : null,
            comparar_con: `/organizations/${opts.owner}/settings/billing/usage (requiere admin:org)` };
    }
    const summary = {
        generated_at: new Date().toISOString(), owner: opts.owner, repos: opts.repos,
        window: { days: opts.days, from: days[0], to: days[days.length - 1] },
        method: 'ceil((completed_at - started_at)/60s) por job x multiplicador (linux 1, windows 2, macos 10); filter=all; una consulta por dia',
        api_calls: gh.calls, active_committers_90d: committers,
        totals: agg.totals, unknown_runner: agg.unknown_runner, repos: agg.repos,
        top_workflows: rankWorkflows(agg, 5), storage, optimizations, scenarios, releases, calibration,
        pricing_source: { fetched_at: pricing.fetched_at, source_url: pricing.source_url },
    };
    fs.mkdirSync(opts.out, { recursive: true });
    const outFile = path.join(opts.out, 'actions-usage-summary.json');
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n');
    console.log(`Resumen: ${outFile}`);
    console.log(`Minutos facturables (${opts.days} d): ${agg.totals.billable_min} · crudos: ${agg.totals.raw_min}`);
    if (calibration) console.log(`Calibración ${calibration.repo}: ${calibration.billable_min} min facturables — comparar con ${calibration.comparar_con}`);
}

module.exports = {
    RUNNER_MULTIPLIERS, runnerOs, runnerMultiplier, jobRawSeconds, billableMinutes, percentile,
    aggregate, rankWorkflows, estimateOptimizations, projectScenarios, releaseRunCost, monthly,
    parseArgs, isInside, windowDays,
};

if (require.main === module) main();
