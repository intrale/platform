// =============================================================================
// qa-evidence-enqueue.test.js — #6145
// =============================================================================
//
// Reproduce el defecto que rechazó la fase de aprobación de #6145: el descriptor
// de evidencia QA aprobada quedó varado en
// `<worktree>/.pipeline/servicios/drive/pendiente/` — porque el rol lo escribía
// con un path RELATIVO y el agente corre con CWD = worktree — mientras la cola
// canónica del servicio quedaba vacía y `listo/` conservaba la pasada rechazada.
//
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../qa-evidence-enqueue');

// -----------------------------------------------------------------------------
// Helpers de sandbox real (fs de verdad en tmp, sin tocar el repo)
// -----------------------------------------------------------------------------

function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ev-6145-'));
    const repoRoot = path.join(root, 'platform');
    const queueDir = path.join(repoRoot, '.pipeline', 'servicios', 'drive', 'pendiente');
    fs.mkdirSync(queueDir, { recursive: true });
    return { root, repoRoot, queueDir };
}

function makeWorktree(sandbox, issue, skill) {
    const wt = path.join(sandbox.root, `platform.agent-${issue}-${skill}`);
    const q = path.join(wt, '.pipeline', 'servicios', 'drive', 'pendiente');
    fs.mkdirSync(q, { recursive: true });
    return { dir: wt, queueDir: q };
}

function listJson(dir) {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

// -----------------------------------------------------------------------------
// Anclaje del destino
// -----------------------------------------------------------------------------

test('el destino se ancla en PIPELINE_REPO_ROOT y nunca en el CWD del worktree', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');

    // El agente corre parado en el worktree; el pulpo le pasa el repo canónico.
    const env = { PIPELINE_REPO_ROOT: s.repoRoot };
    const resuelto = lib.resolveDriveQueueDir(env, {});

    assert.equal(path.resolve(resuelto), path.resolve(s.queueDir));
    assert.notEqual(path.resolve(resuelto), path.resolve(wt.queueDir));
});

test('PIPELINE_STATE_DIR tiene precedencia sobre PIPELINE_REPO_ROOT', () => {
    const s = makeSandbox();
    const otro = path.join(s.root, 'otro-estado');
    const resuelto = lib.resolveDriveQueueDir(
        { PIPELINE_STATE_DIR: otro, PIPELINE_REPO_ROOT: s.repoRoot },
        {},
    );
    assert.equal(
        path.resolve(resuelto),
        path.resolve(path.join(otro, 'servicios', 'drive', 'pendiente')),
    );
});

test('sin ninguna variable de entorno cae al modulo, jamas al CWD', () => {
    const cwdOriginal = process.cwd();
    const s = makeSandbox();
    try {
        process.chdir(s.root);
        const resuelto = lib.resolveStateRoot({}, {});
        // Resuelve relativo al módulo (`.pipeline/lib/..`), no al cwd temporal.
        assert.equal(path.resolve(resuelto), path.resolve(__dirname, '..', '..'));
        assert.notEqual(path.resolve(resuelto), path.resolve(s.root));
    } finally {
        process.chdir(cwdOriginal);
    }
});

// -----------------------------------------------------------------------------
// Nombre único por pasada
// -----------------------------------------------------------------------------

test('dos pasadas del mismo issue producen descriptores distintos y ninguno pisa al otro', () => {
    const s = makeSandbox();
    const env = { PIPELINE_REPO_ROOT: s.repoRoot };

    const r1 = lib.enqueueStructuralEvidence(
        { issue: 6145, verdict: 'rechazado', passed: 6, total: 7, motivo: 'CA-7 no cumple' },
        { env, now: 1000 },
    );
    const r2 = lib.enqueueStructuralEvidence(
        { issue: 6145, verdict: 'aprobado', passed: 7, total: 7, head: 'deadbeef' },
        { env, now: 2000 },
    );

    assert.equal(r1.ok, true, r1.errors.join('; '));
    assert.equal(r2.ok, true, r2.errors.join('; '));
    assert.notEqual(r1.name, r2.name);

    const encolados = listJson(s.queueDir);
    assert.equal(encolados.length, 2);

    const leido2 = JSON.parse(fs.readFileSync(r2.path, 'utf8'));
    assert.equal(leido2.verdict, 'aprobado');
    assert.equal(leido2.passed, 7);
    assert.equal(leido2.total, 7);
    assert.equal(leido2.head, 'deadbeef');
});

test('dos encolados en el mismo milisegundo no colisionan: el secuencial se incrementa', () => {
    const s = makeSandbox();
    const env = { PIPELINE_REPO_ROOT: s.repoRoot };
    const a = lib.enqueueStructuralEvidence({ issue: 42, verdict: 'aprobado' }, { env, now: 777 });
    const b = lib.enqueueStructuralEvidence({ issue: 42, verdict: 'aprobado' }, { env, now: 777 });
    assert.notEqual(a.name, b.name);
    assert.equal(listJson(s.queueDir).length, 2);
});

test('el nombre del descriptor sigue permitiendo derivar el issue con el patron qa-(digitos)', () => {
    const nombre = lib.buildDescriptorName(6145, { now: 1787000000000, seq: 0 });
    const m = /qa-(\d+)/.exec(nombre);
    assert.ok(m, `el nombre ${nombre} no matchea qa-(\\d+)`);
    assert.equal(m[1], '6145');
    assert.match(nombre, /\.json$/);
});

// -----------------------------------------------------------------------------
// Contrato del payload que exige servicio-drive.js
// -----------------------------------------------------------------------------

test('el descriptor emite mode structural y source qa-structural, que es lo que exime el uploader de video', () => {
    const { ok, descriptor } = lib.buildDescriptor({ issue: 6145, verdict: 'aprobado' });
    assert.equal(ok, true);
    assert.equal(descriptor.mode, lib.REQUIRED_MODE);
    assert.equal(descriptor.source, lib.REQUIRED_SOURCE);
    assert.equal(descriptor.mode, 'structural');
    assert.equal(descriptor.source, 'qa-structural');
    assert.equal(descriptor.action, 'upload');
    assert.equal(descriptor.file, 'qa/evidence/6145/qa-6145-structural.md');
    assert.equal(descriptor.folder, 'QA/evidence/6145');
});

test('un descriptor sin verdict se rechaza: es lo que impide distinguir la pasada aprobada de la rechazada', () => {
    const r = lib.buildDescriptor({ issue: 6145 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('verdict')));
});

test('un issue no numerico se rechaza y no escribe nada en la cola', () => {
    const s = makeSandbox();
    const r = lib.enqueueStructuralEvidence(
        { issue: '../../etc', verdict: 'aprobado' },
        { env: { PIPELINE_REPO_ROOT: s.repoRoot } },
    );
    assert.equal(r.ok, false);
    assert.equal(listJson(s.queueDir).length, 0);
});

test('los criterios fallidos viajan en el descriptor cuando el veredicto es rechazado', () => {
    const { descriptor } = lib.buildDescriptor({
        issue: 6145, verdict: 'rechazado', criteriosFallidos: ['CA-7'], motivo: 'audit de rev-1',
    });
    assert.deepEqual(descriptor.criteriosFallidos, ['CA-7']);
    assert.equal(descriptor.motivo, 'audit de rev-1');
});

// -----------------------------------------------------------------------------
// Modo del descriptor
// -----------------------------------------------------------------------------

test('el modo android NO emite source qa-structural: eso saltearia el upload real del video', () => {
    const { descriptor } = lib.buildDescriptor({ issue: 6145, verdict: 'aprobado', mode: 'android' });
    assert.equal(descriptor.mode, 'android');
    assert.notEqual(descriptor.source, lib.REQUIRED_SOURCE);
    assert.equal(descriptor.source, 'qa-android');
    assert.equal(descriptor.file, 'qa/evidence/6145/qa-6145.mp4');
});

test('el descriptor de video se nombra qa-<issue>-video-* y el estructural qa-<issue>-structural-*', () => {
    const s = makeSandbox();
    const env = { PIPELINE_REPO_ROOT: s.repoRoot };
    const video = lib.enqueueStructuralEvidence(
        { issue: 6145, verdict: 'aprobado', mode: 'android' }, { env, now: 100 },
    );
    const estructural = lib.enqueueStructuralEvidence(
        { issue: 6145, verdict: 'aprobado' }, { env, now: 100 },
    );
    assert.match(video.name, /^qa-6145-video-/);
    assert.match(estructural.name, /^qa-6145-structural-/);
});

// -----------------------------------------------------------------------------
// Rescate de descriptores varados
// -----------------------------------------------------------------------------

test('detecta el descriptor varado en la cola del worktree, que ningun servicio consume', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');
    fs.writeFileSync(
        path.join(wt.queueDir, 'qa-6145-structural.json'),
        JSON.stringify({ action: 'upload', issue: 6145, mode: 'structural', source: 'qa-structural' }),
    );

    const varados = lib.findStrandedDescriptors({ repoRoot: s.repoRoot });
    assert.equal(varados.length, 1);
    assert.equal(varados[0].name, 'qa-6145-structural.json');
    assert.equal(varados[0].worktree, wt.dir);
});

test('el rescate re-encola el descriptor varado en la cola canonica y limpia el origen', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');
    fs.writeFileSync(
        path.join(wt.queueDir, 'qa-6145-structural.json'),
        JSON.stringify({
            action: 'upload',
            file: 'qa/evidence/6145/qa-6145-structural.md',
            issue: 6145,
            mode: 'structural',
            source: 'qa-structural',
        }),
    );

    const r = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 5000 });
    assert.equal(r.rescued, 1);
    assert.equal(r.errors.length, 0);

    const encolados = listJson(s.queueDir);
    assert.equal(encolados.length, 1);
    const leido = JSON.parse(fs.readFileSync(path.join(s.queueDir, encolados[0]), 'utf8'));
    assert.equal(leido.source, 'qa-structural');
    assert.equal(leido.issue, 6145);
    assert.equal(leido._rescuedFrom, wt.dir);

    // El origen desaparece: sin esto el rescate re-encolaría en cada tick.
    assert.equal(listJson(wt.queueDir).length, 0);
});

test('el rescate es idempotente: una segunda corrida no vuelve a encolar', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');
    fs.writeFileSync(
        path.join(wt.queueDir, 'qa-6145-structural.json'),
        JSON.stringify({ issue: 6145, mode: 'structural', source: 'qa-structural' }),
    );

    lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 5000 });
    const primera = listJson(s.queueDir).length;
    const segunda = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 6000 });

    assert.equal(segunda.rescued, 0);
    assert.equal(listJson(s.queueDir).length, primera);
});

test('un descriptor varado ilegible se saltea sin romper el rescate del resto', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');
    fs.writeFileSync(path.join(wt.queueDir, 'qa-6145-roto.json'), '{ esto no es json');
    fs.writeFileSync(
        path.join(wt.queueDir, 'qa-6145-structural.json'),
        JSON.stringify({ issue: 6145, mode: 'structural', source: 'qa-structural' }),
    );

    const r = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 5000 });
    assert.equal(r.rescued, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.errors.length, 0);
});

test('el rescate no toca directorios hermanos que no son worktrees de agente', () => {
    const s = makeSandbox();
    const ajeno = path.join(s.root, 'platform.backup', '.pipeline', 'servicios', 'drive', 'pendiente');
    fs.mkdirSync(ajeno, { recursive: true });
    fs.writeFileSync(path.join(ajeno, 'qa-999-structural.json'), JSON.stringify({ issue: 999 }));

    const r = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 5000 });
    assert.equal(r.rescued, 0);
    assert.equal(listJson(ajeno).length, 1, 'no debe consumir colas ajenas al pipeline');
});

test('el rescate corta por tanda y DEJA CONSTANCIA de lo diferido, sin descartar nada', () => {
    const s = makeSandbox();
    const wt = makeWorktree(s, 6145, 'pipeline-dev');
    for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
            path.join(wt.queueDir, `qa-6145-structural-${i}.json`),
            JSON.stringify({ issue: 6145, mode: 'structural', source: 'qa-structural' }),
        );
    }

    const avisos = [];
    const r = lib.rescueStrandedDescriptors({
        repoRoot: s.repoRoot, now: 5000, maxPerRun: 2, log: (m) => avisos.push(m),
    });

    assert.equal(r.rescued, 2);
    assert.equal(r.diferidos, 3);
    // Lo diferido sigue en el worktree: se rescata en la próxima corrida, no se pierde.
    assert.equal(listJson(wt.queueDir).length, 3);
    assert.ok(avisos.some((m) => m.includes('proxima corrida')), 'el tope debe loguearse');

    // Segunda tanda: termina de drenar.
    const r2 = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 6000, maxPerRun: 25 });
    assert.equal(r2.rescued, 3);
    assert.equal(listJson(wt.queueDir).length, 0);
    assert.equal(listJson(s.queueDir).length, 5);
});

test('sin worktrees ni descriptores varados el rescate es un no-op silencioso', () => {
    const s = makeSandbox();
    const r = lib.rescueStrandedDescriptors({ repoRoot: s.repoRoot, now: 5000 });
    assert.deepEqual({ rescued: r.rescued, skipped: r.skipped, errors: r.errors }, {
        rescued: 0, skipped: 0, errors: [],
    });
    assert.equal(r.diferidos, 0);
});

// -----------------------------------------------------------------------------
// Robustez: el servicio Drive no puede morir por esto
// -----------------------------------------------------------------------------

test('un fs que explota al escribir devuelve ok=false en vez de lanzar', () => {
    const fsRoto = {
        mkdirSync: () => {},
        existsSync: () => false,
        writeFileSync: () => { throw new Error('EACCES simulado'); },
    };
    const r = lib.enqueueStructuralEvidence(
        { issue: 6145, verdict: 'aprobado' },
        { env: { PIPELINE_REPO_ROOT: '/no/existe' }, fsImpl: fsRoto },
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('EACCES simulado'));
});

test('un fs que explota al listar worktrees no propaga la excepcion al servicio', () => {
    const fsRoto = {
        readdirSync: () => { throw new Error('EIO simulado'); },
        mkdirSync: () => {},
        existsSync: () => false,
        writeFileSync: () => {},
    };
    const r = lib.rescueStrandedDescriptors({ repoRoot: '/x/platform', fsImpl: fsRoto });
    assert.equal(r.rescued, 0);
    assert.equal(r.errors.length, 0, 'readdir fallido se degrada a "sin worktrees"');
});
