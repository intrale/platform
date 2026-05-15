// =============================================================================
// Tests dep-resolver.js — issue #3193
//
// Cubre los criterios de aceptación de la fase `criterios`:
//
//   CA-1  · Sección canónica en body → detectada y destrabada.
//   CA-2  · Sección genérica `## Dependencias` con bullets puros → detectada.
//           Con texto narrativo en líneas → bloque entero ignorado.
//   CA-3  · `Depends on #N` / `Blocked by #N` line-anchored, case-insensitive.
//   CA-4  · Unión de fuentes (comment + body) → source='both', deps unión.
//   CA-5  · Fail-closed: ninguna fuente válida → {deps: null, source: null}.
//   CA-6  · `#N` sueltos en párrafos NO se parsean.
//   CA-7  · Líneas dentro de code fences (```) NO se parsean.
//   CA-8  · Referencias negadas (`does NOT depend on #N`) NO se parsean.
//   CA-9  · Issue numbers inválidos (`#0`, `#-1`, `#999999999`) ignorados.
//   CA-10 · Cap MAX_DEPS=20 aplicado después de dedup.
//   CA-11 · Anti-ReDoS: body de 1 MB completa en < 500 ms (margen para
//           jitter de CI Windows; ReDoS catastrófico tomaría segundos).
//   CA-19 · 3 patrones del body en aislamiento (B1/B2/B3).
//   CA-20 · ReDoS regression + code blocks + bounds + numeric + negative.
//   CA-22 · `parseDependencyComment` mantiene firma intacta (sanity check).
//
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveDependencies,
    parseBodyDependencies,
    buildAutoPromoteComment,
    sanitizeForLog,
    parseCanonicalBlock,
    parseGenericSection,
    parseDependsLines,
    isValidIssueNum,
    MAX_DEPS,
    MAX_ISSUE_NUM,
} = require('../dep-resolver');

const { parseDependencyComment } = require('../dep-comment-parser');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const CANONICAL_BODY = [
    '## Contexto',
    '',
    'Issue paraguas dividido en hijas.',
    '',
    '## Dependencias detectadas por el pipeline',
    '',
    '- #3001',
    '- #3002',
    '- #3003',
    '',
    '---',
    '',
    '## Otra sección',
    '',
    'Mención casual a #9999 que NO debe parsearse.',
].join('\n');

const GENERIC_PURE_BODY = [
    '## Descripción',
    '',
    'Issue creado manualmente con sección genérica.',
    '',
    '## Dependencias',
    '',
    '- #3010',
    '- #3011',
    '',
    '## Otra cosa',
].join('\n');

const GENERIC_NARRATIVE_BODY = [
    '## Dependencias',
    '',
    '- Necesitamos #3020 para arrancar',
    '- También #3021 (opcional)',
].join('\n');

const DEPENDS_ON_BODY = [
    '## Contexto',
    '',
    'Texto del issue.',
    '',
    'Depends on #3030',
    'Blocked by #3031',
    'depends on #3032',
    'BLOCKED BY #3033',
    '',
    'Fin del cuerpo.',
].join('\n');

const COMMENT_CANONICAL = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #4001',
    '- #4002',
].join('\n');

// -----------------------------------------------------------------------------
// Grupo A — patrones individuales del body (CA-1 a CA-3, CA-19)
// -----------------------------------------------------------------------------

test('CA-1/B1: detecta sección canónica en body', () => {
    const out = parseCanonicalBlock(CANONICAL_BODY, null);
    assert.deepEqual(out, [3001, 3002, 3003]);
});

test('CA-1/B1: ignora #N fuera del bloque canónico', () => {
    const out = parseCanonicalBlock(CANONICAL_BODY, null);
    assert.ok(!out.includes(9999));
});

test('CA-2/B2: detecta sección genérica con bullets puros', () => {
    const out = parseGenericSection(GENERIC_PURE_BODY, null);
    assert.deepEqual(out, [3010, 3011]);
});

test('CA-2/B2: ignora sección genérica con texto narrativo', () => {
    const out = parseGenericSection(GENERIC_NARRATIVE_BODY, null);
    assert.deepEqual(out, []);
});

test('CA-3/B3: detecta `Depends on #N` y `Blocked by #N` case-insensitive', () => {
    const out = parseDependsLines(DEPENDS_ON_BODY, null);
    assert.deepEqual(out, [3030, 3031, 3032, 3033]);
});

test('CA-3/B3: NO detecta verbo en medio de párrafo (no anclado)', () => {
    const body = 'Este PR Depends on #1234 según el changelog.';
    const out = parseDependsLines(body, null);
    assert.deepEqual(out, []);
});

// -----------------------------------------------------------------------------
// Grupo B — Falsos positivos bloqueados (CA-6, CA-7, CA-8)
// -----------------------------------------------------------------------------

test('CA-6: #N sueltos en párrafos narrativos NO son interpretados como deps', () => {
    const body = [
        '## Contexto',
        '',
        'Fix relacionado con #123. Ver discusión en #456.',
        '',
        'Tambien tenemos historico de #789 que no es dep.',
    ].join('\n');
    const out = parseBodyDependencies(body, null);
    assert.deepEqual(out, []);
});

test('CA-7: code fences (triple backtick) NO se parsean', () => {
    const body = [
        '## Ejemplo de uso',
        '',
        '```',
        'Depends on #1234',
        'Blocked by #5678',
        '## Dependencias',
        '- #9999',
        '```',
        '',
        'Y un `Depends on #4242` inline tampoco (no es line-anchored).',
    ].join('\n');
    const out = parseBodyDependencies(body, null);
    assert.deepEqual(out, []);
});

test('CA-7: code fences con lenguaje (```js) también excluidos', () => {
    const body = [
        '```js',
        'Depends on #1234',
        '```',
    ].join('\n');
    const out = parseBodyDependencies(body, null);
    assert.deepEqual(out, []);
});

test('CA-7: code fence se cierra correctamente y las deps siguientes SÍ se parsean', () => {
    const body = [
        '```',
        'Depends on #1234',
        '```',
        '',
        'Depends on #5678',
    ].join('\n');
    const out = parseBodyDependencies(body, null);
    assert.deepEqual(out, [5678]);
});

test('CA-8: referencias negadas NO se parsean (does NOT depend on...)', () => {
    const body = [
        'does NOT depend on #1234',
        'no longer blocked by #5678',
        'It does not Depends on #9999 anymore',
    ].join('\n');
    const out = parseBodyDependencies(body, null);
    assert.deepEqual(out, []);
});

// -----------------------------------------------------------------------------
// Grupo C — Bounds, validación numérica, cap (CA-9, CA-10)
// -----------------------------------------------------------------------------

test('CA-9: issue numbers inválidos (#0, negativos, demasiado grandes) ignorados', () => {
    assert.equal(isValidIssueNum(0), false);
    assert.equal(isValidIssueNum(-1), false);
    assert.equal(isValidIssueNum(MAX_ISSUE_NUM), false);
    assert.equal(isValidIssueNum(MAX_ISSUE_NUM + 1), false);
    assert.equal(isValidIssueNum(1), true);
    assert.equal(isValidIssueNum(MAX_ISSUE_NUM - 1), true);
});

test('CA-9: parseDependsLines descarta #0 y #999999999', () => {
    const body = [
        'Depends on #0',
        'Depends on #999999999',
        'Depends on #1234',
    ].join('\n');
    const out = parseDependsLines(body, null);
    assert.deepEqual(out, [1234]);
});

test('CA-10: cap MAX_DEPS=20 aplicado después de dedup', () => {
    const lines = [];
    for (let i = 1; i <= 50; i++) lines.push(`Depends on #${1000 + i}`);
    const out = parseBodyDependencies(lines.join('\n'), null);
    assert.equal(out.length, MAX_DEPS);
    // Orden asc esperado
    for (let i = 0; i < out.length - 1; i++) {
        assert.ok(out[i] < out[i + 1], `output debe estar ordenado asc, falló en idx ${i}`);
    }
});

test('CA-10: dedup correcto antes del cap (50 unique + 50 duplicados → 20)', () => {
    const lines = [];
    for (let i = 1; i <= 50; i++) lines.push(`Depends on #${1000 + i}`);
    for (let i = 1; i <= 50; i++) lines.push(`Blocked by #${1000 + i}`);
    const out = parseBodyDependencies(lines.join('\n'), null);
    assert.equal(out.length, MAX_DEPS);
    // Set sin duplicados
    assert.equal(new Set(out).size, out.length);
});

// -----------------------------------------------------------------------------
// Grupo D — Self-exclusion (consistente con parser actual)
// -----------------------------------------------------------------------------

test('Self-issue excluido del output incluso si aparece en el body', () => {
    const body = [
        'Depends on #100',
        'Blocked by #200',
        'Depends on #300',
    ].join('\n');
    const out = parseBodyDependencies(body, 200);
    assert.deepEqual(out, [100, 300]);
});

// -----------------------------------------------------------------------------
// Grupo E — Orquestador resolveDependencies (CA-4, CA-5)
// -----------------------------------------------------------------------------

test('CA-4: source=both cuando hay deps en comentario Y body', () => {
    const out = resolveDependencies({
        body: DEPENDS_ON_BODY,
        comments: [{ body: COMMENT_CANONICAL, createdAt: '2026-05-14T00:00:00Z' }],
        selfIssue: null,
    });
    assert.equal(out.source, 'both');
    // Unión: 3030..3033 del body + 4001/4002 del comment, ordenados asc
    assert.deepEqual(out.deps, [3030, 3031, 3032, 3033, 4001, 4002]);
});

test('resolveDependencies: source=comment cuando solo el comentario tiene marker', () => {
    const out = resolveDependencies({
        body: '## Contexto\n\nIssue sin deps en body. Menciono #999 casualmente.',
        comments: [{ body: COMMENT_CANONICAL, createdAt: '2026-05-14T00:00:00Z' }],
        selfIssue: null,
    });
    assert.equal(out.source, 'comment');
    assert.deepEqual(out.deps, [4001, 4002]);
});

test('resolveDependencies: source=body cuando solo el body tiene deps (caso #3176)', () => {
    const out = resolveDependencies({
        body: CANONICAL_BODY,
        comments: [],
        selfIssue: null,
    });
    assert.equal(out.source, 'body');
    assert.deepEqual(out.deps, [3001, 3002, 3003]);
});

test('CA-5: fail-closed cuando ninguna fuente tiene marker', () => {
    const out = resolveDependencies({
        body: '## Contexto\n\nMenciono #100 casualmente, sin marker.',
        comments: [{ body: 'comentario sin marker', createdAt: '2026-05-14T00:00:00Z' }],
        selfIssue: null,
    });
    assert.deepEqual(out, { deps: null, source: null });
});

test('CA-5: fail-closed con inputs vacíos', () => {
    assert.deepEqual(
        resolveDependencies({ body: '', comments: [], selfIssue: null }),
        { deps: null, source: null }
    );
    assert.deepEqual(
        resolveDependencies({}),
        { deps: null, source: null }
    );
});

// -----------------------------------------------------------------------------
// Grupo F — Anti-ReDoS y seguridad (CA-11, CA-20)
// -----------------------------------------------------------------------------

test('CA-11/CA-20: body de 1 MB con patrones repetidos completa sin ReDoS', () => {
    // Construir body grande: secciones repetidas de heading + bullets + texto
    // narrativo. Verifica que el state machine line-based escala lineal.
    const section = [
        '## Sección de prueba',
        '',
        'Texto narrativo con menciones #100, #200 y enlaces.',
        '',
        '## Dependencias detectadas por el pipeline',
        '',
        '- #1234',
        '- #5678',
        '',
        'Depends on #4242',
        'Blocked by #4243',
        '',
    ].join('\n');
    let body = '';
    while (body.length < 1024 * 1024) body += section;

    const start = process.hrtime.bigint();
    const out = parseBodyDependencies(body, null);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // El objetivo es detectar backtracking catastrófico (varios segundos),
    // no medir performance fina. 500 ms es generoso para CI Windows con
    // carga concurrente y sigue siendo 10x más rápido que cualquier ReDoS
    // real (típicamente >5 s para patrones catastróficos sobre 1 MB).
    assert.ok(elapsedMs < 500, `parser tomó ${elapsedMs.toFixed(2)} ms — posible ReDoS`);
    // Resultado debe estar cappeado (las deps únicas son pocas pero se repiten).
    assert.ok(out.length <= MAX_DEPS);
    assert.ok(out.length > 0);
});

test('CA-20: bullets con caracteres unicode raros NO rompen el parser', () => {
    const body = [
        '## Dependencias',
        '',
        '- #1234 ★ ✦ 🎉',
        '- #5678',
    ].join('\n');
    // Línea con texto adicional → invalida el bloque genérico.
    const out = parseGenericSection(body, null);
    assert.deepEqual(out, []);
});

// -----------------------------------------------------------------------------
// Grupo G — Auto-promote: comentario canónico + idempotencia (CA-13/CA-14)
// -----------------------------------------------------------------------------

test('CA-13: buildAutoPromoteComment genera markdown con heading canónico + disclaimer', () => {
    const md = buildAutoPromoteComment([3001, 3002]);
    assert.ok(md.includes('## Dependencias detectadas por el pipeline'));
    assert.ok(md.includes('- #3001'));
    assert.ok(md.includes('- #3002'));
    assert.ok(md.includes('Auto-promovido del body'));
    assert.ok(md.includes('⚙️'));
    assert.ok(md.includes('body deja de ser fuente de verdad'));
});

test('CA-14: comentario auto-promovido es parseable por parseDependencyComment (round-trip)', () => {
    const deps = [3001, 3002, 3003];
    const md = buildAutoPromoteComment(deps);
    // Simular que el comentario aparece en el array de comments
    const reparsed = parseDependencyComment(
        [{ body: md, createdAt: '2026-05-14T00:00:00Z' }],
        null
    );
    assert.deepEqual(reparsed, deps);
});

test('CA-14: idempotencia — re-resolver con auto-promote en comments NO duplica deps', () => {
    // Ciclo 1: deps detectadas en body → source='body', auto-promote posted.
    const out1 = resolveDependencies({
        body: CANONICAL_BODY,
        comments: [],
        selfIssue: null,
    });
    assert.equal(out1.source, 'body');

    // Ciclo 2: el comentario auto-promovido ya está en comments. El body
    // sigue teniendo el bloque canónico → ahora source='both' pero las deps
    // son las mismas (union sin duplicados).
    const autoPromoteComment = buildAutoPromoteComment(out1.deps);
    const out2 = resolveDependencies({
        body: CANONICAL_BODY,
        comments: [{ body: autoPromoteComment, createdAt: '2026-05-14T01:00:00Z' }],
        selfIssue: null,
    });
    assert.equal(out2.source, 'both');
    assert.deepEqual(out2.deps, out1.deps);
});

test('CA-13: auto-promote filtra issue numbers inválidos', () => {
    const md = buildAutoPromoteComment([0, -1, 999999999, 1234, 5678]);
    assert.ok(md.includes('- #1234'));
    assert.ok(md.includes('- #5678'));
    assert.ok(!md.includes('- #0'));
    assert.ok(!md.includes('- #-1'));
    assert.ok(!md.includes('- #999999999'));
});

// -----------------------------------------------------------------------------
// Grupo H — Log sanitization (CA-12)
// -----------------------------------------------------------------------------

test('CA-12: sanitizeForLog elimina caracteres de control', () => {
    const out = sanitizeForLog('hola\nmundo\r\nlinea\x00null\x07bell');
    assert.ok(!out.includes('\n'));
    assert.ok(!out.includes('\r'));
    assert.ok(!out.includes('\x00'));
    assert.ok(!out.includes('\x07'));
});

test('CA-12: sanitizeForLog trunca a maxLen', () => {
    const long = 'a'.repeat(500);
    const out = sanitizeForLog(long, 200);
    assert.ok(out.length <= 201); // 200 + ellipsis char
    assert.ok(out.endsWith('…'));
});

test('CA-12: sanitizeForLog acepta input no-string defensivamente', () => {
    assert.equal(sanitizeForLog(null), '');
    assert.equal(sanitizeForLog(undefined), '');
    assert.equal(sanitizeForLog(123), '');
});

test('CA-12: sanitizeForLog no trunca si está bajo el límite', () => {
    const short = 'mensaje corto';
    assert.equal(sanitizeForLog(short, 200), short);
});

// -----------------------------------------------------------------------------
// Grupo I — Compatibilidad (CA-22)
// -----------------------------------------------------------------------------

test('CA-22: parseDependencyComment sigue funcionando idéntico (sanity)', () => {
    const comments = [
        { body: COMMENT_CANONICAL, createdAt: '2026-05-14T00:00:00Z' },
    ];
    const out = parseDependencyComment(comments, null);
    assert.deepEqual(out, [4001, 4002]);
});

test('CA-23: issue con marker canónico en comentario → flujo idéntico al anterior', () => {
    const out = resolveDependencies({
        body: 'Body sin marker',
        comments: [{ body: COMMENT_CANONICAL, createdAt: '2026-05-14T00:00:00Z' }],
        selfIssue: null,
    });
    assert.equal(out.source, 'comment');
    // Mismo resultado que parseDependencyComment directo
    assert.deepEqual(
        out.deps,
        parseDependencyComment(
            [{ body: COMMENT_CANONICAL, createdAt: '2026-05-14T00:00:00Z' }],
            null
        )
    );
});

// -----------------------------------------------------------------------------
// Grupo J — Integración: simulación de #3176/#3177 (CA-21)
// -----------------------------------------------------------------------------

test('CA-21: escenario #3176 — deps en body con sección canónica, comments vacío', () => {
    // Body real-ish: heading canónico + bullets + texto adicional. Sin
    // comentarios del pulpo todavía (issue creado manualmente vía Telegram).
    const body3176 = [
        '## Contexto',
        '',
        'Migración a multi-provider — docs.',
        '',
        '## Dependencias',
        '',
        '- #3160',
        '- #3161',
        '- #3162',
        '',
        '## Criterios de aceptación',
        '',
        '- [ ] Doc creada',
    ].join('\n');
    const out = resolveDependencies({
        body: body3176,
        comments: [],
        selfIssue: 3176,
    });
    assert.equal(out.source, 'body');
    assert.deepEqual(out.deps, [3160, 3161, 3162]);
});

test('CA-21: escenario #3177 — deps en body con verbos GitHub-nativos', () => {
    const body3177 = [
        '## Contexto',
        '',
        'Dashboard UI multi-provider.',
        '',
        'Depends on #3160',
        'Depends on #3161',
        'Blocked by #3170',
    ].join('\n');
    const out = resolveDependencies({
        body: body3177,
        comments: [],
        selfIssue: 3177,
    });
    assert.equal(out.source, 'body');
    assert.deepEqual(out.deps, [3160, 3161, 3170]);
});
