// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de lib/actions-usage-cron/index.js (#7689, parte 3/4 de #7661).
// Usa `report.js` y `mapping.js` reales (#7688) con un `spawnMeasure` fake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const index = require('../index');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const PRICING = {
    per_minute_usd: { linux: 0.006, windows: 0.01, macos: 0.062 },
    plans: { free: { included_minutes: 2000 }, team: { included_minutes: 3000 } },
    optimization_rules: [],
};

const BASELINE = {
    window: { days: 30, from: '2026-08-24', to: '2026-09-22' },
    totals: { billable_min: 3000 },
    repos: { platform: { workflows: { 'Admission Gate': { billable_min: 1200 }, Lints: { billable_min: 1800 } } } },
};

function summary(over = {}) {
    return {
        generated_at: '2026-09-26T11:00:00.000Z',
        owner: 'intrale',
        window: { days: 7, from: '2026-09-19', to: '2026-09-25' },
        totals: { billable_min: 700 },
        repos: { platform: { workflows: { 'Admission Gate': { billable_min: 300 }, Lints: { billable_min: 400 } } } },
        ...over,
    };
}

function ctx() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-index-'));
    const ev = path.join(dir, 'evidence');
    fs.mkdirSync(ev);
    const baselinePath = path.join(ev, 'baseline.json');
    const pricingPath = path.join(ev, 'pricing.json');
    fs.writeFileSync(baselinePath, JSON.stringify(BASELINE));
    fs.writeFileSync(pricingPath, JSON.stringify(PRICING));
    const seriesFile = path.join(dir, 'state', 'actions-usage-series.json');
    const section = {
        since: '2026-09-01', cadence_days: 7, timeout_min: 90, target_plan: 'free', repos: ['platform'],
        baselinePath, pricingPath, workflow_map: Object.create(null), tracking_issue: null, ola_cerrada: false,
    };
    return { dir, seriesFile, section };
}

function deps(c, measured, extra = {}) {
    const logs = [];
    return {
        logs,
        d: {
            seriesFile: c.seriesFile,
            now: () => NOW,
            logger: (m) => logs.push(m),
            spawnMeasure: async () => measured,
            ...extra,
        },
    };
}

test('CA-15 · flujo feliz: +1 entrada con sólo agregados (sin stderr, paths ni logins)', async () => {
    const c = ctx();
    let doneCalls = 0;
    const { d } = deps(c, { kind: 'ok', summary: summary() });
    const res = await index.runWeek(c.section, { done: () => doneCalls++, repoRoot: c.dir }, d);
    assert.strictEqual(res.kind, 'ok');
    assert.strictEqual(res.appended, true);
    assert.strictEqual(doneCalls, 1);
    const serie = JSON.parse(fs.readFileSync(c.seriesFile, 'utf8'));
    assert.strictEqual(serie.length, 1);
    const e = serie[0];
    assert.deepStrictEqual(Object.keys(e), [...index.ENTRY_KEYS]);
    assert.strictEqual(e.week_start, '2026-09-19');
    assert.strictEqual(e.week_end, '2026-09-25');
    assert.strictEqual(e.generated_at, new Date(NOW).toISOString());
    assert.strictEqual(e.minutes, 700);
    assert.strictEqual(e.total_min_mes, 3000);
    assert.strictEqual(e.plan_objetivo, 'free');
    assert.strictEqual(e.excedente_min_mes, 1000);
    assert.strictEqual(e.veredicto, 'excede');
    assert.strictEqual(e.cost_usd_estimado, 6);
    assert.strictEqual(e.parcial, false);
    const crudo = fs.readFileSync(c.seriesFile, 'utf8');
    for (const prohibido of ['intrale', 'Admission', 'Lints', c.dir, 'stderr', 'filas', 'owner']) {
        assert.ok(!crudo.includes(prohibido), `la serie contiene "${prohibido}"`);
    }
});

test('CA-16 · kind distinto de ok, summary ausente/no-objeto o excepción ⇒ serie idéntica byte a byte', async () => {
    const casos = [
        { kind: 'timeout', summary: null },
        { kind: 'rate_limit', summary: null },
        { kind: 'api', summary: null },
        { kind: 'config', summary: null },
        { kind: 'summary_invalido', summary: null },
        { kind: 'ok', summary: null },
        { kind: 'ok', summary: [1, 2] },
        null,
    ];
    for (const measured of casos) {
        const c = ctx();
        fs.mkdirSync(path.dirname(c.seriesFile), { recursive: true });
        const previo = Buffer.from(JSON.stringify([{ week_start: '2026-09-12', total_min_mes: 1 }], null, 2) + '\n');
        fs.writeFileSync(c.seriesFile, previo);
        let done = 0;
        const { d } = deps(c, measured);
        const res = await index.runWeek(c.section, { done: () => done++ }, d);
        assert.notStrictEqual(res.kind, 'ok', JSON.stringify(measured));
        assert.strictEqual(res.appended, false);
        assert.strictEqual(done, 1);
        assert.strictEqual(Buffer.compare(fs.readFileSync(c.seriesFile), previo), 0, JSON.stringify(measured));
    }
    // spawnMeasure que rechaza / report que lanza ⇒ serie intacta y done una vez.
    for (const extra of [
        { spawnMeasure: async () => { throw new Error('boom'); } },
        { report: { buildWeek: () => { throw new Error('boom'); } } },
    ]) {
        const c = ctx();
        fs.mkdirSync(path.dirname(c.seriesFile), { recursive: true });
        const previo = Buffer.from('[]\n');
        fs.writeFileSync(c.seriesFile, previo);
        let done = 0;
        const { d } = deps(c, { kind: 'ok', summary: summary() }, extra);
        const res = await index.runWeek(c.section, { done: () => done++ }, d);
        assert.strictEqual(res.kind, 'error');
        assert.strictEqual(done, 1);
        assert.strictEqual(Buffer.compare(fs.readFileSync(c.seriesFile), previo), 0);
    }
});

test('CA-16 · evidencia ilegible o mayor a 5 MB ⇒ evidencia_invalida, sin lanzar el hijo', async () => {
    for (const prep of [
        (c) => fs.writeFileSync(c.section.pricingPath, '{no json'),
        (c) => fs.writeFileSync(c.section.baselinePath, '[]'),
        (c) => fs.writeFileSync(c.section.baselinePath, JSON.stringify({ x: 'a'.repeat(index.EVIDENCE_MAX_BYTES) })),
        (c) => fs.rmSync(c.section.pricingPath),
    ]) {
        const c = ctx();
        prep(c);
        let lanzado = false;
        const { d } = deps(c, null, { spawnMeasure: async () => { lanzado = true; return { kind: 'ok', summary: summary() }; } });
        const res = await index.runWeek(c.section, {}, d);
        assert.strictEqual(res.kind, 'evidencia_invalida');
        assert.strictEqual(lanzado, false);
        assert.ok(!fs.existsSync(c.seriesFile));
    }
});

test('el runner recibe el pricing ya leído (objeto), la sección y el repoRoot', async () => {
    const c = ctx();
    let args = null;
    const { d } = deps(c, null, { spawnMeasure: async (a) => { args = a; return { kind: 'api', summary: null }; } });
    await index.runWeek(c.section, { repoRoot: c.dir }, d);
    assert.deepStrictEqual(args.pricingObj, PRICING);
    assert.strictEqual(args.section, c.section);
    assert.strictEqual(args.repoRoot, c.dir);
});

test('CA-17 · workflows __proto__/constructor no contaminan prototipos y la agregación es correcta', async () => {
    const c = ctx();
    const s = JSON.parse(JSON.stringify(summary()).replace('"Admission Gate"', '"__proto__"').replace('"Lints"', '"constructor"'));
    s.repos.platform.workflows.polluted = { billable_min: 0 };
    const { d } = deps(c, { kind: 'ok', summary: s });
    c.section.workflow_map = { __proto__: null, constructor: 'polluted' };
    const res = await index.runWeek(c.section, {}, d);
    assert.strictEqual(res.kind, 'ok');
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.strictEqual(typeof ({}).constructor, 'function');
    const serie = JSON.parse(fs.readFileSync(c.seriesFile, 'utf8'));
    assert.strictEqual(serie[0].minutes, 700);
    assert.strictEqual(serie[0].total_min_mes, 3000);
});

test('CA-18 · 104 + 1 ⇒ 104 entradas, sin la más vieja', async () => {
    const c = ctx();
    fs.mkdirSync(path.dirname(c.seriesFile), { recursive: true });
    const previa = Array.from({ length: 104 }, (_, i) => ({ week_start: `w${i}`, total_min_mes: 1000 + i }));
    fs.writeFileSync(c.seriesFile, JSON.stringify(previa));
    const { d } = deps(c, { kind: 'ok', summary: summary() });
    await index.runWeek(c.section, {}, d);
    const serie = JSON.parse(fs.readFileSync(c.seriesFile, 'utf8'));
    assert.strictEqual(serie.length, index.SERIES_MAX);
    assert.strictEqual(serie[0].week_start, 'w1');
    assert.strictEqual(serie[serie.length - 1].week_start, '2026-09-19');
});

test('serie previa corrupta ⇒ arranca de [] y el delta usa la última entrada válida', async () => {
    const c = ctx();
    fs.mkdirSync(path.dirname(c.seriesFile), { recursive: true });
    fs.writeFileSync(c.seriesFile, '{corrupto');
    const { d } = deps(c, { kind: 'ok', summary: summary() });
    await index.runWeek(c.section, {}, d);
    assert.strictEqual(JSON.parse(fs.readFileSync(c.seriesFile, 'utf8')).length, 1);
    let prevRecibido = 'sin llamar';
    const report = require('../report');
    const { d: d2 } = deps(c, { kind: 'ok', summary: summary() }, {
        report: { ...report, buildWeek: (...a) => { prevRecibido = a[4]; return report.buildWeek(...a); } },
    });
    await index.runWeek(c.section, {}, d2);
    assert.strictEqual(prevRecibido.total_min_mes, 3000);
});

test('CA-19 · sin publish ⇒ ok; publish que lanza ⇒ serie persiste y se loguea', async () => {
    const c = ctx();
    const { d } = deps(c, { kind: 'ok', summary: summary() });
    const res = await index.runWeek(c.section, {}, d);
    assert.strictEqual(res.kind, 'ok');
    assert.ok(!('publicado' in res));
    const c2 = ctx();
    let done = 0;
    const { d: d2, logs } = deps(c2, { kind: 'ok', summary: summary() }, { publish: async () => { throw new Error('telegram caído'); } });
    const res2 = await index.runWeek(c2.section, { done: () => done++ }, d2);
    assert.strictEqual(res2.kind, 'ok');
    assert.strictEqual(res2.publicado, false);
    assert.strictEqual(done, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(c2.seriesFile, 'utf8')).length, 1);
    assert.ok(logs.some((l) => l.includes('publicación falló')));
});

test('publish recibe la semana, la entrada, la serie y el veredicto de suficiencia', async () => {
    const c = ctx();
    let recibido = null;
    c.section.ola_cerrada = true;
    const { d } = deps(c, { kind: 'ok', summary: summary() }, { publish: async (p) => { recibido = p; } });
    const res = await index.runWeek(c.section, {}, d);
    assert.strictEqual(res.publicado, true);
    assert.strictEqual(recibido.series.length, 1);
    assert.strictEqual(recibido.entry.plan_objetivo, 'free');
    assert.strictEqual(recibido.suficiente.estado, 'suficiente');
    assert.ok(Array.isArray(recibido.week.filas));
});

test('done se llama exactamente una vez en todos los caminos', async () => {
    for (const measured of [{ kind: 'ok', summary: summary() }, { kind: 'timeout', summary: null }]) {
        const c = ctx();
        let done = 0;
        let recibido = null;
        const { d } = deps(c, measured);
        await index.runWeek(c.section, { done: (r) => { done++; recibido = r; } }, d);
        assert.strictEqual(done, 1);
        assert.strictEqual(recibido.kind, measured.kind);
    }
});

test('describeResult arma frases legibles sin paths', () => {
    const ok = index.describeResult({ kind: 'ok', entry: { total_min_mes: 3000, cost_usd_estimado: 6, plan_objetivo: 'free' } });
    assert.match(ok, /semana agregada a la serie/);
    assert.match(ok, /USD 6,00/);
    for (const kind of ['timeout', 'rate_limit', 'api', 'config', 'summary_invalido', 'evidencia_invalida', 'tmp_no_disponible', 'error', undefined]) {
        assert.match(index.describeResult({ kind }), /la serie no cambió/, String(kind));
    }
    assert.match(index.describeResult(null), /la serie no cambió/);
});

test('defaultSeriesFile resuelve por write-target a state/actions-usage-series.json', () => {
    try {
        const f = index.defaultSeriesFile();
        assert.ok(f.endsWith(path.join('state', 'actions-usage-series.json')), f);
    } catch (e) {
        assert.ok(/EscrituraBloqueada|ambiente|pipeline-env/i.test(`${e.name} ${e.message}`), e.message);
    }
});
