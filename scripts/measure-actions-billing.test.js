// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests de measure-actions-billing.js (#7594) — sin red: fixtures inline.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const m = require('./measure-actions-billing.js');

const PRICING = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'pipeline', 'evidence', '7594', 'pricing.json'), 'utf8'));

const T0 = Date.parse('2026-09-01T10:00:00Z');
function job(secs, opts = {}) {
    return {
        id: opts.id, name: opts.name || 'build', run_attempt: opts.run_attempt || 1,
        conclusion: opts.conclusion || 'success',
        labels: opts.labels || ['ubuntu-latest'],
        started_at: opts.started_at !== undefined ? opts.started_at : new Date(opts.start || T0).toISOString(),
        completed_at: opts.completed_at !== undefined ? opts.completed_at
            : new Date((opts.start || T0) + secs * 1000).toISOString(),
    };
}

// --- runnerMultiplier -------------------------------------------------------

test('runnerMultiplier devuelve 1 para ubuntu-latest', () => {
    assert.equal(m.runnerMultiplier(['ubuntu-latest']), 1);
});
test('runnerMultiplier devuelve 2 para windows-latest', () => {
    assert.equal(m.runnerMultiplier(['windows-latest']), 2);
});
test('runnerMultiplier devuelve 10 para macos-latest', () => {
    assert.equal(m.runnerMultiplier(['macos-latest']), 10);
});
test('runnerMultiplier con label desconocido devuelve 1 y runnerOs lo marca unknown', () => {
    assert.equal(m.runnerMultiplier(['self-hosted-gpu']), 1);
    assert.equal(m.runnerOs(['self-hosted-gpu']), 'unknown');
    assert.equal(m.runnerMultiplier(undefined), 1);
});

// --- billableMinutes --------------------------------------------------------

test('billableMinutes: 61 s en Linux son 2 minutos', () => {
    assert.equal(m.billableMinutes(job(61)), 2);
});
test('billableMinutes: 5 s en Linux es 1 minuto (mínimo por job)', () => {
    assert.equal(m.billableMinutes(job(5)), 1);
});
test('billableMinutes: job skipped es 0', () => {
    assert.equal(m.billableMinutes(job(300, { conclusion: 'skipped' })), 0);
});
test('billableMinutes: started_at nulo es 0', () => {
    assert.equal(m.billableMinutes(job(60, { started_at: null })), 0);
    assert.equal(m.billableMinutes(job(60, { completed_at: null })), 0);
});
test('billableMinutes: 61 s en Windows son 4 minutos', () => {
    assert.equal(m.billableMinutes(job(61, { labels: ['windows-latest'] })), 4);
});
test('billableMinutes: 30 s en macOS son 10 minutos', () => {
    assert.equal(m.billableMinutes(job(30, { labels: ['macos-latest'] })), 10);
});
test('jobRawSeconds ignora timestamps invertidos', () => {
    assert.equal(m.jobRawSeconds(job(0, { completed_at: '2026-09-01T09:00:00Z' })), 0);
});

// --- percentile -------------------------------------------------------------

test('percentile usa rango más cercano y lista vacía da 0', () => {
    assert.equal(m.percentile([], 50), 0);
    assert.equal(m.percentile([5, 1, 3, 2, 4], 50), 3);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(m.percentile(hundred, 95), 95);
    assert.equal(m.percentile(hundred, 50), 50);
});

// --- aggregate --------------------------------------------------------------

test('aggregate suma por repo/workflow, incluye reintentos y calcula p50/p95', () => {
    const runs = [
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 1, jobs: [job(61), job(5)] },               // 3
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 2,
            jobs: [job(120, { run_attempt: 1 }), job(120, { run_attempt: 2 })] },                              // 4
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 1, jobs: [job(600)] },                      // 10
        { repo: 'platform', workflow: 'Lint', run_attempt: 1, jobs: [job(10), job(0, { conclusion: 'skipped' })] }, // 1
        { repo: 'kernel', workflow: 'release', run_attempt: 1, jobs: [job(30, { labels: ['macos-latest'] })] },   // 10
    ];
    const agg = m.aggregate(runs);
    const sast = agg.repos.platform.workflows['Security SAST'];
    assert.equal(sast.runs, 3);
    assert.equal(sast.jobs, 5);
    assert.equal(sast.billable_min, 17);
    assert.equal(sast.retried_runs, 1);
    assert.equal(sast.p50_min, 4);
    assert.equal(sast.p95_min, 10);
    assert.equal(agg.repos.platform.workflows.Lint.jobs, 1, 'el job skipped no se cuenta');
    assert.equal(agg.repos.platform.totals.billable_min, 18);
    assert.equal(agg.repos.kernel.totals.billable_by_os.macos, 10);
    assert.equal(agg.totals.billable_min, 28);
    assert.ok(agg.totals.raw_min < agg.totals.billable_min, 'los crudos quedan por debajo de los redondeados');
});

test('aggregate cuenta runners desconocidos sin fallar', () => {
    const agg = m.aggregate([{ repo: 'r', workflow: 'w', jobs: [job(10, { labels: ['raro'] })] }]);
    assert.equal(agg.unknown_runner, 1);
    assert.equal(agg.totals.billable_by_os.linux, 1);
});

test('rankWorkflows ordena por costo y calcula el porcentaje', () => {
    const agg = m.aggregate([
        { repo: 'p', workflow: 'A', jobs: [job(59)] },
        { repo: 'p', workflow: 'B', jobs: [job(179)] },
    ]);
    const top = m.rankWorkflows(agg, 5);
    assert.deepEqual(top.map(r => r.workflow), ['B', 'A']);
    assert.equal(top[0].pct, 75);
});

// --- estimateOptimizations --------------------------------------------------

test('estimateOptimizations: schedule reemplaza los runs por uno diario del p50', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ repo: 'p', id: i, workflow: 'SAST',
        jobs: [job(300, { id: i, name: 'OWASP' })] }));
    const [o] = m.estimateOptimizations(runs, [{ type: 'schedule', workflow: 'SAST', job: 'OWASP', runs_per_day: 1 }], { days: 2 });
    assert.equal(o.measured_min, 50);
    assert.equal(o.after_min, 10);
    assert.equal(o.saving_min, 40);
});

test('estimateOptimizations: concurrency trunca el run viejo cuando arranca uno nuevo de la misma rama', () => {
    const runs = [
        { repo: 'p', id: 1, workflow: 'SAST', head_branch: 'x', event: 'pull_request',
            created_at: new Date(T0).toISOString(), jobs: [job(600, { id: 1 })] },
        { repo: 'p', id: 2, workflow: 'SAST', head_branch: 'x', event: 'pull_request',
            created_at: new Date(T0 + 120000).toISOString(), jobs: [job(600, { id: 2, start: T0 + 120000 })] },
        { repo: 'p', id: 3, workflow: 'SAST', head_branch: 'y', event: 'pull_request',
            created_at: new Date(T0).toISOString(), jobs: [job(600, { id: 3 })] },
    ];
    const [o] = m.estimateOptimizations(runs, [{ type: 'concurrency', workflow: 'SAST' }]);
    assert.equal(o.measured_min, 30);
    assert.equal(o.after_min, 22); // 2 (truncado) + 10 + 10
    assert.equal(o.saving_min, 8);
});

test('estimateOptimizations: consolidate usa un solo redondeo por commit y no re-cuenta jobs consumidos', () => {
    const runs = ['L1', 'L2', 'L3'].map((wf, i) => ({ repo: 'p', id: 10 + i, workflow: wf, head_sha: 'abc',
        jobs: [job(10, { id: 10 + i })] }));
    const rules = [
        { type: 'consolidate', workflows: ['L1', 'L2', 'L3'] },
        { type: 'consolidate', workflows: ['L1'] },
        { type: 'desconocida' },
    ];
    const out = m.estimateOptimizations(runs, rules);
    assert.equal(out.length, 2, 'las reglas desconocidas se ignoran');
    assert.equal(out[0].measured_min, 3);
    assert.equal(out[0].after_min, 1);
    assert.equal(out[0].saving_min, 2);
    assert.equal(out[1].measured_min, 0, 'un job ya consumido no se vuelve a contar');
});

// --- projectScenarios -------------------------------------------------------

function fakeAgg(linuxMin, macosMin = 0) {
    return { totals: { billable_min: linuxMin + macosMin, billable_by_os: { linux: linuxMin, windows: 0, macos: macosMin } } };
}

test('projectScenarios devuelve los 4 escenarios con las mismas columnas', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, { days: 30, active_committers: 1 });
    assert.deepEqual(sc.map(s => s.id), ['public', 'private_free', 'private_team', 'private_team_optimized']);
    const cols = ['billable_min', 'minutes_usd', 'storage_usd', 'seats_usd', 'ghas_usd', 'control_perdido', 'total_usd'];
    for (const s of sc) for (const c of cols) assert.ok(c in s, `${s.id} tiene ${c}`);
    assert.equal(sc[0].total_usd, 0);
});

test('projectScenarios: cada escenario privado trae costo de GHAS o control perdido no vacío', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, { days: 30, active_committers: 2 });
    for (const s of sc.filter(x => x.id !== 'public')) {
        assert.ok(s.ghas_usd > 0 || s.control_perdido.length > 0, s.id);
    }
    assert.ok(sc.find(s => s.id === 'private_free').control_perdido.includes('Se pierde'));
    assert.equal(sc.find(s => s.id === 'private_team').ghas_usd, 2 * (19 + 30));
});

test('projectScenarios: excedente = max(0, minutos − incluidos) y normaliza la ventana a 30 días', () => {
    const [, free, team] = m.projectScenarios(fakeAgg(5000), PRICING, { days: 30 });
    assert.equal(free.excess_min, 3000);
    assert.equal(team.excess_min, 2000);
    assert.equal(free.minutes_usd, 18);           // 3000 × 0.006
    const [, small] = m.projectScenarios(fakeAgg(1000), PRICING, { days: 30 });
    assert.equal(small.excess_min, 0);
    assert.equal(small.minutes_usd, 0);
    const [, half] = m.projectScenarios(fakeAgg(2500), PRICING, { days: 15 });
    assert.equal(half.billable_min, 5000);
});

test('projectScenarios: el escenario optimizado descuenta el ahorro medido y storage/asientos se cotizan', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, {
        days: 30, saving_min: 4000, active_committers: 1,
        storage: { artifacts_gb: 3, cache_gb_by_repo: { platform: 12, kernel: 1 } },
    });
    const team = sc.find(s => s.id === 'private_team');
    const opt = sc.find(s => s.id === 'private_team_optimized');
    assert.equal(opt.billable_min, 6000);
    assert.ok(opt.minutes_usd < team.minutes_usd);
    assert.equal(team.seats_usd, 8);
    assert.equal(team.storage_usd, 0.39);        // (3−2)×0.25 + (12−10)×0.07
    const free = sc.find(s => s.id === 'private_free');
    assert.ok(Math.abs(free.storage_usd - 0.765) <= 0.01); // (3−0.5)×0.25 + 0.14
});

test('projectScenarios cotiza macOS a la tarifa de su SKU', () => {
    const [, free] = m.projectScenarios(fakeAgg(0, 3000), PRICING, { days: 30 }); // 300 min reales de macOS
    // excedente 1000 de 3000 → 1/3 de 300 × 0.062
    assert.equal(free.minutes_usd, 6.2);
});

test('releaseRunCost cotiza un run de iOS (macOS ×10) y de desktop (Windows ×2)', () => {
    const ios = m.releaseRunCost([job(600, { labels: ['macos-latest'] }), job(0, { conclusion: 'skipped' })], PRICING);
    assert.equal(ios.billable_min, 100);
    assert.equal(ios.usd, 0.62);
    const win = m.releaseRunCost([job(61, { labels: ['windows-latest'] }), job(5, { labels: ['raro'] })], PRICING);
    assert.equal(win.billable_min, 5);
    assert.equal(win.usd, 0.03);
});

// --- helpers de CLI ---------------------------------------------------------

test('parseArgs toma defaults fuera del repo y parsea listas', () => {
    const o = m.parseArgs(['--repos', 'platform, kernel', '--days', '14', '--release-workflows', 'platform:a.yml']);
    assert.deepEqual(o.repos, ['platform', 'kernel']);
    assert.equal(o.days, 14);
    assert.deepEqual(o.releaseWorkflows, ['platform:a.yml']);
    assert.equal(m.isInside(o.raw, path.resolve(__dirname, '..')), false);
});

test('isInside detecta paths dentro del repo', () => {
    const root = path.resolve(__dirname, '..');
    assert.equal(m.isInside(path.join(root, 'x', 'raw'), root), true);
    assert.equal(m.isInside(path.resolve(root, '..', 'otro'), root), false);
});

test('windowDays devuelve N días completos terminando ayer', () => {
    const d = m.windowDays(3);
    assert.equal(d.length, 3);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    assert.equal(d[2], yesterday);
    assert.equal(m.monthly(15, 15), 30);
});

// --- Estructurales (RS-5) -----------------------------------------------------

test('el script no referencia stores de credenciales ni .env', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/credentials/i.test(code), 'no menciona credentials');
    assert.ok(!/\.claude[\\/]secrets/.test(code), 'no lee ~/.claude/secrets');
    assert.ok(!/['"`]\.env/.test(code), 'no lee .env');
});

test('el script usa resolveGhBin, respeta el rate limit y no tiene precios hardcodeados', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    assert.match(src, /resolveGhBin\(\)/);
    assert.match(src, /rate_limit/);
    assert.ok(!/execFileSync\(\s*['"]gh['"]/.test(src), 'no invoca el literal gh');
    assert.ok(!/0\.006|0\.062|0\.010/.test(src), 'sin tarifas por minuto en el código');
});

test('ningún archivo nuevo del spike usa pull_request_target', () => {
    const files = [
        path.join(__dirname, 'measure-actions-billing.js'),
        path.join(__dirname, '..', 'docs', 'pipeline', 'evidence', '7594', 'pricing.json'),
    ];
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('pull_request_target'), f);
});

test('countCommitters cuenta ids distintos e ignora vacíos (GHAS se cobra por committer activo)', () => {
    assert.equal(m.countCommitters(['leitolarreta', 'leitolarreta', 'bot@intrale', null, '']), 2);
    assert.equal(m.countCommitters([]), 0);
    assert.equal(m.countCommitters(undefined), 0);
});

test('activeCommitters pide los ids como JSON (tojson) para que lines() pueda parsearlos', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    assert.match(src, /\.commit\.author\.email\) \| tojson/);
});

// =============================================================================
// #7687 — Modo estricto: measure(), runCli(), reintentos y ventana since.
// Sin red: `gh` fake, `sleep` fake y `now` fijo. Directorios en os.tmpdir().
// =============================================================================

const os = require('os');

const PRICING_PATH = path.join(__dirname, '..', 'docs', 'pipeline', 'evidence', '7594', 'pricing.json');
const REPO = path.resolve(__dirname, '..');
const NOW = () => new Date('2026-09-20T12:00:00Z');
const quiet = { log: () => {}, error: () => {}, stderr: () => {}, sleep: () => {} };

function tmpDir(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mab-test-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
}

// Fake de gh: responde por endpoint (primer match por substring), cuenta llamadas y
// puede fallar a demanda.
function fakeGh(routes) {
    const log = [];
    const hit = (ep) => {
        log.push(ep);
        const r = Object.entries(routes).find(([k]) => ep.includes(k));
        if (!r) return [];
        if (r[1] instanceof Error) throw r[1];
        return typeof r[1] === 'function' ? r[1](ep) : r[1];
    };
    return { json: hit, lines: hit, get calls() { return log.length; }, log };
}
const ghErr = (stderr, extra = {}) => Object.assign(new Error(stderr), { stderr }, extra);

const RUN = { id: 11, name: 'CI', event: 'push', status: 'completed', conclusion: 'success',
    head_branch: 'agent/1-secreto', head_sha: 'deadbeefcafe', run_attempt: 1, created_at: '2026-09-19T10:00:00Z' };

// Rutas de una corrida sana; `over` pisa/agrega rutas (van primero en el match).
function okRoutes(over = {}) {
    return Object.assign({}, over, {
        'actions/runs?created=': (ep) => (ep.endsWith('per_page=1') ? { total_count: 1 } : [RUN]),
        '/jobs?': [job(61, { id: 1 })],
        'actions/cache/usage': { active_caches_size_in_bytes: 1024 },
        'actions/artifacts': [2048],
        '/commits': ['leitolarreta', 'alguien@intrale.com'],
        'actions/workflows/': { workflow_runs: [{ id: 99, conclusion: 'success', created_at: '2026-09-18T00:00:00Z' }] },
    }, over);
}

function opts(t, extra = []) {
    const raw = tmpDir(t);
    return m.parseArgs(['--pricing', PRICING_PATH, '--raw', raw, '--out', path.join(raw, 'out'), '--days', '2', ...extra]);
}

// --- windowDaysSince (CA-1) --------------------------------------------------

test('windowDaysSince recorta los días previos a since y devuelve [] si since es futuro', () => {
    const today = NOW();
    assert.deepEqual(m.windowDays(3, today), ['2026-09-17', '2026-09-18', '2026-09-19']);
    assert.deepEqual(m.windowDaysSince(3, '2026-09-18', today), ['2026-09-18', '2026-09-19']);
    assert.deepEqual(m.windowDaysSince(3, '2026-09-20', today), [], 'hoy todavía no es un día completo');
    assert.deepEqual(m.windowDaysSince(3, '2027-01-01', today), []);
    assert.deepEqual(m.windowDaysSince(3, '', today), m.windowDays(3, today), 'sin since equivale a windowDays');
});

test('windowDays no muta el Date recibido', () => {
    const today = NOW();
    m.windowDays(2, today);
    assert.equal(today.toISOString(), '2026-09-20T12:00:00.000Z');
});

// --- measure con ventana vacía (CA-2) ----------------------------------------

test('measure con since futuro deja window.from/to en null y totales en 0', (t) => {
    const gh = fakeGh(okRoutes());
    const s = m.measure(opts(t, ['--strict', '--since', '2026-12-01']), { ...quiet, gh, now: NOW });
    assert.ok('from' in s.window && 'to' in s.window);
    assert.equal(s.window.from, null);
    assert.equal(s.window.to, null);
    assert.equal(s.totals.billable_min, 0);
    assert.equal(s.generated_at, '2026-09-20T12:00:00.000Z');
});

// --- validación de argumentos (CA-3, CA-13, CA-19) ----------------------------

test('runCli sale con 2 ante --since inválido o sin valor', (t) => {
    for (const since of ['2026-02-30', '2026-13-45', 'abc']) {
        assert.equal(m.runCli(['--strict', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--since', since], quiet), 2, since);
    }
    assert.equal(m.runCli(['--pricing', PRICING_PATH, '--raw', tmpDir(t), '--since'], quiet), 2, 'flag sin valor');
    assert.equal(m.isValidIsoDate('2024-02-29'), true);
    assert.equal(m.isValidIsoDate('2026-02-29'), false);
});

test('runCli en strict con --raw dentro del repo sale con 2 sin crear nada', () => {
    const inside = path.join(REPO, `tmp-x-7687-${process.pid}`);
    const gh = fakeGh(okRoutes());
    assert.equal(m.runCli(['--strict', '--pricing', PRICING_PATH, '--raw', inside], { ...quiet, gh }), 2);
    assert.equal(fs.existsSync(inside), false);
    assert.equal(gh.calls, 0, 'no se llama a gh');
});

test('runCli en strict rechaza --owner y --repos con caracteres peligrosos', (t) => {
    const base = ['--strict', '--pricing', PRICING_PATH, '--raw', tmpDir(t)];
    assert.equal(m.runCli([...base, '--owner', 'a/b'], quiet), 2);
    assert.equal(m.runCli([...base, '--repos', 'x?y'], quiet), 2);
    assert.equal(m.runCli([...base, '--calibrate', 'a&b'], quiet), 2);
    assert.equal(m.runCli([...base, '--release-workflows', 'platform:../x.yml'], quiet), 2);
});

test('validateOpts lanza MeasureError args si falta --pricing', (t) => {
    const o = m.parseArgs(['--raw', tmpDir(t)]);
    assert.throws(() => m.validateOpts(o), (e) => e instanceof m.MeasureError && e.kind === 'args' && /--pricing/.test(e.message));
    assert.doesNotThrow(() => m.validateOpts(m.parseArgs(['--raw', tmpDir(t), '--pricing', PRICING_PATH, '--owner', 'a/b'])),
        'sin strict el owner no se valida (CA-20)');
});

// --- withRetry y classifyGhError (CA-5 a CA-9) --------------------------------

function counting(fn) { const f = () => { f.calls += 1; return fn(f.calls); }; f.calls = 0; return f; }

test('withRetry: 5xx persistente hace 4 llamadas con esperas 2/8/30 s y lanza kind api', () => {
    const slept = [];
    const fn = counting(() => { throw ghErr('HTTP 502: Bad Gateway'); });
    assert.throws(() => m.withRetry(fn, { sleep: (ms) => slept.push(ms), endpoint: 'repos/o/r/actions/runs' }),
        (e) => e instanceof m.MeasureError && e.kind === 'api' && e.status === 502);
    assert.equal(fn.calls, 4);
    assert.deepEqual(slept, [2000, 8000, 30000]);
});

test('withRetry reintenta un timeout y devuelve el valor cuando se recupera', () => {
    const slept = [];
    const fn = counting((n) => { if (n === 1) throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }); return 'ok'; });
    assert.equal(m.withRetry(fn, { sleep: (ms) => slept.push(ms) }), 'ok');
    assert.equal(fn.calls, 2);
    assert.deepEqual(slept, [2000]);
});

test('withRetry: 429 o 403 de rate limit secundario persistente lanza kind rate_limit', () => {
    for (const stderr of ['HTTP 429: Too Many Requests', 'gh: You have exceeded a secondary rate limit (HTTP 403)']) {
        const fn = counting(() => { throw ghErr(stderr); });
        assert.throws(() => m.withRetry(fn, { sleep: () => {} }), (e) => e.kind === 'rate_limit', stderr);
        assert.equal(fn.calls, 4, stderr);
    }
});

test('withRetry no reintenta 404, 401 ni 403 común', () => {
    for (const stderr of ['gh: Not Found (HTTP 404)', 'HTTP 401: Bad credentials', 'HTTP 403: Resource not accessible by integration']) {
        const slept = [];
        const fn = counting(() => { throw ghErr(stderr); });
        assert.throws(() => m.withRetry(fn, { sleep: (ms) => slept.push(ms) }), (e) => e.kind === 'api', stderr);
        assert.equal(fn.calls, 1, stderr);
        assert.deepEqual(slept, []);
    }
});

test('withRetry avisa cada reintento por onRetry y respeta un MeasureError ya tipado', () => {
    const seen = [];
    const fn = counting(() => { throw ghErr('HTTP 503'); });
    assert.throws(() => m.withRetry(fn, { sleep: () => {}, onRetry: (r) => seen.push(`${r.attempt}/${r.of}:${r.delayMs}`) }));
    assert.deepEqual(seen, ['1/3:2000', '2/3:8000', '3/3:30000']);
    const typed = new m.MeasureError('rate_limit', 'x');
    const fn2 = counting(() => { throw typed; });
    assert.throws(() => m.withRetry(fn2, { sleep: () => {} }), (e) => e === typed);
    assert.equal(fn2.calls, 1);
});

test('el mensaje de error es de una línea, trae status y endpoint y no el resto del stderr', () => {
    const stderr = 'gh: Server Error (HTTP 500)\n{"author":{"email":"secreto@intrale.com","login":"leito"}}';
    const fn = () => { throw ghErr(stderr); };
    try {
        m.withRetry(fn, { attempts: 0, endpoint: 'repos/intrale/platform/commits' });
        assert.fail('debía lanzar');
    } catch (e) {
        assert.ok(!e.message.includes('\n'));
        assert.match(e.message, /HTTP 500/);
        assert.match(e.message, /repos\/intrale\/platform\/commits/);
        assert.ok(!/secreto|@|leito/.test(e.message));
    }
});

test('classifyGhError cubre timeout, SIGTERM, 5xx, 429, 403 con y sin rate limit y errores sin status', () => {
    assert.deepEqual(m.classifyGhError({ code: 'ETIMEDOUT' }), { retryable: true, kind: 'api', status: 'timeout' });
    assert.deepEqual(m.classifyGhError({ signal: 'SIGTERM' }), { retryable: true, kind: 'api', status: 'timeout' });
    assert.deepEqual(m.classifyGhError(ghErr('HTTP 504')), { retryable: true, kind: 'api', status: 504 });
    assert.deepEqual(m.classifyGhError(ghErr('HTTP 429')), { retryable: true, kind: 'rate_limit', status: 429 });
    assert.deepEqual(m.classifyGhError(ghErr('API rate limit exceeded (HTTP 403)')), { retryable: true, kind: 'rate_limit', status: 403 });
    assert.deepEqual(m.classifyGhError(ghErr('HTTP 403: Forbidden')), { retryable: false, kind: 'api', status: 403 });
    assert.deepEqual(m.classifyGhError(new SyntaxError('Unexpected token')), { retryable: false, kind: 'api', status: null });
    assert.deepEqual(m.classifyGhError(undefined), { retryable: false, kind: 'api', status: null });
});

// --- runCli: exit codes 3 y 4 en strict (CA-8) --------------------------------

test('runCli en strict sale con 3 si se agota el rate limit y con 4 ante un 500 persistente', (t) => {
    const argv = () => ['--strict', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', path.join(tmpDir(t), 'out'), '--days', '1'];
    const errors = [];
    const deps = (stderr) => ({ ...quiet, now: NOW, error: (s) => errors.push(s),
        exec: () => { throw ghErr(stderr); } });
    assert.equal(m.runCli(argv(), deps('HTTP 429: Too Many Requests')), 3);
    assert.equal(m.runCli(argv(), deps('HTTP 500: Internal Server Error')), 4);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /Límite de uso de la API de GitHub agotado/);
    assert.match(errors[1], /Error de la API de GitHub \(HTTP 500/);
});

test('runCli en strict mapea un error crudo del gh inyectado a exit 4', (t) => {
    const gh = fakeGh(okRoutes({ 'actions/runs?created=': ghErr('HTTP 502: Bad Gateway') }));
    assert.equal(m.runCli(['--strict', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', path.join(tmpDir(t), 'o')],
        { ...quiet, gh, now: NOW }), 4);
});

test('runCli sin strict propaga un error de API igual que antes (sin mapeo nuevo)', (t) => {
    const gh = fakeGh(okRoutes({ 'actions/runs?created=': ghErr('HTTP 502: Bad Gateway') }));
    assert.throws(() => m.runCli(['--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', path.join(tmpDir(t), 'o'), '--days', '1'],
        { ...quiet, gh, now: NOW }), /HTTP 502/);
});

// --- measure en strict relanza en vez de devolver 0 (CA-11) --------------------

for (const [label, route] of [['storage', 'actions/cache/usage'], ['commits', '/commits'], ['releases', 'actions/workflows/']]) {
    test(`measure en strict lanza si falla ${label}; sin strict devuelve 0 o note`, (t) => {
        const extra = ['--release-workflows', 'platform:release.yml'];
        const failing = () => fakeGh(okRoutes({ [route]: ghErr('HTTP 502: Bad Gateway') }));
        assert.throws(() => m.measure(opts(t, ['--strict', ...extra]), { ...quiet, gh: failing(), now: NOW }), /HTTP 502/);
        const s = m.measure(opts(t, extra), { ...quiet, gh: failing(), now: NOW });
        if (label === 'storage') assert.equal(s.storage.cache_gb_by_repo.platform, 0);
        if (label === 'commits') assert.equal(s.active_committers_90d, 0);
        if (label === 'releases') assert.match(s.releases[0].note, /^error: /);
    });
}

test('measure en strict falla también si falla la consulta de artifacts', (t) => {
    const gh = fakeGh(okRoutes({ 'actions/artifacts': ghErr('HTTP 500') }));
    assert.throws(() => m.measure(opts(t, ['--strict']), { ...quiet, gh, now: NOW }), /HTTP 500/);
});

test('measure en strict con todo sano mide runs, storage, committers y releases', (t) => {
    const gh = fakeGh(okRoutes());
    const s = m.measure(opts(t, ['--strict', '--release-workflows', 'platform:release.yml']), { ...quiet, gh, now: NOW });
    assert.equal(s.totals.runs, 2, 'un run por cada uno de los 2 días');
    assert.equal(s.active_committers_90d, 2);
    assert.equal(s.releases[0].billable_min, 2);
    assert.ok(gh.log.some(ep => ep.includes('/commits?since=2026-06-22')), 'since de commits sale del now inyectado');
});

// --- --skip-storage / --skip-releases (CA-12) ----------------------------------

test('--skip-storage y --skip-releases no llaman a esas consultas y conservan la forma', (t) => {
    const gh = fakeGh(okRoutes());
    const s = m.measure(opts(t, ['--strict', '--skip-storage', '--skip-releases', '--release-workflows', 'platform:release.yml']),
        { ...quiet, gh, now: NOW });
    assert.ok(!gh.log.some(ep => /cache\/usage|artifacts|workflows\/|\/commits/.test(ep)), gh.log.join('\n'));
    assert.deepEqual(s.storage, { by_repo: {}, artifacts_gb: 0, cache_gb_by_repo: {} });
    assert.equal(s.active_committers_90d, 0);
    assert.deepEqual(s.releases, []);
});

// --- directorio temporal y caché (CA-14, CA-15, SEC-1, SEC-2) -------------------

test('en strict se borra sólo el subdirectorio propio y no se lee la caché legada', (t) => {
    const parent = tmpDir(t);
    const sentinel = path.join(parent, 'centinela.txt');
    fs.writeFileSync(sentinel, 'no borrar');
    // JSON "envenenado" justo donde el modo legado buscaría la caché del día.
    const poisoned = path.join(parent, 'intrale', 'platform', 'runs', '2026-09-19.json');
    fs.mkdirSync(path.dirname(poisoned), { recursive: true });
    fs.writeFileSync(poisoned, JSON.stringify([Object.assign({}, RUN, { id: 666 })]));
    const noRuns = { 'actions/runs?created=': (ep) => (ep.endsWith('per_page=1') ? { total_count: 0 } : []) };
    const o = m.parseArgs(['--strict', '--pricing', PRICING_PATH, '--raw', parent, '--days', '1']);

    const ok = m.measure(o, { ...quiet, gh: fakeGh(okRoutes(noRuns)), now: NOW });
    assert.equal(ok.totals.runs, 0, 'no refleja el JSON envenenado');
    const failing = fakeGh(okRoutes(Object.assign({}, noRuns, { 'actions/cache/usage': ghErr('HTTP 500') })));
    assert.throws(() => m.measure(o, { ...quiet, gh: failing, now: NOW }));

    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'no borrar');
    assert.ok(fs.existsSync(poisoned));
    assert.deepEqual(fs.readdirSync(parent).filter(n => n.startsWith('measure-actions-')), []);
});

// --- escritura atómica (CA-16, CA-17) ---------------------------------------------

test('runCli en strict con --summary-only no deja nada en --out si measure falla', (t) => {
    const out = path.join(tmpDir(t), 'out');
    const gh = fakeGh(okRoutes({ '/commits': ghErr('HTTP 500') }));
    assert.equal(m.runCli(['--strict', '--summary-only', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', out, '--days', '1'],
        { ...quiet, gh, now: NOW }), 4);
    assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0);
});

test('una corrida OK con --summary-only deja sólo actions-usage-summary.json', (t) => {
    const out = path.join(tmpDir(t), 'out');
    const lines = [];
    assert.equal(m.runCli(['--strict', '--summary-only', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', out, '--days', '1'],
        { ...quiet, log: (s) => lines.push(s), gh: fakeGh(okRoutes()), now: NOW }), 0);
    assert.deepEqual(fs.readdirSync(out), ['actions-usage-summary.json']);
    assert.equal(lines[0], `Resumen: ${path.join(out, 'actions-usage-summary.json')}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'actions-usage-summary.json'), 'utf8')).totals.runs, 1);
});

test('runCli avisa la ventana vacía', (t) => {
    const lines = [];
    assert.equal(m.runCli(['--strict', '--summary-only', '--since', '2026-12-01', '--pricing', PRICING_PATH, '--raw', tmpDir(t),
        '--out', path.join(tmpDir(t), 'o')], { ...quiet, log: (s) => lines.push(s), gh: fakeGh(okRoutes()), now: NOW }), 0);
    assert.ok(lines.includes('Ventana vacía: no hay días desde 2026-12-01; totales en 0.'));
});

test('writeSummaryAtomic borra el .tmp si el rename falla y runCli en strict sale con 4', (t) => {
    const out = path.join(tmpDir(t), 'out');
    const original = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
    try {
        assert.throws(() => m.writeSummaryAtomic(out, { a: 1 }), /EPERM/);
        assert.deepEqual(fs.readdirSync(out), []);
        assert.equal(m.runCli(['--strict', '--summary-only', '--pricing', PRICING_PATH, '--raw', tmpDir(t), '--out', out, '--days', '1'],
            { ...quiet, gh: fakeGh(okRoutes()), now: NOW }), 4);
        assert.deepEqual(fs.readdirSync(out), []);
    } finally {
        fs.renameSync = original;
    }
    assert.equal(m.writeSummaryAtomic(out, { a: 1 }), path.join(out, 'actions-usage-summary.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'actions-usage-summary.json'), 'utf8')), { a: 1 });
});

// --- privacidad del summary (CA-18) ---------------------------------------------

test('el summary no contiene head_branch, head_sha, logins ni emails', (t) => {
    const s = m.measure(opts(t, ['--strict', '--release-workflows', 'platform:release.yml']), { ...quiet, gh: fakeGh(okRoutes()), now: NOW });
    const json = JSON.stringify(s);
    assert.ok(!/head_branch|head_sha|@|"login"|leitolarreta|agent\/1-secreto|deadbeef/.test(json), json);
});

// --- compatibilidad del modo legado (CA-20) y texto prohibido (CA-21) ------------

test('parseArgs([]) conserva los defaults del modo legado', () => {
    const o = m.parseArgs([]);
    assert.equal(o.owner, 'intrale');
    assert.deepEqual(o.repos, ['platform']);
    assert.equal(o.days, 30);
    assert.equal(o.out, path.join(os.tmpdir(), 'measure-actions-billing'));
    assert.equal(o.raw, path.join(os.tmpdir(), 'measure-actions-billing', 'raw'));
    assert.equal(o.pricing, '');
    assert.equal(o.rules, '');
    assert.deepEqual(o.releaseWorkflows, []);
    assert.equal(o.minRemaining, 1000);
    assert.equal(o.calibrate, '');
    assert.equal(o.strict, false);
    assert.equal(o.since, '');
    assert.equal(o.summaryOnly, false);
    assert.equal(o.skipStorage, false);
    assert.equal(o.skipReleases, false);
});

test('en modo legado las claves del summary son las de siempre y runCli escribe como antes', (t) => {
    const raw = tmpDir(t);
    const out = path.join(tmpDir(t), 'out');
    const s = m.measure(m.parseArgs(['--pricing', PRICING_PATH, '--raw', raw, '--days', '1']), { ...quiet, gh: fakeGh(okRoutes()), now: NOW });
    assert.deepEqual(Object.keys(s).sort(), ['active_committers_90d', 'api_calls', 'calibration', 'generated_at', 'method', 'optimizations',
        'owner', 'pricing_source', 'releases', 'repos', 'scenarios', 'storage', 'top_workflows', 'totals', 'unknown_runner', 'window'].sort());
    assert.ok(fs.existsSync(path.join(raw, 'intrale', 'platform', 'runs', '2026-09-19.json')), 'el legado sigue cacheando en --raw');
    assert.equal(m.runCli(['--pricing', PRICING_PATH, '--raw', raw, '--out', out, '--days', '1'], { ...quiet, gh: fakeGh(okRoutes()), now: NOW }), 0);
    assert.deepEqual(fs.readdirSync(out), ['actions-usage-summary.json']);
});

test('la calibración compara contra la doc de medición, no contra settings de billing', (t) => {
    const gh = fakeGh(okRoutes({ 'repos/intrale/kernel/actions/runs?per_page=100': [RUN] }));
    const s = m.measure(opts(t, ['--strict', '--calibrate', 'kernel']), { ...quiet, gh, now: NOW });
    assert.equal(s.calibration.repo, 'kernel');
    assert.equal(s.calibration.runs, 1);
    assert.equal(s.calibration.comparar_con, 'billing real de la org, ver docs/pipeline/actions-usage-measure.md');
});

test('el script no referencia settings/billing ni gh auth refresh', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    assert.ok(!/settings\/billing|gh auth refresh/.test(src));
});
