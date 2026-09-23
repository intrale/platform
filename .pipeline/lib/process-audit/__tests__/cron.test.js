'use strict';

// #6809 CA-3 / SEC-6809-7 — tick fail-closed del auditor del modelo operativo.
// `stateFile` se resuelve con `mkdtemp`: nunca dentro del `.pipeline` productivo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cron = require('../cron');

const DAY = 86400000;
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const ON = { process_audit: { enabled: true, cadence_days: 7, window_days: 14, min_samples_hora: 60 } };

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cron-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function spyFs(overrides = {}) {
    const writes = [];
    const impl = {
        existsSync: (p) => fs.existsSync(p),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        mkdirSync: (p, o) => { writes.push(['mkdirSync', p]); return fs.mkdirSync(p, o); },
        writeFileSync: (p, d, o) => { writes.push(['writeFileSync', p]); return fs.writeFileSync(p, d, o); },
        renameSync: (a, b) => { writes.push(['renameSync', a, b]); return fs.renameSync(a, b); },
        chmodSync: () => undefined,
        ...overrides,
    };
    return { impl, writes };
}

const reporte = (hallazgos = []) => ({ ejes: { proceso: { veredicto: 'mantener', hallazgos: [] }, capacidad: { veredicto: 'atacar_causa', hallazgos }, proveedores: { veredicto: 'sin_evidencia_suficiente', hallazgos: [] } }, hallazgos });

test('enabled distinto de true EXACTO ⇒ deshabilitado, sin escrituras ni corrida', (t) => {
    const dir = tmpDir(t);
    for (const enabled of ['true', 1, 'yes', undefined, null, false]) {
        const { impl, writes } = spyFs();
        const r = cron.tickIfDue({ cfgRoot: { process_audit: { enabled } }, now: NOW, fsImpl: impl, stateFile: path.join(dir, 's.json'),
            run: () => { throw new Error('no debería correr'); } });
        assert.deepEqual(r, { ran: false, reason: 'deshabilitado' });
        assert.deepEqual(writes, []);
    }
    assert.equal(cron.resolveSection({}), null);
    assert.equal(cron.resolveSection(null), null);
    assert.equal(cron.resolveSection({ process_audit: [] }), null);
});

test('cadence_days / window_days / min_samples_hora fuera de rango ⇒ deshabilitado (sin clamp silencioso)', () => {
    const casos = [{ cadence_days: 0 }, { cadence_days: 31 }, { cadence_days: 1.5 }, { window_days: 6 }, { window_days: 31 },
        { window_days: '14' }, { min_samples_hora: 0 }, { min_samples_hora: 121 }];
    for (const c of casos) {
        assert.equal(cron.resolveSection({ process_audit: { enabled: true, ...c } }), null, JSON.stringify(c));
    }
    assert.deepEqual(cron.resolveSection({ process_audit: { enabled: true } }), { cadence_days: 7, window_days: 14, min_samples_hora: 60 });
    assert.deepEqual(cron.resolveSection({ process_audit: { enabled: true, cadence_days: 30, window_days: 7, min_samples_hora: 1 } }), { cadence_days: 30, window_days: 7, min_samples_hora: 1 });
});

test('estado no persistible ⇒ no corre', (t) => {
    const dir = tmpDir(t);
    const { impl } = spyFs({ writeFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } });
    let corrio = false;
    const logs = [];
    const r = cron.tickIfDue({ cfgRoot: ON, now: NOW, fsImpl: impl, stateFile: path.join(dir, 's.json'), run: () => { corrio = true; }, logger: (m) => logs.push(m) });
    assert.deepEqual(r, { ran: false, reason: 'estado_no_persistible' });
    assert.equal(corrio, false);
    assert.match(logs[0], /EACCES/);
});

test('corre, publica sólo por el puerto inyectado y persiste el resumen; después no_due hasta la cadencia', (t) => {
    const dir = tmpDir(t);
    const stateFile = path.join(dir, 'state', 'process-audit-cron.json');
    const publicados = [];
    const run = (args) => {
        assert.equal(args.windowDays, 14);
        assert.equal(args.minSamplesHora, 60);
        return reporte([{ clave: 'a' }, { clave: 'b' }]);
    };
    const publish = (h) => { publicados.push(h.clave); return h.clave === 'a' ? { publicado: true, motivo: 'publicada' } : { publicado: false, motivo: 'duplicada' }; };
    const r = cron.tickIfDue({ cfgRoot: ON, now: NOW, stateFile, run, publish });
    assert.deepEqual(r, { ran: true, reason: 'publicado', publicadas: 1, hallazgos: 2 });
    assert.deepEqual(publicados, ['a', 'b']);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.last_run_at, NOW);
    assert.equal(st.last_reason, 'publicado');
    assert.deepEqual(st.motivos, { publicada: 1, duplicada: 1 });
    assert.equal(st.ejes.capacidad.hallazgos, 2);
    assert.deepEqual(cron.tickIfDue({ cfgRoot: ON, now: NOW + 6 * DAY, stateFile, run, publish }), { ran: false, reason: 'no_due' });
    assert.equal(cron.tickIfDue({ cfgRoot: ON, now: NOW + 7 * DAY, stateFile, run, publish }).ran, true);
});

test('last_run_at en el futuro o corrupto ⇒ corre (no silencia el auditor)', (t) => {
    const dir = tmpDir(t);
    const stateFile = path.join(dir, 's.json');
    fs.writeFileSync(stateFile, JSON.stringify({ last_run_at: NOW + 100 * DAY }));
    assert.equal(cron.tickIfDue({ cfgRoot: ON, now: NOW, stateFile, run: () => reporte() }).reason, 'sin_hallazgos');
    fs.writeFileSync(stateFile, '{corrupto');
    assert.equal(cron.tickIfDue({ cfgRoot: ON, now: NOW, stateFile, run: () => reporte() }).ran, true);
    assert.equal(cron.isDue({ last: 'x', now: NOW, cadenceDays: 7 }), true);
});

test('si run lanza, la corrida se marca run_fallo y no se publica nada', (t) => {
    const dir = tmpDir(t);
    const stateFile = path.join(dir, 's.json');
    let publicado = false;
    const r = cron.tickIfDue({ cfgRoot: ON, now: NOW, stateFile, run: () => { throw new Error('x'); }, publish: () => { publicado = true; } });
    assert.deepEqual(r, { ran: true, reason: 'run_fallo' });
    assert.equal(publicado, false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).last_reason, 'run_fallo');
});

test('tope de publicaciones por corrida y publish que lanza no tumba el tick', (t) => {
    const dir = tmpDir(t);
    const hallazgos = Array.from({ length: 15 }, (_, i) => ({ clave: `h${i}` }));
    let n = 0;
    const r = cron.tickIfDue({ cfgRoot: ON, now: NOW, stateFile: path.join(dir, 's.json'), run: () => reporte(hallazgos),
        publish: () => { n++; if (n === 1) throw new Error('boom'); return { publicado: true, motivo: 'publicada' }; } });
    assert.equal(n, cron.MAX_PUBLICACIONES_POR_CORRIDA);
    assert.equal(r.publicadas, cron.MAX_PUBLICACIONES_POR_CORRIDA - 1);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8'));
    assert.equal(st.motivos.tope_corrida, 5);
    assert.equal(st.motivos.publish_fallo, 1);
});

test('readStatus: los tres estados visibles y sólo números/enums/ISO (CA-7 / UX-G5)', (t) => {
    const dir = tmpDir(t);
    const stateFile = path.join(dir, 's.json');
    assert.equal(cron.readStatus({ cfgRoot: {}, stateFile }).estado, 'inactivo');
    assert.equal(cron.readStatus({ cfgRoot: ON, stateFile }).estado, 'esperando_primera_corrida');
    fs.writeFileSync(stateFile, JSON.stringify({ last_run_at: NOW, last_reason: '<script>alert(1)</script>', hallazgos: 3, publicadas: 1,
        ejes: { proceso: { veredicto: 'sugerir', hallazgos: 1 }, capacidad: { veredicto: '<img onerror=x>', hallazgos: 'x' } } }));
    const s = cron.readStatus({ cfgRoot: ON, stateFile });
    assert.equal(s.estado, 'activo');
    assert.equal(s.last_run_at, '2026-09-23T12:00:00.000Z');
    assert.equal(s.last_reason, null, 'token fuera de whitelist no se expone');
    assert.equal(s.ejes.capacidad.veredicto, null);
    assert.equal(s.ejes.capacidad.hallazgos, null);
    assert.equal(s.ejes.proceso.veredicto, 'sugerir');
    assert.equal(s.config_valida, true);
    assert.equal(cron.readStatus({ cfgRoot: { process_audit: { enabled: true, window_days: 99 } }, stateFile }).config_valida, false);
    assert.equal(JSON.stringify(s).includes('<'), false);
});

test('el estado productivo se resuelve SIEMPRE vía write-target (canal estado)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'cron.js'), 'utf8');
    assert.match(src, /require\('\.\.\/write-target'\)\.writePath\(process\.env, \{ canal: 'estado', destino: STATE_DESTINO \}/);
    assert.equal(cron.STATE_DESTINO, 'state/process-audit-cron.json');
});
