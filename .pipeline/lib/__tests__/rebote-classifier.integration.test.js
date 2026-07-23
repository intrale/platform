// =============================================================================
// Tests de INTEGRACIÓN — rebote-classifier (issue #3167)
//
// Diferencia con `rebote-classifier.test.js` (unit):
// los unit tests cubren cada función aisladamente. Acá ejercitamos el flujo
// completo end-to-end con stubs livianos:
//
//   1) Motivo crudo "agente dijo X" → classifyRebote → reportDependencyBlock
//      → archivos JSON en `.pipeline/servicios/github/pendiente/` con el
//      formato exacto que consume `servicio-github.js`.
//
//   2) Hint estructurado del agente (rebote_categoria + depende_de) →
//      classify usa hint → reportDependencyBlock encola las deps del hint.
//
//   3) Round-trip comment: el comment generado por buildDependencyComment
//      → parseDependenciesFromComment recupera los mismos números.
//
//   4) Negative case: comment sin marker → parseDependenciesFromComment = [].
//
// Aislamiento: `os.tmpdir()/rebote-int-<pid>` con cleanup al final.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mismo patrón que rebote-classifier.test.js: aislamos PIPELINE_DIR a tmp
// ANTES de cargar los módulos (traceability resuelve REPO_ROOT al require).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `rebote-int-${process.pid}-`));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
delete require.cache[require.resolve('../rebote-classifier')];
delete require.cache[require.resolve('../dep-comment-parser')];

const trace = require('../traceability');
const rc = require('../rebote-classifier');
const depParser = require('../dep-comment-parser');

const GH_QUEUE = path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente');

function listQueue() {
    try { return fs.readdirSync(GH_QUEUE); } catch { return []; }
}
function readQueueEntries() {
    return listQueue().map(f => ({
        name: f,
        payload: JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')),
    }));
}
function resetState() {
    for (const f of listQueue()) {
        try { fs.unlinkSync(path.join(GH_QUEUE, f)); } catch {}
    }
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

// Cleanup global al final del proceso de tests.
process.on('exit', () => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// 1) Flujo end-to-end con motivo real del incidente #3086
// -----------------------------------------------------------------------------

test('integration · motivo "#3083 está OPEN" → classify → reportDependencyBlock encola label + comment', () => {
    resetState();

    const motivo = '#3083 (S5 audit trail) está OPEN — no puedo integrar el audit dual-provider sin que se mergee primero.';

    // Paso 1: clasificar
    const result = rc.classifyRebote({ motivo, classifyErrorResult: 'codigo' });
    assert.equal(result.category, 'dependency_block');
    assert.deepEqual(result.dependsOn, [3083]);
    assert.equal(result.counts_against_circuit_breaker, false);
    assert.equal(result.label, 'blocked:dependencies');

    // Paso 2: reportar (encola label + comment)
    const reported = rc.reportDependencyBlock({
        issue: 3086,
        dependsOn: result.dependsOn,
        reason: motivo,
        skill: 'guru',
        phase: 'analisis',
    });
    assert.equal(reported.ok, true);
    assert.equal(reported.label_queued, true);
    assert.equal(reported.comment_queued, true);

    // Paso 3: verificar archivos JSON encolados con formato del servicio-github
    const entries = readQueueEntries();
    assert.equal(entries.length, 2, 'debe haber 2 archivos (label + comment)');

    const label = entries.find(e => e.payload.action === 'label');
    assert.ok(label, 'falta archivo de label');
    assert.equal(label.payload.issue, 3086);
    assert.equal(label.payload.label, 'blocked:dependencies');

    const comment = entries.find(e => e.payload.action === 'comment');
    assert.ok(comment, 'falta archivo de comment');
    assert.equal(comment.payload.issue, 3086);
    assert.match(comment.payload.body, /^## Dependencias detectadas por el pipeline/m);
    assert.match(comment.payload.body, /- #3083/);
});

// -----------------------------------------------------------------------------
// 2) Hint estructurado del agente — formato preferido
// -----------------------------------------------------------------------------

test('integration · hint estructurado "rebote_categoria + depende_de" → reportDependencyBlock con deps del hint', () => {
    resetState();

    const motivo = [
        'rebote_categoria: dependency_block',
        'depende_de: [3083, 3084]',
        'motivo: U1 multi-provider necesita el audit trail unificado de #3083.',
    ].join('\n');

    const result = rc.classifyRebote({ motivo });
    assert.equal(result.category, 'dependency_block');
    assert.deepEqual(result.dependsOn, [3083, 3084]);

    const reported = rc.reportDependencyBlock({
        issue: 3086,
        dependsOn: result.dependsOn,
        reason: motivo,
        skill: 'guru',
        phase: 'analisis',
    });
    assert.equal(reported.ok, true);

    const entries = readQueueEntries();
    const comment = entries.find(e => e.payload.action === 'comment');
    assert.ok(comment, 'falta archivo de comment');
    assert.match(comment.payload.body, /- #3083/);
    assert.match(comment.payload.body, /- #3084/);
});

// -----------------------------------------------------------------------------
// 3) Round-trip: build comment → parseDependenciesFromComment recupera la lista
// -----------------------------------------------------------------------------

test('integration · round-trip buildDependencyComment → parseDependenciesFromComment recupera deps', () => {
    const body = rc.buildDependencyComment({
        dependsOn: [3083, 3084],
        reason: 'U1 depende de S5 y H6',
        skill: 'guru',
    });
    const parsed = depParser.parseDependenciesFromComment(body);
    assert.deepEqual(parsed, [3083, 3084]);
});

test('integration · parseDependenciesFromComment con body sin marker → []', () => {
    const body = '## Otro heading random\n\n- #100\n- #200\n\nSin el marker correcto.';
    const parsed = depParser.parseDependenciesFromComment(body);
    assert.deepEqual(parsed, []);
});

test('integration · parseDependenciesFromComment con body vacío → []', () => {
    assert.deepEqual(depParser.parseDependenciesFromComment(''), []);
    assert.deepEqual(depParser.parseDependenciesFromComment(null), []);
    assert.deepEqual(depParser.parseDependenciesFromComment(undefined), []);
});

test('integration · parseDependenciesFromComment dedup + cap a 20', () => {
    const nums = [];
    for (let i = 1; i <= 30; i++) nums.push('- #' + i);
    const body = '## Dependencias detectadas por el pipeline\n\n' + nums.join('\n') + '\n- #5\n- #10';
    const parsed = depParser.parseDependenciesFromComment(body);
    assert.equal(parsed.length, 20);
    assert.deepEqual(parsed.slice(0, 5), [1, 2, 3, 4, 5]);
    // No debe haber duplicados
    const set = new Set(parsed);
    assert.equal(set.size, parsed.length);
});

// -----------------------------------------------------------------------------
// 4) Asset-only path (sin issue numbers) — caso UX
// -----------------------------------------------------------------------------

test('integration · motivo "assets UX no en main" → dependency_block + comment sin bullets numéricos', () => {
    resetState();

    const motivo = 'No puedo seguir — los assets UX no están en main todavía. Mockups #N pendiente de entrega.';
    const result = rc.classifyRebote({ motivo });
    assert.equal(result.category, 'dependency_block');
    assert.deepEqual(result.dependsOn, []);

    const reported = rc.reportDependencyBlock({
        issue: 9999,
        dependsOn: result.dependsOn,
        reason: motivo,
        skill: 'android-dev',
        phase: 'desarrollo',
    });
    assert.equal(reported.ok, true);

    const entries = readQueueEntries();
    const comment = entries.find(e => e.payload.action === 'comment');
    assert.ok(comment, 'falta archivo de comment');
    // Sin números en deps, el comment NO debe inyectar bullets `- #N`
    assert.doesNotMatch(comment.payload.body, /^- #\d+/m);
    // Sí debe traer la nota de asset/recurso sin número concreto
    assert.match(comment.payload.body, /asset\/recurso/i);
});

// -----------------------------------------------------------------------------
// 5) Event traceability — emit dependency:blocked
// -----------------------------------------------------------------------------

test('integration · reportDependencyBlock emite evento dependency:blocked en activity-log', () => {
    resetState();

    rc.reportDependencyBlock({
        issue: 3086,
        dependsOn: [3083],
        reason: 'Test trazabilidad',
        skill: 'guru',
        phase: 'analisis',
    });

    assert.ok(fs.existsSync(trace.LOG_FILE), 'activity-log no se escribió');
    const lines = fs.readFileSync(trace.LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const events = lines.map(l => JSON.parse(l));
    const dep = events.find(e => e.event === 'dependency:blocked' && e.issue === 3086);
    assert.ok(dep, 'falta evento dependency:blocked para #3086');
    assert.deepEqual(dep.depends_on, [3083]);
    assert.equal(dep.skill, 'guru');
    assert.equal(dep.phase, 'analisis');
});

// -----------------------------------------------------------------------------
// 6) Negative case: motivo NO-dependencia NO crea archivos en la cola
// -----------------------------------------------------------------------------

test('integration · motivo de error de código NO encola label dependency_block', () => {
    resetState();

    const motivo = 'NullPointerException at LoginViewModel.kt:42 — bug claro en el código.';
    const result = rc.classifyRebote({ motivo, classifyErrorResult: 'codigo' });
    assert.equal(result.category, 'code');
    // Caller NO debe invocar reportDependencyBlock para category=code.
    // Verificamos que si NO lo invocamos, la cola queda limpia.
    const entries = readQueueEntries();
    assert.equal(entries.length, 0);
});
