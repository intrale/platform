// =============================================================================
// wave-add-sync-integration-5882.test.js — Escritura conjunta end-to-end y
// reparación aditiva de la allowlist (#5882).
//
// Cubre los cuatro escenarios Gherkin del issue:
//   1. Promoción coherente (happy path) → ambos archivos en sync, sin divergencia.
//   2. Falla la escritura de la allowlist → rollback de waves.json + error explícito.
//   3. Desync aditivo con issue ABIERTO y traza legítima → auto-reparado.
//   4. Desync sin traza legítima → sigue frenando fail-closed.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/wave-add-sync-integration-5882.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const partialPause = require('../partial-pause');
const desyncDetector = require('../desync-detector');
const waves = require('../waves');
const waveAudit = require('../wave-audit');
const cd = require('../commander-deterministic');
const pulpo = require('../../pulpo.js');

// -----------------------------------------------------------------------------
// Helpers de fixture (mismo patrón que desync-sync-4439.test.js)
// -----------------------------------------------------------------------------

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-sync-5882-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'desarrollo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    try { cd._waveInternal.setSyncLogger(null); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function writeWaves(dir, activeIssues) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #5882',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa — Test 5882',
            goal: 'coherencia waves↔partial-pause',
            started_at: '2026-08-01T00:00:00.000Z',
            issues: activeIssues.map((n) => ({ number: n, status: 'in_progress' })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

function dropArtifact(dir, issue) {
    const target = path.join(dir, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${issue}.pipeline-dev`), `issue: ${issue}\n`);
}

function readAllowlist(dir) {
    const p = path.join(dir, '.partial-pause.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')).allowed_issues;
}

function readWaveIssues(dir) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    return state.active_wave.issues.map((i) => i.number);
}

// El `reply` sale escapado en MarkdownV2 (`partial\_sync\_failed`). Para
// asertar sobre el CONTENIDO y no sobre el escape, lo des-escapamos.
function plano(reply) {
    return String(reply).replace(/\\(.)/g, '$1');
}

function seedAllowlist(issues) {
    return partialPause.setPartialPause(issues, {
        source: 'wave-promote',
        authorizedBy: 'wave-promote',
        justification: 'seed test #5882',
    });
}

// =============================================================================
// Gherkin 1 — Promoción coherente (happy path)
// =============================================================================

test('promoción coherente deja waves.json y allowlist en sync y el detector no reporta divergencia', async () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        assert.ok(plano(reply).includes('880001'), 'responde OK con el issue');
        assert.ok(!plano(reply).includes('partial_sync_failed'), 'no es un error de sync');
        assert.ok(readWaveIssues(dir).includes(880001), 'waves.json contiene el issue');
        assert.ok(readAllowlist(dir).includes(880001), 'la allowlist contiene el issue');

        const probe = desyncDetector.detectDesync({ isClosed: () => false });
        assert.equal(probe.desync, false, `sin divergencia: ${JSON.stringify(probe)}`);
    } finally {
        teardown(dir);
    }
});

// =============================================================================
// Gherkin 2 — Falla la escritura de la allowlist (CA-1, CA-2)
// =============================================================================

test('si falla la escritura de la allowlist, el issue NO queda en waves.json (rollback) y responde error explícito', async () => {
    const dir = setup();
    const original = partialPause.setPartialPause;
    const logLines = [];
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger((l) => logLines.push(l));

        // La escritura de la allowlist falla — y NO aterriza.
        partialPause.setPartialPause = () => { throw new Error('EACCES: disco de sólo lectura'); };

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        // CA-1 — rollback: el estado final es el previo al comando.
        assert.deepEqual(readWaveIssues(dir), [880002], 'la suma se revirtió');
        assert.ok(!readAllowlist(dir).includes(880001), 'la allowlist quedó sin el issue');

        // CA-2 — error explícito al usuario.
        assert.ok(plano(reply).includes('partial_sync_failed'), `debe reportar el error-kind: ${reply}`);
        assert.ok(plano(reply).includes('deshice la promoción'), 'el mensaje dice qué pasó con el estado');

        // CA-2 — log con nivel error.
        assert.ok(logLines.length > 0, 'el fallo debe dejar rastro en el log');
        assert.ok(logLines.some((l) => l.includes('ERROR') && l.includes('partial_sync_failed')),
            `la línea de log debe ser de error: ${JSON.stringify(logLines)}`);
        assert.ok(logLines.some((l) => l.includes('rollback=true')), 'el log dice si revirtió');

        // El pipeline sigue despachando: sin divergencia que frene nada.
        const probe = desyncDetector.detectDesync({ isClosed: () => false });
        assert.equal(probe.desync, false, `estado coherente tras el rollback: ${JSON.stringify(probe)}`);
    } finally {
        partialPause.setPartialPause = original;
        teardown(dir);
    }
});

// ─── Regresión rev-1 (#5882) — el no-op NO puede disparar rollback ───────────
//
// `addIssueToWave` es IDEMPOTENTE: si el issue ya estaba en la ola devuelve
// `{added:false}` sin escribir ni auditar (waves.js:531-533). Si el rollback se
// dispara sin mirar `added`, un `/wave add` sobre un issue PREEXISTENTE cuya
// sync de allowlist falla REMUEVE de la ola un issue que el comando nunca sumó.
//
// El escenario es el de recuperación natural del propio bug de #5882 (issue en
// la ola, falta en la allowlist → el operador re-corre `/wave add`, cosa que el
// copy incluso le sugiere) y las causas de fallo de la allowlist son
// PERSISTENTES (FS read-only, disco lleno, lock tomado, rechazo del gate).
// Peor: tras el borrado ambos archivos coinciden, así que el detector de desync
// queda CIEGO — el issue desaparece de la ola activa en silencio, nadie lo
// despacha y no hay alerta. Misma clase de defecto que #5876/#4753.
test('un /wave add que fue no-op (added=false) NO remueve el issue de la ola', async () => {
    const dir = setup();
    const original = partialPause.setPartialPause;
    const logLines = [];
    try {
        // #880001 YA está en la ola activa; la allowlist NO lo tiene (el desync
        // que el operador viene a reparar re-corriendo el comando).
        writeWaves(dir, [880001, 880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger((l) => logLines.push(l));

        // La causa del desync sigue viva: la allowlist vuelve a fallar.
        partialPause.setPartialPause = () => { throw new Error('EACCES: disco de sólo lectura'); };

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        // El invariante: no se revierte lo que este comando nunca hizo.
        assert.ok(readWaveIssues(dir).includes(880001),
            'el issue preexistente NO puede desaparecer de la ola por un rollback que no le corresponde');
        assert.deepEqual(readWaveIssues(dir), [880001, 880002], 'la ola queda intacta');

        // Y el reporte no puede mentir diciendo que revirtió algo.
        assert.ok(plano(reply).includes('partial_sync_failed'), `reporta el error-kind: ${reply}`);
        assert.ok(!plano(reply).includes('todo volvió a como estaba'),
            `no puede afirmar que revirtió: ${reply}`);
        assert.ok(logLines.some((l) => l.includes('rollback=false')),
            `el log debe dejar claro que no hubo rollback: ${JSON.stringify(logLines)}`);
    } finally {
        partialPause.setPartialPause = original;
        teardown(dir);
    }
});

test('un rechazo del gate (que NO lanza) también dispara rollback y error explícito', async () => {
    const dir = setup();
    const original = partialPause.setPartialPause;
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);

        // `setPartialPause` devuelve { ok:false, rejected:true } SIN lanzar.
        // Antes de #5882 esto pasaba de largo y producía el desync silencioso.
        partialPause.setPartialPause = () => ({ ok: false, rejected: true, msg: 'Mutación rechazada por gate' });

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        assert.ok(plano(reply).includes('partial_sync_failed'), 'un rechazo del gate no puede pasar en silencio');
        assert.deepEqual(readWaveIssues(dir), [880002], 'se revirtió la suma');
    } finally {
        partialPause.setPartialPause = original;
        teardown(dir);
    }
});

test('si la allowlist SÍ quedó escrita pese al error, NO se revierte (estado coherente)', async () => {
    const dir = setup();
    const original = partialPause.setPartialPause;
    const logLines = [];
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger((l) => logLines.push(l));

        // El write aterriza y RECIÉN DESPUÉS falla (o muere el proceso).
        partialPause.setPartialPause = (issues, opts) => {
            original.call(partialPause, issues, opts);
            throw new Error('murió después del rename');
        };

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        // Revertir acá produciría un desync ADITIVO con issue abierto → ambiguo
        // → human-block: peor que el bug original.
        assert.ok(readWaveIssues(dir).includes(880001), 'NO se revierte: ambos archivos coherentes');
        assert.ok(readAllowlist(dir).includes(880001));
        assert.ok(!plano(reply).includes('partial_sync_failed'), 'se reconcilia hacia adelante, no es error');
        assert.ok(logLines.some((l) => l.includes('sin rollback')), 'queda registrado igual');
    } finally {
        partialPause.setPartialPause = original;
        teardown(dir);
    }
});

test('si el estado de la allowlist es INDETERMINADO no se revierte (fail-safe)', async () => {
    const dir = setup();
    const originalSet = partialPause.setPartialPause;
    const originalMode = partialPause.getPipelineMode;
    const logLines = [];
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger((l) => logLines.push(l));

        partialPause.setPartialPause = () => { throw new Error('fallo de escritura'); };
        let llamadas = 0;
        partialPause.getPipelineMode = function (...args) {
            llamadas += 1;
            // La primera lectura (la del flujo normal) funciona; la relectura
            // posterior al fallo es la que queda indeterminada.
            if (llamadas > 1) throw new Error('no se puede leer el marker');
            return originalMode.apply(partialPause, args);
        };

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        assert.ok(readWaveIssues(dir).includes(880001), 'ante la duda NO se revierte');
        assert.ok(plano(reply).includes('partial_sync_failed'));
        assert.ok(plano(reply).includes('no tengo certeza'), `el mensaje declara la incertidumbre: ${reply}`);
        assert.ok(logLines.some((l) => l.includes('landed=null')), 'el log deja el estado indeterminado');
    } finally {
        partialPause.setPartialPause = originalSet;
        partialPause.getPipelineMode = originalMode;
        teardown(dir);
    }
});

test('un mensaje de error con CRLF y control chars se sanitiza antes de loguear', async () => {
    const dir = setup();
    const original = partialPause.setPartialPause;
    const logLines = [];
    try {
        writeWaves(dir, [880002]);
        dropArtifact(dir, 880001);
        seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger((l) => logLines.push(l));

        partialPause.setPartialPause = () => {
            throw new Error('fallo\r\n[commander] INFO linea forjada\u0000con nulls');
        };

        await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        const linea = logLines.find((l) => l.includes('partial_sync_failed'));
        assert.ok(linea, 'debe haber línea de error');
        assert.ok(!linea.includes('\r'), 'sin CR (anti log-injection)');
        assert.ok(!linea.includes('\n'), 'sin LF: una línea de log es una línea');
        assert.ok(!linea.includes('\u0000'), 'sin null bytes');

        // Regresion rev-1 (#5882): las tres asserts de arriba pasaban DE FORMA
        // VACUA. `sanitizeJustification` devuelve un OBJETO {sanitized,...}, no
        // un string, asi que interpolado en el template literal daba
        // "[object Object]" — un string que trivialmente no tiene CR/LF/nulls.
        // La linea de CA-2 existia pero no decia POR QUE fallo, que es justo lo
        // que #5882 viene a evitar. Anclamos el CONTENIDO real para que el test
        // no pueda volver a pasar por vacio.
        assert.ok(!linea.includes('[object Object]'),
            `el motivo debe ser legible, no el toString de un objeto: ${linea}`);
        assert.ok(linea.includes('fallo'),
            `la linea debe conservar el motivo real del fallo: ${linea}`);
        assert.ok(linea.includes('linea forjada'),
            `el texto se conserva legible, aplanado en UNA sola linea: ${linea}`);
    } finally {
        partialPause.setPartialPause = original;
        teardown(dir);
    }
});

// =============================================================================
// Gherkin 3 — Desync aditivo con issue ABIERTO se auto-repara (CA-3, CA-4)
// =============================================================================

test('la reparación aditiva agrega a la allowlist el issue de la ola que le faltaba', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        seedAllowlist([880002]);            // 880003 está en la ola pero no acá

        const r = pulpo.repairAllowlistFromLegitWaveAdd([880003]);

        assert.equal(r.ok, true, `debe reparar: ${JSON.stringify(r)}`);
        assert.deepEqual(r.added, [880003]);
        assert.deepEqual(readAllowlist(dir).sort((a, b) => a - b), [880002, 880003]);
    } finally {
        teardown(dir);
    }
});

test('tras la reparación el detector deja de reportar divergencia y el pipeline despacha', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        seedAllowlist([880002]);

        const antes = desyncDetector.detectDesync({ isClosed: () => false });
        assert.equal(antes.desync, true, 'el fixture arranca desincronizado');

        pulpo.repairAllowlistFromLegitWaveAdd([880003]);

        const despues = desyncDetector.detectDesync({ isClosed: () => false });
        assert.equal(despues.desync, false, `debe converger: ${JSON.stringify(despues)}`);
    } finally {
        teardown(dir);
    }
});

// =============================================================================
// CA-4 — Invariante ADITIVO
// =============================================================================

test('la reparación NUNCA remueve issues de la allowlist (current ⊆ resultado)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        // La allowlist tiene un issue que NO está en la ola (extra legítimo de
        // otro flujo: huérfano de split, dep recursiva, etc.). Una reparación
        // que construyera la lista "desde la ola" lo PODARÍA — regresión de
        // #4753 / #5516.
        seedAllowlist([880002, 870001]);

        pulpo.repairAllowlistFromLegitWaveAdd([880003]);

        const resultado = readAllowlist(dir);
        for (const n of [880002, 870001]) {
            assert.ok(resultado.includes(n), `#${n} no puede desaparecer de la allowlist`);
        }
        assert.ok(resultado.includes(880003), 'y se sumó el faltante');
    } finally {
        teardown(dir);
    }
});

test('la reparación NO escribe waves.json', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        seedAllowlist([880002]);
        const antes = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');

        pulpo.repairAllowlistFromLegitWaveAdd([880003]);

        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), antes,
            'waves.json debe quedar byte-idéntico (invariante estructural)');
    } finally {
        teardown(dir);
    }
});

test('sólo repara issues que YA están en active_wave.issues (no deriva permiso de la lista de candidatos)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002]);
        seedAllowlist([880002]);

        // 999999 no está en la ola: aunque venga como candidato, no entra.
        const r = pulpo.repairAllowlistFromLegitWaveAdd([999999]);

        assert.equal(r.ok, false);
        assert.equal(r.reason, 'nothing_to_add');
        assert.deepEqual(readAllowlist(dir), [880002], 'la allowlist no se tocó');
    } finally {
        teardown(dir);
    }
});

// =============================================================================
// Gherkin 4 / CA-5 — cada rama de no-reparación declara su motivo
// =============================================================================

test('sin pausa parcial vigente no repara y declara el motivo', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        // Sin .partial-pause.json → modo running.
        const r = pulpo.repairAllowlistFromLegitWaveAdd([880003]);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'no_partial_pause', 'crear la allowlist acá restringiría el pipeline (#5060)');
    } finally {
        teardown(dir);
    }
});

test('sin ola activa no repara y declara el motivo', () => {
    const dir = setup();
    try {
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
            version: '1.0',
            meta: { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
            active_wave: null, planned_waves: [], archived_waves: [], dependencies: [],
        }, null, 2));
        waves.invalidateCache();
        seedAllowlist([880002]);

        const r = pulpo.repairAllowlistFromLegitWaveAdd([880003]);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'no_active_wave');
    } finally {
        teardown(dir);
    }
});

test('si el issue ya está en la allowlist no hay nada que reparar', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002, 880003]);
        seedAllowlist([880002, 880003]);

        const r = pulpo.repairAllowlistFromLegitWaveAdd([880003]);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'nothing_to_add');
    } finally {
        teardown(dir);
    }
});

test('todo `reason` de no-reparación es una cadena no vacía (nunca aborta en silencio)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [880002]);
        seedAllowlist([880002]);
        for (const entrada of [[], [999999], null]) {
            const r = pulpo.repairAllowlistFromLegitWaveAdd(entrada);
            assert.equal(r.ok, false);
            assert.equal(typeof r.reason, 'string');
            assert.ok(r.reason.length > 0, 'el motivo debe ser logueable');
        }
    } finally {
        teardown(dir);
    }
});

// =============================================================================
// CA-7 — el código ya no promete una reconciliación que no ocurre
// =============================================================================

test('el catch de sync de allowlist ya no está vacío ni promete auto-reparación', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commander-deterministic.js'), 'utf8');

    assert.ok(!/El desync reductivo resultante se auto-repara vía realign del Pulpo/.test(src),
        'el comentario que prometía la reconciliación inexistente debe estar removido');
    assert.ok(!/\}\s*catch\s*\{\s*\/\/ Best-effort: no rompemos el comando por la sync de allowlist/.test(src),
        'el catch best-effort vacío debe estar removido');
    assert.ok(/partial_sync_failed/.test(src), 'debe existir el error-kind explícito');
    assert.ok(/rollbackIssueAdd/.test(src), 'debe invocar el rollback');
});
