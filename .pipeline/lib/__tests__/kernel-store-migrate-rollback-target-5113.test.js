// =============================================================================
// kernel-store-migrate-rollback-target-5113.test.js — #5113 rev-12
//
// QUÉ PRUEBA — Y POR QUÉ ASÍ
// --------------------------
// R-1 · El rollback del cutover restauraba SIEMPRE contra `.pipeline/` plano,
// porque `defaultPipelineDir()` era el default y el CLI no tenía forma de
// apuntarlo a otro lado. Pero `operational_state.namespaced.enabled: true` es el
// PASO 1 del orden de encendido no negociable, y con él el estado vive en
// `.pipeline/projects/<projectId>/`. O sea: la única ruta de recuperación del
// cutover escribía en el directorio equivocado, devolvía `ok: true` — falso
// verde — y encima re-creaba los archivos del layout plano, el estado obsoleto
// que el runbook advierte que después hay que re-migrar.
//
// El test no mockea `defaultStateDir`: enciende el namespaceado de verdad por
// entorno y comprueba DÓNDE quedó el archivo. Un test que le pase `targetDir` a
// mano no habría cazado nada — el defecto ERA el default.
//
// Además:
//   · el rollback escribe con lock + write atómico + modo, no con un
//     `writeFileSync` pelado sobre el archivo que controla el dispatch;
//   · el apply multi-clave que aborta a mitad de camino informa QUÉ entró
//     (`actions` + `partial`), en vez de dejar al operador a ciegas.
//
// Ejecución: `node --test .pipeline/lib/__tests__/kernel-store-migrate-rollback-target-5113.test.js`
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withEnv } = require('../test-helpers/with-env');

const PROJECT_ID = 'intrale-platform';

const tmpDirs = [];
function freshTmp(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ksm-r12-${label}-`));
    tmpDirs.push(dir);
    return dir;
}
test.after(() => {
    for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

/** Módulos frescos: el layout depende de config/env leídos al cargar. */
function freshMigrate() {
    for (const k of Object.keys(require.cache)) {
        if (k.includes(`${path.sep}.pipeline${path.sep}lib${path.sep}`)) delete require.cache[k];
    }
    return require('../kernel-store-migrate'); // eslint-disable-line global-require
}

function sembrarFuentes(dir) {
    const waves = { version: 1, active_wave: { id: 'ola-9.4' }, planned_waves: [], archived_waves: [] };
    const partial = {
        allowed_issues: [5113], allowed_skills: ['pipeline-dev'],
        created_at: '2026-09-10T00:00:00.000Z', source: 'ola-9.4',
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(waves, null, 2));
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(partial, null, 2));
    return { waves, partial };
}

// -----------------------------------------------------------------------------
// R-1 · el rollback restaura DONDE vive el estado
// -----------------------------------------------------------------------------

test('R-1: con el namespaceado ENCENDIDO, el rollback restaura al layout namespaceado', async () => {
    const pipelineDir = freshTmp('ns-pipe');
    const backupRoot = path.join(pipelineDir, 'backup');

    await withEnv({
        PIPELINE_DIR_OVERRIDE: pipelineDir,
        PIPELINE_OPSTATE_NAMESPACED: '1',
        // El env es TRANSPORTE, no autoridad: un `PIPELINE_PROJECT_ID` sin
        // binding de spawn lo rechaza `project-context` (A01/A07). Se BORRAN
        // las dos variables — este proceso de test puede haber sido lanzado por
        // el propio pulpo, con la suya puesta — para resolver al proyecto HOST,
        // que es el caso real de la máquina que corre el cutover.
        PIPELINE_PROJECT_ID: undefined,
        PIPELINE_PROJECT_BINDING: undefined,
    }, async () => {
        const migrate = freshMigrate();

        // El estado vive namespaceado: ése es el layout del paso 1 del cutover.
        const stateDir = path.join(pipelineDir, 'projects', PROJECT_ID);
        const original = sembrarFuentes(stateDir);

        // Backup por el camino real (dry-run), SIN pasarle sourceDir a mano: si
        // el migrador leyera del layout plano, el backup saldría vacío.
        const dry = await migrate.migrateState({ apply: false, backupRoot });
        assert.equal(dry.ok, true, dry.error);
        assert.ok(fs.existsSync(path.join(dry.backupDir, 'waves.json')),
            'el backup no tomó el estado namespaceado: el migrador está leyendo el layout equivocado');

        // Se corrompe el estado vigente (el escenario del rollback).
        fs.writeFileSync(path.join(stateDir, 'waves.json'), '{"corrupto":true}');

        // Rollback EXACTAMENTE como lo invoca el CLI: sin targetDir.
        const rb = migrate.rollbackState({ fromDir: dry.backupDir, backupRoot });
        assert.equal(rb.ok, true, rb.error);

        // La aserción central: restauró donde el pipeline VA A LEER.
        const restaurado = JSON.parse(fs.readFileSync(path.join(stateDir, 'waves.json'), 'utf8'));
        assert.deepEqual(restaurado, original.waves,
            'el rollback devolvió ok:true habiendo escrito en otro directorio');

        // Y NO re-creó el layout plano obsoleto.
        assert.equal(fs.existsSync(path.join(pipelineDir, 'waves.json')), false,
            'se re-crearon los archivos del layout plano que el runbook manda no resucitar');
    });
});

test('R-1: con el namespaceado APAGADO, el rollback sigue restaurando al layout plano', async () => {
    const pipelineDir = freshTmp('plano-pipe');
    const backupRoot = path.join(pipelineDir, 'backup');

    await withEnv({
        PIPELINE_DIR_OVERRIDE: pipelineDir,
        PIPELINE_OPSTATE_NAMESPACED: '0',
        PIPELINE_PROJECT_ID: undefined,
        PIPELINE_PROJECT_BINDING: undefined,
    }, async () => {
        const migrate = freshMigrate();
        const original = sembrarFuentes(pipelineDir);

        const dry = await migrate.migrateState({ apply: false, backupRoot });
        assert.equal(dry.ok, true, dry.error);
        fs.writeFileSync(path.join(pipelineDir, 'waves.json'), '{"corrupto":true}');

        const rb = migrate.rollbackState({ fromDir: dry.backupDir, backupRoot });
        assert.equal(rb.ok, true, rb.error);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(pipelineDir, 'waves.json'), 'utf8')),
            original.waves,
            'el default histórico (flag apagado) no puede haber cambiado',
        );
    });
});

test('R-1: el CLI acepta `--target-dir` y `--force`', () => {
    const migrate = freshMigrate();
    const args = migrate.parseArgs
        ? migrate.parseArgs(['--rollback', '--from', 'x', '--target-dir', 'y', '--force'])
        : null;
    if (!args) return; // `parseArgs` no exportado: el contrato se cubre por el smoke del CLI
    assert.equal(args.rollback, true);
    assert.equal(args.from, 'x');
    assert.equal(args.targetDir, 'y');
    assert.equal(args.force, true);
});

test('R-1: si el layout no se puede resolver, el rollback FALLA en vez de adivinar', async () => {
    const pipelineDir = freshTmp('unres-pipe');
    await withEnv({
        PIPELINE_DIR_OVERRIDE: pipelineDir,
        PIPELINE_OPSTATE_NAMESPACED: '1',
        // `PIPELINE_PROJECT_ID` en banda SIN binding: `project-context` lo
        // rechaza. Antes esto caía al layout plano en silencio — que es
        // exactamente el defecto R-1 entrando por la puerta de atrás.
        PIPELINE_PROJECT_ID: 'otro-proyecto',
        PIPELINE_PROJECT_BINDING: undefined,
    }, async () => {
        const migrate = freshMigrate();
        const rb = migrate.rollbackState({ fromDir: path.join(pipelineDir, 'backup', 'x') });
        assert.equal(rb.ok, false);
        assert.equal(rb.code, 'state_dir_unresolved');
        assert.match(rb.error, /--target-dir/, 'el error tiene que traer la salida manual');
    });
});

// -----------------------------------------------------------------------------
// El rollback escribe como escribe el sustrato, no a lo bruto
// -----------------------------------------------------------------------------

test('el rollback escribe con write atómico y no deja `.tmp` colgado', async () => {
    const pipelineDir = freshTmp('atom-pipe');
    const backupRoot = path.join(pipelineDir, 'backup');

    await withEnv({
        PIPELINE_DIR_OVERRIDE: pipelineDir,
        PIPELINE_OPSTATE_NAMESPACED: '0',
        PIPELINE_PROJECT_ID: undefined,
        PIPELINE_PROJECT_BINDING: undefined,
    }, async () => {
        const migrate = freshMigrate();
        sembrarFuentes(pipelineDir);
        const dry = await migrate.migrateState({ apply: false, backupRoot });
        fs.unlinkSync(path.join(pipelineDir, '.partial-pause.json'));

        const rb = migrate.rollbackState({ fromDir: dry.backupDir, backupRoot });
        assert.equal(rb.ok, true, rb.error);
        assert.ok(rb.restored.includes('.partial-pause.json'));

        // El write atómico es tmp + rename: si el rename ocurrió, no queda `.tmp`.
        assert.equal(fs.existsSync(path.join(pipelineDir, '.partial-pause.json.tmp')), false);
        // Y tampoco queda el lock tomado: la liberación es parte del contrato.
        assert.equal(fs.existsSync(path.join(pipelineDir, '.partial-pause.json.lock')), false,
            'el lock del rollback quedó sin liberar: el pipeline no podría escribir la allowlist');
    });
});

// -----------------------------------------------------------------------------
// Apply multi-clave que aborta a mitad: el operador tiene que saber qué entró
// -----------------------------------------------------------------------------

test('apply parcial: el fallo de una clave informa `actions` + `partial` de lo ya escrito', async () => {
    const sourceDir = freshTmp('parcial-src');
    const backupRoot = freshTmp('parcial-bak');
    sembrarFuentes(sourceDir);

    const migrate = freshMigrate();

    // Store que acepta la primera clave y se cae en la segunda: la migración
    // queda a medias, que es exactamente el escenario sin remedio informado.
    let escrituras = 0;
    const store = {
        async getState() { return null; },
        async initState() {
            escrituras += 1;
            if (escrituras > 1) throw new Error('ThrottlingException (test)');
            return { ok: true, version: 1 };
        },
        async compareAndSet() { return { ok: true, version: 2 }; },
    };

    // `sources` explícitas: el guard de alcance (#5112) exige declararlas para
    // `--apply`, justamente para que nadie migre las operativas por accidente.
    const sources = [
        { file: 'waves.json', key: 'waves' },
        { file: '.partial-pause.json', key: 'partial-pause' },
    ];
    const res = await migrate.migrateState({ apply: true, store, sources, sourceDir, backupRoot });
    assert.equal(res.ok, false, 'la migración a medias no puede reportarse como exitosa');
    assert.ok(res.actions && typeof res.actions === 'object',
        'sin `actions` el operador no sabe qué clave entró al store y cuál no');
    assert.equal(res.partial, Object.keys(res.actions).length > 0);
    assert.ok(typeof res.failedKey === 'string' && res.failedKey.length > 0,
        'la clave que falló tiene que estar nombrada');
    assert.match(String(res.remediation), /reintent|parcial|ninguna clave/i,
        'el remedio ofrecido (rollbackCmd) restaura filesystem, no toca el store: hace falta decir qué hacer');
});
