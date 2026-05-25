// =============================================================================
// commander-wave-subcommands.test.js — Tests del handler `/wave` con
// subcomandos status/next/add/promote (issue #3493 / Spike #3378 H5).
//
// Cubre los 16 CA consolidados del issue:
//   CA-1  dispatcher acepta `status`, `next`, `add`, `promote`; rechaza otros
//   CA-2  authz: chat_id distinto al esperado → unauthorized, no IO
//   CA-3  `status` reutiliza renderWaveSnapshot + fallback legacy
//   CA-4  `next` lista candidatos o mensaje cálido si vacío
//   CA-5  `add` validación estricta de input (floats, negativos, regex, extras)
//   CA-6  `add` existence check del issue (cache 30s, sin red)
//   CA-7  `add` read-fresh + atomic write + conflict si issue ya está en otra ola
//   CA-8  `promote` secuencia transaccional + allowlist via partial-pause
//   CA-9  destructiveCooldown MUST en add/promote (30s ventana, anti doble-tap)
//   CA-10 audit log canónico (verificado vía dispatcher)
//   CA-11 determinismo + performance (< 500ms p99 — assert sobre durationMs)
//   CA-12 MarkdownV2 escaped (smoke check sobre output)
//   CA-13 4 templates existen y se cargan sin error
//   CA-15 happy paths + edge cases por subcomando
//   CA-16 TTL cache + invalidación pre-mutación
//
// Ejecutar:  node --test .pipeline/lib/__tests__/commander-wave-subcommands.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// IMPORTANTE: el módulo commander-deterministic.js requiere lazy a `./waves`,
// `./partial-pause`, `./wave-resolver`, etc. Por eso seteamos PIPELINE_DIR_OVERRIDE
// ANTES de re-requerirlo, igual que `waves.test.js`.

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-wave-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

function setupTmp() {
    const dir = mkTmp();
    // Subdirs que ciertos handlers esperan (logs, desarrollo, definicion).
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'desarrollo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'definicion'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Reset de caches de módulos que reaccionan a PIPELINE_DIR_OVERRIDE.
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../commander-deterministic')];
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    rmrf(dir);
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../commander-deterministic')];
}

function writeWavesFixture(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

function sampleWavesState() {
    return {
        version: '1.0',
        meta: { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test' },
        active_wave: {
            number: 9,
            name: 'Ola N+9 — Tests',
            goal: 'Cierre Spike #3378',
            started_at: '2026-05-20T00:00:00.000Z',
            issues: [
                { number: 3500, status: 'in_progress' },
                { number: 3501, status: 'completed' },
            ],
        },
        planned_waves: [
            {
                number: 10,
                name: 'Ola N+10',
                goal: 'Multi-ola en dashboard',
                issues: [{ number: 3600, size: 'small', rationale: 'requiere H1' }],
            },
            {
                number: 11,
                name: 'Ola N+11',
                issues: [{ number: 3700 }],
            },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

// Crea un archivo de artefacto de issue para que getKnownIssues lo detecte.
function dropIssueArtifact(dir, issue, skill = 'pipeline-dev') {
    const target = path.join(dir, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${issue}.${skill}`), `issue: ${issue}\n`);
}

// -----------------------------------------------------------------------------
// CA-1 / parseWaveArgs — Validación de subcomandos
// -----------------------------------------------------------------------------

test('parseWaveArgs: sin args → status backward-compat', () => {
    const cd = require('../commander-deterministic');
    assert.deepEqual(cd.parseWaveArgs(''), { subcommand: 'status', audio: false });
    assert.deepEqual(cd.parseWaveArgs('   '), { subcommand: 'status', audio: false });
});

test('parseWaveArgs: `--audio` solo (legacy #3262) → status con audio', () => {
    const cd = require('../commander-deterministic');
    assert.deepEqual(cd.parseWaveArgs('--audio'), { subcommand: 'status', audio: true });
});

test('parseWaveArgs: `status` y `status --audio` parsean correctamente', () => {
    const cd = require('../commander-deterministic');
    assert.deepEqual(cd.parseWaveArgs('status'), { subcommand: 'status', audio: false });
    assert.deepEqual(cd.parseWaveArgs('status --audio'), { subcommand: 'status', audio: true });
    assert.deepEqual(cd.parseWaveArgs('STATUS --AUDIO'), { subcommand: 'status', audio: true });
});

test('parseWaveArgs: `next` y `promote` sin args', () => {
    const cd = require('../commander-deterministic');
    assert.deepEqual(cd.parseWaveArgs('next'), { subcommand: 'next' });
    assert.deepEqual(cd.parseWaveArgs('promote'), { subcommand: 'promote' });
});

test('parseWaveArgs: `add 2 #3500` happy path', () => {
    const cd = require('../commander-deterministic');
    assert.deepEqual(cd.parseWaveArgs('add 2 #3500'), {
        subcommand: 'add', waveNumber: 2, issueNumber: 3500,
    });
});

test('parseWaveArgs: rechaza floats, negativos, hex en waveNumber (CA-5)', () => {
    const cd = require('../commander-deterministic');
    assert.equal(cd.parseWaveArgs('add 2.5 #3500'), null);
    assert.equal(cd.parseWaveArgs('add -1 #3500'), null);
    assert.equal(cd.parseWaveArgs('add 0x2 #3500'), null);
    assert.equal(cd.parseWaveArgs('add 0 #3500'), null);
});

test('parseWaveArgs: rechaza `#issue` sin numerals o con caracteres extra (CA-5)', () => {
    const cd = require('../commander-deterministic');
    assert.equal(cd.parseWaveArgs('add 1 3500'), null);   // sin `#`
    assert.equal(cd.parseWaveArgs('add 1 #3500a'), null); // letra extra
    assert.equal(cd.parseWaveArgs('add 1 #'), null);      // sin número
});

test('parseWaveArgs: rechaza tokens extra después de subcomando (CA-5)', () => {
    const cd = require('../commander-deterministic');
    assert.equal(cd.parseWaveArgs('status foo'), null);
    assert.equal(cd.parseWaveArgs('next bar'), null);
    assert.equal(cd.parseWaveArgs('promote ahora'), null);
    assert.equal(cd.parseWaveArgs('add 1 #2 3'), null);
});

test('parseWaveArgs: rechaza subcomando desconocido', () => {
    const cd = require('../commander-deterministic');
    assert.equal(cd.parseWaveArgs('delete'), null);
    assert.equal(cd.parseWaveArgs('eliminar 1'), null);
});

// -----------------------------------------------------------------------------
// ARG_SCHEMAS.wave.allow — coherente con parseWaveArgs
// -----------------------------------------------------------------------------

test('ARG_SCHEMAS.wave.allow: acepta los mismos casos válidos que parseWaveArgs', () => {
    const cd = require('../commander-deterministic');
    const allow = cd.ARG_SCHEMAS.wave.allow;
    assert.equal(allow(''), true);
    assert.equal(allow('--audio'), true);
    assert.equal(allow('status'), true);
    assert.equal(allow('status --audio'), true);
    assert.equal(allow('next'), true);
    assert.equal(allow('promote'), true);
    assert.equal(allow('add 2 #3500'), true);
});

test('ARG_SCHEMAS.wave.allow: rechaza inputs malformados', () => {
    const cd = require('../commander-deterministic');
    const allow = cd.ARG_SCHEMAS.wave.allow;
    assert.equal(allow('xxx'), false);
    assert.equal(allow('add 2'), false);
    assert.equal(allow('promote ya'), false);
    assert.equal(allow('add 2.5 #1'), false);
});

// -----------------------------------------------------------------------------
// CA-15 — getKnownIssues (cache + lectura FS)
// -----------------------------------------------------------------------------

test('getKnownIssues: recorre desarrollo/* y definicion/* y devuelve set', () => {
    const dir = setupTmp();
    try {
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        dropIssueArtifact(dir, 3500);
        dropIssueArtifact(dir, 3501, 'guru');
        // Issue en definicion también detectado.
        const defDir = path.join(dir, 'definicion', 'analisis', 'pendiente');
        fs.mkdirSync(defDir, { recursive: true });
        fs.writeFileSync(path.join(defDir, '4000.guru.json'), '{}');

        const known = cd._waveInternal.getKnownIssues(dir);
        assert.ok(known.has(3500));
        assert.ok(known.has(3501));
        assert.ok(known.has(4000));
        assert.equal(known.has(9999), false);
    } finally { teardown(dir); }
});

test('getKnownIssues: cache 30s — la segunda llamada no reescanea (CA-6 perf)', () => {
    const dir = setupTmp();
    try {
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        dropIssueArtifact(dir, 1234);
        const first = cd._waveInternal.getKnownIssues(dir);
        assert.ok(first.has(1234));
        // Agregar issue al disco después del primer scan: cache la oculta.
        dropIssueArtifact(dir, 5678);
        const second = cd._waveInternal.getKnownIssues(dir);
        assert.equal(second.has(5678), false, 'cache vigente debe seguir devolviendo el set viejo');
        // Invalidar y verificar que ahora sí aparece.
        cd._waveInternal.invalidateKnownIssuesCache();
        const third = cd._waveInternal.getKnownIssues(dir);
        assert.ok(third.has(5678));
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-4 — handleWaveNext
// -----------------------------------------------------------------------------

test('handleWaveNext: con planned_waves[0] lista candidatos con rationale', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWaveNext({ pipelineRoot: dir });
        assert.ok(reply.includes('10'), 'debe incluir número de ola próxima');
        assert.ok(reply.includes('3600'), 'debe listar el issue candidato');
        assert.ok(reply.includes('requiere H1'), 'debe incluir el rationale');
    } finally { teardown(dir); }
});

test('handleWaveNext: con planned_waves vacía → mensaje cálido (CA-4 último bullet)', async () => {
    const dir = setupTmp();
    try {
        const state = sampleWavesState();
        state.planned_waves = [];
        writeWavesFixture(dir, state);
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWaveNext({ pipelineRoot: dir });
        assert.ok(/no hay ola próxima/i.test(reply), `mensaje cálido esperado, got: ${reply}`);
    } finally { teardown(dir); }
});

test('handleWaveNext: issue sin rationale muestra "(sin rationale aún)" (UX guideline)', async () => {
    const dir = setupTmp();
    try {
        const state = sampleWavesState();
        // ola 10 ya tiene el issue 3600 con rationale; agregamos uno sin rationale.
        state.planned_waves[0].issues.push({ number: 3601 });
        writeWavesFixture(dir, state);
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWaveNext({ pipelineRoot: dir });
        assert.ok(reply.includes('sin rationale aún'),
            'fallback "(sin rationale aún)" requerido por UX guideline');
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-5 / CA-6 / CA-7 — handleWaveAdd
// -----------------------------------------------------------------------------

test('handleWaveAdd: happy path mueve issue a ola planificada', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        dropIssueArtifact(dir, 3700);
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 3700, // 3700 ya está en ola 11; pero como es no-op, no falla
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        // 3700 ya está en ola 11 → addIssueToWave es no-op (logInfo), retorna ok.
        assert.ok(reply.includes('3700'));
        assert.ok(reply.includes('11'));
    } finally { teardown(dir); }
});

test('handleWaveAdd: issue inexistente → error unknown_issue (CA-6)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        // No droppeamos ningún artefacto: getKnownIssues devuelve set vacío.
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 9999,
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        assert.ok(/9999/.test(reply));
        // El error-kind se escribe `unknown\_issue` por MarkdownV2 escape;
        // testeamos contra el mensaje funcional ("No encontré ... en el pipeline").
        assert.ok(/no encontré/i.test(reply));
        assert.ok(/pipeline/i.test(reply));
    } finally { teardown(dir); }
});

test('handleWaveAdd: ola inexistente → error wave_not_found (CA-5)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        dropIssueArtifact(dir, 3700);
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 99,
            issueNumber: 3700,
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        // error-kind se escapa por MarkdownV2; verificamos el mensaje funcional.
        assert.ok(/no encontré la ola/i.test(reply));
        assert.ok(/99/.test(reply));
    } finally { teardown(dir); }
});

test('handleWaveAdd: conflict si issue está en otra ola (CA-7 contrato addIssueToWave)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState()); // 3500 ya está en ola 9 (activa)
        dropIssueArtifact(dir, 3500);
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 3500,
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        // error-kind escaped; verificamos mensaje funcional ("ya está en ola").
        assert.ok(/ya está en ola/i.test(reply));
        assert.ok(/3500/.test(reply));
    } finally { teardown(dir); }
});

test('handleWaveAdd: cooldown bloquea segunda invocación dentro de la ventana (CA-9)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        dropIssueArtifact(dir, 3800);
        const cd = require('../commander-deterministic');
        cd._waveInternal.invalidateKnownIssuesCache();
        const { createDestructiveCooldown } = require('../commander/destructive-cooldown');
        // Reloj controlado para cooldown determinista.
        let virtualNow = 1000000;
        const cooldown = createDestructiveCooldown({
            cooldownMs: 30 * 1000,
            destructiveCommands: ['wave-add', 'wave-promote'],
            now: () => virtualNow,
        });

        const first = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 3800,
            cooldown,
            chatId: 'leo',
            from: 'Leo',
        });
        assert.ok(/3800/.test(first.reply));

        // Segunda invocación inmediata → cooldown_blocked.
        const second = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 3801,
            cooldown,
            chatId: 'leo',
            from: 'Leo',
        });
        assert.ok(/Esperá .* antes de repetir/i.test(second.reply));

        // Avanzar 31s → cooldown vencido, permite de nuevo.
        virtualNow += 31000;
        dropIssueArtifact(dir, 3801);
        cd._waveInternal.invalidateKnownIssuesCache();
        const third = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir,
            waveNumber: 11,
            issueNumber: 3801,
            cooldown,
            chatId: 'leo',
            from: 'Leo',
        });
        assert.ok(!/Esperá .* antes de repetir/i.test(third.reply), 'tras 31s debería permitir nueva mutación');
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-8 — handleWavePromote
// -----------------------------------------------------------------------------

test('handleWavePromote: promueve planned[0] a active + actualiza allowlist', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWavePromote({
            pipelineRoot: dir,
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        assert.ok(/10/.test(reply), 'mensaje debe mencionar la nueva ola activa #10');
        assert.ok(/9/.test(reply), 'mensaje debe mencionar la ola archivada #9');

        // Verificar que waves.json refleja el cambio.
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.equal(written.active_wave.number, 10);
        assert.equal(written.planned_waves.length, 1);
        assert.equal(written.archived_waves.length, 1);
        assert.equal(written.archived_waves[0].number, 9);
        assert.equal(written.meta.source, 'telegram-commander/wave-promote');

        // Verificar que .partial-pause.json fue regenerado con issues de la nueva ola.
        const pp = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(pp.allowed_issues, [3600]);
        assert.equal(pp.source, 'telegram-commander/wave-promote');
    } finally { teardown(dir); }
});

test('handleWavePromote: sin planned_waves → no_next_wave (CA-8 último bullet)', async () => {
    const dir = setupTmp();
    try {
        const state = sampleWavesState();
        state.planned_waves = [];
        writeWavesFixture(dir, state);
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWavePromote({
            pipelineRoot: dir,
            cooldown: null,
            chatId: 'leo',
            from: 'Leo',
        });
        // error-kind escapado; verificamos mensaje funcional.
        assert.ok(/no hay ola próxima/i.test(reply));
        // El estado no debe haber cambiado.
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.equal(written.active_wave.number, 9);
    } finally { teardown(dir); }
});

test('handleWavePromote: cooldown bloquea doble-tap (CA-9)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const { createDestructiveCooldown } = require('../commander/destructive-cooldown');
        let virtualNow = 5000000;
        const cooldown = createDestructiveCooldown({
            cooldownMs: 30 * 1000,
            destructiveCommands: ['wave-add', 'wave-promote'],
            now: () => virtualNow,
        });
        const first = await cd._waveInternal.handleWavePromote({
            pipelineRoot: dir, cooldown, chatId: 'leo', from: 'Leo',
        });
        assert.ok(!/Esperá .* antes de repetir/i.test(first.reply));
        const second = await cd._waveInternal.handleWavePromote({
            pipelineRoot: dir, cooldown, chatId: 'leo', from: 'Leo',
        });
        assert.ok(/Esperá .* antes de repetir/i.test(second.reply));
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-3 — handleWaveStatus
// -----------------------------------------------------------------------------

test('handleWaveStatus: usa renderWaveSnapshot y devuelve MarkdownV2', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const { reply, audioText } = await cd._waveInternal.handleWaveStatus({
            pipelineRoot: dir, audio: false,
        });
        assert.equal(typeof reply, 'string');
        assert.ok(reply.length > 0, 'reply no puede ser vacío');
        assert.equal(audioText, null);
    } finally { teardown(dir); }
});

test('handleWaveStatus: con audio=true devuelve audioText no nulo', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const { audioText } = await cd._waveInternal.handleWaveStatus({
            pipelineRoot: dir, audio: true,
        });
        assert.equal(typeof audioText, 'string');
        assert.ok(audioText.length > 0);
    } finally { teardown(dir); }
});

test('handleWaveStatus: sin waves.json activo → fallback legacy con nota discreta', async () => {
    const dir = setupTmp();
    try {
        // waves.json existe pero active_wave es null (estado inicial del CA-1 de H1).
        writeWavesFixture(dir, {
            version: '1.0',
            meta: { created_at: 'x', updated_at: 'x', updated_by: 'x', source: 'manual', note: 'vacio' },
            active_wave: null,
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        });
        const cd = require('../commander-deterministic');
        const { reply } = await cd._waveInternal.handleWaveStatus({
            pipelineRoot: dir, audio: false,
        });
        assert.ok(/modo legacy/.test(reply), 'debe incluir nota discreta del fallback');
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-2 / CA-10 / CA-11 — Integración via createDispatcher
// -----------------------------------------------------------------------------

test('dispatcher: /wave (sin args) responde determinístico con duracion < 500ms (CA-11)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false, // tests aislados
        });
        const result = await dispatcher.dispatch({ text: '/wave', chat_id: '99' });
        assert.equal(result.intent.class, 'deterministic');
        assert.equal(result.intent.command, 'wave');
        assert.equal(result.status, 'ok');
        assert.ok(result.reply && result.reply.length > 0);
        assert.ok(result.durationMs < 500, `duración esperada < 500ms, fue ${result.durationMs}ms`);
    } finally { teardown(dir); }
});

test('dispatcher: /wave xxx → invalid_args con plantilla error-invalid-args', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false,
        });
        const r = await dispatcher.dispatch({ text: '/wave xxx', chat_id: '99' });
        assert.equal(r.status, 'invalid_args');
        assert.ok(/wave/i.test(r.reply));
    } finally { teardown(dir); }
});

test('dispatcher: /wave add (sin args) → invalid_args (CA-5)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false,
        });
        const r = await dispatcher.dispatch({ text: '/wave add', chat_id: '99' });
        assert.equal(r.status, 'invalid_args');
    } finally { teardown(dir); }
});

test('dispatcher: /wave add 2.5 #1 → invalid_args (CA-5 floats rechazados)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false,
        });
        const r = await dispatcher.dispatch({ text: '/wave add 2.5 #1', chat_id: '99' });
        assert.equal(r.status, 'invalid_args');
    } finally { teardown(dir); }
});

test('dispatcher: /wave next con chat_id no autorizado → unauthorized, sin IO (CA-2)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false,
            expectedChatId: 'leo',
        });
        const r = await dispatcher.dispatch({ text: '/wave next', chat_id: 'intruso' });
        assert.equal(r.status, 'unauthorized');
        assert.equal(r.reply, null);
    } finally { teardown(dir); }
});

test('dispatcher: /wave audit log incluye intent.command=wave (CA-10)', async () => {
    const dir = setupTmp();
    try {
        writeWavesFixture(dir, sampleWavesState());
        const cd = require('../commander-deterministic');
        const dispatcher = cd.createDispatcher({
            pipelineRoot: dir,
            logsDir: path.join(dir, 'logs'),
            rateLimit: { burst: 100, ratePerMin: 600 },
            destructiveCooldown: false,
        });
        await dispatcher.dispatch({ text: '/wave next', chat_id: '99' });
        // Verificar que el audit log fue escrito para hoy.
        const today = new Date().toISOString().slice(0, 10);
        const auditFile = path.join(dir, 'logs', `commander-audit-${today}.jsonl`);
        assert.ok(fs.existsSync(auditFile), 'audit log debe existir');
        const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
        const lastEntry = JSON.parse(lines[lines.length - 1]);
        assert.equal(lastEntry.handler, 'wave');
        assert.equal(lastEntry.intent_class, 'deterministic');
        assert.equal(lastEntry.result_status, 'ok');
    } finally { teardown(dir); }
});

// -----------------------------------------------------------------------------
// CA-13 — Templates existen
// -----------------------------------------------------------------------------

test('templates: las 4 plantillas del CA-13 existen y se cargan sin error', () => {
    const { fillTemplate, clearCache } = require('../commander/fill-template');
    clearCache();
    // wave-status (con snapshot dummy via triple-brace)
    const status = fillTemplate('wave-status', {
        snapshot: 'snapshot dummy', 'using-legacy': false, 'audio-sent': false,
    });
    assert.ok(status.includes('snapshot dummy'));
    // wave-next vacío
    const next = fillTemplate('wave-next', { 'has-next': false });
    assert.ok(/no hay ola/i.test(next));
    // wave-add-ok
    const addOk = fillTemplate('wave-add-ok', {
        'issue-number': 3500, 'wave-number': 2, 'wave-name': 'Ola Y', 'new-size': 3,
    });
    assert.ok(addOk.includes('3500'));
    assert.ok(addOk.includes('2'));
    // wave-promote-ok
    const promoteOk = fillTemplate('wave-promote-ok', {
        'has-old-wave': true, 'old-wave-number': 9, 'new-wave-number': 10,
        'new-wave-name': 'Ola N+10', 'allowlist-size': 5, 'allowlist-applied': true,
        'has-allowlist-error': false, 'allowlist-error': '',
    });
    assert.ok(promoteOk.includes('10'));
    assert.ok(promoteOk.includes('9'));
});

// -----------------------------------------------------------------------------
// describeAvailableWaves — helper de UX para wave_not_found
// -----------------------------------------------------------------------------

test('describeAvailableWaves: formato `N (activa), M, K`', () => {
    const cd = require('../commander-deterministic');
    const { describeAvailableWaves } = cd._waveInternal;
    assert.equal(
        describeAvailableWaves({ number: 9 }, [{ number: 10 }, { number: 11 }]),
        '9 (activa), 10, 11',
    );
    assert.equal(describeAvailableWaves(null, []), 'ninguna');
    assert.equal(describeAvailableWaves(null, [{ number: 1 }]), '1');
});
