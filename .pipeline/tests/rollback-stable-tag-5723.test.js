// =============================================================================
// Tests del avance de `pipeline-stable` y del registro del rollback (#5723)
//
// Cubre los dos bloqueantes que levantó la review y que los 25 tests de
// rollback-guard-5723.test.js no tocaban:
//
//   BLOQUEANTE 1 — `pipelineTreeDirty()` / `moveStableTag()` miraban el diff
//   crudo de `.pipeline/`. Como ahí hay estado runtime TRACKEADO que el propio
//   pipeline reescribe en cada boot (telegram-health.json,
//   process-transitions.jsonl, metrics-history.jsonl…), el árbol está sucio
//   SIEMPRE y el tag no avanzaba nunca: el incidente del 2026-08-09 vuelto
//   permanente por diseño. Se fija en las DOS direcciones, que es lo que pidió
//   la guidance:
//     - falso positivo: sólo estado runtime sucio → el tag SÍ avanza.
//     - falso negativo: código real sucio → el tag NO avanza.
//
//   BLOQUEANTE 2 — `planRollback()` condicionaba diffstat, commits e issues a
//   que el target fuera ancestro de HEAD. Con un target divergente (force-push
//   o rebase de main, o invocación manual con un sha suelto) el rollback
//   revertía sin registrar NADA de lo que perdía, y encima el log afirmaba
//   "Diffstat vacío" sin haberlo verificado.
//
// Los tests de git corren contra repos temporales de verdad (sin red, sin
// remote): ejercitan el MISMO código que corre en producción, no una copia.
// =============================================================================
'use strict';

// Garantizar git en PATH antes de cualquier spawnSync('git'): cuando el tester
// corre desde el pulpo como servicio, el PATH heredado puede no incluirlo.
require('../lib/ensure-git-in-path').ensureGitInProcessPath();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('../lib/rollback-guard');

const PIPELINE_DIR = path.join(__dirname, '..');

// ---- Helpers ----------------------------------------------------------------

function sh(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error(`git ${args.join(' ')} spawn error (${r.error.code || 'UNKNOWN'}): ${r.error.message}`);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} fail (status=${r.status}): ${r.stderr}`);
    return r.stdout.trim();
}

function writeFile(dir, rel, content) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/**
 * Repo temporal que imita la estructura real: `.pipeline/` con código
 * (restart.js) y con estado runtime trackeado (telegram-health.json,
 * process-transitions.jsonl), ambos commiteados.
 */
function makeRepo(prefix = 'rb-tag-5723-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test.test']);
    sh(dir, ['config', 'user.name', 'Test']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    // Sin normalización de EOL: en Windows un core.autocrlf heredado marcaría
    // archivos como modificados sin que nadie los toque y ensuciaría el diff.
    sh(dir, ['config', 'core.autocrlf', 'false']);

    writeFile(dir, '.pipeline/restart.js', '// restart v1\n');
    writeFile(dir, '.pipeline/telegram-health.json', '{"ok":true,"boot":1}\n');
    writeFile(dir, '.pipeline/process-transitions.jsonl', '{"c":"pulpo","alive":true}\n');
    writeFile(dir, '.pipeline/state/multi-provider-health.json', '{"anthropic":"ok"}\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'base']);
    return dir;
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// =============================================================================
// BLOQUEANTE 1 · Clasificación código vs estado runtime
// =============================================================================

test('los archivos de estado runtime del repo vivo se clasifican como runtime-state', () => {
    // Lista textual de la review: `git diff --name-only HEAD -- .pipeline/`
    // sobre el pipeline corriendo. Si alguno volviera a contar como sucio, el
    // tag dejaría de avanzar y volveríamos al incidente del 2026-08-09.
    const observados = [
        '.pipeline/issue-manual-order.json',
        '.pipeline/metrics-history.jsonl',
        '.pipeline/partial-pause-deps-cache.json',
        '.pipeline/process-transitions.jsonl',
        '.pipeline/runtime-boot.json',
        '.pipeline/skill-profiles.json',
        '.pipeline/state/multi-provider-health-state.json',
        '.pipeline/state/multi-provider-health.json',
        '.pipeline/telegram-health.json',
        '.pipeline/credential-reminder-state.json',
    ];
    for (const f of observados) {
        assert.equal(guard.classifyPipelineChange(f), 'runtime-state', `${f} debería ser estado runtime`);
    }
    assert.deepEqual(guard.filterRelevantChanges(observados), []);
});

test('los archivos del lifecycle se clasifican como código y frenan el tag', () => {
    for (const f of guard.LIFECYCLE_FILES) {
        assert.equal(guard.classifyPipelineChange(f), 'code', `${f} debería ser código`);
    }
    assert.deepEqual(guard.filterRelevantChanges(guard.LIFECYCLE_FILES), guard.LIFECYCLE_FILES);
});

test('la extensión gana sobre el directorio: un .js dentro de un dir de estado sigue siendo código', () => {
    // Esta es la regla que impide que la lista de dirs abra la puerta a
    // saltear cambios de código reales.
    assert.equal(guard.classifyPipelineChange('.pipeline/logs/inyectado.js'), 'code');
    assert.equal(guard.classifyPipelineChange('.pipeline/desarrollo/hook.ps1'), 'code');
    assert.equal(guard.classifyPipelineChange('.pipeline/state/script.sh'), 'code');
    assert.equal(guard.classifyPipelineChange('.pipeline/sessions/config.yaml'), 'code');
});

test('lo que no se sabe clasificar cuenta como sucio (fail-closed)', () => {
    assert.equal(guard.classifyPipelineChange('.pipeline/config-nuevo.toml'), 'unknown');
    assert.equal(guard.classifyPipelineChange('.pipeline/algo-sin-extension'), 'unknown');
    assert.deepEqual(
        guard.filterRelevantChanges(['.pipeline/config-nuevo.toml']),
        ['.pipeline/config-nuevo.toml'],
    );
});

test('filterRelevantChanges separa el código del estado runtime en una lista mezclada', () => {
    const mezcla = [
        '.pipeline/telegram-health.json',
        '.pipeline/restart.js',
        '.pipeline/process-transitions.jsonl',
        '.pipeline/lib/rollback-guard.js',
        '.pipeline/state/multi-provider-health.json',
    ];
    assert.deepEqual(guard.filterRelevantChanges(mezcla), [
        '.pipeline/restart.js',
        '.pipeline/lib/rollback-guard.js',
    ]);
});

test('filterRelevantChanges normaliza backslashes y tolera entradas inválidas', () => {
    assert.deepEqual(guard.filterRelevantChanges(['.pipeline\\telegram-health.json']), []);
    assert.deepEqual(guard.filterRelevantChanges(['.pipeline\\restart.js']), ['.pipeline/restart.js']);
    assert.deepEqual(guard.filterRelevantChanges(['', '   ', null, undefined]), []);
    assert.deepEqual(guard.filterRelevantChanges(null), []);
    assert.deepEqual(guard.filterRelevantChanges('no-es-array'), []);
});

// =============================================================================
// BLOQUEANTE 1 · readDirtyPipelineCode contra git real
// (es el cuerpo de pipelineTreeDirty(): mismo código que corre en restart.js)
// =============================================================================

test('árbol limpio: no hay nada sucio y el tag puede avanzar', () => {
    const dir = makeRepo();
    try {
        const r = guard.readDirtyPipelineCode({ cwd: dir });
        assert.equal(r.readFailed, false);
        assert.deepEqual(r.all, []);
        assert.deepEqual(r.relevant, []);
    } finally { rmrf(dir); }
});

test('FALSO POSITIVO: con sólo estado runtime modificado el tag SÍ avanza', () => {
    const dir = makeRepo();
    try {
        // Exactamente lo que hace el pipeline entre el reset --hard de
        // syncWithMain() y moveStableTag(): reescribir sus propios markers.
        writeFile(dir, '.pipeline/telegram-health.json', '{"ok":true,"boot":2}\n');
        writeFile(dir, '.pipeline/process-transitions.jsonl', '{"c":"pulpo","alive":true}\n{"c":"dashboard","alive":true}\n');
        writeFile(dir, '.pipeline/state/multi-provider-health.json', '{"anthropic":"degraded"}\n');

        const r = guard.readDirtyPipelineCode({ cwd: dir });
        assert.equal(r.readFailed, false);
        // git los ve sucios...
        assert.equal(r.all.length, 3, `git debería ver 3 sucios, vio: ${JSON.stringify(r.all)}`);
        // ...pero ninguno frena el tag.
        assert.deepEqual(r.relevant, [], 'el estado runtime no debe frenar el avance de pipeline-stable');
    } finally { rmrf(dir); }
});

test('FALSO NEGATIVO: con código real modificado el tag NO avanza', () => {
    const dir = makeRepo();
    try {
        // El estado post-rollback: .pipeline/ en disco viene de otro commit.
        writeFile(dir, '.pipeline/restart.js', '// restart v0 (revertido)\n');

        const r = guard.readDirtyPipelineCode({ cwd: dir });
        assert.equal(r.readFailed, false);
        assert.deepEqual(r.relevant, ['.pipeline/restart.js']);
    } finally { rmrf(dir); }
});

test('código y estado runtime sucios a la vez: sólo el código frena el tag', () => {
    const dir = makeRepo();
    try {
        writeFile(dir, '.pipeline/restart.js', '// restart v0 (revertido)\n');
        writeFile(dir, '.pipeline/telegram-health.json', '{"ok":true,"boot":2}\n');
        writeFile(dir, '.pipeline/process-transitions.jsonl', '{"c":"pulpo","alive":false}\n');

        const r = guard.readDirtyPipelineCode({ cwd: dir });
        assert.equal(r.all.length, 3);
        assert.deepEqual(r.relevant, ['.pipeline/restart.js']);
    } finally { rmrf(dir); }
});

test('archivo de código NUEVO sin trackear no frena el tag (git diff sólo ve trackeados)', () => {
    // Documenta el límite real de la detección: `git diff HEAD` no lista
    // untracked. No es un bug del filtro; que quede fijado para que nadie
    // asuma cobertura que no existe.
    const dir = makeRepo();
    try {
        writeFile(dir, '.pipeline/nuevo-servicio.js', '// nuevo\n');
        const r = guard.readDirtyPipelineCode({ cwd: dir });
        assert.deepEqual(r.all, []);
        assert.deepEqual(r.relevant, []);
    } finally { rmrf(dir); }
});

test('si git no responde se marca readFailed y no se afirma que el árbol esté sucio', () => {
    const r = guard.readDirtyPipelineCode({
        cwd: process.cwd(),
        run: () => { throw new Error('git murió'); },
    });
    assert.equal(r.readFailed, true);
    assert.deepEqual(r.all, []);
    assert.deepEqual(r.relevant, []);
});

test('readDirtyPipelineCode acota el diff a .pipeline/ y usa el cwd que le pasan', () => {
    const llamadas = [];
    guard.readDirtyPipelineCode({
        cwd: 'C:/repo-falso',
        run: (cmd, cwd) => { llamadas.push({ cmd, cwd }); return ''; },
    });
    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].cmd, /^git diff --name-only HEAD -- \.pipeline\/$/);
    assert.equal(llamadas[0].cwd, 'C:/repo-falso');
});

// =============================================================================
// BLOQUEANTE 2 · planRollback registra también con target divergente
// End-to-end sobre rollback.js con --dry-run: no mata, no revierte, no persiste.
// =============================================================================

/** Copia a un repo temporal el mínimo de `.pipeline/` que rollback.js requiere. */
function installRollbackScript(dir) {
    // #6226 — `lib/dropfile-writer.js` se sumó al mínimo: rollback.js lo usa para
    // encolar su alerta de Telegram con nombre único y escritura `wx`.
    for (const rel of ['rollback.js', 'pid-discovery.js', 'lib/rollback-guard.js', 'lib/dropfile-writer.js']) {
        const dst = path.join(dir, '.pipeline', rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(PIPELINE_DIR, rel), dst);
    }
}

function runRollbackDryRun(dir, target) {
    const r = spawnSync(process.execPath, [path.join(dir, '.pipeline', 'rollback.js'), target, '--dry-run'], {
        cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('target DIVERGENTE: el rollback registra commits y diffstat en vez de callarse', () => {
    const dir = makeRepo('rb-diverg-5723-');
    try {
        // Rama divergente: comparte la base pero no está en la historia de HEAD.
        // Es el caso force-push/rebase de main, o `rollback.js <sha>` a mano.
        sh(dir, ['checkout', '-q', '-b', 'divergente']);
        writeFile(dir, '.pipeline/restart.js', '// restart rama divergente\n');
        sh(dir, ['add', '-A']);
        sh(dir, ['commit', '-q', '-m', 'divergente: toca restart.js']);
        const shaDivergente = sh(dir, ['rev-parse', 'HEAD']);

        sh(dir, ['checkout', '-q', 'main']);
        writeFile(dir, '.pipeline/restart.js', '// restart v2 — el fix que NO queremos perder\n');
        writeFile(dir, '.pipeline/pulpo.js', '// pulpo nuevo\n');
        sh(dir, ['add', '-A']);
        sh(dir, ['commit', '-q', '-m', 'fix del lifecycle en main (#5704)']);

        installRollbackScript(dir);
        const { status, out } = runRollbackDryRun(dir, shaDivergente);
        assert.equal(status, 0, `dry-run debería salir 0. Salida:\n${out}`);

        assert.match(out, /¿Target es ancestro de HEAD\?: no/);
        // Antes del fix: sin commits, sin diffstat, y encima afirmaba que
        // .pipeline/ era idéntico. Ahora tiene que registrar lo que se pierde.
        assert.doesNotMatch(out, /Diffstat vacío/, 'no puede afirmar diff vacío en el caso divergente');
        assert.match(out, /Commits que se van a revertir \(1\)/);
        assert.match(out, /fix del lifecycle en main/);
        assert.match(out, /Diffstat de lo que se está por revertir/);
        assert.match(out, /restart\.js/);
        assert.match(out, /pulpo\.js/);
        // Y avisa que no es un "volver atrás" común.
        assert.match(out, /el target no está en la historia de HEAD/);
        // El lifecycle tocado se reporta aunque no haya ancestría.
        assert.match(out, /¿Toca archivos del lifecycle\?: SÍ/);
    } finally { rmrf(dir); }
});

test('target ANCESTRO: sigue registrando commits, diffstat y lifecycle (no hubo regresión)', () => {
    const dir = makeRepo('rb-ancestro-5723-');
    try {
        const shaBase = sh(dir, ['rev-parse', 'HEAD']);
        writeFile(dir, '.pipeline/restart.js', '// restart v2 — fix\n');
        sh(dir, ['add', '-A']);
        sh(dir, ['commit', '-q', '-m', 'fix del lifecycle (#5704)']);

        installRollbackScript(dir);
        const { status, out } = runRollbackDryRun(dir, shaBase);
        assert.equal(status, 0, `dry-run debería salir 0. Salida:\n${out}`);

        assert.match(out, /¿Target es ancestro de HEAD\?: sí/);
        assert.match(out, /Commits que se van a revertir \(1\)/);
        assert.match(out, /fix del lifecycle/);
        assert.match(out, /Diffstat de lo que se está por revertir/);
        assert.match(out, /¿Toca archivos del lifecycle\?: SÍ/);
        assert.doesNotMatch(out, /Diffstat vacío/);
        assert.match(out, /no se mató ningún proceso, no se revirtió nada/);
    } finally { rmrf(dir); }
});

test('el dry-run no toca el árbol ni deja estado persistido', () => {
    const dir = makeRepo('rb-noside-5723-');
    try {
        const shaBase = sh(dir, ['rev-parse', 'HEAD']);
        writeFile(dir, '.pipeline/restart.js', '// restart v2\n');
        sh(dir, ['add', '-A']);
        sh(dir, ['commit', '-q', '-m', 'v2']);
        const headAntes = sh(dir, ['rev-parse', 'HEAD']);

        installRollbackScript(dir);
        runRollbackDryRun(dir, shaBase);

        assert.equal(sh(dir, ['rev-parse', 'HEAD']), headAntes);
        assert.equal(fs.readFileSync(path.join(dir, '.pipeline/restart.js'), 'utf8'), '// restart v2\n');
        assert.equal(fs.existsSync(path.join(dir, 'rollback-state.json')), false);
    } finally { rmrf(dir); }
});
