// =============================================================================
// Tests dep-comment-parser.js — issue #3002
//
// Cubre los criterios de aceptación de la fase de criterios:
//
//   CA-1  · Parsing formato planner (heading limpio + bullets `- #N` o `#N`).
//   CA-2  · Parsing formato rejection-report (heading con emoji + sub-heading).
//   CA-3  · Aislamiento del bloque: ignora #N fuera del marker.
//   CA-4  · Fin del bloque correcto: no corta en `\n\n` interno.
//   CA-5  · Sin uso de `\Z` (anchor inexistente en JS).
//   CA-6  · Fail-closed: sin marker → null.
//   CA-7  · Múltiples comentarios del marker → usa el más reciente.
//   CA-8  · Complejidad lineal anti-ReDoS (input largo termina rápido).
//   CA-10 · Caso real reproducible #2955 (input contaminado → solo deps reales).
//   CA-11 · Suite de regression con fixtures (planner, rejection-report, vacíos).
//
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseDependencyComment,
    extractDependencyBlock,
    extractIssueNumbers,
    isMarkerHeading,
} = require('../dep-comment-parser');

// -----------------------------------------------------------------------------
// Fixtures — strings inline para que los tests sean autónomos y la fixture
// del caso real de #2955 quede legible junto al assert.
// -----------------------------------------------------------------------------

// Planner — formato "líneas planas" (`.pipeline/tmp/2565-split-comment.md`).
const FIX_PLANNER_PLAIN = [
    '## Dependencias detectadas por el pipeline',
    '',
    '#2643',
    '#2644',
    '#2645',
    '',
    '---',
    '',
    '## Veredicto del Planner',
    '',
    '**Tamaño**: `size:large` (mencionando #999 fuera de bloque)',
].join('\n');

// Planner — formato "bullets" (`.pipeline/tmp/2473-split-comment.md`).
const FIX_PLANNER_BULLETS = [
    '## Dimensionamiento — Planner',
    '',
    '**Tamaño detectado: GRANDE.**',
    '',
    'Razones (mencionando #2570, #2572 dentro de la justificación):',
    '',
    '- Más de 10 archivos a tocar entre #1234 y #5678 ...',
    '',
    '## Dependencias detectadas por el pipeline',
    '',
    '- #2570',
    '- #2572',
    '- #2574',
    '',
    'Esta historia paraguas queda con label `split` + `blocked:dependencies` ...',
].join('\n');

// rejection-report.js:1857 — formato con emoji 🔗 + sub-heading.
const FIX_REJECTION_REPORT = [
    '## 🔗 Dependencias detectadas por el pipeline',
    '',
    '**Issues creados automáticamente:**',
    '- #2458 — fix: validar input del endpoint X',
    '- #2459 — chore: agregar tests de regression',
    '',
    '**Issues existentes vinculados:**',
    '- #2460 — feat: extender ResponseDTO con campo Z',
    '',
    'Este issue queda bloqueado hasta que se resuelvan las dependencias listadas.',
].join('\n');

// Caso real #2955 — sizing comment del planner mencionando muchos issues
// fantasma seguido del bloque real del marker. Reproduce el bug del issue.
const FIX_2955_SIZING = [
    '## Sizing — planner',
    '',
    '**Tamaño**: grande → dividida en 3 historias hijas.',
    '',
    '**Justificación**: el scope cruza varios subsistemas del pipeline V3 ',
    '(lib + pulpo + commander + dashboard + tests + config + docs), suma 6+ ',
    'archivos modificados/creados y los analisis previos (guru #2801, #2882, ',
    'security #2970, po #2971, planner #2972, ux #2973) ya delinearon 6 fases.',
    '',
    'También hay menciones a #1, justificación histórica de #2701 y enlaces.',
    '',
    '1. **#2974** — Detector + gate determinístico (núcleo).',
    '2. **#2975** — Notificaciones Telegram + respuesta canned.',
    '3. **#2976** — Banner amarillo en dashboard con countdown.',
    '',
    '## Dependencias detectadas por el pipeline',
    '',
    '- #2974',
    '- #2975',
    '- #2976',
    '',
    'Las hijas entran al pipeline de definición en fase `criterios`. ',
    'Cuando cierren las tres, el brazo de desbloqueo quitará `blocked:dependencies` ',
    'automáticamente y este paraguas volverá a la cola.',
].join('\n');

const FIX_2955_BODY_NO_MARKER = [
    '## Problema',
    '',
    'El commander queda mudo cuando se acaba la cuota de Anthropic. Caso real: ',
    'madrugada del 03/05 entre 05:00 y 21:00 quedamos sin commander operativo.',
    '',
    'Mencionamos #1234, #5678 y #9999 como ejemplos en otra parte del body.',
].join('\n');

// -----------------------------------------------------------------------------
// CA-5 · Sin uso de `\Z`
// -----------------------------------------------------------------------------

test('CA-5 · el código del módulo NO usa el anchor `\\Z` en regex ejecutables', () => {
    // Validación por inspección del fuente: si el bug regresa con `\Z`
    // queremos que falle el test, no que falle silenciosamente en producción.
    // Acotamos al código ejecutable: el doc del header DOCUMENTA el bug
    // viejo y lo cita literalmente — eso no debe romper este check.
    const fs = require('fs');
    const path = require('path');
    let src = fs.readFileSync(path.join(__dirname, '..', 'dep-comment-parser.js'), 'utf8');
    // Quitar comentarios de bloque /* ... */ y de línea // ... antes de chequear.
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    src = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.equal(
        /\\Z/.test(src),
        false,
        'el código ejecutable de dep-comment-parser.js no debe usar \\Z (anchor inexistente en JS)'
    );
});

test('CA-5 · funcional: comentarios con la letra Z no rompen el parser', () => {
    // Defensa funcional: si alguien re-introduce `\Z` por error, JS lo
    // tratará como literal Z y un comentario con "Z" puede generar
    // matches espurios. Verificamos que NO ocurre.
    const body = [
        'Zafiro Zarpado Zumbando Zorro Zen.',
        '',
        '## Dependencias detectadas por el pipeline',
        '',
        '- #321',
        '- #654',
        '',
        '---',
        '',
        'Más Zs sueltas: Z Z Z #777',
    ].join('\n');
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, [321, 654]);
});

// -----------------------------------------------------------------------------
// CA-1 · Formato planner (líneas planas + bullets)
// -----------------------------------------------------------------------------

test('CA-1 · planner formato líneas planas (#NNNN) → extrae todas las deps', () => {
    const comments = [{ body: FIX_PLANNER_PLAIN, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 999999);
    assert.deepEqual(result, [2643, 2644, 2645]);
});

test('CA-1 · planner formato bullets (- #NNNN) → extrae solo deps del bloque', () => {
    const comments = [{ body: FIX_PLANNER_BULLETS, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 99999);
    // CRÍTICO: ignora #2570, #2572 que aparecen ANTES del marker (en
    // justificación de sizing) y #1234/#5678 (en bullets de razones).
    assert.deepEqual(result, [2570, 2572, 2574]);
});

// -----------------------------------------------------------------------------
// CA-2 · Formato rejection-report (emoji + sub-heading + bullets `- #N — txt`)
// -----------------------------------------------------------------------------

test('CA-2 · rejection-report formato emoji + sub-heading → extrae solo bullets', () => {
    const comments = [{ body: FIX_REJECTION_REPORT, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 99999);
    // CRÍTICO: incluye los 3 issues bullets, ignora la frase final (no tiene #N
    // pero sí menciones que potencialmente se podrían colar).
    assert.deepEqual(result, [2458, 2459, 2460]);
});

test('CA-2 · rejection-report con frase final que menciona deps → ignora menciones fuera del bloque', () => {
    const body = FIX_REJECTION_REPORT.replace(
        'Este issue queda bloqueado hasta que se resuelvan las dependencias listadas.',
        '## Otra sección\n\nVer también #9999 y #8888 — no son deps.'
    );
    const comments = [{ body, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 99999);
    assert.deepEqual(result, [2458, 2459, 2460]);
});

// -----------------------------------------------------------------------------
// CA-3 · Aislamiento — ignora #N fuera del bloque
// -----------------------------------------------------------------------------

test('CA-3 · ignora #N en otros comentarios sin marker', () => {
    const comments = [
        { body: 'Comentario suelto del PO mencionando #111 y #222', createdAt: '2026-04-01T00:00:00Z' },
        { body: FIX_PLANNER_PLAIN, createdAt: '2026-05-01T10:00:00Z' },
        { body: 'Otro comentario con #333 y #444 al pasar', createdAt: '2026-05-02T00:00:00Z' },
    ];
    const result = parseDependencyComment(comments, 99999);
    assert.deepEqual(result, [2643, 2644, 2645]);
});

test('CA-3 · ignora self-issue aunque aparezca dentro del bloque', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #100',
        '- #2955',  // self
        '- #200',
    ].join('\n');
    const comments = [{ body, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 2955);
    assert.deepEqual(result, [100, 200]);
});

// -----------------------------------------------------------------------------
// CA-4 · Fin del bloque correcto (no cortar en `\n\n` interno)
// -----------------------------------------------------------------------------

test('CA-4 · NO corta en el primer \\n\\n entre heading y bullets (causa raíz del bug)', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',                                     // ← \n\n problemático
        '- #2974',
        '- #2975',
        '- #2976',
    ].join('\n');
    const comments = [{ body, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, 2955);
    assert.deepEqual(result, [2974, 2975, 2976], 'el parser viejo devolvía [] aquí');
});

test('CA-4 · termina el bloque al encontrar otro heading', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #100',
        '- #200',
        '',
        '## Sección siguiente',
        '',
        '- #999 ← NO debería incluirse',
    ].join('\n');
    const comments = [{ body, createdAt: '2026-05-01T10:00:00Z' }];
    const result = parseDependencyComment(comments, null);
    assert.deepEqual(result, [100, 200]);
});

test('CA-4 · termina el bloque al encontrar horizontal rule (---)', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #100',
        '',
        '---',
        '',
        '## Justificación',
        '#999 ← NO debería incluirse',
    ].join('\n');
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, [100]);
});

test('CA-4 · termina el bloque al EOF si no hay otro heading ni HR', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #500',
        '- #501',
    ].join('\n');
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, [500, 501]);
});

// -----------------------------------------------------------------------------
// CA-6 · Fail-closed cuando no hay marker
// -----------------------------------------------------------------------------

test('CA-6 · sin comentarios del marker → null (fail-closed)', () => {
    const comments = [
        { body: 'Comentario del PO mencionando #111 y #222', createdAt: '2026-04-01' },
        { body: 'Otro comentario con #333', createdAt: '2026-04-02' },
    ];
    const result = parseDependencyComment(comments, 999);
    assert.equal(result, null);
});

test('CA-6 · array de comentarios vacío → null', () => {
    assert.equal(parseDependencyComment([], 999), null);
});

test('CA-6 · input no-array no-string → null', () => {
    assert.equal(parseDependencyComment(null, 999), null);
    assert.equal(parseDependencyComment(undefined, 999), null);
    assert.equal(parseDependencyComment(42, 999), null);
});

test('CA-6 · marker presente pero sin issue numbers en el bloque → []', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        'Este bloque está vacío de números, solo texto.',
        'Mencionar #en-otro-lugar no cuenta porque no es \\d+.',
    ].join('\n');
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, []);
});

// -----------------------------------------------------------------------------
// CA-7 · Múltiples comentarios del marker → más reciente
// -----------------------------------------------------------------------------

test('CA-7 · si hay 2 comentarios del marker usa el más reciente por createdAt', () => {
    const oldComment = {
        body: '## Dependencias detectadas por el pipeline\n\n- #100\n- #200',
        createdAt: '2026-04-01T10:00:00Z',
    };
    const newComment = {
        body: '## Dependencias detectadas por el pipeline\n\n- #300\n- #400\n- #500',
        createdAt: '2026-05-01T10:00:00Z',
    };
    // El orden de aparición en el array NO debe importar, solo createdAt.
    const result1 = parseDependencyComment([oldComment, newComment], 999);
    const result2 = parseDependencyComment([newComment, oldComment], 999);
    assert.deepEqual(result1, [300, 400, 500]);
    assert.deepEqual(result2, [300, 400, 500]);
});

test('CA-7 · comentarios sin createdAt válido se ordenan al final (defensive)', () => {
    const validNew = {
        body: '## Dependencias detectadas por el pipeline\n\n- #999',
        createdAt: '2026-05-01T10:00:00Z',
    };
    const noTimestamp = {
        body: '## Dependencias detectadas por el pipeline\n\n- #111',
        createdAt: null,
    };
    const result = parseDependencyComment([noTimestamp, validNew], null);
    assert.deepEqual(result, [999], 'el comentario con createdAt válido gana');
});

// -----------------------------------------------------------------------------
// CA-8 · Anti-ReDoS — input grande termina en tiempo lineal
// -----------------------------------------------------------------------------

test('CA-8 · input de 100k chars termina en menos de 50ms (parsing lineal)', () => {
    // Construir input adversarial: padding antes Y después del marker, con
    // muchas menciones #N que NO deben colarse al output. El bloque del
    // marker se cierra con un `---` para que el parser ignore el padding
    // posterior — así verificamos también CA-3 (aislamiento del bloque).
    const paddingPre = ('blah blah #999 con texto suelto y #1234 mencionado.\n').repeat(2000);
    const paddingPost = ('mas blah #888 en post-padding y #4321 también.\n').repeat(2000);
    const body =
        paddingPre +
        '## Dependencias detectadas por el pipeline\n\n' +
        '- #500\n- #501\n- #502\n\n' +
        '---\n\n' +
        paddingPost;
    assert.ok(body.length > 100000, 'fixture debe superar los 100k chars');

    const t0 = process.hrtime.bigint();
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    const t1 = process.hrtime.bigint();
    const elapsedMs = Number(t1 - t0) / 1e6;

    assert.deepEqual(result, [500, 501, 502]);
    assert.ok(elapsedMs < 50, `parser tardó ${elapsedMs.toFixed(2)}ms, esperado < 50ms`);
});

// -----------------------------------------------------------------------------
// CA-10 · Caso real reproducido #2955
// -----------------------------------------------------------------------------

test('CA-10 · caso real #2955: body + sizing del planner + marker → [2974, 2975, 2976]', () => {
    // Reproduce el escenario REAL del bug:
    //   - body del issue habla de #1234, #5678, #9999 (sin label de dep).
    //   - comentario de sizing del planner menciona #2801, #2882, #2970-2973
    //     dentro de la justificación de tamaño (NO son deps).
    //   - SOLO #2974, #2975, #2976 son las deps reales del bloque marker.
    //
    // Pre-fix #3002: parser devolvía []
    //   → fallback "todos los #N de body+comments" → arrastra TODO
    //   → blockedBy[2955] = [1234, 5678, 9999, 2801, 2882, 2970, 2971, 2972, 2973, 2974, 2975, 2976]
    //   → como 2970-2973 estaban abiertas, paraguas trabado indefinidamente.
    //
    // Post-fix #3002: parser devuelve [2974, 2975, 2976] limpios.
    const issueComments = [
        { body: FIX_2955_SIZING, createdAt: '2026-04-30T12:00:00Z', author: { login: 'leitolarreta' } },
    ];
    const result = parseDependencyComment(issueComments, 2955);
    assert.deepEqual(result, [2974, 2975, 2976]);
});

test('CA-10 · paraguas con body propio (no marker) + sizing planner + ningún otro contexto → solo deps reales', () => {
    // Variante: el `body` también va por separado (no en `comments`), pero
    // el parser actual sólo recibe comments. Verificamos que SIN body, las
    // deps siguen siendo correctas (el body se pasaba al fallback viejo).
    const result = parseDependencyComment([
        { body: FIX_2955_BODY_NO_MARKER, createdAt: '2026-04-29' }, // ← no marker
        { body: FIX_2955_SIZING, createdAt: '2026-04-30' },         // ← marker
    ], 2955);
    assert.deepEqual(result, [2974, 2975, 2976]);
});

// -----------------------------------------------------------------------------
// CA-11 · Suite de regression con fixtures
// -----------------------------------------------------------------------------

test('CA-11 · regression: paraguas con un solo comentario del marker bien formateado', () => {
    // Caso simple — el camino feliz que ya funcionaba en el código viejo
    // PERO sólo cuando el writer ponía las deps en la misma línea.
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #1001',
        '- #1002',
    ].join('\n');
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, [1001, 1002]);
});

test('CA-11 · regression: paraguas con marker pero sin números → []', () => {
    // CA-6 también — el caller debe interpretar [] distinto de null.
    const body = '## Dependencias detectadas por el pipeline\n\nBloque vacío de refs.';
    const result = parseDependencyComment([{ body, createdAt: '2026-05-01' }], null);
    assert.deepEqual(result, []);
});

test('CA-11 · regression: dos comentarios del marker → más reciente gana (stable sort)', () => {
    // Cubierto en CA-7 también, pero acá lo verificamos como regression.
    const t1 = '2026-04-01T00:00:00Z';
    const t2 = '2026-05-01T00:00:00Z';
    const a = { body: '## Dependencias detectadas por el pipeline\n\n- #100', createdAt: t1 };
    const b = { body: '## Dependencias detectadas por el pipeline\n\n- #200\n- #201', createdAt: t2 };
    assert.deepEqual(parseDependencyComment([a, b], null), [200, 201]);
});

// -----------------------------------------------------------------------------
// Helpers internos — tests de unidad de las funciones puras exportadas
// -----------------------------------------------------------------------------

test('isMarkerHeading reconoce los formatos válidos del marker', () => {
    assert.equal(isMarkerHeading('## Dependencias detectadas por el pipeline'), true);
    assert.equal(isMarkerHeading('## 🔗 Dependencias detectadas por el pipeline'), true);
    assert.equal(isMarkerHeading('### Dependencias detectadas por el pipeline'), true);
});

test('isMarkerHeading rechaza líneas que no son el marker', () => {
    assert.equal(isMarkerHeading('Dependencias detectadas por el pipeline'), false);
    assert.equal(isMarkerHeading('#Dependencias detectadas por el pipeline'), false);
    assert.equal(isMarkerHeading('## Las dependencias detectadas por el pipeline'), false);
    assert.equal(isMarkerHeading(''), false);
    assert.equal(isMarkerHeading('## Dependencias detectadas por el pipeline (extra)'), false);
});

test('extractDependencyBlock devuelve null si no hay marker', () => {
    assert.equal(extractDependencyBlock('texto sin marker'), null);
    assert.equal(extractDependencyBlock(''), null);
    assert.equal(extractDependencyBlock(null), null);
});

test('extractIssueNumbers descarta valores no positivos y deduplica', () => {
    const text = '#1 #2 #1 #2 #0 #999';
    assert.deepEqual(extractIssueNumbers(text, null), [1, 2, 999]);
});

test('extractIssueNumbers excluye self-issue aunque aparezca varias veces', () => {
    assert.deepEqual(extractIssueNumbers('#100 #200 #100 #300', 100), [200, 300]);
});

// -----------------------------------------------------------------------------
// Compat: legacy callers que pasaban un único string concatenado
// -----------------------------------------------------------------------------

test('compat · acepta string único como input (legacy callers)', () => {
    const body = '## Dependencias detectadas por el pipeline\n\n- #777\n- #778';
    const result = parseDependencyComment(body, null);
    assert.deepEqual(result, [777, 778]);
});

test('compat · string sin marker → null (no fallback a "todos los #N")', () => {
    const body = 'Texto plano con #111, #222 y #333 sin marker.';
    const result = parseDependencyComment(body, null);
    assert.equal(result, null, 'sin marker el fallback debe ser fail-closed');
});
