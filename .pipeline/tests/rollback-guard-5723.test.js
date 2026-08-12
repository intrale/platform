// =============================================================================
// rollback-guard-5723.test.js — Guard del auto-rollback (#5723)
//
// Escenario que motivó el issue (2026-08-09): el auto-rollback revirtió el fix
// que lo habría arreglado, dos ciclos seguidos, porque `pipeline-stable` había
// quedado atrás de HEAD. Estos tests fijan las tres decisiones del guard:
//   - 1er rollback hacia un target → procede, pero alerta con severidad alta
//     si el target es ancestro de HEAD y el diff toca el lifecycle.
//   - 2do rollback consecutivo hacia el MISMO target sin smoke limpio → corta.
//   - Un smoke limpio resetea la racha.
//
// Ejecución: `node --test .pipeline/tests/rollback-guard-5723.test.js`
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require(path.join(__dirname, '..', 'lib', 'rollback-guard.js'));

const HEAD = 'a7d1f851c01d0478e3ba575a6765034aff9bede3';
const STABLE = '336549aff31a5d72bb0e60fa6a98f009da8774bf';
const OTRO = '0000000111112222233333444445555566666777';
const NOW = Date.parse('2026-08-09T02:35:57Z');

function tmpStateFile(nombre) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-guard-'));
    return path.join(dir, nombre || 'rollback-state.json');
}

/** Estado equivalente a "ya hubo un rollback hacia `target` recién". */
function estadoConRacha(target, consecutive, offsetMs = 0) {
    return {
        consecutive,
        last_target: target,
        last_at: new Date(NOW - offsetMs).toISOString(),
        halted: false,
        halted_at: null,
        last_reason: null,
    };
}

// --- CA-1: ancestro + lifecycle ------------------------------------------

test('target ancestro de HEAD que toca el lifecycle: primer intento revierte pero marca severidad critica', () => {
    const d = guard.decide({
        targetSha: STABLE,
        headSha: HEAD,
        isAncestor: true,
        lifecycleTouched: true,
        state: null,
        now: NOW,
    });
    assert.strictEqual(d.action, 'proceed', 'el guard NO es incondicional: el 1er ciclo revierte (precision PO)');
    assert.strictEqual(d.severity, 'critical');
    assert.strictEqual(d.selfDestructive, true);
    assert.strictEqual(d.attempt, 1);
    assert.match(d.reason, /arranque del pipeline/);
});

test('target ancestro que NO toca el lifecycle: severidad normal', () => {
    const d = guard.decide({
        targetSha: STABLE, headSha: HEAD, isAncestor: true, lifecycleTouched: false, state: null, now: NOW,
    });
    assert.strictEqual(d.action, 'proceed');
    assert.strictEqual(d.severity, 'warn');
    assert.strictEqual(d.selfDestructive, false);
});

test('target que NO es ancestro de HEAD: no es el escenario autodestructivo', () => {
    const d = guard.decide({
        targetSha: OTRO, headSha: HEAD, isAncestor: false, lifecycleTouched: true, state: null, now: NOW,
    });
    assert.strictEqual(d.action, 'proceed');
    assert.strictEqual(d.severity, 'warn', 'sin ancestria no puede estar borrando commits que HEAD ya tiene');
});

test('touchesLifecycle reconoce los 4 archivos del lifecycle y ninguno mas', () => {
    assert.strictEqual(guard.touchesLifecycle(['.pipeline/dashboard.js']), false);
    assert.strictEqual(guard.touchesLifecycle(['.pipeline/pulpo.js']), true);
    assert.strictEqual(guard.touchesLifecycle(['.pipeline/restart.js']), true);
    assert.strictEqual(guard.touchesLifecycle(['.pipeline/watchdog.ps1']), true);
    assert.strictEqual(guard.touchesLifecycle(['.pipeline/smoke-test.js']), true);
    assert.strictEqual(guard.touchesLifecycle(['.pipeline\\pulpo.js']), true, 'separadores de Windows');
    assert.strictEqual(guard.touchesLifecycle([]), false);
    assert.strictEqual(guard.touchesLifecycle(null), false);
});

// --- CA-4: corte al 2do ciclo (N = 2) ------------------------------------

test('2do rollback consecutivo hacia el mismo target sin smoke limpio: corta y escala', () => {
    const d = guard.decide({
        targetSha: STABLE,
        headSha: HEAD,
        isAncestor: true,
        lifecycleTouched: true,
        state: estadoConRacha(STABLE, 1),
        now: NOW,
    });
    assert.strictEqual(d.action, 'halt');
    assert.strictEqual(d.attempt, 2);
    assert.strictEqual(d.sameTarget, true);
    assert.strictEqual(d.nextState.halted, true);
    assert.match(d.reason, /smoke test/);
});

test('N = 2 es el umbral: el corte no espera al 3er ciclo', () => {
    assert.strictEqual(guard.CONSECUTIVE_THRESHOLD, 2);
});

test('2do rollback hacia OTRO target todavia procede, el 3ro corta', () => {
    const segundo = guard.decide({
        targetSha: OTRO, headSha: HEAD, isAncestor: true, lifecycleTouched: false,
        state: estadoConRacha(STABLE, 1), now: NOW,
    });
    assert.strictEqual(segundo.action, 'proceed', 'target distinto = situacion distinta');
    assert.strictEqual(segundo.sameTarget, false);
    assert.strictEqual(segundo.nextState.consecutive, 2);

    const tercero = guard.decide({
        targetSha: 'ffffffffffffffffffffffffffffffffffffffff', headSha: HEAD,
        isAncestor: true, lifecycleTouched: false,
        state: { ...segundo.nextState, last_at: new Date(NOW).toISOString() }, now: NOW,
    });
    assert.strictEqual(tercero.action, 'halt', 'tres rollbacks seguidos sin smoke limpio no se recuperan solos');
});

test('una vez frenado sigue frenado hasta que un smoke limpio resetee el estado', () => {
    const frenado = guard.decide({
        targetSha: STABLE, headSha: HEAD, isAncestor: true, lifecycleTouched: true,
        state: estadoConRacha(STABLE, 1), now: NOW,
    });
    const otraVez = guard.decide({
        targetSha: OTRO, headSha: HEAD, isAncestor: true, lifecycleTouched: false,
        state: frenado.nextState, now: NOW + 60_000,
    });
    assert.strictEqual(otraVez.action, 'halt');
    assert.match(otraVez.reason, /frenado/);
});

test('estado viejo (fuera de la ventana de frescura) es otro incidente: el contador arranca de cero', () => {
    const d = guard.decide({
        targetSha: STABLE, headSha: HEAD, isAncestor: true, lifecycleTouched: true,
        state: { ...estadoConRacha(STABLE, 5), halted: true },
        now: NOW + guard.STALE_MS + 1000,
    });
    assert.strictEqual(d.stale, true);
    assert.strictEqual(d.action, 'proceed', 'un halt no puede quedar pegado para siempre');
    assert.strictEqual(d.attempt, 1);
});

// --- Estado persistido ----------------------------------------------------

test('el estado se persiste, se relee y un smoke limpio lo borra', () => {
    const file = tmpStateFile();
    assert.deepStrictEqual(guard.readState(file), guard.defaultState(), 'sin archivo devuelve default');

    const d = guard.decide({ targetSha: STABLE, headSha: HEAD, isAncestor: true, lifecycleTouched: true, state: null, now: NOW });
    guard.writeState(d.nextState, file);

    const releido = guard.readState(file);
    assert.strictEqual(releido.consecutive, 1);
    assert.strictEqual(releido.last_target, STABLE);

    assert.strictEqual(guard.clearState(file), true);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(guard.clearState(file), false, 'idempotente: sin racha que cortar devuelve false');
    assert.deepStrictEqual(guard.readState(file), guard.defaultState());
});

test('estado corrupto no rompe el rollback: degrada a default', () => {
    const file = tmpStateFile('corrupto.json');
    fs.writeFileSync(file, '{ esto no es json');
    assert.deepStrictEqual(guard.readState(file), guard.defaultState());

    fs.writeFileSync(file, '[1,2,3]');
    assert.deepStrictEqual(guard.readState(file), guard.defaultState());
});

test('la escritura es atomica: no queda .tmp colgado', () => {
    const file = tmpStateFile();
    guard.writeState({ consecutive: 3, last_target: STABLE }, file);
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
    assert.strictEqual(guard.readState(file).consecutive, 3);
});

// --- CA-3 / G-2: parsing de git y contenido de los mensajes ---------------

test('parseShortstat entiende la salida real de git diff --shortstat', () => {
    const stat = guard.parseShortstat(' 22 files changed, 124 insertions(+), 2407 deletions(-)');
    assert.deepStrictEqual(stat, { files: 22, insertions: 124, deletions: 2407 });
    assert.strictEqual(guard.formatShortstat(stat), '22 archivos, +124, -2407 líneas');
    assert.strictEqual(guard.parseShortstat(''), null);
    assert.strictEqual(guard.parseShortstat(null), null);
});

test('parseShortstat soporta diffs sin inserciones o sin borrados', () => {
    assert.deepStrictEqual(
        guard.parseShortstat(' 1 file changed, 3 deletions(-)'),
        { files: 1, insertions: 0, deletions: 3 },
    );
});

test('parseCommitList entiende la salida de git log --oneline', () => {
    const commits = guard.parseCommitList(
        'a7d1f85 Merge pull request #5704 from intrale/agent/5704-fix\n' +
        '336549a fix(pipeline): watchdog stuck-phase (#5687)\n' +
        '  \n' +
        '1112223 chore: sin issue',
    );
    assert.strictEqual(commits.length, 3);
    assert.strictEqual(commits[0].sha, 'a7d1f85');
    assert.strictEqual(commits[2].subject, 'chore: sin issue');
});

test('extractIssueRefs prefiere el Closes #N del body sobre el #N del squash (que es el PR)', () => {
    // Caso real del rango a7d1f851..8dacbabd: el subject trae el numero de PR
    // (#5748) y el body el issue de verdad (#5722).
    const log = '[BUG] El guard de puerto hace fail-open (#5748)\nDetalle del fix.\n\nCloses #5722\n';
    assert.deepStrictEqual(guard.extractIssueRefs(log), [5722]);
});

test('extractIssueRefs usa la convencion de ramas agent/<issue>- cuando no hay Closes', () => {
    const log = 'Merge pull request #5704 from intrale/agent/5704-fix\n';
    assert.deepStrictEqual(guard.extractIssueRefs(log), [5704]);
});

test('extractIssueRefs cae a cualquier #N solo si no hay referencia mejor, y acota la cantidad', () => {
    assert.deepStrictEqual(guard.extractIssueRefs('fix (#5687) y tambien #5635'), [5687, 5635]);
    assert.deepStrictEqual(guard.extractIssueRefs('chore: sin refs'), []);
    assert.deepStrictEqual(guard.extractIssueRefs(''), []);
    assert.deepStrictEqual(guard.extractIssueRefs(null), []);
    assert.strictEqual(guard.extractIssueRefs('#1 #2 #3 #4 #5 #6 #7').length, 5, 'blast radius acotado');
});

test('extractIssueRefs tambien acepta la lista parseada de commits', () => {
    assert.deepStrictEqual(
        guard.extractIssueRefs([{ sha: 'abc', subject: 'fix algo', body: 'Closes #5723' }]),
        [5723],
    );
});

test('G-1: el mensaje de un rollback ejecutado nunca es un check verde', () => {
    const msg = guard.buildProceedAlert({
        target: 'pipeline-stable',
        targetSha: STABLE,
        headSha: HEAD,
        severity: 'critical',
        commits: [{ sha: 'a7d1f85', subject: 'fix: reset --hard deja servicios con codigo viejo (#5704)' }],
        shortstat: { files: 22, insertions: 124, deletions: 2407 },
    });
    assert.ok(!msg.includes('✅'), 'un rollback que revierte commits no es un exito');
    assert.ok(msg.includes('🚨'), 'ancestro + lifecycle escala a critico');
    assert.ok(msg.includes('se revirtieron 1 commit'), 'G-2: cuantos commits');
    assert.ok(msg.includes('#5704'), 'G-2: titulo del commit, no solo el hash');
    assert.ok(msg.includes('22 archivos, +124, -2407 líneas'), 'G-2: diffstat en unidades del operador');
    assert.ok(msg.includes('git tag -f pipeline-stable'), 'G-2: el destrabe viene escrito');
    assert.ok(msg.includes(STABLE.slice(0, 8)) && msg.includes(HEAD.slice(0, 8)));
});

test('G-1: un rollback sin impacto en el lifecycle avisa pero no grita', () => {
    const msg = guard.buildProceedAlert({
        target: 'pipeline-stable', targetSha: STABLE, headSha: HEAD, severity: 'warn',
        commits: [], shortstat: null,
    });
    assert.ok(msg.startsWith('⚠️'), 'minimo advertencia, nunca exito');
    assert.ok(!msg.includes('🚨'));
});

test('G-3/G-4: el mensaje del corte dice que se freno, por que y que hacer', () => {
    const msg = guard.buildHaltAlert({
        target: 'pipeline-stable',
        targetSha: STABLE,
        headSha: HEAD,
        reason: 'Es el 2º rollback seguido hacia el mismo punto sin que el smoke test pase en el medio.',
        commits: [{ sha: 'a7d1f85', subject: 'fix #5704' }],
        shortstat: { files: 22, insertions: 124, deletions: 2407 },
        issues: [5704, 5687],
    });
    assert.ok(msg.startsWith('🚨'), 'G-4: se distingue de las alertas rutinarias');
    assert.ok(msg.includes('Pipeline detenido'));
    assert.ok(msg.includes('no se va a recuperar solo'), 'G-4: estado explicito');
    assert.ok(msg.includes('Qué hacer'), 'G-3: llamado a la accion');
    assert.ok(msg.includes('git tag -f pipeline-stable'));
    assert.ok(msg.includes('#5704') && msg.includes('#5687'));
    for (const jerga of ['is-ancestor', 'resetPipelineDir', 'merge-base', 'exit code']) {
        assert.ok(!msg.includes(jerga), `G-3: sin jerga de implementacion (${jerga})`);
    }
});

test('el texto de las alertas se entiende sin los emoji (accesibilidad)', () => {
    const sinEmoji = guard.buildHaltAlert({ targetSha: STABLE, headSha: HEAD, reason: 'x' })
        .replace(/[🚨⚠️✅]/g, '').trim();
    assert.ok(sinEmoji.startsWith('*Pipeline detenido'), 'la gravedad la transmite el texto, no el color');
});

test('los subjects de commit no rompen el Markdown de Telegram', () => {
    const msg = guard.buildProceedAlert({
        targetSha: STABLE, headSha: HEAD, severity: 'warn',
        commits: [{ sha: 'abc1234', subject: 'fix: *bold* y `code` y _under_ [link]' }],
    });
    assert.ok(msg.includes('fix: bold y code y under link'));
    assert.strictEqual((msg.match(/`/g) || []).length % 2, 0, 'backticks balanceados');
});

test('buildProceedAlert corta la lista larga de commits sin ocultar cuantos quedan', () => {
    const commits = Array.from({ length: 9 }, (_, i) => ({ sha: `sha${i}`, subject: `commit ${i}` }));
    const msg = guard.buildProceedAlert({ targetSha: STABLE, headSha: HEAD, commits });
    assert.ok(msg.includes('se revirtieron 9 commits'));
    assert.ok(msg.includes('y 4 commits más'), 'no hay truncado silencioso');
});
