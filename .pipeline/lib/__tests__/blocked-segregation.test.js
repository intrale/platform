// =============================================================================
// Tests segregación bloqueado-dependencias/ vs bloqueado-humano/ — issue #3229
//
// Cubre los criterios de aceptación del issue:
//
//   CA-1 · Carpeta `bloqueado-dependencias/` se crea físicamente y es
//          distinta de `bloqueado-humano/`.
//   CA-2 · classifyRebote con `rebote_categoria: dependency_block` clasifica
//          como dependency_block aunque el motivo no contenga la cadena
//          literal (puente guru → barrido cerrado).
//          classifyRebote con `rebote_categoria: human_block` clasifica
//          como human_block aunque el motivo no matchee patrones.
//   CA-3 · releaseDependencyBlockToPendiente() mueve archivos de
//          `bloqueado-dependencias/` a `pendiente/` (rol del brazoDesbloqueo
//          al destrabar).
//   CA-4 · reportHumanBlock SIGUE creando markers en `bloqueado-humano/`;
//          unblockIssue solo destraba esa carpeta (no toca bloqueado-deps/).
//   CA-5 · E2E con DOS issues hijos: uno dependency_block, otro human_block.
//          Cada uno cae en SU carpeta y se libera por el flujo correspondiente.
//
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR a un tmp por test setup
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-blocked-seg-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente'), { recursive: true });
for (const phase of ['validacion', 'dev']) {
    // #3373 — agregar 'procesado' para tests del sweep defensivo
    for (const state of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', phase, state), { recursive: true });
    }
}
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
delete require.cache[require.resolve('../rebote-classifier')];

const rc = require('../rebote-classifier');
const hb = require('../human-block');

function clearAll() {
    const pipelineDir = path.join(TMP_DIR, '.pipeline');
    for (const pipeline of ['desarrollo', 'definicion']) {
        const root = path.join(pipelineDir, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(root).filter(f => fs.statSync(path.join(root, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            // #3373 — incluir 'procesado' para limpiar también ese estado entre tests
            for (const state of ['pendiente', 'trabajando', 'listo', 'procesado', 'bloqueado-humano', 'bloqueado-dependencias']) {
                const dir = path.join(root, phase, state);
                try {
                    for (const f of fs.readdirSync(dir)) {
                        try { fs.unlinkSync(path.join(dir, f)); } catch {}
                    }
                } catch {}
            }
        }
    }
    const ghQueue = path.join(pipelineDir, 'servicios', 'github', 'pendiente');
    try { for (const f of fs.readdirSync(ghQueue)) fs.unlinkSync(path.join(ghQueue, f)); } catch {}
}

// =============================================================================
// CA-2: hint estructural rebote_categoria
// =============================================================================

test('CA-2: rebote_categoria=dependency_block en opts clasifica como dependency_block sin necesidad de motivo literal', () => {
    const result = rc.classifyRebote({
        // Motivo NO contiene la cadena literal "rebote_categoria: dependency_block"
        // — el agente lo emitió como campo YAML estructurado, no en motivo.
        motivo: 'Verificado: el merge de la dependencia todavía no aterrizó',
        rebote_categoria: 'dependency_block',
        dependsOn: [3220, 3198],
    });
    assert.equal(result.category, 'dependency_block');
    assert.equal(result.label, 'blocked:dependencies');
    assert.deepEqual(result.dependsOn, [3198, 3220]);
    assert.equal(result.counts_against_circuit_breaker, false);
});

test('CA-2: rebote_categoria=dependency_block sin dependsOn → matched=true, assetOnly', () => {
    const result = rc.classifyRebote({
        motivo: 'Asset UX todavía no entregado',
        rebote_categoria: 'dependency_block',
    });
    assert.equal(result.category, 'dependency_block');
    assert.deepEqual(result.dependsOn, []);
    assert.match(result.reason_summary, /asset|recurso/i);
});

test('CA-2: rebote_categoria=human_block en opts fuerza human_block aunque motivo no matchee patrón', () => {
    const result = rc.classifyRebote({
        motivo: 'Necesito que decidas qué hacer con el flow X (no hay merge ni codeowners involucrados)',
        rebote_categoria: 'human_block',
    });
    assert.equal(result.category, 'human_block');
    assert.equal(result.label, 'needs-human');
});

test('CA-2: sin rebote_categoria opt, comportamiento clásico se preserva', () => {
    // Motivo con patrón clásico → dependency_block igual
    const r1 = rc.classifyRebote({
        motivo: 'depende de #1234 que sigue OPEN',
    });
    assert.equal(r1.category, 'dependency_block');
    assert.deepEqual(r1.dependsOn, [1234]);

    // Motivo sin patrón ni hint → code fallback
    const r2 = rc.classifyRebote({ motivo: 'NullPointer en línea 42' });
    assert.equal(r2.category, 'code');
});

// =============================================================================
// CA-1 + CA-3: filesystem segregación
// =============================================================================

test('CA-1: writeDependencyBlockMarker crea marker en bloqueado-dependencias/ + .reason.json', () => {
    clearAll();
    const result = rc.writeDependencyBlockMarker({
        issue: 3221,
        skill: 'guru',
        phase: 'validacion',
        pipeline: 'desarrollo',
        dependsOn: [3220, 3198],
        reason: 'Verificado: #3220 OPEN',
    });
    assert.equal(result.ok, true);
    assert.match(result.marker_path, /bloqueado-dependencias[\\/]3221\.guru$/);
    assert.equal(fs.existsSync(result.marker_path), true);
    assert.equal(fs.existsSync(result.marker_path + '.reason.json'), true);

    const reason = JSON.parse(fs.readFileSync(result.marker_path + '.reason.json', 'utf8'));
    assert.equal(reason.issue, 3221);
    assert.equal(reason.skill, 'guru');
    assert.equal(reason.phase, 'validacion');
    assert.deepEqual(reason.depends_on, [3198, 3220]);
});

test('CA-1: la carpeta bloqueado-dependencias/ es física y distinta de bloqueado-humano/', () => {
    clearAll();
    rc.writeDependencyBlockMarker({
        issue: 9001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [1000],
    });
    const depDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias');
    const humanDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano');
    assert.equal(fs.statSync(depDir).isDirectory(), true);
    // bloqueado-humano puede o no existir aún; lo importante es que NO se solapan.
    assert.ok(depDir !== humanDir);
    assert.ok(!fs.readdirSync(depDir).some(f => f === '.gitkeep' ? false : !f.startsWith('9001')));
});

test('CA-2: moveIssueFilesToDependencyBlock saca archivos de pendiente/trabajando/listo a bloqueado-dependencias/', () => {
    clearAll();
    const pendDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente');
    const workDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'trabajando');
    fs.writeFileSync(path.join(pendDir, '3221.guru'), 'issue: 3221\n');
    fs.writeFileSync(path.join(workDir, '3221.po'), 'issue: 3221\n');

    const result = rc.moveIssueFilesToDependencyBlock({
        issue: 3221, pipeline: 'desarrollo', phase: 'validacion',
    });
    assert.equal(result.moved, 2);

    const depDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias');
    const moved = fs.readdirSync(depDir).filter(f => f.startsWith('3221.'));
    assert.equal(moved.length, 2);
    assert.equal(fs.existsSync(path.join(pendDir, '3221.guru')), false);
    assert.equal(fs.existsSync(path.join(workDir, '3221.po')), false);
});

test('CA-3: releaseDependencyBlockToPendiente devuelve archivos a pendiente/ de la fase original', () => {
    clearAll();
    // Setup: simular un issue en bloqueado-dependencias/ con su .reason.json
    rc.writeDependencyBlockMarker({
        issue: 3221, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [3220],
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 3221 });
    assert.equal(result.moved, 1);
    assert.equal(result.pipeline, 'desarrollo');
    assert.equal(result.phase, 'validacion');

    const pendDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente');
    assert.equal(fs.existsSync(path.join(pendDir, '3221.guru')), true);

    // El marker debe haber salido de bloqueado-dependencias/
    const depDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias');
    assert.equal(fs.existsSync(path.join(depDir, '3221.guru')), false);
    assert.equal(fs.existsSync(path.join(depDir, '3221.guru.reason.json')), false);
});

test('CA-3: releaseDependencyBlockToPendiente es idempotente cuando no hay markers', () => {
    clearAll();
    const result = rc.releaseDependencyBlockToPendiente({ issue: 99999 });
    assert.equal(result.moved, 0);
    assert.deepEqual(result.files, []);
});

test('CA-3: listDependencyBlockedMarkers lista solo markers válidos (excluye .reason.json y .gitkeep)', () => {
    clearAll();
    rc.writeDependencyBlockMarker({
        issue: 3221, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [3220],
    });
    // Crear un .gitkeep que debería ignorarse
    fs.writeFileSync(
        path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias', '.gitkeep'),
        '',
    );
    const list = rc.listDependencyBlockedMarkers();
    const found = list.find(m => m.issue === 3221);
    assert.ok(found, 'marker presente');
    assert.equal(found.skill, 'guru');
    assert.equal(found.phase, 'validacion');
    assert.equal(found.pipeline, 'desarrollo');
    // No debería incluir el .gitkeep ni el .reason.json
    assert.equal(list.filter(m => m.issue === 3221).length, 1);
});

// =============================================================================
// CA-4: bloqueado-humano sigue intacto
// =============================================================================

test('CA-4: reportHumanBlock NO toca bloqueado-dependencias/ (solo bloqueado-humano/)', () => {
    clearAll();
    const srcDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'trabajando');
    fs.writeFileSync(path.join(srcDir, '7777.po'), 'issue: 7777\n');

    hb.reportHumanBlock({
        issue: 7777, skill: 'po', phase: 'validacion',
        reason: 'PO necesita decidir entre A y B',
        question: '¿Cuál preferís?',
        skipGithubLabel: true,
    });

    // El marker DEBE estar en bloqueado-humano/, NO en bloqueado-dependencias/
    const humanDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano');
    const depDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias');
    assert.equal(fs.existsSync(path.join(humanDir, '7777.po')), true, 'marker en bloqueado-humano/');
    assert.equal(fs.existsSync(path.join(depDir, '7777.po')), false, 'NO debe estar en bloqueado-dependencias/');
});

test('CA-4: releaseDependencyBlockToPendiente NO libera markers de bloqueado-humano/', () => {
    clearAll();
    const srcDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'trabajando');
    fs.writeFileSync(path.join(srcDir, '8888.po'), 'issue: 8888\n');
    hb.reportHumanBlock({
        issue: 8888, skill: 'po', phase: 'validacion',
        reason: 'lo que sea',
        question: '¿lo que sea?',
        skipGithubLabel: true,
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 8888 });
    assert.equal(result.moved, 0, 'no debe mover nada — está en bloqueado-humano/, no bloqueado-dependencias/');

    // El marker humano sigue intacto
    const humanDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano');
    assert.equal(fs.existsSync(path.join(humanDir, '8888.po')), true);
});

// =============================================================================
// CA-5: E2E con dos issues hijos
// =============================================================================

test('CA-5 E2E: dos issues, uno dependency_block y otro human_block, cada uno cae en SU carpeta', () => {
    clearAll();

    // ----- Issue A (#10001): dependency_block ----------------------------
    // Simulamos el flujo del barrido del pulpo
    const motivoA = 'No puedo continuar, el merge de la dep todavía no aterrizó';
    const classA = rc.classifyRebote({
        motivo: motivoA,
        rebote_categoria: 'dependency_block',
        dependsOn: [10999],
    });
    assert.equal(classA.category, 'dependency_block');

    // Setup archivos del agente y aplicar el flujo del barrido
    const trabajandoA = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'trabajando');
    fs.writeFileSync(path.join(trabajandoA, '10001.guru'), `issue: 10001\nrechazado: true\n`);
    rc.writeDependencyBlockMarker({
        issue: 10001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: classA.dependsOn, reason: motivoA,
    });
    rc.moveIssueFilesToDependencyBlock({
        issue: 10001, pipeline: 'desarrollo', phase: 'validacion',
    });

    // ----- Issue B (#10002): human_block ---------------------------------
    const motivoB = 'PR #5555 mergeable pero CODEOWNERS requiere review';
    const classB = rc.classifyRebote({ motivo: motivoB });
    assert.equal(classB.category, 'human_block');

    const trabajandoB = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'trabajando');
    fs.writeFileSync(path.join(trabajandoB, '10002.po'), `issue: 10002\nrechazado: true\n`);
    hb.reportHumanBlock({
        issue: 10002, skill: 'po', phase: 'validacion',
        reason: motivoB,
        question: '¿Podés revisar el PR?',
        skipGithubLabel: true,
    });

    // ----- Verificaciones ------------------------------------------------
    const depDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-dependencias');
    const humanDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano');

    // Issue A: SOLO en bloqueado-dependencias/
    assert.equal(fs.existsSync(path.join(depDir, '10001.guru')), true);
    assert.equal(fs.existsSync(path.join(humanDir, '10001.guru')), false);

    // Issue B: SOLO en bloqueado-humano/
    assert.equal(fs.existsSync(path.join(humanDir, '10002.po')), true);
    assert.equal(fs.existsSync(path.join(depDir, '10002.po')), false);

    // ----- Liberación: solo el dependency_block se destrabar automáticamente
    // (esto es lo que hace el brazoDesbloqueo cuando las deps cierran)
    const releaseA = rc.releaseDependencyBlockToPendiente({ issue: 10001 });
    assert.equal(releaseA.moved, 1);

    // Issue A movido a pendiente/
    assert.equal(fs.existsSync(path.join(depDir, '10001.guru')), false);
    assert.equal(
        fs.existsSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente', '10001.guru')),
        true,
    );

    // Issue B sigue en bloqueado-humano/ — espera /unblock manual
    assert.equal(fs.existsSync(path.join(humanDir, '10002.po')), true);

    // ----- /unblock manual sobre el human-blocked -----------------------
    const unblockB = hb.unblockIssue({ issue: 10002, guidance: 'OK, revisar', unlocker: 'test' });
    assert.equal(unblockB.ok, true);
    assert.equal(fs.existsSync(path.join(humanDir, '10002.po')), false);
    assert.equal(
        fs.existsSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente', '10002.po')),
        true,
    );
});

test('CA-5 + #3221 (regresión): motivo con rebote_categoria YAML estructurado NO cae en human_block', () => {
    // Reproducción exacta del bug: el guru clasificó como dependency_block
    // emitiendo `rebote_categoria` como campo YAML top-level, pero el barrido
    // pasaba solo `motivo` al classifier → caía a human_block.
    // Con la fix, el opt `rebote_categoria` hace que clasifique correcto.
    const result = rc.classifyRebote({
        // Motivo del agente (texto plano sin la cadena literal del classifier)
        motivo: '#3220 (multi-provider routing) sigue abierta. Sin ese merge no podemos validar la integración.',
        rebote_categoria: 'dependency_block',
        dependsOn: [3220, 3198],
    });
    assert.equal(result.category, 'dependency_block', 'el bug #3229 se mantendría reproducido si esto fuera human_block');
    assert.equal(result.label, 'blocked:dependencies');
    assert.notEqual(result.label, 'needs-human');
    assert.deepEqual(result.dependsOn, [3198, 3220]);
});

// =============================================================================
// #3373 — Sweep defensivo: recuperar archivos varados en procesado/ por
//         fast-fail-rebote pre-fix. El issue #3361 sufrió este bug en prod.
// =============================================================================

const yamlLib = require('js-yaml');

function writeYamlSync(filepath, data) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, yamlLib.dump(data, { lineWidth: -1 }));
}

test('#3373 sweep: reingresa archivos con cancelado_por=fast-fail-rebote desde procesado/ a pendiente/', () => {
    clearAll();
    const procDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    fs.mkdirSync(procDir, { recursive: true });

    // Simular el estado tras el bug: .po y .ux drenados a procesado/, .guru
    // en bloqueado-dependencias/ (porque el dep_block handler lo movió bien).
    writeYamlSync(path.join(procDir, '3361.po'), {
        issue: 3361, fase: 'validacion', pipeline: 'desarrollo',
        resultado: 'aprobado', cancelado_por: 'fast-fail-rebote',
        cancelado_ts: '2026-05-19T00:00:00.000Z',
    });
    writeYamlSync(path.join(procDir, '3361.ux'), {
        issue: 3361, fase: 'validacion', pipeline: 'desarrollo',
        resultado: 'aprobado', cancelado_por: 'fast-fail-rebote',
        cancelado_ts: '2026-05-19T00:00:00.000Z',
    });
    rc.writeDependencyBlockMarker({
        issue: 3361, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [3353],
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 3361 });

    // 3 archivos: 1 del marker (guru) + 2 del sweep (po, ux)
    assert.equal(result.moved, 3, 'debe mover 3 archivos: guru + po + ux');
    assert.equal(result.swept, 2, 'el contador swept debe reportar 2 archivos recuperados');

    const pendDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente');
    assert.equal(fs.existsSync(path.join(pendDir, '3361.guru')), true, 'guru en pendiente/');
    assert.equal(fs.existsSync(path.join(pendDir, '3361.po')), true, 'po en pendiente/');
    assert.equal(fs.existsSync(path.join(pendDir, '3361.ux')), true, 'ux en pendiente/');

    // procesado/ vacío para el issue
    assert.equal(fs.existsSync(path.join(procDir, '3361.po')), false);
    assert.equal(fs.existsSync(path.join(procDir, '3361.ux')), false);

    // Los flags cancelado_* deben haberse limpiado del YAML reingresado
    const reentry = yamlLib.load(fs.readFileSync(path.join(pendDir, '3361.po'), 'utf8'));
    assert.equal(reentry.cancelado_por, undefined, 'cancelado_por debe limpiarse');
    assert.equal(reentry.cancelado_ts, undefined, 'cancelado_ts debe limpiarse');
    assert.equal(reentry.issue, 3361, 'el resto del YAML se preserva');
});

test('#3373 sweep negativo: NO restituye archivos con cancelado_por=cross-phase-rebote (strict equality)', () => {
    clearAll();
    const procDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    fs.mkdirSync(procDir, { recursive: true });

    // Archivos con cross-phase-rebote — semántica distinta, NO se restituye.
    writeYamlSync(path.join(procDir, '4001.po'), {
        issue: 4001, fase: 'validacion', pipeline: 'desarrollo',
        cancelado_por: 'cross-phase-rebote',
        cancelado_ts: '2026-05-19T00:00:00.000Z',
    });
    rc.writeDependencyBlockMarker({
        issue: 4001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [4999],
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 4001 });

    // Solo 1 movido (el guru del marker), el .po con cross-phase-rebote NO.
    assert.equal(result.moved, 1, 'solo guru se mueve');
    assert.equal(result.swept || 0, 0, 'el sweep no recupera cross-phase-rebote');

    // El .po sigue en procesado/ — semántica intacta.
    assert.equal(fs.existsSync(path.join(procDir, '4001.po')), true);
});

test('#3373 sweep: aislado por (issue, pipeline, phase) — no escanea otras fases ni otros issues', () => {
    clearAll();
    const validProc = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    const devProc = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'procesado');
    fs.mkdirSync(validProc, { recursive: true });
    fs.mkdirSync(devProc, { recursive: true });

    // .po del issue 5001 en validacion/procesado/ con cancelado_por (target)
    writeYamlSync(path.join(validProc, '5001.po'), {
        issue: 5001, cancelado_por: 'fast-fail-rebote',
    });
    // .pipeline-dev del MISMO issue pero en dev/procesado/ con cancelado_por
    // — no debería tocarse porque el marker está en validacion/, no en dev/.
    writeYamlSync(path.join(devProc, '5001.pipeline-dev'), {
        issue: 5001, cancelado_por: 'fast-fail-rebote',
    });
    // .po de OTRO issue (5002) en validacion/procesado/ — no debería tocarse.
    writeYamlSync(path.join(validProc, '5002.po'), {
        issue: 5002, cancelado_por: 'fast-fail-rebote',
    });
    rc.writeDependencyBlockMarker({
        issue: 5001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [5099],
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 5001 });

    // Movidos: guru (marker) + 5001.po (sweep). NO se toca dev ni issue 5002.
    assert.equal(result.moved, 2, 'guru + 5001.po (mismo pipeline+phase)');
    assert.equal(result.swept, 1, 'sweep recupera 1 archivo');

    // El dev/procesado/5001.pipeline-dev sigue ahí — no se escanea.
    assert.equal(fs.existsSync(path.join(devProc, '5001.pipeline-dev')), true,
        'el archivo en otra fase no se toca');
    // El issue 5002 sigue ahí — sweep filtra por issue.
    assert.equal(fs.existsSync(path.join(validProc, '5002.po')), true,
        'archivos de otros issues no se tocan');
});

test('#3373 sweep: cap MAX_FILES_PER_ISSUE=3 (anti-abuso)', () => {
    clearAll();
    const procDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    fs.mkdirSync(procDir, { recursive: true });

    // Plantar 5 archivos del mismo issue con cancelado_por (escenario degenerado).
    for (const skill of ['po', 'ux', 'guru', 'tester', 'review']) {
        writeYamlSync(path.join(procDir, `6001.${skill}`), {
            issue: 6001, cancelado_por: 'fast-fail-rebote',
        });
    }
    rc.writeDependencyBlockMarker({
        issue: 6001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [6099],
    });

    // El sweep no debe reingresar más de 3 archivos por issue, evitando abuso.
    const sweepRes = rc.sweepFastFailRebotesFromProcesado({
        issue: 6001, pipeline: 'desarrollo', phase: 'validacion',
    });
    assert.ok(sweepRes.moved <= 3, `cap respetado: moved=${sweepRes.moved} <= 3`);
    assert.equal(sweepRes.capped, true, 'flag capped=true cuando se llega al límite');
});

test('#3373 sweep: idempotente — sin markers ni archivos legacy, no hace nada', () => {
    clearAll();
    const result = rc.releaseDependencyBlockToPendiente({ issue: 7001 });
    assert.equal(result.moved, 0);
    assert.deepEqual(result.files, []);
});

test('#3373 sweep: idempotente — invocación directa sin archivos coincidentes', () => {
    clearAll();
    const result = rc.sweepFastFailRebotesFromProcesado({
        issue: 7002, pipeline: 'desarrollo', phase: 'validacion',
    });
    assert.equal(result.moved, 0);
    assert.deepEqual(result.files, []);
});

test('#3373 sweep: validación de input — issue inválido devuelve no-op', () => {
    const r1 = rc.sweepFastFailRebotesFromProcesado({ issue: 'abc', pipeline: 'desarrollo', phase: 'validacion' });
    assert.equal(r1.moved, 0);
    const r2 = rc.sweepFastFailRebotesFromProcesado({ issue: -5, pipeline: 'desarrollo', phase: 'validacion' });
    assert.equal(r2.moved, 0);
    const r3 = rc.sweepFastFailRebotesFromProcesado({ issue: 1234, pipeline: '', phase: 'validacion' });
    assert.equal(r3.moved, 0);
    const r4 = rc.sweepFastFailRebotesFromProcesado({ issue: 1234, pipeline: 'desarrollo', phase: '' });
    assert.equal(r4.moved, 0);
});

test('#3373 sweep: tolera YAML corrupto en procesado/ sin romperse', () => {
    clearAll();
    const procDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    fs.mkdirSync(procDir, { recursive: true });

    // YAML válido con flag
    writeYamlSync(path.join(procDir, '8001.po'), {
        issue: 8001, cancelado_por: 'fast-fail-rebote',
    });
    // YAML corrupto del MISMO issue — el sweep debe skipear, no crashear.
    fs.writeFileSync(path.join(procDir, '8001.ux'), '!!! no es yaml válido @#$%^&*\n:::\n');

    rc.writeDependencyBlockMarker({
        issue: 8001, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [8099],
    });

    const result = rc.releaseDependencyBlockToPendiente({ issue: 8001 });

    // El sweep skipea el corrupto pero mueve el válido (.po).
    assert.equal(result.swept, 1, '.po válido se mueve, .ux corrupto se skipea');
    const pendDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente');
    assert.equal(fs.existsSync(path.join(pendDir, '8001.po')), true);
    // El corrupto sigue en procesado/ (no crasheó, no se movió).
    assert.equal(fs.existsSync(path.join(procDir, '8001.ux')), true);
});

test('#3373 reproducción del incidente #3361: destrabe completo sin intervención manual', () => {
    clearAll();
    const procDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'procesado');
    fs.mkdirSync(procDir, { recursive: true });

    // Estado pre-fix del incidente real:
    //   - 3361.guru en bloqueado-dependencias/ (movido bien por dep_block handler)
    //   - 3361.po y 3361.ux drenados a procesado/ por fast-fail-rebote → varados
    writeYamlSync(path.join(procDir, '3361.po'), {
        issue: 3361, fase: 'validacion', pipeline: 'desarrollo',
        resultado: 'aprobado', skill: 'po',
        cancelado_por: 'fast-fail-rebote',
        cancelado_ts: '2026-05-19T12:34:56.000Z',
    });
    writeYamlSync(path.join(procDir, '3361.ux'), {
        issue: 3361, fase: 'validacion', pipeline: 'desarrollo',
        resultado: 'aprobado', skill: 'ux',
        cancelado_por: 'fast-fail-rebote',
        cancelado_ts: '2026-05-19T12:34:56.000Z',
    });
    rc.writeDependencyBlockMarker({
        issue: 3361, skill: 'guru', phase: 'validacion',
        pipeline: 'desarrollo', dependsOn: [3353],
        reason: '#3353 (multi-provider) sigue abierta',
    });

    // Llega el brazoDesbloqueo: la dep cerró, intenta destrabar.
    const result = rc.releaseDependencyBlockToPendiente({ issue: 3361 });

    // Resultado esperado post-fix: 3 archivos en pendiente/ sin intervención manual.
    assert.equal(result.moved, 3, 'log [desbloqueo] reporta 3 archivo(s) movido(s)');
    assert.equal(result.swept, 2, 'log [desbloqueo-sweep] reporta 2 recuperaciones legacy');

    const pendDir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'pendiente');
    for (const skill of ['guru', 'po', 'ux']) {
        assert.equal(fs.existsSync(path.join(pendDir, `3361.${skill}`)), true,
            `3361.${skill} en pendiente/ post-destrabe`);
    }
});
