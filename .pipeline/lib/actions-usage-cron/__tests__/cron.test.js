// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de lib/actions-usage-cron/cron.js (#7689, parte 3/4 de #7661).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cron = require('../cron');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const DAY = 86400000;

/** Repo falso con las dos evidencias en la allowlist. */
function fakeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-cron-repo-'));
    const dir = path.join(root, 'docs', 'pipeline', 'evidence', '7594');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'actions-usage-summary.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pricing.json'), '{}');
    return root;
}

function seccion(over = {}) {
    return {
        enabled: true,
        cadence_days: 7,
        since: '2026-09-01',
        tracking_issue: null,
        repos: ['platform'],
        baseline: 'docs/pipeline/evidence/7594/actions-usage-summary.json',
        pricing: 'docs/pipeline/evidence/7594/pricing.json',
        target_plan: 'free',
        workflow_map: {},
        ola_cerrada: false,
        timeout_min: 90,
        ...over,
    };
}

/** fs que registra el orden de las operaciones; delega al fs real. */
function fakeFs(eventos) {
    return {
        existsSync: (p) => fs.existsSync(p),
        readFileSync: (p, e) => fs.readFileSync(p, e),
        lstatSync: (p) => fs.lstatSync(p),
        mkdirSync: (p, o) => { eventos.push(['mkdirSync', p]); return fs.mkdirSync(p, o); },
        writeFileSync: (p, d, o) => { eventos.push(['writeFileSync', p]); return fs.writeFileSync(p, d, o); },
        renameSync: (a, b) => { eventos.push(['renameSync', b]); return fs.renameSync(a, b); },
        chmodSync: (p, m) => { try { fs.chmodSync(p, m); } catch { /* win */ } },
    };
}

function ctx() {
    cron._resetForTests();
    const repo = fakeRepo();
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'au-cron-state-')), 'state', 'actions-usage-cron.json');
    const eventos = [];
    return { repo, stateFile, eventos, fsImpl: fakeFs(eventos) };
}

test('CA-1 · enabled distinto de true exacto ⇒ deshabilitado, sin escrituras y sin runWeek', () => {
    for (const enabled of ['true', 1, null, undefined, 'yes', false]) {
        const c = ctx();
        const s = seccion({ enabled });
        if (enabled === undefined) delete s.enabled;
        let llamado = false;
        const res = cron.tickIfDue({
            pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: s }, now: NOW, fsImpl: c.fsImpl,
            stateFile: c.stateFile, runWeek: () => { llamado = true; },
        });
        assert.strictEqual(res.reason, 'deshabilitado', `enabled=${String(enabled)}`);
        assert.strictEqual(res.detalle, 'enabled_off');
        assert.strictEqual(llamado, false);
        assert.deepStrictEqual(c.eventos, []);
        assert.ok(!fs.existsSync(c.stateFile));
    }
    const c = ctx();
    assert.strictEqual(cron.tickIfDue({ pipelineRoot: c.repo, cfgRoot: {}, stateFile: c.stateFile, fsImpl: c.fsImpl }).reason, 'deshabilitado');
    assert.strictEqual(cron.tickIfDue({ pipelineRoot: c.repo, cfgRoot: null, stateFile: c.stateFile, fsImpl: c.fsImpl }).reason, 'deshabilitado');
});

test('CA-2 · since inválido ⇒ deshabilitado (since_invalido) sin escrituras', () => {
    for (const since of [null, undefined, '2026-02-30', '--x', 'abc', '2026/01/01', '-2026-01-01', 20260101]) {
        const c = ctx();
        const res = cron.tickIfDue({
            pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion({ since }) }, now: NOW,
            fsImpl: c.fsImpl, stateFile: c.stateFile, runWeek: () => assert.fail('no debería correr'),
        });
        assert.strictEqual(res.reason, 'deshabilitado', `since=${String(since)}`);
        assert.strictEqual(res.detalle, 'since_invalido');
        assert.deepStrictEqual(c.eventos, []);
    }
});

test('CA-3 · repos inválidos se descartan; sin ninguno válido ⇒ deshabilitado (sin_repos)', () => {
    assert.deepStrictEqual(cron.filterRepos(['-x', 'a/b', '..', '.', 'platform', 'kernel', 'platform', '--repos', 'a b', 5]), ['platform', 'kernel']);
    const c = ctx();
    const res = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion({ repos: ['-x', 'a/b', '..'] }) }, now: NOW,
        fsImpl: c.fsImpl, stateFile: c.stateFile, runWeek: () => assert.fail('no debería correr'),
    });
    assert.strictEqual(res.reason, 'deshabilitado');
    assert.strictEqual(res.detalle, 'sin_repos');
    assert.deepStrictEqual(c.eventos, []);
    const s = cron.resolveSection({ actions_usage_measure: seccion({ repos: ['-x', 'platform'] }) }, c.repo);
    assert.deepStrictEqual(s.repos, ['platform']);
});

test('rangos inválidos (cadence_days, timeout_min, target_plan) ⇒ deshabilitado (rango_invalido)', () => {
    const c = ctx();
    for (const over of [{ cadence_days: 0 }, { cadence_days: 31 }, { cadence_days: 1.5 }, { timeout_min: 9 }, { timeout_min: 241 }, { target_plan: 'pro' }]) {
        const r = cron.resolveSectionDetailed({ actions_usage_measure: seccion(over) }, c.repo);
        assert.strictEqual(r.section, null, JSON.stringify(over));
        assert.strictEqual(r.reasonCode, 'rango_invalido');
    }
});

test('evidencia_invalida con ../../etc, path absoluto, archivo inexistente y symlink', () => {
    const c = ctx();
    for (const over of [
        { pricing: '../../etc/passwd' },
        { pricing: 'docs/pipeline/evidence/7594/../../../../etc/x.json' },
        { baseline: '/etc/x.json' },
        { baseline: 'C:\\x\\y.json' },
        { pricing: 'docs/pipeline/evidence/7594/no-existe.json' },
        { pricing: 'docs/otra/7594/pricing.json' },
    ]) {
        const r = cron.resolveSectionDetailed({ actions_usage_measure: seccion(over) }, c.repo);
        assert.strictEqual(r.section, null, JSON.stringify(over));
        assert.strictEqual(r.reasonCode, 'evidencia_invalida');
    }
    // Symlink dentro de la allowlist apuntando afuera ⇒ rechazado.
    const fuera = path.join(c.repo, 'secreto.json');
    fs.writeFileSync(fuera, '{}');
    const link = path.join(c.repo, 'docs', 'pipeline', 'evidence', '7594', 'link.json');
    let symlinkOk = true;
    try { fs.symlinkSync(fuera, link, 'file'); } catch { symlinkOk = false; }
    if (symlinkOk) {
        assert.strictEqual(cron.resolveEvidencePath(c.repo, 'docs/pipeline/evidence/7594/link.json'), null);
    }
    // Symlink simulado vía fsImpl (cubre Windows sin privilegio de symlink).
    const fsSym = { lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => true }) };
    assert.strictEqual(cron.resolveEvidencePath(c.repo, 'docs/pipeline/evidence/7594/pricing.json', fsSym), null);
    // La ruta válida resuelve dentro del repo.
    const ok = cron.resolveEvidencePath(c.repo, 'docs/pipeline/evidence/7594/pricing.json');
    assert.strictEqual(ok, path.join(c.repo, 'docs', 'pipeline', 'evidence', '7594', 'pricing.json'));
});

test('resolveSection devuelve la sección efectiva con rutas absolutas validadas y workflow_map sin prototipo', () => {
    const c = ctx();
    const s = cron.resolveSection({ actions_usage_measure: seccion({ workflow_map: { a: 'b', c: 1 }, tracking_issue: 7690 }) }, c.repo);
    assert.strictEqual(s.since, '2026-09-01');
    assert.strictEqual(s.cadence_days, 7);
    assert.strictEqual(s.timeout_min, 90);
    assert.strictEqual(s.target_plan, 'free');
    assert.strictEqual(s.tracking_issue, 7690);
    assert.ok(path.isAbsolute(s.baselinePath) && path.isAbsolute(s.pricingPath));
    assert.strictEqual(Object.getPrototypeOf(s.workflow_map), null);
    assert.deepStrictEqual({ ...s.workflow_map }, { a: 'b' });
});

test('CA-6 · isDue: viejo, futuro, corrupto y ausente ⇒ true; dentro de la cadencia ⇒ false', () => {
    assert.strictEqual(cron.isDue({ last: NOW - 8 * DAY, now: NOW, cadenceDays: 7 }), true, 'viejo');
    assert.strictEqual(cron.isDue({ last: NOW - 7 * DAY, now: NOW, cadenceDays: 7 }), true, 'exacto');
    assert.strictEqual(cron.isDue({ last: NOW + DAY, now: NOW, cadenceDays: 7 }), true, 'futuro');
    assert.strictEqual(cron.isDue({ last: 'basura', now: NOW, cadenceDays: 7 }), true, 'corrupto');
    assert.strictEqual(cron.isDue({ last: NaN, now: NOW, cadenceDays: 7 }), true, 'NaN');
    assert.strictEqual(cron.isDue({ last: undefined, now: NOW, cadenceDays: 7 }), true, 'ausente');
    assert.strictEqual(cron.isDue({ last: NOW - 2 * DAY, now: NOW, cadenceDays: 7 }), false, 'dentro');
});

test('CA-6 · tick: estado corrupto o futuro lanza; dentro de la cadencia ⇒ no_due', () => {
    const casos = [['{no json', true], [JSON.stringify({ last_run_at: NOW + DAY }), true], [JSON.stringify({ last_run_at: NOW - DAY }), false]];
    for (const [contenido, lanza] of casos) {
        const c = ctx();
        fs.mkdirSync(path.dirname(c.stateFile), { recursive: true });
        fs.writeFileSync(c.stateFile, contenido);
        let corridas = 0;
        const res = cron.tickIfDue({
            pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
            stateFile: c.stateFile, runWeek: (s, h) => { corridas++; h.done({ kind: 'ok' }); },
        });
        assert.strictEqual(res.reason, lanza ? 'lanzado' : 'no_due', contenido);
        assert.strictEqual(corridas, lanza ? 1 : 0);
    }
});

test('CA-7 · el estado (last_run_at, since) se escribe atómico ANTES de llamar a runWeek', () => {
    const c = ctx();
    const res = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
        stateFile: c.stateFile,
        runWeek: (s, h) => { c.eventos.push(['runWeek']); h.done({ kind: 'ok' }); },
    });
    assert.strictEqual(res.reason, 'lanzado');
    const ops = c.eventos.map(([op]) => op);
    const iRename = ops.indexOf('renameSync');
    const iRun = ops.indexOf('runWeek');
    assert.ok(iRename >= 0 && iRun > iRename, `orden: ${ops.join(',')}`);
    assert.ok(ops.indexOf('writeFileSync') < iRename, 'tmp + rename');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')), { last_run_at: NOW, since: '2026-09-01' });
});

test('estado no persistible ⇒ no lanza la medición', () => {
    const c = ctx();
    const fsRoto = { ...c.fsImpl, writeFileSync: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; } };
    const logs = [];
    const res = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: fsRoto,
        stateFile: c.stateFile, runWeek: () => assert.fail('no debería correr'), logger: (m) => logs.push(m),
    });
    assert.strictEqual(res.reason, 'estado_no_persistible');
    assert.strictEqual(cron.isInFlight(), false);
    assert.ok(logs.some((l) => l.includes('EACCES')));
});

test('CA-8 / CA-9 · lanzado es sincrónico; un segundo tick en curso ⇒ en_curso; done libera', () => {
    const c = ctx();
    let handle = null;
    const cfgRoot = { actions_usage_measure: seccion() };
    const res = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot, now: NOW, fsImpl: c.fsImpl, stateFile: c.stateFile,
        runWeek: (s, h) => { handle = h; return new Promise(() => {}); },
    });
    assert.deepStrictEqual(res, { ran: true, reason: 'lanzado', since: '2026-09-01', repos: 1 });
    assert.strictEqual(cron.isInFlight(), true);
    // Aun con el estado borrado (due), el guard impide el solapamiento.
    fs.rmSync(c.stateFile);
    const res2 = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot, now: NOW + 60000, fsImpl: c.fsImpl, stateFile: c.stateFile,
        runWeek: () => assert.fail('no debería solaparse'),
    });
    assert.strictEqual(res2.reason, 'en_curso');
    const resultados = [];
    handle.done({ kind: 'ok' });
    handle.done({ kind: 'ok' }); // idempotente
    assert.strictEqual(cron.isInFlight(), false);
    const res3 = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot, now: NOW + 120000, fsImpl: c.fsImpl, stateFile: c.stateFile,
        runWeek: (s, h) => h.done({ kind: 'timeout' }), onResult: (r) => resultados.push(r),
    });
    assert.strictEqual(res3.reason, 'lanzado');
    assert.deepStrictEqual(resultados, [{ kind: 'timeout' }]);
});

test('CA-8 · un runWeek que lanza sincrónicamente libera inFlight', () => {
    const c = ctx();
    const resultados = [];
    const res = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
        stateFile: c.stateFile, runWeek: () => { throw new Error('boom'); }, onResult: (r) => resultados.push(r),
    });
    assert.strictEqual(res.reason, 'run_fallo');
    assert.strictEqual(cron.isInFlight(), false);
    assert.deepStrictEqual(resultados, [{ kind: 'error' }]);
});

test('CA-8 · una promesa rechazada de runWeek libera inFlight', async () => {
    const c = ctx();
    const resultados = [];
    cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
        stateFile: c.stateFile, runWeek: () => Promise.reject(new Error('boom')), onResult: (r) => resultados.push(r),
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cron.isInFlight(), false);
    assert.deepStrictEqual(resultados, [{ kind: 'error' }]);
});

test('un inFlight perdido (más viejo que timeout_min + margen) se libera en el tick siguiente', () => {
    const c = ctx();
    const cfgRoot = { actions_usage_measure: seccion({ cadence_days: 1 }) };
    cron.tickIfDue({ pipelineRoot: c.repo, cfgRoot, now: NOW, fsImpl: c.fsImpl, stateFile: c.stateFile, runWeek: () => {} });
    assert.strictEqual(cron.isInFlight(), true);
    const dentro = cron.tickIfDue({ pipelineRoot: c.repo, cfgRoot, now: NOW + 60 * 60000, fsImpl: c.fsImpl, stateFile: c.stateFile, runWeek: () => {} });
    assert.strictEqual(dentro.reason, 'en_curso');
    const logs = [];
    const pasado = cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot, now: NOW + 2 * DAY, fsImpl: c.fsImpl, stateFile: c.stateFile,
        runWeek: (s, h) => h.done({ kind: 'ok' }), logger: (m) => logs.push(m),
    });
    assert.strictEqual(pasado.reason, 'lanzado');
    assert.ok(logs.length === 1);
});

test('onResult que lanza no traba el brazo', () => {
    const c = ctx();
    cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
        stateFile: c.stateFile, runWeek: (s, h) => h.done({ kind: 'ok' }), onResult: () => { throw new Error('x'); },
    });
    assert.strictEqual(cron.isInFlight(), false);
});

test('runWeek recibe la sección y el repoRoot', () => {
    const c = ctx();
    let recibido = null;
    cron.tickIfDue({
        pipelineRoot: c.repo, cfgRoot: { actions_usage_measure: seccion() }, now: NOW, fsImpl: c.fsImpl,
        stateFile: c.stateFile, runWeek: (s, h) => { recibido = { s, repoRoot: h.repoRoot }; h.done({ kind: 'ok' }); },
    });
    assert.strictEqual(recibido.repoRoot, c.repo);
    assert.deepStrictEqual(recibido.s.repos, ['platform']);
});

test('defaultStateFile resuelve por write-target a state/actions-usage-cron.json', () => {
    try {
        const f = cron.defaultStateFile();
        assert.ok(f.endsWith(path.join('state', 'actions-usage-cron.json')), f);
    } catch (e) {
        // Sin ambiente declarado write-target falla ruidoso: también es un resultado válido.
        assert.ok(/EscrituraBloqueada|ambiente|pipeline-env/i.test(`${e.name} ${e.message}`), e.message);
    }
});
