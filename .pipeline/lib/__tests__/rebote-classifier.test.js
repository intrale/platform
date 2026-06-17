// =============================================================================
// Tests rebote-classifier.js — issue #3167
//
// Cubre los criterios de aceptación de la Curita C:
//
//   CA-1 · classifyRebote devuelve una de las 5 categorías canónicas
//          (cross_phase, dependency_block, human_block, infra, code).
//   CA-2 · Precedencia: cross_phase > dependency_block > human_block > infra > code.
//   CA-3 · detectDependencyBlock extrae issue numbers de patrones realistas.
//   CA-4 · Hint estructural (rebote_categoria: dependency_block) gana sobre
//          regex, agrega deps al output.
//   CA-5 · Patrones de asset/UX matchean sin issue number (assetOnly=true).
//   CA-6 · buildDependencyComment produce un body parseable por
//          dep-comment-parser.js (heading exacto + bullets `- #N`).
//   CA-7 · reportDependencyBlock encola label + comment en la cola GitHub
//          con formato consumible por servicio-github.js.
//   CA-8 · reportDependencyBlock emite evento `dependency:blocked` en
//          el activity-log.
//   CA-9 · sanitizeDepsList dedup + ordena + acota MAX_DEPS_PER_BLOCK.
//   CA-10 · NO interfiere con human-block: motivos clásicos de bloqueo
//           humano siguen clasificándose como human_block.
//
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR a un tmp por test setup (mismo patrón que
// human-block.test.js para no contaminar la cola real ni el activity-log)
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-rebote-classifier-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
delete require.cache[require.resolve('../rebote-classifier')];
const trace = require('../traceability');
const rc = require('../rebote-classifier');
const depParser = require('../dep-comment-parser');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function resetState() {
    const queue = path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente');
    try { for (const f of fs.readdirSync(queue)) fs.unlinkSync(path.join(queue, f)); } catch {}
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

// =============================================================================
// CA-1 + CA-2: clasificación y precedencia
// =============================================================================

test('CA-1: motivo de timeout con classifyErrorResult=infra → infra', () => {
    const r = rc.classifyRebote({
        motivo: 'ETIMEDOUT al conectar con dynamodb.us-east-1.amazonaws.com',
        classifyErrorResult: 'infra',
    });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
    assert.equal(r.label, null);
});

test('CA-1: motivo técnico genérico (sin matches) → code', () => {
    const r = rc.classifyRebote({
        motivo: 'NullPointerException en LoginService línea 42',
    });
    assert.equal(r.category, 'code');
    assert.equal(r.counts_against_circuit_breaker, true);
    assert.equal(r.label, null);
});

test('CA-1: motivo con merge manual / CODEOWNERS → human_block', () => {
    const r = rc.classifyRebote({
        motivo: 'PR #2547 mergeable pero CODEOWNERS requiere review humano del backend',
    });
    assert.equal(r.category, 'human_block');
    assert.equal(r.label, 'needs-human');
});

test('CA-1: motivo con dependencia explícita → dependency_block', () => {
    const r = rc.classifyRebote({
        motivo: 'No puedo continuar, depende de #3083 que sigue OPEN',
    });
    assert.equal(r.category, 'dependency_block');
    assert.equal(r.label, 'blocked:dependencies');
    assert.deepEqual(r.dependsOn, [3083]);
    assert.equal(r.counts_against_circuit_breaker, false);
    assert.ok(r.autounlock, 'debe declarar mecanismo de autounlock');
    assert.equal(r.autounlock.mechanism, 'brazo-desbloqueo');
});

test('CA-1: isRoutingMismatch=true + faseDestino → cross_phase', () => {
    const r = rc.classifyRebote({
        motivo: 'Fuera de alcance: este issue requiere refinamiento de UX',
        isRoutingMismatch: true,
        faseDestino: 'definicion/ux',
    });
    assert.equal(r.category, 'cross_phase');
    assert.equal(r.counts_against_circuit_breaker, false);
});

test('CA-2: cross_phase gana sobre dependency_block', () => {
    // Si el agente devolvió "depende de #X" PERO el routing-classifier ya
    // determinó que es out-of-scope, el rebote debe ir a la fase destino,
    // no quedar como bloqueado por dependencia.
    const r = rc.classifyRebote({
        motivo: 'depende de #3083 que está abierta — fuera de alcance de dev',
        isRoutingMismatch: true,
        faseDestino: 'definicion/guru',
    });
    assert.equal(r.category, 'cross_phase');
});

test('CA-2: dependency_block gana sobre human_block', () => {
    // Cuando el motivo menciona BOTH "depende de #N" Y un patrón de
    // human-block clásico, debe ganar dependency_block (más específico).
    const r = rc.classifyRebote({
        motivo: 'depende de #3083 — esto requiere intervención humana también',
    });
    assert.equal(r.category, 'dependency_block');
    assert.deepEqual(r.dependsOn, [3083]);
});

test('CA-2: human_block gana sobre infra cuando ambos matchean', () => {
    // Motivo dice "needs-human" Y el caller pre-clasificó como infra. Como
    // human_block es más específico (catch explícito), gana.
    const r = rc.classifyRebote({
        motivo: 'PR pending human review (caída intermitente de gh CLI)',
        classifyErrorResult: 'infra',
    });
    assert.equal(r.category, 'human_block');
});

// =============================================================================
// CA-3: detectDependencyBlock — patrones realistas
// =============================================================================

test('CA-3: "depende de #N" extrae el número', () => {
    const r = rc.detectDependencyBlock('No puedo continuar, depende de #3083');
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [3083]);
    assert.equal(r.assetOnly, false);
});

test('CA-3: "bloqueado por #N" extrae el número', () => {
    const r = rc.detectDependencyBlock('Bloqueado por #2734 mientras no se mergee');
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [2734]);
});

test('CA-3: "espera merge de #N" extrae el número', () => {
    const r = rc.detectDependencyBlock('Esperando el merge de #3083 antes de seguir');
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [3083]);
});

test('CA-3: "#N está open" extrae el número', () => {
    const r = rc.detectDependencyBlock('La dependencia #3083 está abierta todavía');
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [3083]);
});

test('CA-3: múltiples #N → todos en dependsOn ordenados y dedup', () => {
    const r = rc.detectDependencyBlock(
        'Depende de #3083 y de #2734. Adicionalmente #2734 sigue open.',
    );
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [2734, 3083]);
});

test('CA-3: motivo sin ningún patrón → matched=false', () => {
    const r = rc.detectDependencyBlock('NullPointerException en línea 42');
    assert.equal(r.matched, false);
    assert.deepEqual(r.dependsOn, []);
});

test('CA-3: menciones casuales de #N (sin patrón) → matched=false', () => {
    // "Mejor que #2547" no es una dependencia formal. No debe matchear.
    const r = rc.detectDependencyBlock('Decisión: implementar como en #2547 pero con cache');
    assert.equal(r.matched, false);
});

// =============================================================================
// CA-4: Hint estructural
// =============================================================================

test('CA-4: hint estructural detecta dependency_block sin patrones de texto', () => {
    const r = rc.detectDependencyBlock(
        'rebote_categoria: dependency_block; depende_de: [3083, 2734]; reason: ...',
    );
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [2734, 3083]);
});

test('CA-4: hint estructural + dependsOn extra del caller', () => {
    const r = rc.detectDependencyBlock(
        'rebote_categoria: "dependency_block"',
        [3001, 3002],
    );
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [3001, 3002]);
});

test('CA-4: hint con lista en formato YAML works', () => {
    const r = rc.detectDependencyBlock(
        'rebote_categoria: dependency_block\ndepende_de: 3083, #2734, 3001',
    );
    assert.equal(r.matched, true);
    assert.deepEqual(r.dependsOn, [2734, 3001, 3083]);
});

// =============================================================================
// CA-5: Patrones de asset/UX
// =============================================================================

test('CA-5: "assets UX no están en main" → matched + assetOnly', () => {
    const r = rc.detectDependencyBlock('Los assets UX no están en main todavía');
    assert.equal(r.matched, true);
    assert.equal(r.assetOnly, true);
    assert.deepEqual(r.dependsOn, []);
});

test('CA-5: "recursos UX faltan" → matched + assetOnly', () => {
    const r = rc.detectDependencyBlock('Recursos UX faltan para implementar el flujo');
    assert.equal(r.matched, true);
    assert.equal(r.assetOnly, true);
});

test('CA-5: classify con assetOnly genera reason_summary apropiado', () => {
    const r = rc.classifyRebote({
        motivo: 'Los recursos UX no están en main',
    });
    assert.equal(r.category, 'dependency_block');
    assert.equal(r.label, 'blocked:dependencies');
    assert.deepEqual(r.dependsOn, []);
    assert.match(r.reason_summary, /asset|recurso/i);
});

// =============================================================================
// CA-6: buildDependencyComment parseable por dep-comment-parser
// =============================================================================

test('CA-6: comment con deps numéricas es parseable por dep-comment-parser', () => {
    const body = rc.buildDependencyComment({
        dependsOn: [3083, 2734],
        skill: 'guru',
        reason: 'Test reason',
    });
    // Heading EXACTO esperado por dep-comment-parser.js
    assert.match(body, /^## Dependencias detectadas por el pipeline$/m);
    assert.match(body, /^- #2734$/m);
    assert.match(body, /^- #3083$/m);

    // Validamos que el parser real lo procese
    const parsed = depParser.parseDependencyComment(
        [{ body, createdAt: new Date().toISOString() }],
        9999, // selfIssue distinto
    );
    assert.ok(Array.isArray(parsed), 'parser debe devolver array');
    assert.deepEqual(parsed.map(Number).sort((a, b) => a - b), [2734, 3083]);
});

test('CA-6: comment sin deps numéricas (assetOnly) NO inserta bullets vacíos', () => {
    const body = rc.buildDependencyComment({
        dependsOn: [],
        skill: 'guru',
        reason: 'Asset UX pendiente',
    });
    assert.match(body, /## Dependencias detectadas por el pipeline/);
    assert.doesNotMatch(body, /^- #/m);
});

// =============================================================================
// CA-7 + CA-8: reportDependencyBlock encola artefactos y emite evento
// =============================================================================

test('CA-7: reportDependencyBlock encola label + comment en cola GitHub', () => {
    resetState();
    const result = rc.reportDependencyBlock({
        issue: 3086,
        dependsOn: [3083],
        skill: 'guru',
        phase: 'analisis',
        reason: 'Dependencia #3083 todavía OPEN',
    });
    assert.equal(result.ok, true);
    assert.equal(result.issue, 3086);
    assert.equal(result.label_queued, true);
    assert.equal(result.comment_queued, true);

    const queue = path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente');
    const files = fs.readdirSync(queue).filter(f => f.startsWith('3086-'));
    assert.equal(files.length, 2, 'debe haber 2 archivos encolados (label + comment)');

    const labelFile = files.find(f => f.includes('blocked-dependencies'));
    const commentFile = files.find(f => f.includes('deps-comment'));
    assert.ok(labelFile, 'archivo de label presente');
    assert.ok(commentFile, 'archivo de comment presente');

    const labelPayload = JSON.parse(fs.readFileSync(path.join(queue, labelFile), 'utf8'));
    assert.equal(labelPayload.action, 'label');
    assert.equal(labelPayload.issue, 3086);
    assert.equal(labelPayload.label, 'blocked:dependencies');

    const commentPayload = JSON.parse(fs.readFileSync(path.join(queue, commentFile), 'utf8'));
    assert.equal(commentPayload.action, 'comment');
    assert.equal(commentPayload.issue, 3086);
    assert.match(commentPayload.body, /## Dependencias detectadas por el pipeline/);
    assert.match(commentPayload.body, /- #3083/);
});

test('CA-8: reportDependencyBlock emite evento dependency:blocked', () => {
    resetState();
    rc.reportDependencyBlock({
        issue: 3086,
        dependsOn: [3083, 2734],
        skill: 'guru',
        phase: 'analisis',
    });
    const events = readEvents();
    const ev = events.find(e => e.event === 'dependency:blocked' && e.issue === 3086);
    assert.ok(ev, 'evento dependency:blocked emitido');
    assert.deepEqual(ev.depends_on, [2734, 3083]);
    assert.equal(ev.skill, 'guru');
    assert.equal(ev.phase, 'analisis');
});

test('CA-7: reportDependencyBlock rechaza issue inválido', () => {
    resetState();
    const result = rc.reportDependencyBlock({ issue: 'not-a-number', dependsOn: [3083] });
    assert.equal(result.ok, false);
    assert.match(result.error, /num[eé]rico/);
});

// =============================================================================
// CA-9: sanitizeDepsList
// =============================================================================

test('CA-9: sanitizeDepsList dedup, ordena, descarta inválidos, acepta strings con #', () => {
    const r = rc.sanitizeDepsList([3083, '#2734', 3083, '#abc', null, 0, -5, '2734']);
    assert.deepEqual(r, [2734, 3083]);
});

test('CA-9: sanitizeDepsList acota a MAX_DEPS_PER_BLOCK', () => {
    const huge = Array.from({ length: 50 }, (_, i) => i + 1);
    const r = rc.sanitizeDepsList(huge);
    assert.equal(r.length, rc.MAX_DEPS_PER_BLOCK);
});

// =============================================================================
// CA-10: No interfiere con human-block clásico
// =============================================================================

test('CA-10: motivos clásicos de human-block siguen siendo human_block', () => {
    const motivos = [
        'PR #2547 mergeable pero CODEOWNERS requiere review',
        'Pending human review del feature flag',
        'merge manual pendiente del backend',
        'needs-human: revisión de seguridad obligatoria',
        'aprobación humana pendiente',
    ];
    for (const motivo of motivos) {
        const r = rc.classifyRebote({ motivo });
        assert.equal(r.category, 'human_block', `"${motivo}" debería ser human_block`);
        assert.equal(r.label, 'needs-human');
    }
});

test('CA-10: motivo vacío → code (fallback) sin romper', () => {
    const r = rc.classifyRebote({});
    assert.equal(r.category, 'code');
});

test('CA-10: motivo undefined → code (fallback) sin romper', () => {
    const r = rc.classifyRebote({ motivo: undefined });
    assert.equal(r.category, 'code');
});

// =============================================================================
// Smoke: caso real del incidente #3086
// =============================================================================

test('SMOKE #3086: motivo realístico del guru → dependency_block con #3083', () => {
    // Motivo aproximado al que el guru emitió en el incidente real:
    const motivoReal = [
        'Verificado empíricamente: #3083 (S5 audit trail dinámico) está OPEN.',
        'Sin él, pulpo.js no emite el campo provider en session:start, y el slice',
        'dashboard-slices.js no tiene de dónde sacar el dato. Adicionalmente, los',
        'assets UX no están en main.',
    ].join('\n');

    const r = rc.classifyRebote({ motivo: motivoReal });
    assert.equal(r.category, 'dependency_block');
    assert.ok(r.dependsOn.includes(3083), '#3083 debe estar en dependsOn');
    assert.equal(r.label, 'blocked:dependencies');
});

// ─── #4046 · infra_no_apk no penaliza circuit breaker ───────────────────────
test('#4046 · rebote_categoria=infra_no_apk → infra, counts_against_circuit_breaker=false', () => {
    const r = rc.classifyRebote({
        rebote_categoria: 'infra_no_apk',
        motivo: 'Issue de dashboard sin cambios de app',
    });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
    assert.equal(r.label, null);
});

test('#4046 · motivo con "infra-no-apk" en texto → infra, no penaliza', () => {
    const r = rc.classifyRebote({
        motivo: 'preflight resolvió reason=infra-no-apk (área pipeline sin app/composeApp)',
    });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
});

test('#4046 · rechazo técnico normal sigue contando contra circuit breaker', () => {
    const r = rc.classifyRebote({ motivo: 'la función X no respeta el patrón Do' });
    assert.equal(r.category, 'code');
    assert.equal(r.counts_against_circuit_breaker, true);
});
