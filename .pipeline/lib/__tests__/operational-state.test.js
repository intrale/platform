// =============================================================================
// operational-state.test.js — Tests de la fachada de estado operativo (#5108).
//
// Cobertura por criterio de aceptación:
//   CA-1  superficie única de lectura/escritura de olas + allowlist
//   CA-2  ningún consumidor conoce la ruta física
//   CA-3  escrituras atómicas (sin .tmp/.lock residual, JSON siempre válido)
//   CA-4  lecturas fail-closed con el campo inválido en el error
//   CA-5  los tres modos de dispatch se preservan (paused/partial_pause/running)
//   CA-6  escape hatch #5060 como ÚNICA vía de dispatch sin ola (test de contrato
//         que falla si la fachada reintroduce el fail-open del incidente)
//   CA-7  gate #3625: authorizedBy + justification obligatorios y propagados
//
// Más el guarda anti-ciclo (grep estático sobre los módulos base).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/operational-state.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');

let opState; // se re-requiere con PIPELINE_DIR_OVERRIDE seteado

const MODULE_PATHS = ['../operational-state', '../waves', '../partial-pause', '../partial-pause-audit'];

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-test-'));
    // #5172 — el sandbox ES el pipelineDir: sin `config.yaml` la lectura de
    // config ahora falla cerrado (`ConfigParseViolation`) en vez de degradar en
    // silencio. Se siembra el documento MÍNIMO para conservar los mismos
    // valores efectivos (sección ausente ⇒ default seguro del consumidor).
    seedPipelineConfig(dir);
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Reset del module cache: los módulos base resuelven el pipelineDir en cada
    // llamada, pero la caché in-memory de waves vive en el módulo.
    for (const m of MODULE_PATHS) delete require.cache[require.resolve(m)];
    opState = require('../operational-state');
    opState._internal.invalidateCache();
    return dir;
}

function teardownTmp(dir) {
    if (opState) opState._internal.invalidateCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    delete process.env.PARTIAL_PAUSE_STRICT_AUTH;
}

// Estado base válido. Se escribe SIN integrity_hash a propósito: es el caso
// legacy pre-#4370, que `loadStateStrict` tolera (`missing`, no `mismatch`).
function sampleState(overrides = {}) {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by: 'test',
            source: 'manual',
            note: 'fixture',
            next_wave_number: 3,
        },
        active_wave: {
            number: 1,
            name: 'Ola 9.4 — Estado operativo',
            goal: 'Envoltorio único',
            started_at: '2026-07-01T00:00:00.000Z',
            issues: [
                { number: 5108, status: 'in_progress' },
                { number: 5109, status: 'pending' },
                { number: 5107, status: 'completed' },
            ],
        },
        planned_waves: [
            { number: 2, name: 'Ola 9.5', started_at: null, issues: [{ number: 6001, status: 'pending' }] },
        ],
        archived_waves: [],
        dependencies: [{ blocker: 5108, blocked: 5109 }],
        ...overrides,
    };
}

function writeState(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

function readAuditEntries(dir) {
    const file = path.join(dir, 'audit', 'partial-pause-mutations.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

const AUTH = { authorizedBy: 'commander:leo', justification: 'test de la fachada #5108' };

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — superficie única, sin rutas físicas
// -----------------------------------------------------------------------------

test('CA-2: lectura de ola activa y planeadas no requiere conocer el path del archivo', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());

        const active = opState.getActiveWave();
        assert.equal(active.number, 1);
        assert.equal(active.name, 'Ola 9.4 — Estado operativo');

        const planned = opState.getPlannedWave(2);
        assert.equal(planned.name, 'Ola 9.5');

        const all = opState.listWaves();
        assert.deepEqual(all.map((w) => w.status), ['active', 'planned']);

        const horizon = opState.getHorizon(1);
        assert.equal(horizon.length, 2);
        assert.equal(horizon[0].status, 'active');

        assert.deepEqual(opState.getBlockingIssues(5109), [5108]);
        assert.equal(opState.getVersion(), '2026-07-01T00:00:00.000Z');
    } finally { teardownTmp(dir); }
});

test('CA-2: la superficie pública no expone ninguna ruta física fuera de _internal', () => {
    const dir = setupTmp();
    try {
        for (const [key, value] of Object.entries(opState)) {
            if (key === '_internal') continue;
            assert.notEqual(key, '_paths', 'la fachada no debe re-exportar _paths');
            assert.ok(
                typeof value === 'function' || typeof value === 'object',
                `export inesperado: ${key}`,
            );
        }
        // Los paths sólo se alcanzan por el canal explícito de tests.
        const paths = opState._internal.paths();
        assert.ok(paths.WAVES_FILE.startsWith(dir));
        assert.ok(paths.PARTIAL_FILE.startsWith(dir));
    } finally { teardownTmp(dir); }
});

test('CA-1: los mutadores de olas escriben y se leen de vuelta por la misma fachada', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());

        opState.addIssueToWave(2, { number: 6002, status: 'pending' }, { updated_by: 'test' });
        assert.deepEqual(
            opState.getPlannedWave(2).issues.map((i) => i.number),
            [6001, 6002],
        );

        opState.removeIssueFromWave(2, 6001, { updated_by: 'test' });
        assert.deepEqual(opState.getPlannedWave(2).issues.map((i) => i.number), [6002]);

        const res = opState.markIssuesCompletedInActiveWave([5108], { updated_by: 'test' });
        assert.deepEqual(res.completed, [5108]);
        assert.equal(
            opState.getActiveWave().issues.find((i) => i.number === 5108).status,
            'completed',
        );

        opState.addDependency(6002, [6003], { source: 'test' });
        assert.ok(opState.getVersion() !== '2026-07-01T00:00:00.000Z', 'la versión avanzó');
    } finally { teardownTmp(dir); }
});

test('CA-1: el ciclo de vida completo de una ola se opera por la fachada', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());

        // Crear → editar → reordenar → borrar, todo sin tocar waves.js directo.
        const creada = opState.createPlannedWave(
            { name: 'Ola 9.6', issues: [8001, 8002], concurrency_max: 3, window_minutes: 60 },
            { updated_by: 'test', source: 'manual' },
        );
        assert.ok(creada.waveNumber > 0);

        opState.editWave(creada.waveNumber, { name: 'Ola 9.6 (rev)' }, { updated_by: 'test' });
        assert.equal(opState.getPlannedWave(creada.waveNumber).name, 'Ola 9.6 (rev)');

        // versionToken sobre un snapshot ya leído es coherente con getVersion().
        const snapshot = opState._internal.readWaveStateStrict();
        assert.equal(opState.versionToken(snapshot), opState.getVersion());

        opState.reorderPlannedWaves([creada.waveNumber, 2], { updated_by: 'test' });
        assert.deepEqual(
            opState.listWaves().filter((w) => w.status === 'planned').map((w) => w.number),
            [creada.waveNumber, 2],
        );

        const borrada = opState.deletePlannedWave(creada.waveNumber, { updated_by: 'test' });
        assert.equal(borrada.waveNumber, creada.waveNumber);
        assert.equal(opState.getPlannedWave(creada.waveNumber), null);
    } finally { teardownTmp(dir); }
});

test('CA-1: promoteWave y archiveWave se operan por la fachada', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());

        // Promoción transaccional (default): la planificada 2 pasa a activa y la
        // 1 se archiva. Coordina registro de olas + allowlist efectiva.
        const res = opState.promoteWave(2, {
            updated_by: 'test',
            source: 'manual',
            authorizedBy: 'wave-promote',
        });
        assert.equal(res.newWaveNumber, 2);
        assert.equal(res.oldWaveNumber, 1);
        assert.equal(opState.getActiveWave().number, 2);
        assert.equal(opState.getPlannedWave(2), null, 'ya no está en planificadas');

        // Archivado explícito de la ola activa.
        const arch = opState.archiveWave(2, { force: true, updated_by: 'test' });
        assert.equal(arch.archived, true);
        assert.equal(opState.getActiveWave(), null);
        assert.ok(
            opState.listWaves().some((w) => w.number === 2 && w.status === 'archived'),
            'la ola quedó en archivadas',
        );
    } finally { teardownTmp(dir); }
});

test('promoteWave con { atomic: false } usa la variante que sólo toca el registro', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());
        opState.promoteWave(2, { atomic: false, updated_by: 'test' });
        assert.equal(opState.getActiveWave().number, 2);
        assert.equal(
            opState.getDispatchState().mode,
            'running',
            'la variante no transaccional no escribe la allowlist efectiva',
        );
    } finally { teardownTmp(dir); }
});

test('readFullPauseOrigin distingue halt manual de halt automático (fail-closed)', () => {
    const dir = setupTmp();
    try {
        opState.setFullPause({ ...AUTH, source: 'test' });
        const origin = opState.readFullPauseOrigin();
        assert.notEqual(
            origin.source,
            'config-corruption-halt',
            'un halt puesto por el operador jamás debe reportarse como auto-recuperable',
        );
    } finally { teardownTmp(dir); }
});

test('CA-4: un fallo de lectura del archivo falla cerrado, no devuelve dato parcial', () => {
    const dir = setupTmp();
    try {
        // Un directorio donde se espera el archivo: el read falla con EISDIR.
        fs.mkdirSync(path.join(dir, 'waves.json'));
        assert.throws(
            () => opState.getActiveWave(),
            (err) => {
                assert.ok(err instanceof opState.OperationalStateError, 'error tipado');
                assert.equal(err.code, 'EWAVES_READ');
                assert.equal(err.stage, 'read:waves');
                return true;
            },
        );
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// CA-3 — atomicidad
// -----------------------------------------------------------------------------

test('CA-3: escritura mediante la fachada no deja .tmp ni .lock residual y el JSON queda válido', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());
        const wavesFile = path.join(dir, 'waves.json');

        for (let i = 0; i < 5; i++) {
            opState.addIssueToWave(2, { number: 7000 + i, status: 'pending' }, { updated_by: 'test' });
        }

        assert.equal(fs.existsSync(`${wavesFile}.tmp`), false, 'tmp residual');
        assert.equal(fs.existsSync(`${wavesFile}.lock`), false, 'lock residual');

        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(fs.readFileSync(wavesFile, 'utf8')); });
        assert.equal(parsed.planned_waves[0].issues.length, 6);
    } finally { teardownTmp(dir); }
});

test('CA-3: mutar la allowlist efectiva no deja artefactos residuales', () => {
    const dir = setupTmp();
    try {
        const marker = opState._internal.paths().PARTIAL_FILE;
        opState.setAllowlist([5108, 5109], { ...AUTH, source: 'test' });

        assert.equal(fs.existsSync(`${marker}.tmp`), false, 'tmp residual');
        assert.equal(fs.existsSync(`${marker}.lock`), false, 'lock residual');
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(marker, 'utf8')));
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// CA-4 — fail-closed
// -----------------------------------------------------------------------------

test('CA-4: estado con shape inválido falla cerrado indicando el campo inválido', () => {
    const dir = setupTmp();
    try {
        const bad = sampleState();
        bad.active_wave.issues[0].number = 'no-soy-un-numero';
        writeState(dir, bad);

        assert.throws(
            () => opState.getActiveWave(),
            (err) => {
                assert.ok(err instanceof opState.OperationalStateValidationError, 'error tipado');
                assert.equal(err.code, 'EWAVES_SCHEMA');
                assert.equal(err.stage, 'read:waves');
                assert.ok(
                    err.field && err.field.includes('issues[0].number'),
                    `field debe nombrar el campo inválido, fue: ${err.field}`,
                );
                assert.ok(err.errors.length > 0, 'conserva el detalle de validación');
                return true;
            },
        );
    } finally { teardownTmp(dir); }
});

test('CA-4: JSON corrupto falla cerrado y ningún consumidor recibe datos parciales', () => {
    const dir = setupTmp();
    try {
        fs.writeFileSync(path.join(dir, 'waves.json'), '{ "version": "1.0", esto no es json');

        for (const fn of ['getActiveWave', 'listWaves', 'getHorizon', 'getVersion']) {
            assert.throws(
                () => opState[fn](),
                (err) => {
                    assert.ok(err instanceof opState.OperationalStateValidationError, `${fn}: error tipado`);
                    assert.equal(err.code, 'EWAVES_JSON');
                    return true;
                },
                `${fn} debe fallar cerrado, no devolver un resultado parcial`,
            );
        }
    } finally { teardownTmp(dir); }
});

test('CA-4: OperationalStateValidationError extiende OperationalStateError', () => {
    const dir = setupTmp();
    try {
        const err = new opState.OperationalStateValidationError('x', { stage: 's', field: 'f' });
        assert.ok(err instanceof opState.OperationalStateError);
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'OperationalStateValidationError');
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// CA-5 / CA-6 — semántica de dispatch y contrato #5060
// -----------------------------------------------------------------------------

test('CA-5: los tres modos de dispatch se preservan tal como están en main', () => {
    const dir = setupTmp();
    try {
        // running — sin ningún marker de control.
        assert.equal(opState.getDispatchState().mode, 'running');

        // partial_pause — con allowlist.
        opState.setAllowlist([5108], { ...AUTH, source: 'test' });
        const partial = opState.getDispatchState();
        assert.equal(partial.mode, 'partial_pause');
        assert.deepEqual(partial.allowedIssues, [5108]);
        assert.equal(opState.isIssueAllowed(5108), true, 'issue en allowlist → permitido');
        assert.equal(opState.isIssueAllowed(9999), false, 'issue fuera de allowlist → denegado');

        // paused — gana sobre partial_pause (más restrictivo).
        opState.setFullPause({ ...AUTH, source: 'test' });
        assert.equal(opState.getDispatchState().mode, 'paused');
        assert.equal(opState.isIssueAllowed(5108), false, 'halt total deniega incluso lo allowlisteado');

        opState.clearFullPause({ ...AUTH, source: 'test' });
        assert.equal(opState.getDispatchState().mode, 'partial_pause', 'clearFullPause no toca la allowlist');
    } finally { teardownTmp(dir); }
});

test('CONTRATO #5060: sin allowlist el dispatch DENIEGA (fail-closed, no fail-open)', () => {
    const dir = setupTmp();
    try {
        delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;

        // Estado exacto del incidente: fin de ola → allowlist vaciada → sin marker.
        opState.setAllowlist([5108], { ...AUTH, source: 'test' });
        opState.clearAllowlist({ ...AUTH, source: 'test' });

        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(opState.unscopedDispatchEnabled(), false);

        // Si esta aserción cae, la fachada reintrodujo el fail-open del incidente
        // #5060 (dispatch de ~320 agentes sobre el backlog histórico).
        for (const issue of [5108, 1, 99999]) {
            assert.equal(
                opState.isIssueAllowed(issue),
                false,
                `REGRESIÓN #5060: sin allowlist el issue ${issue} NO debe poder dispatchearse`,
            );
        }
    } finally { teardownTmp(dir); }
});

test('CONTRATO #5060: el escape hatch explícito es la ÚNICA vía de dispatch sin ola', () => {
    const dir = setupTmp();
    try {
        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(opState.isIssueAllowed(5108), false, 'default: denegado');

        process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = '1';
        assert.equal(opState.unscopedDispatchEnabled(), true);
        assert.equal(opState.isIssueAllowed(5108), true, 'con escape hatch: permitido');

        // Cualquier otro valor NO abre el gate.
        process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = 'true';
        assert.equal(opState.unscopedDispatchEnabled(), false);
        assert.equal(opState.isIssueAllowed(5108), false);
    } finally { teardownTmp(dir); }
});

test('CA-5: los skills del control-plane NO heredan el fail-closed de issues', () => {
    const dir = setupTmp();
    try {
        // running → los skills siguen habilitados (si no, el pipeline se queda
        // sin diagnóstico justo entre olas).
        assert.equal(opState.isSkillAllowed('multi-provider-smoke-test'), true);

        opState.setAllowlist([5108], { ...AUTH, allowedSkills: ['smoke'], source: 'test' });
        const state = opState.getDispatchState();
        assert.equal(opState.isSkillAllowedInState('smoke', state), true);
        assert.equal(opState.isSkillAllowedInState('otro', state), false);

        opState.setFullPause({ ...AUTH, source: 'test' });
        assert.equal(opState.isSkillAllowed('smoke'), false, 'halt total deniega también skills');
    } finally { teardownTmp(dir); }
});

test('CA-5: isIssueAllowedInState es coherente con isIssueAllowed sobre el mismo estado', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108, 5109], { ...AUTH, source: 'test' });
        const state = opState.getDispatchState();
        for (const issue of [5108, 5109, 7777]) {
            assert.equal(opState.isIssueAllowedInState(issue, state), opState.isIssueAllowed(issue));
        }
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// CA-7 — gate de autorización #3625
// -----------------------------------------------------------------------------

test('CA-7: mutar la allowlist sin authorizedBy tira, incluso en grace mode', () => {
    const dir = setupTmp();
    try {
        // Grace mode explícito: el gate de partial-pause dejaría pasar con warning.
        delete process.env.PARTIAL_PAUSE_STRICT_AUTH;

        const mutadores = [
            ['setAllowlist', () => opState.setAllowlist([1], { justification: 'x' })],
            ['setAllowlistAtomic', () => opState.setAllowlistAtomic([1], { justification: 'x' })],
            ['addToAllowlist', () => opState.addToAllowlist([1], { justification: 'x' })],
            ['removeFromAllowlist', () => opState.removeFromAllowlist([1], { justification: 'x' })],
            ['clearAllowlist', () => opState.clearAllowlist({ justification: 'x' })],
            ['resumeAll', () => opState.resumeAll({ justification: 'x' })],
            ['setFullPause', () => opState.setFullPause({ justification: 'x' })],
            ['clearFullPause', () => opState.clearFullPause({ justification: 'x' })],
        ];

        for (const [name, fn] of mutadores) {
            assert.throws(fn, (err) => {
                assert.ok(err instanceof opState.OperationalStateError, `${name}: error tipado`);
                assert.equal(err.code, 'EOPSTATE_UNAUTHORIZED');
                assert.match(err.message, /authorizedBy/);
                return true;
            }, `${name} sin authorizedBy debe tirar`);
        }

        // Y no escribió nada: el estado sigue en running.
        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(fs.existsSync(opState._internal.paths().PARTIAL_FILE), false);
    } finally { teardownTmp(dir); }
});

test('CA-7: mutar la allowlist sin justification tira', () => {
    const dir = setupTmp();
    try {
        assert.throws(
            () => opState.setAllowlist([1], { authorizedBy: 'commander:leo' }),
            (err) => {
                assert.equal(err.code, 'EOPSTATE_UNAUTHORIZED');
                assert.match(err.message, /justification/);
                return true;
            },
        );
        // Vacíos y blancos tampoco cuentan.
        assert.throws(() => opState.setAllowlist([1], { authorizedBy: '  ', justification: 'x' }));
        assert.throws(() => opState.setAllowlist([1], { authorizedBy: 'commander:leo', justification: '   ' }));
    } finally { teardownTmp(dir); }
});

test('CA-7: authorizedBy se propaga tal cual al audit — la fachada no lo reescribe', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108, 5109], {
            authorizedBy: 'dashboard:roadmap:allowlist',
            justification: 'alcance de la ola 9.4',
            source: 'dashboard:roadmap:allowlist',
        });

        const entries = readAuditEntries(dir);
        assert.ok(entries.length >= 1, 'se escribió al menos una entry de audit');
        const last = entries[entries.length - 1];
        assert.equal(
            last.authorized_by,
            'dashboard:roadmap:allowlist',
            'la identidad del caller llega intacta (no colapsada en una identidad genérica de la fachada)',
        );
        assert.match(String(last.justification), /alcance de la ola 9\.4/);
    } finally { teardownTmp(dir); }
});

test('CA-7: con strict auth activo, un authorizedBy fuera del enum no aplica removals', () => {
    const dir = setupTmp();
    try {
        process.env.PARTIAL_PAUSE_STRICT_AUTH = '1';
        opState.setAllowlist([5108, 5109], { ...AUTH, source: 'test' });

        const res = opState.setAllowlist([5108], {
            authorizedBy: 'inventado:no-existe',
            justification: 'intento de bypass',
            source: 'test',
        });

        assert.equal(res.ok, false, 'el gate rechaza el removal');
        assert.equal(res.rejected, true);
        assert.deepEqual(
            opState.getDispatchState().allowedIssues,
            [5108, 5109],
            'el estado NO cambió',
        );
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// Add / remove incrementales
// -----------------------------------------------------------------------------

test('addToAllowlist preserva los issues ya habilitados (read-modify-write)', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108], { ...AUTH, source: 'test' });
        opState.addToAllowlist([5109, 5110], { ...AUTH, source: 'test' });
        assert.deepEqual(opState.getDispatchState().allowedIssues, [5108, 5109, 5110]);

        // Idempotente.
        opState.addToAllowlist([5109], { ...AUTH, source: 'test' });
        assert.deepEqual(opState.getDispatchState().allowedIssues, [5108, 5109, 5110]);
    } finally { teardownTmp(dir); }
});

test('removeFromAllowlist deja el resto intacto', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108, 5109, 5110], { ...AUTH, source: 'test' });
        opState.removeFromAllowlist([5109], { ...AUTH, source: 'test' });
        assert.deepEqual(opState.getDispatchState().allowedIssues, [5108, 5110]);
        assert.equal(opState.isIssueAllowed(5109), false);
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// Regresión del rebote rev-1 (security) — el RMW de los mutadores incrementales
// debe preservar el marker COMPLETO, no sólo el eje `allowed_issues`.
//
// El bug: `readPreviousAllowlist()` devuelve sólo `allowed_issues` y
// `setPartialPause()` reescribe el marker desde cero, así que un `add`/`remove`
// borraba `allowed_skills` (gate #3680), `dep_sources`/`accepted_dep_risk`
// (#2893), la metadata de ola (#4030) y dejaba `source` en "unknown" (#3625).
// No era sólo pérdida de metadata: al caer el marker el modo va a `running`,
// donde el gate de skills deja pasar TODOS los skills (delivery incluido).
// -----------------------------------------------------------------------------

function readMarker() {
    return JSON.parse(fs.readFileSync(opState._internal.paths().PARTIAL_FILE, 'utf8'));
}

test('addToAllowlist preserva allowed_skills, dep_sources, accepted_dep_risk, metadata de ola y source', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([100, 200], {
            ...AUTH,
            source: 'wave-promote',
            allowedSkills: ['qa', 'multi-provider-smoke-test'],
            acceptedDepRisk: true,
            depSources: { 100: 'recursive-deps:from-99' },
            waveNumber: 9,
            waveName: 'Ola 9.4',
        });
        assert.equal(opState.isSkillAllowed('qa'), true, 'precondición: la ventana de skills está activa');

        opState.addToAllowlist([300], { ...AUTH });

        const marker = readMarker();
        assert.deepEqual(marker.allowed_issues, [100, 200, 300], 'el eje issues se mergea');
        assert.deepEqual(
            marker.allowed_skills,
            ['multi-provider-smoke-test', 'qa'],
            'el gate de skills #3680 sobrevive al add (era el ensanchamiento de autorización)',
        );
        assert.equal(marker.accepted_dep_risk, true, '#2893: accepted_dep_risk sobrevive');
        assert.deepEqual(marker.dep_sources, { 100: 'recursive-deps:from-99' }, '#2893: dep_sources sobrevive');
        assert.equal(marker.wave_number, 9, '#4030: metadata de ola sobrevive');
        assert.equal(marker.wave_name, 'Ola 9.4');
        assert.equal(marker.source, 'wave-promote', '#3625: la procedencia no se degrada a "unknown"');

        const state = opState.getDispatchState();
        assert.equal(opState.isSkillAllowedInState('qa', state), true, 'el skill sigue permitido…');
        assert.equal(opState.isSkillAllowedInState('delivery', state), false, '…y el no listado sigue denegado');
    } finally { teardownTmp(dir); }
});

test('addToAllowlist con halt total activo tampoco borra la ventana de skills del marker', () => {
    const dir = setupTmp();
    try {
        // Con `.paused` presente, `getPipelineMode()` devuelve el estado `paused`
        // con listas vacías: usarlo como fuente del RMW borraría los skills. El
        // RMW lee el marker crudo justamente para no caer en eso.
        opState.setAllowlist([100], { ...AUTH, source: 'wave-promote', allowedSkills: ['qa'] });
        opState.setFullPause({ ...AUTH, source: 'test' });
        assert.equal(opState.getDispatchState().mode, 'paused');

        opState.addToAllowlist([200], { ...AUTH });

        const marker = readMarker();
        assert.deepEqual(marker.allowed_issues, [100, 200]);
        assert.deepEqual(marker.allowed_skills, ['qa'], 'el marker de allowlist queda intacto bajo halt total');
        assert.equal(marker.source, 'wave-promote');
    } finally { teardownTmp(dir); }
});

test('removeFromAllowlist hasta vaciar NO ensancha el gate de skills', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([100], { ...AUTH, source: 'wave-promote', allowedSkills: ['qa'] });
        assert.equal(opState.isSkillAllowed('delivery'), false, 'precondición: delivery denegado');

        const res = opState.removeFromAllowlist([100], { ...AUTH });
        assert.equal(res.ok, true);

        const state = opState.getDispatchState();
        assert.equal(state.mode, 'partial_pause', 'no degrada a running: la ventana de skills se conserva');
        assert.deepEqual(state.allowedIssues, [], 'el issue removido efectivamente salió');
        assert.equal(opState.isIssueAllowed(100), false, 'eje issues fail-closed (#5060 intacto)');
        assert.equal(opState.isIssueAllowed(999), false);
        assert.equal(opState.isSkillAllowed('qa'), true, 'el skill autorizado sigue autorizado');
        assert.equal(
            opState.isSkillAllowed('delivery'),
            false,
            'delivery (el que mergea a main) NO puede pasar de denegado a permitido por un remove',
        );
    } finally { teardownTmp(dir); }
});

test('removeFromAllowlist que vaciaría la allowlist sin skills se rechaza: borrar el gate es explícito', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108, 5110], { ...AUTH, source: 'test' });

        const res = opState.removeFromAllowlist([5108, 5110], { ...AUTH });
        assert.equal(res.ok, false, 'no se aplica');
        assert.equal(res.rejected, true);
        assert.equal(res.reason, 'would-clear-allowlist');
        assert.match(res.msg, /clearAllowlist/, 'el mensaje dice cómo pedir el clear deliberado');

        assert.equal(fs.existsSync(opState._internal.paths().PARTIAL_FILE), true, 'el marker sigue ahí');
        assert.deepEqual(opState.getDispatchState().allowedIssues, [5108, 5110], 'el estado no se movió');

        // La vía deliberada sí lo hace: `clearAllowlist()` audita como `clear`.
        opState.clearAllowlist({ ...AUTH, source: 'test' });
        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(opState.isIssueAllowed(5108), false, 'sin allowlist sigue siendo fail-closed (#5060)');
    } finally { teardownTmp(dir); }
});

test('removeFromAllowlist con allowClear:true sí vacía (opt-in explícito del caller)', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([5108], { ...AUTH, source: 'test' });
        const res = opState.removeFromAllowlist([5108], { ...AUTH, source: 'test', allowClear: true });
        assert.equal(res.ok, true);
        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(fs.existsSync(opState._internal.paths().PARTIAL_FILE), false, 'el marker se borró');
    } finally { teardownTmp(dir); }
});

test('lo que el caller declara pisa lo preservado; lo que no declara se conserva', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([100], {
            ...AUTH,
            source: 'wave-promote',
            allowedSkills: ['qa'],
            acceptedDepRisk: true,
        });

        // Declara skills y source → los pisa. No declara acceptedDepRisk → lo conserva.
        opState.addToAllowlist([200], { ...AUTH, source: 'telegram', allowedSkills: ['delivery'] });

        const marker = readMarker();
        assert.deepEqual(marker.allowed_skills, ['delivery'], 'el caller reemplaza la ventana que declara');
        assert.equal(marker.source, 'telegram', 'y la procedencia que declara');
        assert.equal(marker.accepted_dep_risk, true, 'lo no declarado se preserva');
        assert.equal(opState.isSkillAllowed('qa'), false);
        assert.equal(opState.isSkillAllowed('delivery'), true);
    } finally { teardownTmp(dir); }
});

test('addToAllowlist sin issues válidos es no-op: un add nunca borra el marker', () => {
    const dir = setupTmp();
    try {
        const res = opState.addToAllowlist([], { ...AUTH, source: 'test' });
        assert.equal(res.ok, true);
        assert.equal(res.noop, true);
        assert.equal(fs.existsSync(opState._internal.paths().PARTIAL_FILE), false);
        assert.equal(opState.getDispatchState().mode, 'running');
    } finally { teardownTmp(dir); }
});

test('setAllowlist es REEMPLAZO declarado, no merge (contraste con los incrementales)', () => {
    const dir = setupTmp();
    try {
        opState.setAllowlist([100], { ...AUTH, source: 'wave-promote', allowedSkills: ['qa'] });
        // Semántica deliberada de setter: lo que no se declara, no se conserva.
        opState.setAllowlist([200], { ...AUTH, source: 'telegram' });

        const marker = readMarker();
        assert.deepEqual(marker.allowed_issues, [200]);
        assert.equal(marker.allowed_skills, undefined, 'el setter reemplaza el marker completo');
        assert.equal(marker.source, 'telegram');
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// Separación de conceptos
// -----------------------------------------------------------------------------

test('alcance de ola derivado y allowlist efectiva son superficies distintas', () => {
    const dir = setupTmp();
    try {
        writeState(dir, sampleState());

        // Alcance de ola: derivado del registro, filtra completados.
        assert.deepEqual(opState.getWaveScopeIssues(), [5108, 5109], 'excluye el completed 5107');

        // Allowlist efectiva: vacía todavía → dispatch denegado pese al alcance.
        assert.equal(opState.getDispatchState().mode, 'running');
        assert.equal(
            opState.isIssueAllowed(5108),
            false,
            'estar en alcance de la ola NO habilita el dispatch por sí solo',
        );

        // Recién al escribir la allowlist efectiva se habilita.
        opState.setAllowlist([5108], { ...AUTH, source: 'test' });
        assert.equal(opState.isIssueAllowed(5108), true);
        assert.equal(opState.isIssueAllowed(5109), false, 'está en alcance pero no en la allowlist efectiva');

        // Y el alcance de ola no se movió: no es escribible desde la allowlist.
        assert.deepEqual(opState.getWaveScopeIssues(), [5108, 5109]);
    } finally { teardownTmp(dir); }
});

test('la fachada no expone save(snapshot): rompería el read-modify-write bajo lock', () => {
    const dir = setupTmp();
    try {
        assert.equal(opState.save, undefined, 'save(snapshot) permitiría lost updates');
        assert.equal(opState.loadWaves, undefined, 'la lectura cruda no es parte del contrato');
        assert.equal(opState.getAllowlist, undefined, 'alias ambiguo: usar getWaveScopeIssues o getDispatchState');
    } finally { teardownTmp(dir); }
});

// -----------------------------------------------------------------------------
// Guarda anti-ciclo
// -----------------------------------------------------------------------------

test('ningún módulo base requiere operational-state (guarda anti-ciclo)', () => {
    const base = ['waves.js', 'partial-pause.js', 'partial-pause-audit.js', 'file-lock.js'];
    for (const file of base) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.equal(
            /require\(\s*['"]\.\/operational-state['"]\s*\)/.test(src),
            false,
            `${file} no debe requerir operational-state: la fachada compone HACIA ABAJO. ` +
            'Invertir la dirección crea un ciclo de carga.',
        );
    }
});
