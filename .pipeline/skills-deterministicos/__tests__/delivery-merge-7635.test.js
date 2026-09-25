// #7635 · CA-9…CA-14 — Gate de permisos del entorno de agentes, paso (4b) de
// `attemptMergeWithGates`. Sin red ni gh real: todo inyectado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const delivery = require('../delivery');
const { detectPermissionChanges, PATHS_SENSIBLES } = require('../../lib/permission-change-guard');

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_SHA_2 = 'ffeeddccbbaa00998877665544332211aabbccdd';

const MERGED_OK = { exit_code: 0, stdout: JSON.stringify({ sha: 'merge-sha-7635', merged: true, message: 'ok' }), stderr: '' };
const HEAD_CHANGED_409 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: HTTP 409: Head branch was modified. Review and try the merge again. (https://api.github.com/...)',
};

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/pulpo.js'],
        filesComplete: true,
        headRefOid: HEAD_SHA,
        headRefName: 'agent/7635-pipeline-dev',
        statusCheckRollup: [],
        ...over,
    };
}

/** Guard REAL con lectores fake: contenido idéntico en base y head salvo lo que se pase. */
function guardReal({ base = {}, head = {} } = {}) {
    const lector = (mapa) => (p) => (Object.prototype.hasOwnProperty.call(mapa, p) ? mapa[p] : 'contenido');
    return (snap) => detectPermissionChanges({
        files: snap.files.map((p) => ({ path: p })),
        filesComplete: snap.filesComplete === true,
        readAtBase: lector(base),
        readAtHead: lector(head),
    });
}

function deps(over = {}) {
    const merges = [];
    const d = {
        prNumber: 7635,
        getSnapshot: () => snapshotOk(),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true, reason: 'author-allowlisted' }),
        mergePR: (o) => { merges.push(o); return MERGED_OK; },
        logAppend: () => {},
        checkPermissions: guardReal(),
        ...over,
    };
    return { d, merges };
}

// ── CA-9 · PR que toca permisos queda frenado ──────────────────────────────

for (const p of PATHS_SENSIBLES) {
    test(`CA-9 · un PR que toca ${p} → needs-human con gate permisos y sin merge`, () => {
        const { d, merges } = deps({ getSnapshot: () => snapshotOk({ files: [p, 'docs/x.md'] }) });
        const out = delivery.attemptMergeWithGates(d);
        assert.equal(out.status, 'needs-human');
        assert.equal(out.gate, 'permisos');
        assert.ok(out.motivos.length >= 1);
        assert.deepEqual(out.owners, []);
        assert.equal(merges.length, 0, 'mergePR NO se llama');
    });
}

test('CA-9 · requires_credentials nuevo en agent-models.json → needs-human', () => {
    const AM = '.pipeline/agent-models.json';
    const { d, merges } = deps({
        getSnapshot: () => snapshotOk({ files: [AM] }),
        checkPermissions: guardReal({
            base: { [AM]: JSON.stringify({ skills: { guru: {} } }) },
            head: { [AM]: JSON.stringify({ skills: { guru: { requires_credentials: ['aws'] } } }) },
        }),
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.deepEqual(out.motivos, ['requires_credentials: alta en skill guru']);
    assert.equal(merges.length, 0);
});

test('CA-9 · env_isolation_enabled cambiado → needs-human', () => {
    const CFG = '.pipeline/config.yaml';
    const { d, merges } = deps({
        getSnapshot: () => snapshotOk({ files: [CFG] }),
        checkPermissions: guardReal({
            base: { [CFG]: 'pipeline:\n  env_isolation_enabled: true\n' },
            head: { [CFG]: 'pipeline:\n  env_isolation_enabled: false\n' },
        }),
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.equal(out.gate, 'permisos');
    assert.equal(merges.length, 0);
});

// ── CA-10 · sin falsos positivos obvios ────────────────────────────────────

test('CA-10 · un PR que sólo cambia el provider de un skill mergea', () => {
    const AM = '.pipeline/agent-models.json';
    const { d, merges } = deps({
        getSnapshot: () => snapshotOk({ files: [AM] }),
        checkPermissions: guardReal({
            base: { [AM]: JSON.stringify({ skills: { guru: { provider: 'anthropic', requires_credentials: ['github'] } } }) },
            head: { [AM]: JSON.stringify({ skills: { guru: { provider: 'openai-codex', requires_credentials: ['github'] } } }) },
        }),
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'merged');
    assert.equal(merges.length, 1);
});

// ── CA-11 · autoprotección ─────────────────────────────────────────────────

test('CA-11 · un PR que quita la invocación del guard en delivery.js queda frenado', () => {
    const DLV = '.pipeline/skills-deterministicos/delivery.js';
    const { d, merges } = deps({
        getSnapshot: () => snapshotOk({ files: [DLV] }),
        checkPermissions: guardReal({
            base: { [DLV]: 'detectPermissionChanges(...)' },
            head: { [DLV]: '// guard removido' },
        }),
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.deepEqual(out.motivos, ['delivery.js deja de invocar el gate de permisos']);
    assert.equal(merges.length, 0);
});

// ── CA-12 · fail-closed ─────────────────────────────────────────────────────

test('CA-12 · sin checkPermissions inyectado el default BLOQUEA (y lo loguea)', () => {
    const logs = [];
    const { d, merges } = deps({ checkPermissions: undefined, logAppend: (m) => logs.push(m) });
    delete d.checkPermissions;
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'permisos');
    assert.equal(merges.length, 0);
    assert.ok(logs.some((m) => /gate de permisos no inyectado/.test(m)));
});

test('CA-12 · un checkPermissions que tira → needs-human, nunca merge', () => {
    const { d, merges } = deps({ checkPermissions: () => { throw new Error('boom'); } });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.equal(out.gate, 'permisos');
    assert.equal(merges.length, 0);
});

test('CA-12 · una respuesta sin lista de motivos → needs-human', () => {
    for (const respuesta of [null, {}, { motivos: 'x' }]) {
        const { d, merges } = deps({ checkPermissions: () => respuesta });
        const out = delivery.attemptMergeWithGates(d);
        assert.equal(out.status, 'needs-human');
        assert.equal(merges.length, 0);
    }
});

test('CA-12 · lista de archivos incompleta (≥100) → needs-human', () => {
    const { d, merges } = deps({ getSnapshot: () => snapshotOk({ filesComplete: false }) });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.ok(out.motivos.some((m) => /incompleta/.test(m)));
    assert.equal(merges.length, 0);
});

// ── CA-13 · reevaluación ante head-changed ─────────────────────────────────

test('CA-13 · un head-changed vuelve a correr el gate sobre el snapshot nuevo', () => {
    const vistos = [];
    let snaps = 0;
    const { d, merges } = deps({
        getSnapshot: () => {
            snaps++;
            return snaps === 1
                ? snapshotOk()
                : snapshotOk({ headRefOid: HEAD_SHA_2, files: ['.pipeline/env-exceptions.yaml'] });
        },
        mergePR: (o) => { merges.push(o); return HEAD_CHANGED_409; },
        checkPermissions: (snap) => { vistos.push(snap.headRefOid); return guardReal()(snap); },
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.deepEqual(vistos, [HEAD_SHA, HEAD_SHA_2], 'el gate corre en cada intento');
    assert.equal(out.status, 'needs-human');
    assert.equal(out.gate, 'permisos');
    assert.equal(merges.length, 1, 'sólo el primer intento llegó al PUT');
});

test('CA-13 · el gate corre DESPUÉS de CODEOWNERS y ANTES de la procedencia', () => {
    const orden = [];
    const { d } = deps({
        loadOwners: () => { orden.push('owners'); return { ok: true, rules: [] }; },
        checkPermissions: (s) => { orden.push('permisos'); return guardReal()(s); },
        verifyOrigin: () => { orden.push('origen'); return { ok: true }; },
    });
    delivery.attemptMergeWithGates(d);
    assert.deepEqual(orden.slice(0, 3), ['owners', 'permisos', 'origen']);
});

// ── CA-14 · sin llave por label ─────────────────────────────────────────────

test('CA-14 · ningún label destraba el gate (ni needs-human ni uno de aprobación)', () => {
    const { d, merges } = deps({
        getSnapshot: () => snapshotOk({
            files: ['.pipeline/env-exceptions.yaml'],
            labels: ['qa:passed', 'needs-human', 'permisos:aprobado', 'approved'],
        }),
    });
    const out = delivery.attemptMergeWithGates(d);
    assert.equal(out.status, 'needs-human');
    assert.equal(merges.length, 0);
});

// ── Caller: label + escalado human-block ───────────────────────────────────

test('CA-9 · el escalado con gate permisos es human-block (sin rebote a dev) y dice cómo destrabar', () => {
    assert.match(delivery.GATE_BLOCK_LABELS.permisos, /permisos del entorno de agentes/);
    assert.match(delivery.GATE_BLOCK_LABELS.permisos, /mergear a mano/);
    const motivo = delivery.buildGateBlockMotivo({ prNumber: 7635, branch: 'agent/7635-x', gate: 'permisos', reason: 'cambio de permisos de agentes: env-exceptions.yaml modificado' });
    assert.match(motivo, /Merge bloqueado/);
    assert.match(motivo, /requiere intervención humana/);
    assert.match(motivo, /permisos del entorno de agentes/);
});

test('CA-9 · el caller distingue gate permisos: aplica needs-human y escala con gate permisos', () => {
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    const i = src.indexOf("outcome.status === 'needs-human' && outcome.gate === 'permisos'");
    assert.ok(i > 0, 'existe la rama del caller para gate permisos');
    const j = src.indexOf("} else if (outcome.status === 'needs-human') {", i);
    assert.ok(j > i, 'y va ANTES de la rama genérica de CODEOWNERS');
    const rama = src.slice(i, j);
    assert.match(rama, /applyNeedsHumanLabel\(/);
    assert.match(rama, /escalateMergeGateBlock\(/);
    assert.match(rama, /gate: 'permisos'/);
    assert.match(rama, /cambio de permisos de agentes: /);
    assert.match(rama, /exitCode = 1/);
});

// ── Anti-código-muerto: producción inyecta el gate ─────────────────────────

test('producción inyecta checkPermissions en el camino de merge', () => {
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    assert.match(src, /checkPermissions: buildPermissionsChecker\(\{ prNumber, logAppend \}\)/);
    assert.match(src, /require\('\.\.\/lib\/permission-change-guard'\)/);
});

test('producción inyecta checkPermissions en los DOS caminos de merge (principal y reclaim)', () => {
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    const llamadas = (src.match(/attemptMergeWithGates\(\{/g) || []).length;
    const inyecciones = (src.match(/checkPermissions: buildPermissionsChecker\(\{ prNumber, /g) || []).length;
    assert.equal(inyecciones, llamadas, 'cada attemptMergeWithGates de producción inyecta el gate de permisos');
    const i = src.indexOf('function reclaimMergeWithGates(');
    const fin = /\r?\n\}\r?\n/.exec(src.slice(i));
    const j = fin ? i + fin.index : -1;
    assert.ok(i > 0 && j > i, 'existe reclaimMergeWithGates');
    assert.match(src.slice(i, j), /checkPermissions: buildPermissionsChecker\(\{ prNumber, cwd, logAppend \}\)/);
});

// ── Wiring de producción con fakes de gh y git ─────────────────────────────

function fakeSpawn(mapa) {
    // mapa: { 'ref:path': texto | null } ; ausente ⇒ "does not exist"
    const llamadas = [];
    const impl = (cmd, argv, opts) => {
        llamadas.push({ cmd, argv, opts });
        const spec = argv[1];
        if (Object.prototype.hasOwnProperty.call(mapa, spec) && mapa[spec] !== null) {
            if (mapa[spec] instanceof Error) return { status: 128, stdout: '', stderr: 'fatal: bad object' };
            return { status: 0, stdout: mapa[spec], stderr: '' };
        }
        const [ref, p] = spec.split(':');
        return { status: 128, stdout: '', stderr: `fatal: path '${p}' does not exist in '${ref}'` };
    };
    impl.llamadas = llamadas;
    return impl;
}

test('wiring · usa la lista paginada de la API (con renombres) y git show sin shell', () => {
    const gh = (argv) => {
        assert.equal(argv[0], 'api');
        assert.ok(argv.includes('--paginate'));
        return {
            exit_code: 0,
            stdout: [
                JSON.stringify({ path: '.pipeline/otro.yaml', previous_filename: '.pipeline/env-exceptions.yaml' }),
                JSON.stringify({ path: 'docs/x.md', previous_filename: null }),
            ].join('\n') + '\n',
        };
    };
    const spawnImpl = fakeSpawn({});
    const check = delivery.buildPermissionsChecker({ prNumber: 7635, cwd: '/wt', ghImpl: gh, spawnImpl });
    const r = check(snapshotOk({ files: ['.pipeline/otro.yaml', 'docs/x.md'] }));
    assert.ok(r.motivos.some((m) => /env-exceptions\.yaml/.test(m)), 'el renombre se detecta por previous_filename');
});

test('wiring · si la API falla el snapshot no acredita una lista completa', () => {
    const gh = () => ({ exit_code: 1, stdout: '', stderr: 'boom' });
    const logs = [];
    const check = delivery.buildPermissionsChecker({ prNumber: 1, ghImpl: gh, spawnImpl: fakeSpawn({}), logAppend: (m) => logs.push(m) });
    assert.ok(check(snapshotOk({ files: ['docs/x.md'], filesComplete: true })).motivos.some((m) => /incompleta/.test(m)));
    assert.ok(check(snapshotOk({ files: ['docs/x.md'], filesComplete: false })).motivos.some((m) => /incompleta/.test(m)));
    assert.ok(logs.some((m) => /gate permisos/.test(m)));
});

test('wiring · lee base en origin/main y head en el SHA del snapshot; git show que falla ⇒ motivo', () => {
    const AM = '.pipeline/agent-models.json';
    const gh = () => ({ exit_code: 0, stdout: JSON.stringify({ path: AM }) + '\n' });
    const modelos = JSON.stringify({ skills: { guru: { requires_credentials: ['github'] } } });
    const ok = fakeSpawn({ [`origin/main:${AM}`]: modelos, [`${HEAD_SHA}:${AM}`]: modelos });
    const r1 = delivery.buildPermissionsChecker({ prNumber: 1, ghImpl: gh, spawnImpl: ok })(snapshotOk({ files: [AM] }));
    assert.deepEqual(r1.motivos, []);
    for (const l of ok.llamadas) {
        assert.equal(l.cmd, 'git');
        assert.equal(l.argv[0], 'show');
        assert.equal(l.opts.shell, false);
    }
    const falla = fakeSpawn({ [`origin/main:${AM}`]: modelos, [`${HEAD_SHA}:${AM}`]: new Error('x') });
    const r2 = delivery.buildPermissionsChecker({ prNumber: 1, ghImpl: gh, spawnImpl: falla })(snapshotOk({ files: [AM] }));
    assert.ok(r2.motivos.some((m) => /no se pudo leer/.test(m)));
});

test('wiring · gitShowAt rechaza refs o paths con caracteres de shell', () => {
    assert.throws(() => delivery.gitShowAt('origin/main;rm', '.pipeline/x', { spawnImpl: fakeSpawn({}) }));
    assert.throws(() => delivery.gitShowAt('origin/main', '../$(x)', { spawnImpl: fakeSpawn({}) }));
});

test('getPRSnapshot no acredita renombres completos aunque haya menos de 100 archivos', () => {
    const mk = (n) => () => ({
        exit_code: 0,
        stdout: JSON.stringify({
            labels: [], headRefOid: HEAD_SHA, headRefName: 'agent/x', state: 'OPEN',
            files: Array.from({ length: n }, (_, i) => ({ path: `f${i}.js` })),
        }),
    });
    assert.equal(delivery.getPRSnapshot(1, { ghImpl: mk(3) }).filesComplete, false);
    assert.equal(delivery.getPRSnapshot(1, { ghImpl: mk(100) }).filesComplete, false);
});

for (const escenario of [
    { nombre: 'renombre sensible con API caída', previous_filename: '.pipeline/env-exceptions.yaml', api: { exit_code: 1 } },
    { nombre: 'snapshot sin metadatos de renombre con API caída', api: { exit_code: 1 } },
    { nombre: 'API con JSON roto', api: { exit_code: 0, stdout: '{' } },
    { nombre: 'API con una entrada inválida entre rutas válidas', api: { exit_code: 0, stdout: '{"path":"docs/x.md"}\n{"path":null}' } },
    { nombre: 'API con renombre inválido', api: { exit_code: 0, stdout: '{"path":"docs/x.md","previous_filename":42}' } },
    { nombre: 'API vacía', api: { exit_code: 0, stdout: '' } },
]) {
    test(`CA-4 regresión integrada · ${escenario.nombre} bloquea sin merge`, () => {
        const file = { path: '.pipeline/archived-exceptions.yaml', ...(escenario.previous_filename
            ? { previous_filename: escenario.previous_filename } : {}) };
        const fakeGithub = (argv) => argv[0] === 'pr' ? {
            exit_code: 0,
            stdout: JSON.stringify({ labels: [{ name: 'qa:passed' }], headRefOid: HEAD_SHA,
                headRefName: 'agent/7635-pipeline-dev', state: 'OPEN', files: [file], statusCheckRollup: [] }),
        } : escenario.api;
        const snapshot = delivery.getPRSnapshot(7635, { ghImpl: fakeGithub });
        assert.equal(snapshot.ok, true);
        assert.deepEqual(snapshot.files, [file.path], 'compatibilidad con los otros gates');
        assert.deepEqual(snapshot.permissionFiles, [file], 'conserva el nombre anterior');
        assert.equal(snapshot.filesComplete, false);
        const { d, merges } = deps({
            getSnapshot: () => snapshot,
            checkPermissions: delivery.buildPermissionsChecker({ prNumber: 7635, ghImpl: fakeGithub,
                spawnImpl: () => { throw new Error('no corresponde leer contenido'); } }),
        });
        const out = delivery.attemptMergeWithGates(d);
        assert.equal(out.status, 'needs-human');
        assert.equal(out.gate, 'permisos');
        assert.ok(out.motivos.some((m) => /incompleta/.test(m)));
        if (escenario.previous_filename) assert.ok(out.motivos.some((m) => /env-exceptions/.test(m)));
        assert.equal(merges.length, 0);
    });
}

test('CA-4 regresión integrada · API completa permite un PR inocuo y frena un renombre sensible', () => {
    for (const previous_filename of [null, '.pipeline/env-exceptions.yaml']) {
        const fakeGithub = () => ({ exit_code: 0, stdout: JSON.stringify({ path: 'docs/x.md', previous_filename }) });
        const { d, merges } = deps({
            checkPermissions: delivery.buildPermissionsChecker({ prNumber: 7635, ghImpl: fakeGithub }),
        });
        const out = delivery.attemptMergeWithGates(d);
        assert.equal(out.status, previous_filename ? 'needs-human' : 'merged');
        assert.equal(merges.length, previous_filename ? 0 : 1);
    }
});
