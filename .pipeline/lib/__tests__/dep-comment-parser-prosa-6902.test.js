// =============================================================================
// Tests dep-comment-parser.js — issue #6902
//
// "El marker de dependencias toma menciones narrativas como dependencias duras
//  y genera ciclos madre-hija irrompibles."
//
// Cubre:
//   CA-1 · Una referencia que aparece SÓLO en la prosa no es dependencia.
//   CA-2 · Una referencia declarada como item de lista SÍ lo es (intacto).
//   CA-3 · Regresión contra los markers reales de #6191, #6192, #6207 y #6209,
//          ya corregidos a mano el 04/09: deben resolver exactamente lo mismo.
//   CA-6 · Las referencias descartadas quedan disponibles para el reporte.
//
// Los fixtures de CA-3 son transcripciones textuales de los markers vivos en
// GitHub (`gh issue view <N> --json comments`, comentario del 04/09/2026). No
// se los "limpió" al copiarlos: si el test pasa es porque el parser resuelve el
// marker REAL, no una versión idealizada de él.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/dep-comment-parser-prosa-6902.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseDependencyComment,
    parseDependencyCommentDetailed,
    parseDependenciesFromComment,
    analyzeDependencyBlock,
    extractDeclaredRefsFromLine,
    extractDependencyBlock,
} = require('../dep-comment-parser');

const { resolveDependencies } = require('../dep-resolver');

const comentario = (body, createdAt) => ({ body, createdAt });

// -----------------------------------------------------------------------------
// CA-1 · Mención narrativa que NO debe convertirse en dependencia
// -----------------------------------------------------------------------------

test('CA-1 · una referencia que sólo aparece en la prosa NO es dependencia', () => {
    // Escenario Gherkin del issue: un único bullet declara A; la prosa
    // explicativa menciona además a B para justificar el bloqueo.
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #6190 — crea el módulo único que esta historia consume.',
        '',
        'Esta historia no puede empezar antes de que #6190 cierre: el criterio',
        'CA-4 de la madre #6173 prohibe que el dashboard redacte su propia',
        'version del copy.',
    ].join('\n');

    const deps = parseDependencyComment([comentario(body, '2026-09-04T18:57:31Z')], 6191);
    assert.deepEqual(deps, [6190], 'la única dependencia declarada es #6190');
    assert.ok(!deps.includes(6173), '#6173 se mencionó en prosa, no se declaró');
});

test('CA-1 · la mención dentro de la descripción de un bullet tampoco cuenta', () => {
    // El caso que realmente envenenó a #6207: el `#6199` no estaba en un
    // párrafo aparte sino DENTRO del texto del bullet. Una regla que sólo
    // mirara "líneas que son bullets" no lo hubiera atrapado.
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #6206 — kernel del canal de firma.',
        '- #6192 — dueño del aviso de GATE 1. Decisión de colisión tomada en el',
        '  sizing de #6199: esta historia consume ese aviso.',
    ].join('\n');

    assert.deepEqual(parseDependencyComment([comentario(body, '2026-08-19T17:13:30Z')], 6207), [6206, 6192]);
});

test('CA-1 · un issue absorbido citado para dejar constancia no es dependencia', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #6206 — kernel del canal de firma.',
        '',
        'Absorbe a #5445 (cableado del productor del canal de firma), cerrado como duplicado.',
    ].join('\n');

    assert.deepEqual(parseDependencyComment([comentario(body, '2026-08-19')], 6207), [6206]);
});

test('CA-1 · el wrapper del clasificador de rebotes aplica la MISMA regla', () => {
    // `parseDependenciesFromComment` alimenta al clasificador de rebotes: si
    // ahí la prosa siguiera contando, un `blocked:dependencies` espurio nacería
    // igual, sólo que por la otra puerta.
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #100 — la única dependencia real.',
        '',
        'Contexto: se decidió en #999 y reemplaza a #888.',
    ].join('\n');

    assert.deepEqual(parseDependenciesFromComment(body), [100]);
});

// -----------------------------------------------------------------------------
// CA-2 · La declaración legítima se mantiene intacta
// -----------------------------------------------------------------------------

test('CA-2 · tres dependencias declaradas como items de lista → las tres, sin agregar ni perder', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #6206 — kernel del canal de aprobación.',
        '- #6207 — firma real de GATE 1 desde Telegram.',
        '- #6208 — pieza previa del split, ya cerrada.',
    ].join('\n');

    assert.deepEqual(parseDependencyComment([comentario(body, '2026-09-04')], 6209), [6206, 6207, 6208]);
});

test('CA-2 · formatos de declaración soportados', () => {
    const casos = [
        ['- #100 — bullet con guion', [100]],
        ['* #101 — bullet con asterisco', [101]],
        ['+ #102 — bullet con mas', [102]],
        ['1. #103 — lista numerada con punto', [103]],
        ['2) #104 — lista numerada con parentesis', [104]],
        ['#105 — referencia sin bullet, al inicio de linea', [105]],
        ['- **#106** — referencia con enfasis', [106]],
        ['- [ ] #107 — checkbox', [107]],
        ['  - #108 — bullet indentado', [108]],
        ['- #109, #110 y #111 — varias referencias contiguas', [109, 110, 111]],
        ['| 1 de 3 | #112 | celda declarativa de tabla |', [112]],
    ];
    for (const [linea, esperado] of casos) {
        assert.deepEqual(extractDeclaredRefsFromLine(linea), esperado, `línea: ${linea}`);
    }
});

test('CA-2 · formatos que NO son declaración', () => {
    const casos = [
        'Esta historia espera a #200 porque la madre #201 lo pide.',
        '- Depende de que cierre #202 antes del viernes.',
        'Absorbe a #203, cerrado como duplicado.',
        '**Issues creados automáticamente:** ver #204.',
        '| 1 de 3 | tabla con #205 en prosa dentro de la celda | x |',
    ];
    for (const linea of casos) {
        assert.deepEqual(extractDeclaredRefsFromLine(linea), [], `línea: ${linea}`);
    }
});

test('CA-2 · una descripción larguísima detrás de la referencia no la invalida', () => {
    const linea = '- #6190 — crea `.pipeline/lib/decision-card.js`, el modulo unico de la ficha de decision que esta historia consume.';
    assert.deepEqual(extractDeclaredRefsFromLine(linea), [6190]);
});

// -----------------------------------------------------------------------------
// CA-3 · Regresión contra los markers reales corregidos a mano el 04/09
// -----------------------------------------------------------------------------

// Transcripción textual del comentario del 04/09/2026 de cada issue.
const MARKER_6191 = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6190 — crea `.pipeline/lib/decision-card.js`, el modulo unico de la ficha de decision que esta historia consume.',
    '',
    '---',
    '',
    '_Correccion del marker (Commander, 04/09)._ El marker anterior de esta historia declaraba correctamente **#6190** como unica dependencia, pero la prosa explicativa debajo del bullet mencionaba a la madre del split.',
].join('\n');

const MARKER_6192 = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6190 — crea `.pipeline/lib/decision-card.js`, el modulo unico de la ficha de decision que esta historia consume.',
    '',
    '---',
    '',
    '_Correccion del marker (Commander, 04/09)._ Mismo caso que la hermana #6191: la prosa del marker anterior mencionaba a la madre del split.',
].join('\n');

const MARKER_6207 = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6206 — kernel `approval-channel.js` (`requestSignature` / `submitSignature`); esta historia lo consume y tiene prohibido escribir firmas por su cuenta.',
    '- #6192 — dueno del aviso de GATE 1 (ficha, dedupe persistente, teclado inline autorizado). Esta historia consume ese aviso y no reescribe la presentacion. #6192 entra primero.',
    '',
    '---',
    '',
    '_Correccion del marker (Commander, 04/09)._ Dependencias reales: #6206 (cerrada) y #6192 (abierta).',
].join('\n');

const MARKER_6209 = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6206 — kernel del canal de aprobacion, que esta historia documenta y cubre.',
    '- #6207 — firma real de GATE 1 desde Telegram; el cierre del ciclo no puede verificarse antes de que exista.',
    '- #6208 — pieza previa del split, ya cerrada.',
    '',
    '---',
    '',
    '_Correccion del marker (Commander, 04/09)._ Dependencias reales: #6206 y #6208 (cerradas) y #6207 (abierta).',
].join('\n');

// Markers ORIGINALES (19/08), los que generaron los ciclos. Sirven para
// demostrar que el fix ataca la causa y no sólo el síntoma ya parcheado.
const MARKER_6191_ORIGINAL = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6190 — crea `.pipeline/lib/decision-card.js`, el modulo unico de la ficha de decision que esta historia consume.',
    '',
    'Esta historia no puede empezar antes de que #6190 cierre: el criterio CA-4 de la madre #6173 prohibe que el dashboard redacte su propia version del copy, asi que la tarjeta tiene que importar la ficha ya existente, no inventarla.',
    '',
    'Se aplico `blocked:dependencies`. El brazo de desbloqueo lo quita solo cuando #6190 cierre.',
].join('\n');

const MARKER_6207_ORIGINAL = [
    '## Dependencias detectadas por el pipeline',
    '',
    '- #6206 — kernel `approval-channel.js` (`requestSignature` / `submitSignature`); esta historia lo consume y tiene prohibido escribir firmas por su cuenta.',
    '- #6192 — dueño del aviso de GATE 1 (ficha, dedupe persistente, teclado inline autorizado por `from.id`). Decisión de colisión tomada en `sizing` de #6199: esta historia **consume** ese aviso y **no** reescribe `pulpo.js:5896-5952` en lo que hace a presentación. Por eso no pueden estar en `desarrollo` en paralelo: #6192 entra primero.',
    '',
    'Absorbe a #5445 (cableado del productor del canal de firma del `operator-gate`), cerrado como duplicado.',
].join('\n');

const CASOS_REGRESION = [
    { issue: 6191, marker: MARKER_6191, esperado: [6190] },
    { issue: 6192, marker: MARKER_6192, esperado: [6190] },
    { issue: 6207, marker: MARKER_6207, esperado: [6206, 6192] },
    { issue: 6209, marker: MARKER_6209, esperado: [6206, 6207, 6208] },
];

for (const c of CASOS_REGRESION) {
    test(`CA-3 · marker real de #${c.issue} resuelve las mismas deps después del fix`, () => {
        const deps = parseDependencyComment([comentario(c.marker, '2026-09-04T18:57:31Z')], c.issue);
        assert.deepEqual(deps, c.esperado);
    });

    test(`CA-3 · #${c.issue} vía resolveDependencies (el camino que usa el brazo)`, () => {
        const res = resolveDependencies({ body: '', comments: [comentario(c.marker, '2026-09-04T18:57:31Z')], selfIssue: c.issue });
        assert.equal(res.source, 'comment');
        assert.deepEqual(res.deps.slice().sort((a, b) => a - b), c.esperado.slice().sort((a, b) => a - b));
    });
}

test('CA-3 · el marker ORIGINAL de #6191 ya no arrastra a la madre #6173', () => {
    // Con el parser viejo esto devolvía [6190, 6173] y cerraba el ciclo
    // #6173 → #6191 → #6173 que congeló a las dos historias.
    const deps = parseDependencyComment([comentario(MARKER_6191_ORIGINAL, '2026-08-19T14:15:49Z')], 6191);
    assert.deepEqual(deps, [6190]);
});

test('CA-3 · el marker ORIGINAL de #6207 ya no arrastra ni a la madre #6199 ni al absorbido #5445', () => {
    // Con el parser viejo: [6206, 6192, 6199, 5445].
    const deps = parseDependencyComment([comentario(MARKER_6207_ORIGINAL, '2026-08-19T17:13:30Z')], 6207);
    assert.deepEqual(deps, [6206, 6192]);
});

// -----------------------------------------------------------------------------
// CA-6 · Las referencias descartadas quedan disponibles para reportarlas
// -----------------------------------------------------------------------------

test('CA-6 · el detalle expone la referencia descartada y la línea donde apareció', () => {
    const detalle = parseDependencyCommentDetailed(
        [comentario(MARKER_6191_ORIGINAL, '2026-08-19T14:15:49Z')], 6191);

    assert.deepEqual(detalle.deps, [6190]);
    assert.equal(detalle.ignored.length, 1, 'una sola línea con referencia sospechosa');
    assert.deepEqual(detalle.ignored[0].numbers, [6173]);
    assert.match(detalle.ignored[0].line, /criterio CA-4 de la madre/);
    assert.equal(typeof detalle.ignored[0].lineNo, 'number');
});

test('CA-6 · una referencia ya declarada que la prosa repite NO se reporta como sospechosa', () => {
    // "...hasta que #6190 cierre" repite la dependencia declarada. Reportarla
    // sería ruido, y un reporte ruidoso deja de leerse.
    const detalle = parseDependencyCommentDetailed(
        [comentario(MARKER_6191_ORIGINAL, '2026-08-19')], 6191);
    for (const entry of detalle.ignored) {
        assert.ok(!entry.numbers.includes(6190), '#6190 está declarado, no es sospechoso');
    }
});

test('CA-6 · sin marker el detalle es fail-closed (deps null), no un array vacío', () => {
    const detalle = parseDependencyCommentDetailed([comentario('Comentario suelto con #111', '2026-05-01')], 999);
    assert.equal(detalle.deps, null);
    assert.deepEqual(detalle.ignored, []);
});

// -----------------------------------------------------------------------------
// Robustez
// -----------------------------------------------------------------------------

test('el self-issue nunca entra, ni declarado ni mencionado', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        '- #100 — real.',
        '- #2955 — self, se excluye.',
        '',
        'Esta historia #2955 se explica sola.',
    ].join('\n');
    const detalle = parseDependencyCommentDetailed([comentario(body, '2026-05-01')], 2955);
    assert.deepEqual(detalle.deps, [100]);
    for (const e of detalle.ignored) assert.ok(!e.numbers.includes(2955));
});

test('anti-ReDoS: un bloque de 100k chars de prosa con referencias termina rápido', () => {
    const prosa = 'Contexto narrativo mencionando #1234 y #5678 en cada renglón. '.repeat(1600);
    const body = `## Dependencias detectadas por el pipeline\n\n- #4242\n\n${prosa}`;
    const t0 = Date.now();
    const deps = parseDependencyComment([comentario(body, '2026-05-01')], 1);
    const elapsed = Date.now() - t0;
    assert.deepEqual(deps, [4242]);
    assert.ok(elapsed < 500, `tardó ${elapsed}ms — el parser debe ser lineal`);
});

test('bloque vacío o sin declaraciones → [] (fail-closed en el caller, no destrabe)', () => {
    const body = [
        '## Dependencias detectadas por el pipeline',
        '',
        'Todo el bloque es prosa que menciona #111 y #222 sin declarar nada.',
    ].join('\n');
    // `[]` NO es "sin dependencias, liberá": `allDepsClosed([])` es false y el
    // brazo registra el issue como bloqueado sin liberarlo.
    assert.deepEqual(parseDependencyComment([comentario(body, '2026-05-01')], 1), []);
});

test('analyzeDependencyBlock tolera entradas no-string', () => {
    for (const raro of [null, undefined, 42, {}, []]) {
        assert.deepEqual(analyzeDependencyBlock(raro, null), { deps: [], ignored: [] });
    }
    assert.deepEqual(extractDeclaredRefsFromLine(null), []);
    assert.equal(extractDependencyBlock(undefined), null);
});
