// =============================================================================
// migrate-operational-state-namespace.test.js — #5110 (Ola 9.4 · E2).
//
// El migrador toca el estado operativo REAL de una instalación viva. Los tres
// riesgos que este archivo fija:
//
//   R2 / SEC-7 · el layout namespaceado NO está cubierto por las entradas
//                literales del `.gitignore` viejo. Si el migrador produce un
//                solo archivo trackeable, la allowlist, los motivos de rechazo
//                y el audit interno terminan en un repo PÚBLICO.
//   R6 / SEC-8 · TOCTOU contra un pulpo vivo: migrar mientras el pipeline
//                despacha pierde escrituras en silencio.
//   R8        · el rollback tiene que devolver el layout plano BIT A BIT, o no
//                es un rollback.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/migrate-operational-state-namespace.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIGRATOR = '../../scripts/migrate-operational-state-namespace';
const PROJECT_CONTEXT = '../project-context';

function fresh() {
    delete require.cache[require.resolve(MIGRATOR)];
    delete require.cache[require.resolve(PROJECT_CONTEXT)];
    require(PROJECT_CONTEXT)._resetForTests();
    return require(MIGRATOR);
}

/** Sandbox con layout PLANO poblado, como una instalación pre-#5110. */
function setup({ paused = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-migrate-'));
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'archived'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({ version: '1.0', active_wave: { number: 7 } }, null, 2));
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({ allowed_issues: [101, 102] }, null, 2));
    fs.writeFileSync(path.join(dir, 'archived', 'waves-2026-01.json'), JSON.stringify({ snapshot: true }));
    fs.writeFileSync(path.join(dir, 'audit', 'partial-pause-mutations.jsonl'), '{"action":"write"}\n');
    fs.writeFileSync(path.join(dir, 'wave-promote.in-progress.json'), JSON.stringify({ pid: 1 }));
    // NO se migra: halt global + template versionado.
    fs.writeFileSync(path.join(dir, 'waves.json.template'), '{}');
    if (paused) fs.writeFileSync(path.join(dir, '.paused'), JSON.stringify({ reason: 'migracion' }));

    process.env.PIPELINE_DIR_OVERRIDE = dir;
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_OPSTATE_NAMESPACED;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function snapshotTree(root) {
    const out = {};
    const walk = (p) => {
        let st;
        try { st = fs.statSync(p); } catch { return; }
        if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
        out[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    };
    walk(root);
    return out;
}

const HOST = () => require(PROJECT_CONTEXT).HOST_PROJECT_ID;

// ─── Migración ──────────────────────────────────────────────────────────────

test('migra el layout plano al namespace del host', () => {
    const dir = setup();
    try {
        const m = fresh();
        assert.equal(m.main([]), 0);

        const ns = path.join(dir, 'projects', HOST());
        assert.ok(fs.existsSync(path.join(ns, 'waves.json')), 'waves.json debe estar en el namespace');
        assert.ok(fs.existsSync(path.join(ns, '.partial-pause.json')));
        assert.ok(fs.existsSync(path.join(ns, 'archived', 'waves-2026-01.json')));
        assert.ok(fs.existsSync(path.join(ns, 'audit', 'partial-pause-mutations.jsonl')));
        assert.ok(fs.existsSync(path.join(ns, 'wave-promote.in-progress.json')));

        // Y ya no están en el layout plano.
        assert.ok(!fs.existsSync(path.join(dir, 'waves.json')));
        assert.ok(!fs.existsSync(path.join(dir, '.partial-pause.json')));

        // Contenido preservado, no sólo el nombre del archivo.
        const waves = JSON.parse(fs.readFileSync(path.join(ns, 'waves.json'), 'utf8'));
        assert.equal(waves.active_wave.number, 7);
    } finally { teardown(dir); }
});

test('D4 · .paused NO se migra, y el template versionado tampoco', () => {
    const dir = setup();
    try {
        fresh().main([]);
        assert.ok(fs.existsSync(path.join(dir, '.paused')), '.paused queda global (SEC-6)');
        assert.ok(fs.existsSync(path.join(dir, 'waves.json.template')), 'el template es del repo, no estado');
        const ns = path.join(dir, 'projects', HOST());
        assert.ok(!fs.existsSync(path.join(ns, '.paused')));
        assert.ok(!fs.existsSync(path.join(ns, 'waves.json.template')));
    } finally { teardown(dir); }
});

test('escribe el marker .migrated con schemaVersion y projectId', () => {
    const dir = setup();
    try {
        fresh().main([]);
        const marker = JSON.parse(fs.readFileSync(path.join(dir, 'projects', HOST(), '.migrated'), 'utf8'));
        assert.equal(marker.schemaVersion, 1);
        assert.equal(marker.projectId, HOST());
        assert.equal(marker.issue, 5110);
        assert.ok(marker.backup, 'el marker apunta al backup para poder volver');
    } finally { teardown(dir); }
});

test('es idempotente: correrlo dos veces no duplica ni rompe', () => {
    const dir = setup();
    try {
        const m = fresh();
        assert.equal(m.main([]), 0);
        const after1 = snapshotTree(path.join(dir, 'projects', HOST()));
        assert.equal(m.main([]), 0, 'la segunda corrida sale limpia');
        const after2 = snapshotTree(path.join(dir, 'projects', HOST()));
        assert.deepEqual(after2, after1, 'el namespace no cambió en la segunda corrida');
    } finally { teardown(dir); }
});

test('--dry-run no toca el filesystem', () => {
    const dir = setup();
    try {
        const before = snapshotTree(dir);
        assert.equal(fresh().main(['--dry-run']), 0);
        assert.deepEqual(snapshotTree(dir), before, 'dry-run no puede escribir nada');
    } finally { teardown(dir); }
});

test('instalación sin layout plano: no falla, deja el marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-fresh-'));
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.paused'), '{}');
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try {
        assert.equal(fresh().main([]), 0);
        assert.ok(fs.existsSync(path.join(dir, 'projects', HOST(), '.migrated')));
    } finally { teardown(dir); }
});

// ─── R6 / SEC-8 · halt obligatorio ──────────────────────────────────────────

test('SEC-8 · sin halt ni lock, el migrador se niega a correr', () => {
    const dir = setup({ paused: false });
    try {
        const m = fresh();
        assert.throws(() => m.main([]), (err) => {
            assert.match(err.message, /halt total verificado/i);
            return true;
        });
        // Y no dejó el estado a medias.
        assert.ok(fs.existsSync(path.join(dir, 'waves.json')), 'el layout plano queda intacto');
        assert.ok(!fs.existsSync(path.join(dir, 'projects')), 'no creó el namespace');
    } finally { teardown(dir); }
});

test('SEC-8 · --lock permite correr sin .paused, y el lock se libera al terminar', () => {
    const dir = setup({ paused: false });
    try {
        assert.equal(fresh().main(['--lock']), 0);
        assert.ok(fs.existsSync(path.join(dir, 'projects', HOST(), 'waves.json')));
        assert.ok(!fs.existsSync(path.join(dir, '.opstate-migration.lock')), 'el lock se libera');
    } finally { teardown(dir); }
});

test('SEC-8 · un lock preexistente aborta la corrida (otra migración en curso)', () => {
    const dir = setup({ paused: false });
    try {
        fs.writeFileSync(path.join(dir, '.opstate-migration.lock'), JSON.stringify({ pid: 99999 }));
        assert.throws(() => fresh().main(['--lock']), (err) => {
            assert.match(err.message, /lock de migraci/i);
            return true;
        });
        assert.ok(fs.existsSync(path.join(dir, 'waves.json')), 'no migró nada');
    } finally { teardown(dir); }
});

// ─── R8 · rollback ──────────────────────────────────────────────────────────

test('R8 · el rollback restaura el layout plano BIT A BIT', () => {
    const dir = setup();
    try {
        // Foto del estado operativo antes de tocar nada (sin backups, que son nuevos).
        const antes = {};
        for (const rel of ['waves.json', '.partial-pause.json', 'archived/waves-2026-01.json',
            'audit/partial-pause-mutations.jsonl', 'wave-promote.in-progress.json']) {
            antes[rel] = fs.readFileSync(path.join(dir, ...rel.split('/'))).toString('base64');
        }

        const m = fresh();
        assert.equal(m.main([]), 0);
        assert.ok(!fs.existsSync(path.join(dir, 'waves.json')), 'migró');

        assert.equal(m.main(['--rollback']), 0);

        for (const [rel, b64] of Object.entries(antes)) {
            const p = path.join(dir, ...rel.split('/'));
            assert.ok(fs.existsSync(p), `${rel} debe volver al layout plano`);
            assert.equal(fs.readFileSync(p).toString('base64'), b64, `${rel} debe ser idéntico byte a byte`);
        }
        assert.ok(!fs.existsSync(path.join(dir, 'projects', HOST(), '.migrated')), 'el marker se borra');
    } finally { teardown(dir); }
});

test('R8 · el rollback es idempotente', () => {
    const dir = setup();
    try {
        const m = fresh();
        m.main([]);
        assert.equal(m.main(['--rollback']), 0);
        assert.equal(m.main(['--rollback']), 0, 'segundo rollback no rompe');
        assert.ok(fs.existsSync(path.join(dir, 'waves.json')));
    } finally { teardown(dir); }
});

test('R8 · migrar → rollback → migrar vuelve a dejar todo en el namespace', () => {
    const dir = setup();
    try {
        const m = fresh();
        m.main([]);
        m.main(['--rollback']);
        assert.equal(m.main([]), 0);
        const ns = path.join(dir, 'projects', HOST());
        assert.ok(fs.existsSync(path.join(ns, 'waves.json')));
        assert.ok(fs.existsSync(path.join(ns, '.partial-pause.json')));
    } finally { teardown(dir); }
});

// ─── R2 / SEC-7 · nada trackeable ───────────────────────────────────────────

test('R2/SEC-7 · el .gitignore REAL cubre el namespace y los backups del migrador', () => {
    // Contra el repo de verdad, no contra un fixture: la garantía que importa
    // es que ESTE checkout no filtre estado operativo.
    const m = fresh();
    const rutas = [
        '.pipeline/projects/intrale-platform/waves.json',
        '.pipeline/projects/intrale-platform/.partial-pause.json',
        '.pipeline/projects/intrale-platform/archived/waves-2026-01.json',
        '.pipeline/projects/intrale-platform/audit/partial-pause-mutations.jsonl',
        '.pipeline/projects/intrale-platform/wave-promote.in-progress.json',
        '.pipeline/projects/intrale-platform/.migrated',
        '.pipeline/projects/otro-proyecto/waves.json',
        '.pipeline/backup/opstate-2026-08-18/waves.json',
    ];
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const leaked = rutas.filter((r) => !m._internal.isGitIgnored(path.join(repoRoot, r)));
    assert.deepEqual(leaked, [], `rutas TRACKEABLES en repo público: ${leaked.join(', ')}`);
});

test('R2/SEC-7 · el guard aborta ante una ruta in-repo NO ignorada', () => {
    const m = fresh();
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    // `lib/waves.js` está versionado: es el caso exacto que el guard debe
    // rechazar si algún día el `.gitignore` deja de cubrir el namespace.
    // (Un tmpdir NO sirve como caso negativo: cae fuera del repo y el guard lo
    // considera sin riesgo a propósito.)
    const trackeable = path.join(repoRoot, '.pipeline', 'lib', 'waves.js');
    assert.equal(m._internal.isGitIgnored(trackeable), false, 'premisa: waves.js está versionado');
    assert.throws(
        () => m._internal.assertIgnored([trackeable], 'destino'),
        (err) => {
            assert.match(err.message, /R2\/SEC-7/);
            assert.match(err.message, /TRACKEABLES/);
            return true;
        },
    );
});

test('R2/SEC-7 · ningún archivo producido por el migrador cae fuera de rutas ignoradas', () => {
    const dir = setup();
    try {
        const m = fresh();
        const antes = new Set(Object.keys(snapshotTree(dir)));
        m.main([]);
        const nuevos = Object.keys(snapshotTree(dir)).filter((f) => !antes.has(f));
        assert.ok(nuevos.length > 0, 'el migrador tiene que haber producido archivos');

        // Cada archivo nuevo tiene que caer bajo `projects/` o bajo `backup/`,
        // que son exactamente los dos prefijos que el .gitignore real cubre.
        for (const f of nuevos) {
            assert.ok(
                f.startsWith('projects/') || f.startsWith('backup/'),
                `archivo nuevo fuera de los prefijos ignorados: ${f}`,
            );
        }
    } finally { teardown(dir); }
});

// ─── Backup ─────────────────────────────────────────────────────────────────

test('el backup es fiel al origen y trae MANIFEST', () => {
    const dir = setup();
    try {
        fresh().main([]);
        const backups = fs.readdirSync(path.join(dir, 'backup'));
        assert.equal(backups.length, 1, 'una corrida, un backup');
        const bdir = path.join(dir, 'backup', backups[0]);

        const manifest = JSON.parse(fs.readFileSync(path.join(bdir, 'MANIFEST.json'), 'utf8'));
        assert.equal(manifest.schemaVersion, 1);
        assert.ok(manifest.items.includes('waves.json'));

        // El backup conserva el contenido original, que es lo que lo hace útil.
        const waves = JSON.parse(fs.readFileSync(path.join(bdir, 'waves.json'), 'utf8'));
        assert.equal(waves.active_wave.number, 7);
    } finally { teardown(dir); }
});

// ─── --status ───────────────────────────────────────────────────────────────

test('--status reporta el layout sin modificar nada', () => {
    const dir = setup();
    try {
        const m = fresh();
        const before = snapshotTree(dir);
        assert.equal(m.main(['--status']), 0);
        assert.deepEqual(snapshotTree(dir), before);
    } finally { teardown(dir); }
});
