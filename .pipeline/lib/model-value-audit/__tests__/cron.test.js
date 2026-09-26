// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests del tick del auditor (#7520 CA-24 / CA-25 / CA-27 / SEC-11 / SEC-14).
// `stateFile` y `pipelineDir` se resuelven con `mkdtemp`: nunca dentro del
// `.pipeline` productivo (R3 de write-target-lint).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cron = require('../cron');
const { withEnv } = require('../../test-helpers/with-env');

const DAY = 86400000;
const NOW = Date.parse('2026-09-21T12:00:00.000Z');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mva-cron-'));
}

/** `fsImpl` espía sobre el fs real: registra cada primitiva de escritura. */
function spyFs(overrides = {}) {
    const writes = [];
    const impl = {
        existsSync: (p) => fs.existsSync(p),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        mkdirSync: (p, o) => { writes.push(['mkdirSync', p]); return fs.mkdirSync(p, o); },
        writeFileSync: (p, d, o) => { writes.push(['writeFileSync', p]); return fs.writeFileSync(p, d, o); },
        renameSync: (a, b) => { writes.push(['renameSync', a, b]); return fs.renameSync(a, b); },
        chmodSync: (p, m) => { writes.push(['chmodSync', p]); try { return fs.chmodSync(p, m); } catch { return undefined; } },
        openSync: (...a) => { writes.push(['openSync', a[0]]); return fs.openSync(...a); },
        closeSync: (fd) => fs.closeSync(fd),
        appendFileSync: (p, d) => { writes.push(['appendFileSync', p]); return fs.appendFileSync(p, d); },
        ...overrides,
    };
    return { impl, writes };
}

function cfg(over = {}) {
    return { model_value_audit: { enabled: true, cadence_days: 7, window_days: 30, registrar: false, publish: 'none', ...over } };
}

function reporte(over = {}) {
    return {
        sha256: 'c'.repeat(64),
        propagation_enabled: false,
        ventana: { from: '2026-08-22T00:00:00.000Z', to: '2026-09-21T23:59:59.999Z', dias: 30 },
        precios: { stale: false, missing_models: [], updated_at: '2026-09-01T00:00:00Z' },
        skills: { guru: { veredicto: 'mantener', evidencia: { n: 40 } }, doc: { veredicto: 'sin_evidencia_suficiente', evidencia: { n: 3 } } },
        calidad: {},
        ...over,
    };
}

function ctx({ state, section, fsOver, run, registrar, publish } = {}) {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state', cron.STATE_FILE);
    if (state !== undefined) {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state));
    }
    const { impl, writes } = spyFs(fsOver);
    const logs = [];
    const runCalls = [];
    const registrarCalls = [];
    const publishCalls = [];
    const runFn = run || ((args) => { runCalls.push(args); return reporte(); });
    const registrarFn = registrar || ((args) => { registrarCalls.push(args); return { hash_self: 'd'.repeat(64) }; });
    const publishFn = publish || ((proposal, c) => { publishCalls.push({ proposal, ctx: c }); return { ok: true, reason: 'publicado', items: 1, audio: 'no' }; });
    const tick = (over = {}) => cron.tickIfDue({
        pipelineDir: path.join(dir, 'pipeline'), cfgRoot: section === null ? {} : cfg(section), now: NOW, fsImpl: impl, stateFile,
        run: runFn, registrar: registrarFn, publish: publishFn, logger: (m) => logs.push(m), ...over,
    });
    return { dir, stateFile, writes, logs, runCalls, registrarCalls, publishCalls, tick };
}

// ---------------------------------------------------------------------------
// resolveSection / gate (CA-24, SEC-14)
// ---------------------------------------------------------------------------
test('CA-24 · sin sección o con enabled ausente ⇒ deshabilitado y cero escrituras', () => {
    for (const root of [undefined, null, {}, { model_value_audit: null }, { model_value_audit: [] }, { model_value_audit: {} }, { model_value_audit: { cadence_days: 7 } }]) {
        assert.equal(cron.resolveSection(root), null, JSON.stringify(root));
    }
    const c = ctx({ section: null });
    const r = c.tick({ cfgRoot: { model_value_audit: { cadence_days: 7 } } });
    assert.deepEqual(r, { ran: false, published: false, reason: 'deshabilitado' });
    assert.deepEqual(c.writes, []);
    assert.equal(c.runCalls.length, 0);
    assert.equal(fs.existsSync(c.stateFile), false);
});

test('SEC-14 · enabled "true" (string), 1, "yes" ⇒ deshabilitado; sólo el booleano true enciende', () => {
    for (const v of ['true', 1, 'yes', 'TRUE', {}, [], 0, false]) {
        const c = ctx();
        const r = c.tick({ cfgRoot: cfg({ enabled: v }) });
        assert.equal(r.reason, 'deshabilitado', `enabled=${JSON.stringify(v)}`);
        assert.deepEqual(c.writes, []);
    }
    assert.ok(cron.resolveSection(cfg()));
});

test('SEC-14 · publish fuera del enum o registrar no booleano ⇒ deshabilitado', () => {
    assert.equal(cron.resolveSection(cfg({ publish: 'digest' })), null);
    assert.equal(cron.resolveSection(cfg({ publish: '' })), null);
    assert.equal(cron.resolveSection(cfg({ registrar: 'true' })), null);
    assert.equal(cron.resolveSection(cfg({ registrar: 1 })), null);
    const c = ctx({ section: { publish: 'digest' } });
    assert.equal(c.tick().reason, 'deshabilitado');
    assert.deepEqual(c.writes, []);
});

test('P11 · defaults en código: cadence 7, window 30, publish none; valores inválidos caen al default', () => {
    assert.deepEqual(cron.resolveSection({ model_value_audit: { enabled: true } }), { registrar: false, publish: 'none', cadence_days: 7, window_days: 30 });
    assert.deepEqual(cron.resolveSection(cfg({ cadence_days: 0, window_days: 29, publish: 'telegram-plain', registrar: true })), { registrar: true, publish: 'telegram-plain', cadence_days: 7, window_days: 30 });
    assert.equal(cron.resolveSection(cfg({ window_days: 45 })).window_days, 45);
    assert.deepEqual(cron.DEFAULTS, { cadence_days: 7, window_days: 30, publish: 'none' });
    assert.ok(Object.isFrozen(cron.PUBLISH_ENUM) && Object.isFrozen(cron.DEFAULTS));
});

// ---------------------------------------------------------------------------
// isDue / cadencia (SEC-11)
// ---------------------------------------------------------------------------
test('SEC-11 · isDue: hace 6 días no; hace 8 sí; exacto 7 sí; futuro sí; corrupto sí', () => {
    assert.equal(cron.isDue({ last: NOW - 6 * DAY, now: NOW, cadenceDays: 7 }), false);
    assert.equal(cron.isDue({ last: NOW - 8 * DAY, now: NOW, cadenceDays: 7 }), true);
    assert.equal(cron.isDue({ last: NOW - 7 * DAY, now: NOW, cadenceDays: 7 }), true);
    assert.equal(cron.isDue({ last: NOW + DAY, now: NOW, cadenceDays: 7 }), true);
    for (const last of [undefined, null, 'ayer', NaN, Infinity, {}]) assert.equal(cron.isDue({ last, now: NOW, cadenceDays: 7 }), true, String(last));
    assert.equal(cron.isDue({ last: NOW - 2 * DAY, now: NOW, cadenceDays: 1 }), true);
    assert.equal(cron.isDue({ last: NOW - 8 * DAY, now: NOW, cadenceDays: 0 }), true, 'cadence inválida cae a 7');
});

test('CA-24 · last_run_at hace 6 días ⇒ no_due, sin escrituras ni corrida', () => {
    const c = ctx({ state: { last_run_at: NOW - 6 * DAY } });
    const r = c.tick();
    assert.deepEqual(r, { ran: false, published: false, reason: 'no_due' });
    assert.deepEqual(c.writes, []);
    assert.equal(c.runCalls.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')).last_run_at, NOW - 6 * DAY);
});

test('CA-24 · last_run_at hace 8 días ⇒ corre con { dias: 30, hasta } y actualiza el estado con UNA escritura atómica', () => {
    const c = ctx({ state: { last_run_at: NOW - 8 * DAY } });
    const r = c.tick();
    assert.equal(r.ran, true);
    assert.equal(r.reason, 'sin_hallazgos');
    assert.equal(c.runCalls.length, 1);
    assert.equal(c.runCalls[0].dias, 30);
    assert.equal(c.runCalls[0].hasta, '2026-09-21');
    assert.equal(c.runCalls[0].pipelineDir, path.join(c.dir, 'pipeline'));
    const escrituras = c.writes.filter(([op]) => op === 'writeFileSync');
    const renames = c.writes.filter(([op]) => op === 'renameSync');
    assert.equal(escrituras.length, 1, 'una sola writeFileSync');
    assert.equal(renames.length, 1, 'un solo renameSync');
    assert.ok(escrituras[0][1].startsWith(`${c.stateFile}.tmp.`), 'escribe al tmp');
    assert.equal(renames[0][1], escrituras[0][1]);
    assert.equal(renames[0][2], c.stateFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')), { last_run_at: NOW });
    assert.equal(fs.readdirSync(path.dirname(c.stateFile)).length, 1, 'sin tmp huérfano');
});

test('SEC-11 · last_run_at futuro (+1d) ⇒ corre; last_run_at "ayer" ⇒ corre; JSON roto ⇒ corre', () => {
    for (const state of [{ last_run_at: NOW + DAY }, { last_run_at: 'ayer' }, '{ no json', { otro: 1 }]) {
        const c = ctx({ state });
        const r = c.tick();
        assert.equal(r.ran, true, JSON.stringify(state));
        assert.deepEqual(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')), { last_run_at: NOW });
    }
});

test('SEC-11 · sin archivo de estado (primera corrida) ⇒ corre y crea el directorio + archivo', () => {
    const c = ctx();
    const r = c.tick();
    assert.equal(r.ran, true);
    assert.ok(c.writes.some(([op]) => op === 'mkdirSync'));
    assert.deepEqual(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')), { last_run_at: NOW });
});

test('SEC-11 · writeFileSync que lanza ⇒ estado_no_persistible, run y publish NO invocados', () => {
    const c = ctx({ state: { last_run_at: NOW - 8 * DAY }, section: { publish: 'telegram-plain' }, fsOver: { writeFileSync: () => { const e = new Error('disk'); e.code = 'ENOSPC'; throw e; } } });
    const r = c.tick();
    assert.deepEqual(r, { ran: false, published: false, reason: 'estado_no_persistible' });
    assert.equal(c.runCalls.length, 0);
    assert.equal(c.publishCalls.length, 0);
    assert.ok(c.logs.some((m) => /estado no persistible, corrida omitida \(ENOSPC\)/.test(m)), c.logs.join('|'));
    assert.equal(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')).last_run_at, NOW - 8 * DAY, 'estado intacto');
});

test('SEC-11 · dos ticks concurrentes (el segundo dentro del run del primero) ⇒ una sola corrida', () => {
    let inner = null;
    const c = ctx();
    c.tick({
        run: (args) => {
            c.runCalls.push(args);
            inner = c.tick();
            return reporte();
        },
    });
    assert.deepEqual(inner, { ran: false, published: false, reason: 'en_curso' });
    assert.equal(c.runCalls.length, 1);
    // Y después del primero, el guard se libera (un tercer tick es no_due, no en_curso).
    assert.equal(c.tick().reason, 'no_due');
});

test('SEC-17 · run que lanza ⇒ run_fallo, estado ya escrito, publish no invocado, sin excepción hacia afuera', () => {
    const c = ctx({ section: { publish: 'telegram-plain' }, run: () => { throw new Error('boom'); } });
    const r = c.tick();
    assert.deepEqual(r, { ran: true, published: false, reason: 'run_fallo' });
    assert.equal(c.publishCalls.length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(c.stateFile, 'utf8')), { last_run_at: NOW });
    assert.ok(c.logs.some((m) => m === 'corrida falló (error)'), c.logs.join('|'));
    assert.ok(!c.logs.some((m) => /boom/.test(m)), 'sin mensaje del error en el log');
    // El guard se libera: el tick siguiente vuelve a evaluar (no_due porque el estado quedó escrito).
    assert.equal(c.tick().reason, 'no_due');
});

test('SEC-17 · run que devuelve algo que no es un reporte ⇒ run_fallo', () => {
    const c = ctx({ run: () => null });
    assert.equal(c.tick().reason, 'run_fallo');
});

// ---------------------------------------------------------------------------
// registrar (CA-25)
// ---------------------------------------------------------------------------
test('CA-25 · registrar: false ⇒ registrar NO invocado (cero appendChained); referencia = report.sha256', () => {
    const c = ctx({ section: { registrar: false, publish: 'telegram-plain' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }) });
    const r = c.tick();
    assert.equal(c.registrarCalls.length, 0);
    assert.equal(c.publishCalls.length, 1);
    assert.equal(c.publishCalls[0].ctx.hash, 'c'.repeat(64));
    assert.equal(r.hash8, 'cccccccc');
});

test('CA-25 · registrar: true ⇒ una llamada con { pipelineDir, report, fsImpl, now } y referencia === hash_self', () => {
    const c = ctx({ section: { registrar: true, publish: 'telegram-plain' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }) });
    const r = c.tick();
    assert.equal(c.registrarCalls.length, 1);
    const args = c.registrarCalls[0];
    assert.equal(args.pipelineDir, path.join(c.dir, 'pipeline'));
    assert.equal(args.report.sha256, 'c'.repeat(64));
    assert.equal(typeof args.now, 'function');
    assert.equal(args.now(), NOW);
    assert.equal(c.publishCalls[0].ctx.hash, 'd'.repeat(64));
    assert.equal(c.publishCalls[0].proposal.evidencia.referencia, 'd'.repeat(64));
    assert.equal(r.hash8, 'dddddddd');
});

// ---------------------------------------------------------------------------
// shouldPublish / decisión (CA-27)
// ---------------------------------------------------------------------------
test('CA-27 · shouldPublish: todo mantener/sin evidencia con precios al día ⇒ false; un bajar, un subir, stale o missing ⇒ true', () => {
    assert.equal(cron.shouldPublish(reporte()), false);
    assert.equal(cron.shouldPublish(reporte({ skills: { a: { veredicto: 'no_evaluable' } } })), false);
    assert.equal(cron.shouldPublish(reporte({ skills: { a: { veredicto: 'bajar' } } })), true);
    assert.equal(cron.shouldPublish(reporte({ skills: { a: { veredicto: 'subir' } } })), true);
    assert.equal(cron.shouldPublish(reporte({ precios: { stale: true, missing_models: [] } })), true);
    assert.equal(cron.shouldPublish(reporte({ precios: { stale: false, missing_models: [{ provider: 'anthropic', model: 'x', n: 1 }] } })), true);
    assert.equal(cron.shouldPublish(reporte({ precios: { stale: 'true', missing_models: 'x' } })), false, 'sólo booleano/array exactos');
    assert.equal(cron.shouldPublish(null), false);
});

test('CA-27 / CA-UX-6 · sin hallazgos ⇒ sin_hallazgos, adaptador NO invocado y log de silencio', () => {
    const c = ctx({ section: { publish: 'telegram-plain' } });
    const r = c.tick();
    assert.deepEqual(r, { ran: true, published: false, reason: 'sin_hallazgos', hash8: 'cccccccc' });
    assert.equal(c.publishCalls.length, 0);
    assert.ok(c.logs.includes('corrida sin hallazgos accionables (2 agentes; todo mantener/sin evidencia; precios al día)'), c.logs.join('|'));
});

test('CA-27 · con un bajar ⇒ publica UNA vez con la propuesta y el ctx completo (productor en ctx, no en payload)', () => {
    const c = ctx({ section: { publish: 'telegram-plain' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40, modelo_efectivo: 'claude-opus-5', modelo_destino: 'claude-sonnet-4-6' } } } }) });
    const r = c.tick();
    assert.equal(r.published, true);
    assert.equal(r.reason, 'publicado');
    assert.equal(c.publishCalls.length, 1);
    const { proposal, ctx: pctx } = c.publishCalls[0];
    assert.equal(pctx.productor, 'auditor-modelos');
    assert.equal('productor' in proposal, false);
    assert.equal(pctx.hash8, 'cccccccc');
    assert.equal(pctx.propagationEnabled, false);
    assert.equal(pctx.now, NOW);
    assert.equal(typeof pctx.logger, 'function');
    assert.ok(pctx.cfgRoot.model_value_audit);
    assert.equal(pctx.pipelineRoot, c.dir);
    assert.ok(c.logs.some((m) => m === 'publicado cccccccc (1 ítems, audio omitido)'), c.logs.join('|'));
});

test('SEC-13 · respeta la raíz explícita aunque pipelineDir esté separado', () => {
    const c = ctx({ run: () => reporte({ precios: { stale: true } }) });
    const pipelineRoot = path.join(c.dir, 'repo');
    assert.equal(c.tick({ pipelineRoot }).published, true);
    assert.equal(c.publishCalls[0].ctx.pipelineRoot, pipelineRoot);
});

test('CA-27 · sólo stale:true ⇒ publica; sólo missing_models ⇒ publica', () => {
    for (const precios of [{ stale: true, missing_models: [], updated_at: '2026-05-08T00:00:00Z' }, { stale: false, missing_models: [{ provider: 'anthropic', model: 'claude-opus-5', n: 3 }], updated_at: '2026-09-01T00:00:00Z' }]) {
        const c = ctx({ section: { publish: 'telegram-plain' }, run: () => reporte({ precios }) });
        assert.equal(c.tick().published, true, JSON.stringify(precios));
        assert.equal(c.publishCalls.length, 1);
    }
});

test('CA-26 · publish: none ⇒ published false, reason adaptador_none, cero dropfiles y adaptador telegram no cargado', () => {
    const c = ctx({ section: { publish: 'none' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }) });
    const r = c.tick({ publish: undefined });
    assert.deepEqual(r, { ran: true, published: false, reason: 'adaptador_none', hash8: 'cccccccc' });
    assert.ok(c.logs.includes('suprimido adaptador_none'));
    // Única escritura: el estado (tmp + rename).
    assert.deepEqual(c.writes.map(([op]) => op).filter((op) => op !== 'mkdirSync' && op !== 'chmodSync'), ['writeFileSync', 'renameSync']);
});

test('SEC-15 · publish: registry sin #6807 ⇒ adaptador_no_disponible, no publica ni degrada a otro canal', () => {
    const c = ctx({ section: { publish: 'registry' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }) });
    const r = c.tick({ publish: undefined });
    assert.deepEqual(r, { ran: true, published: false, reason: 'adaptador_no_disponible', hash8: 'cccccccc' });
    assert.ok(c.logs.includes('suprimido adaptador_no_disponible'));
    assert.deepEqual(c.writes.map(([op]) => op).filter((op) => op !== 'mkdirSync' && op !== 'chmodSync'), ['writeFileSync', 'renameSync']);
});

test('publish que lanza ⇒ publish_fallo sin excepción hacia afuera', () => {
    const c = ctx({ section: { publish: 'telegram-plain' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }), publish: () => { throw new Error('x'); } });
    const r = c.tick();
    assert.equal(r.reason, 'publish_fallo');
    assert.equal(r.published, false);
});

test('publish con ok:false ⇒ suprimido <reason> y published false', () => {
    const c = ctx({ section: { publish: 'telegram-plain' }, run: () => reporte({ skills: { doc: { veredicto: 'bajar', evidencia: { n: 40 } } } }), publish: () => ({ ok: false, reason: 'dropfile_no_escrito' }) });
    const r = c.tick();
    assert.equal(r.reason, 'dropfile_no_escrito');
    assert.ok(c.logs.includes('suprimido dropfile_no_escrito'));
});

// ---------------------------------------------------------------------------
// Gherkin CA-24: "auditor apagado no corre ni escribe"
// ---------------------------------------------------------------------------
test('Gherkin CA-24 · Dado model_value_audit.enabled=false, cuando pasa el tick horario, entonces no corre, no escribe y loguea deshabilitado', () => {
    // Dado
    const c = ctx({ section: { enabled: false, publish: 'telegram-plain', registrar: true } });
    // Cuando (tres ticks horarios)
    const res = [c.tick(), c.tick({ now: NOW + 3600000 }), c.tick({ now: NOW + 2 * 3600000 })];
    // Entonces
    for (const r of res) assert.deepEqual(r, { ran: false, published: false, reason: 'deshabilitado' });
    assert.deepEqual(c.writes, []);
    assert.equal(c.runCalls.length, 0);
    assert.equal(c.registrarCalls.length, 0);
    assert.equal(c.publishCalls.length, 0);
    assert.equal(fs.existsSync(path.dirname(c.stateFile)), false, 'ni el directorio de estado');
});

// ---------------------------------------------------------------------------
// defaultStateFile: siempre vía write-target
// ---------------------------------------------------------------------------
test('P4 · defaultStateFile resuelve state/<STATE_FILE> vía write-target con PIPELINE_DIR_OVERRIDE', () => {
    const dir = tmpDir();
    return withEnv({ PIPELINE_DIR_OVERRIDE: dir }, () => {
        const f = cron.defaultStateFile();
        assert.equal(f, path.join(dir, 'state', 'model-value-audit-cron.json'));
        assert.equal(cron.STATE_FILE, 'model-value-audit-cron.json');
    });
});

test('readState/writeStateAtomic: round-trip con 0o600 best-effort y lectura nula ante JSON roto', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a', 'b', 'estado.json');
    assert.equal(cron.readState(f), null);
    cron.writeStateAtomic(f, { last_run_at: 5 });
    assert.deepEqual(cron.readState(f), { last_run_at: 5 });
    fs.writeFileSync(f, '{');
    assert.equal(cron.readState(f), null);
    fs.writeFileSync(f, '"texto"');
    assert.equal(cron.readState(f), null);
});
