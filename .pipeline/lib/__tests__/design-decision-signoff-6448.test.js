// =============================================================================
// #6448 — El gate de decisión de arquitectura frena issues con receta ya firmada
//
// EL INCIDENTE QUE ESTO CUBRE (2026-08-24). #6431 fue movido a bloqueo humano a
// las 13:29:23Z por `detectDesignDecision()`, con el motivo "el issue plantea
// opciones excluyentes sin elegir una". La premisa era falsa: #6431 YA tenía
// publicada la firma del arquitecto con la receta técnica cerrada. El detector
// leyó la enumeración de decisiones YA TOMADAS como decisiones PENDIENTES,
// porque `isDecisionSettled()` sólo miraba el body y los labels — y la firma
// vive en un COMENTARIO, que es justo donde el pipeline la deposita.
//
// Costo medido: #6432 depende de #6431 y #6423 de ambos. Con los tres frenados
// el despachador reportó "no hay trabajo habilitado" durante más de una hora.
//
// CERO ACCESO A RED (CA-31): comentarios y timestamps se inyectan.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const design = require('../design-decision-detect');
const io = require('../design-decision-gate-io');
const humanBlock = require('../human-block');
const { resolveGhBin } = require('../gh-bin');

// -----------------------------------------------------------------------------
// Fixtures congelados. Son datos REALES del incidente, no invenciones parecidas:
// una firma sintética "más o menos igual" es exactamente lo que dejó pasar el
// defecto que rebotó la receta dos veces.
// -----------------------------------------------------------------------------

const MARCADOR_6431 = '<!-- architect-signoff issue=6431 -->';

/** #6431 — la firma real NO lleva pie de agente. Margen medido: 63 segundos. */
const FIXTURE_6431 = Object.freeze({
    lastEditedAt: '2026-08-24T13:24:26Z',
    comments: [
        {
            createdAt: '2026-08-24T13:25:29Z', authorAssociation: 'MEMBER', isMinimized: false,
            author: { login: 'leitolarreta' },
            body: `${MARCADOR_6431}\n## ✅ Arquitecto — firma de pre-admisión\n\nIssue habilitado para promoción a \`Ready\`.`,
        },
        {
            // El propio aviso de destrabe CITA el marcador sin ser línea
            // completa. Con un regex de substring, este comentario desarma el
            // gate solo (trampa B).
            createdAt: '2026-08-24T14:51:59Z', authorAssociation: 'MEMBER', isMinimized: false,
            author: { login: 'leitolarreta' },
            body: `El aviso menciona \`${MARCADOR_6431}\` dentro de una línea con más texto.`,
        },
    ],
});

/**
 * #6448 — la firma real SÍ lleva pie de agente, y el skill declarado es
 * `architect`. Margen medido: 43 segundos.
 *
 * Este fixture es el contra-caso que hace visible el defecto que rebotó la
 * receta: implementada como "cualquier pie de agente descalifica", la batería
 * entera pasaba en verde con el gate rechazando la firma del propio arquitecto.
 */
const FIRMA_6448_BODY = '<!-- architect-signoff issue=6448 -->\n'
    + '## ✅ Arquitecto — firma de pre-admisión\n\n'
    + 'Issue habilitado para promoción a `Ready`.\n\n---\n'
    + '🤖 `architect` · fase `criterios` · pipeline `definicion` · HEAD `b21526863`';

const FIXTURE_6448 = Object.freeze({
    lastEditedAt: '2026-08-24T15:41:35Z',
    comments: [{
        createdAt: '2026-08-24T15:42:18Z', authorAssociation: 'MEMBER', isMinimized: false,
        author: { login: 'leitolarreta' }, body: FIRMA_6448_BODY,
    }],
});

/** Traza local que corrobora (condición (g) cumplida por el camino normal). */
const AUDIT_OK = Object.freeze({ available: true, corroborated: true });
/** Traza local ausente: la excepción de CA-34. */
const AUDIT_AUSENTE = Object.freeze({ available: false, corroborated: false });

/**
 * Body real del tipo que disparó #6431: enumera alternativas de arquitectura.
 * Dispara `alternativas-enumeradas` con marco decisorio.
 */
const BODY_CON_SENAL = 'Hay que decidir entre dos alternativas para el store: '
    + 'la opción A guarda el estado en disco local del host; '
    + 'la opción B lo centraliza en un servicio compartido.';

const firmaDe = (fx, issue, audit = AUDIT_OK) => design.evaluateArchitectSignoff({
    issue, comments: fx.comments, lastEditedAt: fx.lastEditedAt, audit,
});

/** Comentario de firma sintético parametrizable, sobre la base de #6448. */
function comentarioFirma(over = {}) {
    return Object.assign({
        createdAt: '2026-08-24T15:42:18Z',
        authorAssociation: 'MEMBER',
        isMinimized: false,
        author: { login: 'leitolarreta' },
        body: FIRMA_6448_BODY,
    }, over);
}

// =============================================================================
// GRUPO A — La firma cierra la decisión
// =============================================================================

test('CA-1: señal en el body + firma posterior a la última edición ⇒ NO escala', () => {
    const firma = firmaDe(FIXTURE_6431, 6431);
    assert.equal(firma.settled, true, 'la firma real de #6431 tiene que contar');

    const v = design.detectDesignDecision({
        issue: 6431, title: 'Store del estado', body: BODY_CON_SENAL, signoff: firma,
    });
    assert.equal(v.escalate, false, 'con firma vigente el gate deja pasar');
    assert.ok(v.signals.includes('alternativas-enumeradas'),
        'la señal se sigue detectando: el fix no desarma la detección, agrega el cierre');
    assert.match(v.note, /firma del arquitecto cierra la decisión/,
        'CA-1: queda registrado que la firma cerró la decisión');
});

test('CA-2: el MISMO body SIN firma sí escala (el gate no se desarma)', () => {
    const v = design.detectDesignDecision({
        issue: 6431, title: 'Store del estado', body: BODY_CON_SENAL,
        signoff: { settled: false, reason: 'sin firma', rejected: [] },
    });
    assert.equal(v.escalate, true);
    assert.ok(v.signals.includes('alternativas-enumeradas'));

    // Y sin pasar `signoff` en absoluto: el comportamiento histórico intacto.
    const sinCampo = design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL });
    assert.equal(sinCampo.escalate, true);
});

test('CA-3: firma ANTERIOR a la última edición del body ⇒ escala (firma obsoleta)', () => {
    // Mismo fixture, con el body editado DESPUÉS de firmar.
    const firma = design.evaluateArchitectSignoff({
        issue: 6431,
        comments: FIXTURE_6431.comments,
        lastEditedAt: '2026-08-24T18:00:00Z',   // posterior a la firma (13:25:29Z)
        audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false, 'una firma obsoleta no cierra nada');
    assert.ok(firma.rejected.some((r) => /anterior-a-la-ultima-edicion/.test(r.motivo)),
        'CA-28: el descarte por obsolescencia queda en la traza con su motivo');

    const v = design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL, signoff: firma });
    assert.equal(v.escalate, true);
});

test('CA-4: reproducción del incidente real de #6431, con y sin firma', () => {
    // Margen REAL de 63 segundos: 13:24:26Z (edición) contra 13:25:29Z (firma).
    // Cualquier redondeo a minutos rompe este caso.
    const edicion = Date.parse(FIXTURE_6431.lastEditedAt);
    const firmado = Date.parse(FIXTURE_6431.comments[0].createdAt);
    assert.equal(firmado - edicion, 63000, 'precondición: el margen real es de 63 s');

    const conFirma = firmaDe(FIXTURE_6431, 6431);
    assert.equal(conFirma.settled, true);
    assert.equal(
        design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL, signoff: conFirma }).escalate,
        false, 'con la firma real, #6431 NO se habría frenado');

    const sinFirma = design.evaluateArchitectSignoff({
        issue: 6431,
        comments: [FIXTURE_6431.comments[1]],   // sólo el comentario que CITA el marcador
        lastEditedAt: FIXTURE_6431.lastEditedAt,
        audit: AUDIT_OK,
    });
    assert.equal(sinFirma.settled, false);
    assert.equal(
        design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL, signoff: sinFirma }).escalate,
        true, 'sin firma el gate sigue frenando');
});

test('CA-5: lastEditedAt nulo (body nunca editado) ⇒ la firma cuenta', () => {
    for (const vacio of [null, undefined, '']) {
        const firma = design.evaluateArchitectSignoff({
            issue: 6448, comments: FIXTURE_6448.comments, lastEditedAt: vacio, audit: AUDIT_OK,
        });
        assert.equal(firma.settled, true,
            `lastEditedAt=${JSON.stringify(vacio)} significa "no hay edición posterior", no "editado recién"`);
    }
});

// =============================================================================
// GRUPO B — Qué NO cuenta como firma (D-1, cada condición con su contra-caso)
// =============================================================================

test('CA-6: el marcador CITADO dentro de una línea con más texto no cuenta', () => {
    const firma = design.evaluateArchitectSignoff({
        issue: 6431,
        comments: [FIXTURE_6431.comments[1]],
        lastEditedAt: FIXTURE_6431.lastEditedAt,
        audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false,
        'el propio aviso de destrabe cita el marcador: con un regex laxo desarma el gate solo');
});

test('CA-7: marcador con el número de OTRO issue no cuenta', () => {
    // Una firma de #6431 pegada dentro de #6432 no puede desarmar #6432.
    const firma = design.evaluateArchitectSignoff({
        issue: 6432, comments: FIXTURE_6431.comments, lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false);
    assert.ok(firma.rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.OTRO_ISSUE));
});

test('CA-8: authorAssociation NONE / CONTRIBUTOR no cuenta', () => {
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', undefined]) {
        const firma = design.evaluateArchitectSignoff({
            issue: 6448, comments: [comentarioFirma({ authorAssociation: assoc })],
            lastEditedAt: null, audit: AUDIT_OK,
        });
        assert.equal(firma.settled, false, `authorAssociation=${assoc} no puede firmar`);
        assert.ok(firma.rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.AUTORIA));
    }
});

test('CA-9: marcador estricto + MEMBER + pie de agente AJENO ⇒ no cuenta', () => {
    // Es el paso 3 de la cadena de explotación de R-1: el repo es público, un
    // tercero abre un issue con prompt-injection, un agente LLM lo lee y emite
    // el marcador en su salida. Ese comentario se autodeclara con SU skill.
    for (const ajeno of ['guru', 'po', 'doc', 'ux']) {
        const body = FIRMA_6448_BODY.replace('`architect` · fase', `\`${ajeno}\` · fase`);
        const firma = design.evaluateArchitectSignoff({
            issue: 6448, comments: [comentarioFirma({ body })], lastEditedAt: null, audit: AUDIT_OK,
        });
        assert.equal(firma.settled, false, `un pie de \`${ajeno}\` no puede firmar`);
        assert.ok(firma.rejected.some((r) => r.motivo === `${design.SIGNOFF_REJECT.FOOTER}:${ajeno}`),
            'CA-28: el descarte por autoría de agente queda en la traza');
    }

    // La otra forma que emiten los agentes en producción.
    const otraForma = `<!-- architect-signoff issue=6448 -->\nOK.\n\n> Producido por el agente \`ux\` en la fase \`criterios\`.`;
    const f2 = design.evaluateArchitectSignoff({
        issue: 6448, comments: [comentarioFirma({ body: otraForma })], lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(f2.settled, false);
});

test('CA-9b: la firma REAL de #6448 —con pie propio `architect`— SÍ cuenta', () => {
    // Sin este caso el defecto vuelve a colarse por el mismo agujero: medido
    // sobre las 5 firmas estrictas reales del repo, 1 lleva el pie (#6448) y 4
    // no (#6431, #6199, #5440 ×2). Elegir sólo un fixture sin pie deja la
    // batería en verde con el gate rechazando la firma legítima.
    assert.deepEqual([...design.skillsDeclarados(FIRMA_6448_BODY)], ['architect'],
        'precondición: el pie de la firma real declara `architect`');

    const firma = firmaDe(FIXTURE_6448, 6448);
    assert.equal(firma.settled, true, 'el pie del propio arquitecto no puede auto-descalificar su firma');

    const margen = Date.parse(FIXTURE_6448.comments[0].createdAt) - Date.parse(FIXTURE_6448.lastEditedAt);
    assert.equal(margen, 43000, 'precondición: el margen real de #6448 es de 43 s');
});

test('CA-9c: una sección de handoff nunca es una firma, aunque diga `architect`', () => {
    const body = `<!-- architect-signoff issue=6448 -->\n## architect · 2026-08-24T15:42:18Z\n\nResumen para el próximo agente.`;
    const firma = design.evaluateArchitectSignoff({
        issue: 6448, comments: [comentarioFirma({ body })], lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false);
    assert.ok(firma.rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.HANDOFF));
});

test('CA-10: comentario minimizado (oculto por spam/abuse) no cuenta', () => {
    const firma = design.evaluateArchitectSignoff({
        issue: 6448, comments: [comentarioFirma({ isMinimized: true })],
        lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false);
    assert.ok(firma.rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.MINIMIZADO));
});

test('CA-11: login distinto del bot declarado pero MEMBER ⇒ SÍ cuenta', () => {
    // Sin este test el fix pasa con fixtures y NO arregla producción: la firma
    // real de #6431 tiene `author.login = leitolarreta`, no `architect-bot`.
    const gate = require('../architect-signoff-gate');
    assert.equal(gate.DEFAULT_BOT_LOGIN, 'architect-bot', 'precondición del contra-caso');

    const firma = design.evaluateArchitectSignoff({
        issue: 6448,
        comments: [comentarioFirma({ author: { login: 'leitolarreta' }, authorAssociation: 'MEMBER' })],
        lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, true, 'la validación es por asociación, no por identidad de bot');
});

test('CA-11 bis: la validación reusa las constantes exportadas, no copias locales', () => {
    // Dos definiciones del mismo contrato divergen. El regex laxo hace que el
    // aviso de destrabe —que cita el marcador— desarme el gate.
    const src = fs.readFileSync(path.join(__dirname, '..', 'design-decision-detect.js'), 'utf8');
    assert.match(src, /architectGate\.STRICT_MARKER_LINE_REGEX/,
        'A-5: el marcador se importa, no se redefine');
    assert.match(src, /architectGate\.ALLOWED_AUTHOR_ASSOCIATIONS/,
        'A-4: la allowlist de asociación se importa');
    assert.match(src, /SECTION_HEADER_RE/, 'CA-9c: el marcador de handoff se importa de su módulo');
    assert.doesNotMatch(src, /bot_login/, 'D-2: NO se valida contra la identidad de bot');
});

// =============================================================================
// GRUPO C — Costo y robustez
// =============================================================================

test('CA-12: el camino feliz no paga NI UNA llamada de red', () => {
    // El criterio se verifica, no se argumenta: doble inyectado que cuenta.
    let llamadas = 0;
    const execFalso = () => { llamadas += 1; return '{}'; };

    const v = design.detectDesignDecision({
        issue: 1,
        title: 'Corregir el typo del banner',
        body: 'El banner dice "Pendinte". Cambiar el string y agregar un test.',
    });
    assert.equal(v.escalate, false, 'precondición: issue sin señales');
    assert.equal(v.signals.length, 0);

    // El caller sólo consulta cuando el detector YA decidió escalar. Sin
    // escalado no hay invocación: el contador queda en cero.
    if (v.escalate) io.fetchSignoffContext(1, { exec: execFalso });
    assert.equal(llamadas, 0, 'CA-12: cero llamadas nuevas en el 99% de los issues');
});

test('CA-12 bis: el gate del pulpo consulta la firma DENTRO de la rama de escalado', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const gate = src.indexOf('const veredicto = designDecision.detectDesignDecision(');
    assert.ok(gate > 0, 'precondición: el gate sigue en el intake');
    const fin = src.indexOf('detector de decisión de arquitectura falló', gate);
    const bloque = src.slice(gate, fin);

    const fetch = bloque.indexOf('fetchSignoffContext');
    const escalado = bloque.indexOf('if (veredicto.escalate)');
    assert.ok(escalado >= 0 && fetch > escalado,
        'la consulta de firma va DESPUÉS del chequeo de señales, nunca antes (A-3/CA-12)');
    assert.match(bloque, /require\('\.\/lib\/design-decision-gate-io'\)/,
        'el require es lazy: en el camino feliz ni se carga el módulo');
});

test('CA-13: firma y fecha de edición del body vienen en UN SOLO round-trip', () => {
    let llamadas = 0;
    const execFalso = () => {
        llamadas += 1;
        return JSON.stringify({ data: { repository: { issue: {
            lastEditedAt: '2026-08-24T13:24:26Z',
            comments: { nodes: FIXTURE_6431.comments },
        } } } });
    };
    const ctx = io.fetchSignoffContext(6431, { exec: execFalso });
    assert.equal(llamadas, 1, 'dos llamadas serían dos oportunidades de fallar');
    assert.equal(ctx.ok, true);
    assert.equal(ctx.lastEditedAt, '2026-08-24T13:24:26Z');
    assert.equal(ctx.comments.length, 2);

    assert.match(io.SIGNOFF_QUERY, /lastEditedAt/);
    assert.match(io.SIGNOFF_QUERY, /comments\(last:/);
    // A-6 — `updatedAt` queda PROHIBIDO: cambia con cualquier comentario o
    // label, así que usarlo invalidaría toda firma y el gate frenaría MÁS.
    assert.doesNotMatch(io.SIGNOFF_QUERY, /updatedAt/);
});

test('A-6: ningún módulo del gate usa `updatedAt` como fecha de edición', () => {
    for (const f of ['design-decision-detect.js', 'design-decision-gate-io.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const usos = src.split('\n')
            .map((l, i) => ({ l, i }))
            .filter((x) => /\bupdatedAt\b/.test(x.l) && !/^\s*(\/\/|\*)/.test(x.l));
        assert.equal(usos.length, 0, `${f} no puede leer updatedAt (línea ${usos[0] && usos[0].i})`);
    }
});

// -----------------------------------------------------------------------------
// #7438 — el binario `gh` se resuelve con el helper único (causa raíz de #7113)
// -----------------------------------------------------------------------------

test('#7438 / RS-1.4: `exec` que lanza ENOENT ⇒ ok:false con `gh falló:`, y el file NO es el literal pelado', () => {
    let argv = null;
    const enoent = () => {
        throw Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' });
    };
    const r = io.fetchSignoffContext(7113, { exec: (file, args, options) => { argv = { file, args, options }; return enoent(); } });
    assert.deepEqual(r, { ok: false, lastEditedAt: null, comments: [], error: 'gh falló: spawnSync gh ENOENT' });
    assert.equal(argv.file, resolveGhBin(), 'el binario que se intentó es el resuelto por el helper');
    if (process.platform === 'win32') assert.notEqual(argv.file, 'gh');
});

test('#7438: `ghBin` inyectado tiene precedencia y las options llevan windowsHide sin shell', () => {
    let argv = null;
    io.fetchSignoffContext(7113, { ghBin: '/x/gh', exec: (file, args, options) => { argv = { file, args, options }; return '{}'; } });
    assert.equal(argv.file, '/x/gh');
    assert.deepEqual(argv.args.slice(0, 2), ['api', 'graphql']);
    assert.equal(argv.options.windowsHide, true, 'sin flash de consola bajo watchdog.ps1');
    assert.equal(argv.options.encoding, 'utf8');
    assert.equal(typeof argv.options.timeout, 'number');
    assert.ok(!('shell' in argv.options), 'RS-1.2: nunca por shell');
});

test('#7438 / CA-2: design-decision-gate-io.js consume lib/gh-bin.js y no tiene `gh` pelado ni execSync', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'design-decision-gate-io.js'), 'utf8');
    assert.match(src, /require\(['"]\.\/gh-bin['"]\)/, 'debe consumir el helper único');
    assert.doesNotMatch(src, /'gh'/, 'cero literal `gh` pelado');
    assert.doesNotMatch(src, /\bexecSync\b/, 'cero execSync');
    assert.doesNotMatch(src, /\$\{ghBin\}/, 'cero interpolación del binario');
});

test('CA-14: falla de red / respuesta inválida ⇒ escala, y nunca lanza', () => {
    const casos = [
        ['exec explota', () => { throw new Error('gh: connect ETIMEDOUT'); }],
        ['JSON ilegible', () => 'no-soy-json'],
        ['errors de GraphQL', () => JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'x' }] })],
        ['sin issue', () => JSON.stringify({ data: { repository: {} } })],
        ['comments no es array', () => JSON.stringify({ data: { repository: { issue: { comments: { nodes: 'x' } } } } })],
    ];
    for (const [nombre, execFalso] of casos) {
        const ctx = io.fetchSignoffContext(6431, { exec: execFalso });
        assert.equal(ctx.ok, false, `${nombre}: tiene que fallar cerrado`);
        assert.ok(ctx.error && ctx.error.length > 0, `${nombre}: el motivo técnico queda registrado`);
        assert.ok(ctx.error.length <= 120, `${nombre}: el motivo va acotado`);

        // El caller arma el veredicto fail-closed y el issue ESCALA.
        const firma = { settled: false, reason: `firma no verificable: ${ctx.error}`, rejected: [] };
        assert.equal(
            design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL, signoff: firma }).escalate,
            true, `${nombre}: "no pude comprobar que un humano firmó" nunca es "asumo que firmó"`);
    }
});

test('CA-14 bis: `evaluateArchitectSignoff` nunca lanza con input basura', () => {
    const basura = [
        undefined, {}, { issue: 6448 },
        { issue: 'x', comments: [], lastEditedAt: null },
        { issue: 6448, comments: 'no-array', lastEditedAt: null },
        { issue: 6448, comments: [null, 7, 'x'], lastEditedAt: null },
        { issue: 6448, comments: FIXTURE_6448.comments, lastEditedAt: 'no-es-fecha' },
        { issue: -1, comments: [], lastEditedAt: null },
    ];
    for (const arg of basura) {
        const r = design.evaluateArchitectSignoff(arg);
        assert.equal(r.settled, false, `input ${JSON.stringify(arg)} tiene que fallar cerrado`);
        assert.ok(typeof r.reason === 'string' && r.reason);
        assert.ok(Array.isArray(r.rejected));
    }
});

test('CA-15: `isDecisionSettled` mantiene la invocación histórica de dos campos', () => {
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [] }), false);
    assert.equal(design.isDecisionSettled({ body: 'Decisión tomada: vault externo.', labels: [] }), true);
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: ['decision:approved'] }), true);
    assert.equal(design.isDecisionSettled(), false);
    // Y el campo nuevo es aditivo.
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [], signoff: { settled: true } }), true);
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [], signoff: { settled: false } }), false);
});

test('CA-15 bis: `detectDesignDecision` sigue siendo síncrona y sin lanzar', () => {
    const v = design.detectDesignDecision({ issue: 1, body: BODY_CON_SENAL });
    assert.ok(!(v instanceof Promise), 'volverla async rompería el fail-open del intake');
    for (const bad of [undefined, {}, { body: null, title: null }, { body: {}, labels: 'x' }]) {
        assert.equal(design.detectDesignDecision(bad).escalate, false);
    }
});

test('CA-16: el número de issue va como variable tipada, jamás interpolado', () => {
    assert.doesNotMatch(io.SIGNOFF_QUERY, /\$\{/, 'el número no puede vivir en el string de la query');
    assert.match(io.SIGNOFF_QUERY, /\$num:Int!/, 'va como variable tipada de GraphQL');

    let argv = null;
    io.fetchSignoffContext(6431, { exec: (file, args, options) => { argv = { file, args, options }; return '{}'; } });
    // #7438: el binario ya no es el literal pelado sino el resuelto por el helper.
    assert.equal(argv.file, resolveGhBin(), 'se invoca el binario resuelto por resolveGhBin()');
    assert.ok(Array.isArray(argv.args), 'se invoca por argv, nunca por shell');
    assert.ok(!argv.options || !('shell' in argv.options), 'sin `shell` en las options');
    if (process.platform === 'win32') assert.notEqual(argv.file, 'gh', 'en win32 nunca el literal pelado');
    assert.ok(argv.args.includes('-F'), 'el número entra como variable (`-F`), no como parte del query');
    assert.ok(argv.args.includes('num=6431'));

    // `issueNum` nace de nombres de archivo del filesystem: la validación va
    // ANTES de armar el comando.
    let toco = false;
    for (const malo of ['6431; rm -rf /', '../../etc', '', null, 0, -3, 1.5, '00042abc']) {
        const r = io.fetchSignoffContext(malo, { exec: () => { toco = true; return '{}'; } });
        assert.equal(r.ok, false, `"${malo}" no puede llegar a gh`);
    }
    assert.equal(toco, false, 'ningún identificador inválido tocó la red');
});

// =============================================================================
// GRUPO D — El aviso que lee el operador
// =============================================================================

test('CA-17/CA-19: el aviso RENDERIZADO incluye la cita del issue, rotulada', () => {
    // Se assertea sobre el TEXTO RENDERIZADO, no sobre `veredicto.reason`: un
    // test sobre el objeto pasa en verde con el operador viendo el mensaje
    // cortado a mitad de palabra, que es el modo de falla que `ux` midió.
    const v = design.detectDesignDecision({ issue: 6431, title: 'Store', body: BODY_CON_SENAL });
    assert.ok(v.fragment, 'CA-17: el veredicto expone el fragmento disparador');

    const texto = humanBlock.buildBlockedSummaryPlain({
        blocked: [],
        nowMs: Date.parse('2026-08-24T14:00:00Z'),
        highlight: {
            issue: 6431, skill: 'definicion', phase: 'analisis', titulo: 'Store del estado',
            reason: v.reason, question: v.question, recommendation: v.recommendation,
            evidence: v.fragment, blocked_at: '2026-08-24T13:29:23Z',
        },
    });
    assert.match(texto, /Texto del issue: "/, 'CA-19: la cita va ROTULADA como cita del issue');
    assert.match(texto, /alternativas/, 'CA-17: el fragmento disparador llega al operador');
});

test('CA-UX-3: sin `evidence` el aviso sale byte por byte igual que antes', () => {
    const base = {
        blocked: [], nowMs: Date.parse('2026-08-24T14:00:00Z'),
        highlight: {
            issue: 6431, skill: 'definicion', phase: 'analisis', titulo: 'Store',
            reason: 'Motivo cualquiera.', question: '¿Seguimos?',
            blocked_at: '2026-08-24T13:29:23Z',
        },
    };
    const sinCampo = humanBlock.buildBlockedSummaryPlain(base);
    const conVacio = humanBlock.buildBlockedSummaryPlain({
        ...base, highlight: { ...base.highlight, evidence: '' },
    });
    assert.equal(sinCampo, conVacio);
    assert.doesNotMatch(sinCampo, /Texto del issue/,
        'la línea es CONDICIONAL: ningún caller actual cambia un byte');
});

test('CA-18: el fragmento tiene tope duro EN EL ORIGEN, no delegado a la vista', () => {
    const relleno = 'palabra '.repeat(900);   // >4000 chars sin saltos de línea
    const body = `Hay que decidir entre dos alternativas: la opción A ${relleno} contra la opción B.`;
    const v = design.detectDesignDecision({ issue: 1, body });
    assert.ok(v.fragment.length > 0);
    assert.ok(v.fragment.length <= design.FRAGMENT_MAX,
        `el fragmento mide ${v.fragment.length}: un body de 60 KB no puede viajar entero al disco`);
});

test('CA-UX-5: corta en borde de palabra, cierra con UNA elipsis y comillas balanceadas', () => {
    const relleno = 'contenido '.repeat(400);
    const body = `Hay que decidir entre dos alternativas: la opción A ${relleno} "cita abierta contra la opción B.`;
    const v = design.detectDesignDecision({ issue: 1, body });

    assert.ok(v.fragment.endsWith('…'), 'termina en elipsis');
    assert.doesNotMatch(v.fragment, /\.\.\.$/, 'una elipsis, no tres puntos');
    assert.doesNotMatch(v.fragment, /\s…$/, 'sin espacio colgando antes de la elipsis');
    assert.equal((v.fragment.match(/"/g) || []).length % 2, 0, 'comillas balanceadas');
    assert.doesNotMatch(v.fragment, /[\r\n]/, 'sin saltos: rompen la línea del aviso');

    // Y el balanceo también resiste el caso directo.
    assert.equal((design.signalFragment(
        ['Hay que elegir entre la opción A y la opción B: la "primera'],
        design.DESIGN_DECISION_SIGNALS[0],
    ).match(/"/g) || []).length % 2, 0);
});

test('CA-20 / CA-UX-4: el copy del operador no lleva jerga ni keys internas', () => {
    // Regex de jerga de `ux` (UX-6). Cubre las tres familias que se cuelan
    // solas: vocabulario de implementación, keys con guiones (`alternativas-
    // enumeradas`, que es el defecto D-B), nombres de archivo y llamadas.
    const JERGA = /\b(regex|regexp|qualifier|co-?ocurrencia|escalate|payload|detector|marker|fail-?(open|closed)|boolean|null|undefined|GraphQL|authorAssociation|lastEditedAt|signoff|parse_mode|slice|commit|HEAD|CA-\d+|body|label|flag|hash|merge)\b|[a-z]+-[a-z]+-[a-z]+|\b\w+\.(js|json|yaml|md)\b|\w+\(\)/i;

    // Cuerpo con LAS CUATRO señales a la vez: el peor caso.
    const cuatro = 'Hay que decidir entre dos alternativas: la opción A o la opción B. '
        + 'Hay que definir dónde se guardan las credenciales del pipeline: store local o vault. '
        + 'Hay que elegir entre correr en un solo host o distribuido multi-host. '
        + 'Hay que decidir si adoptar un servicio externo, con su costo y pricing.';
    const v = design.detectDesignDecision({ issue: 6431, body: cuatro });
    assert.equal(v.escalate, true);
    assert.ok(v.signals.length >= 3, 'precondición: varias señales simultáneas');

    for (const [campo, texto] of [['motivo', v.reason], ['pregunta', v.question], ['reco', v.recommendation]]) {
        assert.doesNotMatch(texto, JERGA, `el ${campo} que lee el operador tiene jerga: ${texto}`);
        for (const key of v.signals) {
            assert.ok(!texto.includes(key), `el ${campo} muestra la key interna \`${key}\``);
        }
    }
});

test('CA-UX-6: con 4 señales el motivo conserva completa la frase accionable', () => {
    const cuatro = 'Hay que decidir entre dos alternativas: la opción A o la opción B. '
        + 'Hay que definir dónde se guardan las credenciales: store local o vault. '
        + 'Hay que elegir entre un solo host o distribuido multi-host. '
        + 'Hay que decidir si adoptar un servicio externo, con su costo y pricing.';
    const v = design.detectDesignDecision({ issue: 6431, body: cuatro });

    // La frase accionable va PRIMERO: si el recorte muerde algo, muerde la
    // enumeración, nunca el "qué hago con esto".
    assert.match(v.reason, /^Freno #6431 antes de definirlo\. Si ya está decidido, dejalo escrito en el issue y sigo solo\./);
    assert.ok(v.reason.slice(0, 280).includes('sigo solo'),
        'la frase accionable sobrevive al recorte de la vista');

    // UX-3 — máximo 3 señales enumeradas; el resto se resume.
    if (v.signals.length > design.MAX_SENALES_EN_COPY) {
        assert.match(v.reason, /y \d+ cosas? más/);
    }
    // La pregunta tiene que seguir siendo CITABLE por la ficha de decisión.
    assert.ok(v.question.length <= design.MAX_PREGUNTA_OPERADOR, `la pregunta mide ${v.question.length}`);
    assert.ok(v.question.endsWith('?'));
});

test('CA-UX-7: el guion de audio NO narra la cita del issue', () => {
    // Una cita entrecomillada leída en voz alta es indistinguible de lo que
    // dice el pipeline: la evidencia es visual, escaneable de un vistazo.
    const v = design.detectDesignDecision({ issue: 6431, body: BODY_CON_SENAL });
    const audio = humanBlock.buildNeedHumanAudioText({
        issue: 6431, skill: 'definicion', phase: 'analisis',
        reason: v.reason, question: v.question, recommendation: v.recommendation,
        evidence: v.fragment, blocked_at: '2026-08-24T13:29:23Z',
        nowMs: Date.parse('2026-08-24T14:00:00Z'),
    });
    assert.ok(!audio.includes('Texto del issue'));
    assert.ok(!audio.includes(v.fragment.slice(0, 40)));
    assert.ok(audio.length <= 600, 'el tope del guion de audio se conserva');
});

test('CA-21 / RS-2.5: un secreto del body no llega al aviso, ni al disco, ni a la traza', () => {
    const secreto = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const body = `Hay que decidir entre dos alternativas para el store: la opción A usa la clave ${secreto} y la opción B no.`;
    const v = design.detectDesignDecision({ issue: 4321, body });
    assert.equal(v.escalate, true);
    assert.ok(v.fragment.includes('alternativas'), 'precondición: el fragmento sale del tramo con el secreto');

    // (1) el aviso que lee el operador
    const texto = humanBlock.buildBlockedSummaryPlain({
        blocked: [], nowMs: Date.parse('2026-08-24T14:00:00Z'),
        highlight: {
            issue: 4321, skill: 'definicion', phase: 'analisis', titulo: 'Store',
            reason: v.reason, question: v.question, evidence: v.fragment,
            blocked_at: '2026-08-24T13:29:23Z',
        },
    });
    assert.ok(!texto.includes(secreto), 'el secreto no puede viajar al chat del operador');
    assert.ok(!v.fragment.includes(secreto), 'redactar va ANTES de recortar, no después');

    // (2) la traza auditable
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-6448-'));
    io.appendGateAudit({
        issue: 4321, signals: v.signals, fragment: v.fragment,
        signoff_present: false, signoff_reason: 'sin firma', signoff_rejected: [],
        escalated: true, error: null,
    }, { pipelineRoot: tmp });
    const jsonl = fs.readFileSync(path.join(tmp, 'audit', io.GATE_AUDIT_FILE), 'utf8');
    assert.ok(!jsonl.includes(secreto), 'CA-30: la traza no puede contener secretos');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('CA-21 bis: redactar DESPUÉS de recortar dejaría pasar medio secreto', () => {
    // El orden es lo que se testea: con el secreto justo en el borde del tope,
    // recortar primero lo partiría y la mitad sobreviviría a la redacción.
    const secreto = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const relleno = 'x'.repeat(190);
    const body = `Hay que elegir entre la opción A y la opción B ${relleno} ${secreto} fin.`;
    const v = design.detectDesignDecision({ issue: 1, body });
    assert.ok(!v.fragment.includes(secreto.slice(0, 12)),
        'ni siquiera un prefijo largo del secreto puede sobrevivir');
});

// =============================================================================
// GRUPO F — Traza auditable
// =============================================================================

test('CA-27/CA-28: la traza registra señales, fragmento, firma y los DESCARTES', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-6448-'));
    const firma = design.evaluateArchitectSignoff({
        issue: 6448,
        comments: [
            comentarioFirma({ authorAssociation: 'NONE' }),
            comentarioFirma({ isMinimized: true }),
        ],
        lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, false);
    assert.equal(firma.rejected.length, 2, 'los dos descartes quedan enumerados');

    io.appendGateAudit({
        issue: 6448, signals: ['alternativas-enumeradas'], fragment: 'un fragmento',
        signoff_present: firma.settled, signoff_reason: firma.reason,
        signoff_rejected: firma.rejected, signoff_corroboracion: true,
        escalated: true, error: null,
    }, { pipelineRoot: tmp });

    const linea = JSON.parse(fs.readFileSync(path.join(tmp, 'audit', io.GATE_AUDIT_FILE), 'utf8').trim());
    assert.equal(linea.issue, 6448);
    assert.deepEqual(linea.signals, ['alternativas-enumeradas']);
    assert.equal(linea.fragment, 'un fragmento');
    assert.equal(linea.signoff_present, false);
    assert.equal(linea.escalated, true);
    assert.equal(linea.signoff_rejected.length, 2);
    // Sin el negativo sólo se cuentan falsos positivos y no se detecta un
    // intento de bypass (RS-5.2).
    assert.ok(linea.signoff_rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.AUTORIA));
    assert.ok(linea.signoff_rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.MINIMIZADO));
    assert.ok(linea.timestamp);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('#7440 CA-10: appendGateAudit persiste lifted_by (y null cuando falta); los registros previos siguen leyéndose', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-7440-'));
    io.appendGateAudit({ issue: 7440, signals: [], escalated: true, lifted_by: 'late-signoff' }, { pipelineRoot: tmp });
    io.appendGateAudit({ issue: 7440, signals: [], escalated: true }, { pipelineRoot: tmp });
    io.appendGateAudit({ issue: 7440, signals: [], escalated: true, lifted_by: 'x'.repeat(100) }, { pipelineRoot: tmp });
    const lineas = fs.readFileSync(path.join(tmp, 'audit', io.GATE_AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lineas[0].lifted_by, 'late-signoff');
    assert.equal(lineas[1].lifted_by, null, 'ausente ⇒ null explícito');
    assert.ok(lineas[2].lifted_by.length <= 40, 'techo de textoTraza');
    assert.ok(Object.prototype.hasOwnProperty.call(lineas[1], 'lifted_by'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('#7440: el retorno positivo de evaluateArchitectSignoff trae signedAt = createdAt del comentario aceptado', () => {
    const r = firmaDe(FIXTURE_6448, 6448, AUDIT_OK);
    assert.equal(r.settled, true);
    assert.equal(r.signedAt, '2026-08-24T15:42:18Z');
    // Dos comentarios: uno rechazado y uno aceptado ⇒ signedAt es el del ACEPTADO.
    const r2 = design.evaluateArchitectSignoff({
        issue: 6448, lastEditedAt: null, audit: AUDIT_OK,
        comments: [comentarioFirma({ authorAssociation: 'NONE', createdAt: '2026-08-24T10:00:00Z' }), comentarioFirma({ createdAt: '2026-08-24T16:00:00Z' })],
    });
    assert.equal(r2.settled, true);
    assert.equal(r2.signedAt, '2026-08-24T16:00:00Z');
    // Negativo: sin la clave.
    const r3 = design.evaluateArchitectSignoff({ issue: 6448, comments: [], lastEditedAt: null, audit: AUDIT_OK });
    assert.equal(r3.settled, false);
    assert.equal('signedAt' in r3, false);
});

test('#7440 CN-8 / RS-4.5: el comentario de traza del auto-levantamiento (copy UX-C renderizado) NO cuenta como firma', () => {
    const body = [
        '## ♻️ Bloqueo de decisión levantado — firma del arquitecto posterior',
        '',
        'El intake había frenado este issue por señales de decisión de arquitectura (plantea opciones excluyentes y no elige una; define dónde va a vivir un dato crítico) sin encontrar la firma.',
        'La firma del arquitecto se verificó en 2026-09-18T18:44:25Z y la traza local la corrobora, así que el pipeline quitó `needs-human` solo y el issue sigue por definición.',
        '',
        'No hace falta que hagas nada.',
        '',
        '<!-- agent: intake -->',
    ].join('\n');
    const r = design.evaluateArchitectSignoff({
        issue: 6448, lastEditedAt: null, audit: AUDIT_OK,
        comments: [comentarioFirma({ body, authorAssociation: 'OWNER' })],
    });
    assert.equal(r.settled, false);
    assert.deepEqual(r.rejected, [], 'sin marcador: ni siquiera se registra como descarte (regla a)');
    // Y aunque alguien le pegara el marcador, el footer `intake` lo rechaza (regla d).
    const conMarcador = `<!-- architect-signoff issue=6448 -->\n${body}`;
    const r2 = design.evaluateArchitectSignoff({
        issue: 6448, lastEditedAt: null, audit: AUDIT_OK,
        comments: [comentarioFirma({ body: conMarcador, authorAssociation: 'OWNER' })],
    });
    assert.equal(r2.settled, false);
    assert.equal(r2.rejected[0].motivo, `${design.SIGNOFF_REJECT.FOOTER}:intake`);
    assert.equal(typeof design.listaSenales, 'function', 'UX-E: listaSenales exportada');
});

test('CA-30 / R1: la traza es APPEND-ONLY y nunca trunca el histórico', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-6448-'));
    for (let i = 0; i < 3; i += 1) {
        io.appendGateAudit({ issue: 6000 + i, signals: [], escalated: true }, { pipelineRoot: tmp });
    }
    io.appendUnblockAudit({ issue: 6431, pipeline: 'definicion', phase: 'analisis', skill: 'definicion', action: 'destrabado', origin: 'github:label-removed' }, { pipelineRoot: tmp });
    const lineas = fs.readFileSync(path.join(tmp, 'audit', io.GATE_AUDIT_FILE), 'utf8').trim().split('\n');
    assert.equal(lineas.length, 4, 'cada evento suma una línea, ninguna pisa a la anterior');
    fs.rmSync(tmp, { recursive: true, force: true });

    // Test estático: `writeFileSync` sobre un path de `audit/` trunca el
    // histórico entero de auditoría. Regla R1 de `architect-audit.js`.
    const src = fs.readFileSync(path.join(__dirname, '..', 'design-decision-gate-io.js'), 'utf8');
    const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const truncan = codigo.filter((l) => /\bwriteFileSync\b/.test(l));
    assert.deepEqual(truncan, [], 'sobre audit/ sólo se escribe con appendFileSync');
    assert.ok(codigo.some((l) => /\bappendFileSync\b/.test(l)));
});

test('CA-29: cada destrabe queda registrado con issue, fase, marker y origen', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-6448-'));
    io.appendUnblockAudit({
        issue: 6431, pipeline: 'definicion', phase: 'sizing', skill: 'po',
        action: 'destrabado', origin: 'github:label-removed',
    }, { pipelineRoot: tmp });
    const l = JSON.parse(fs.readFileSync(path.join(tmp, 'audit', io.GATE_AUDIT_FILE), 'utf8').trim());
    assert.equal(l.evento, 'unblock');
    assert.equal(l.issue, 6431);
    assert.equal(l.phase, 'sizing');
    assert.equal(l.skill, 'po');
    assert.equal(l.action, 'destrabado');
    assert.equal(l.origin, 'github:label-removed');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('la traza nunca puede tumbar el intake: un destino ilegible no lanza', () => {
    assert.equal(io.appendGateAudit({ issue: 1 }, { pipelineRoot: '\0invalido' }), false);
    assert.equal(io.appendUnblockAudit({ issue: 1 }, { pipelineRoot: '\0invalido' }), false);
    assert.equal(io.appendGateAudit(null, { pipelineRoot: '\0invalido' }), false);
});

// =============================================================================
// GRUPO G — Corroboración local y separación de líneas
// =============================================================================

function conTraza(lineas) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-audit-6448-'));
    fs.mkdirSync(path.join(tmp, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'audit', io.ARCHITECT_TOKENS_FILE), lineas.join('\n'));
    return tmp;
}

test('CA-33: traza local legible SIN entrada para el issue ⇒ la firma no cuenta', () => {
    const tmp = conTraza([
        JSON.stringify({ issue_id: 1111, skill: 'architect', decision: 'signoff' }),
        JSON.stringify({ issue_id: 6448, skill: 'architect', decision: 'rebote' }),
        JSON.stringify({ issue_id: 6448, skill: 'guru', decision: 'signoff' }),
    ]);
    const audit = io.readSignoffAudit(6448, { pipelineRoot: tmp });
    assert.deepEqual(audit, { available: true, corroborated: false });

    const firma = firmaDe(FIXTURE_6448, 6448, audit);
    assert.equal(firma.settled, false, 'no es regresión: es exactamente lo que pasa hoy (escalar)');
    assert.ok(firma.rejected.some((r) => r.motivo === design.SIGNOFF_REJECT.SIN_CORROBORACION));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('CA-33 bis: la traza SÍ corrobora cuando la entrada existe', () => {
    const tmp = conTraza([
        'línea rota que no parsea',
        JSON.stringify({ issue_id: 6448, skill: 'architect', decision: 'signoff' }),
    ]);
    const audit = io.readSignoffAudit(6448, { pipelineRoot: tmp });
    assert.deepEqual(audit, { available: true, corroborated: true },
        'una línea corrupta se saltea, no invalida el barrido');
    assert.equal(firmaDe(FIXTURE_6448, 6448, audit).settled, true);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('CA-34: traza inexistente / vacía ⇒ la firma SÍ cuenta, y queda registrado', () => {
    // `.pipeline/audit/` está gitignored y es local: un respawn la borra. Hacer
    // esto fail-closed haría que ninguna firma volviera a corroborar y el gate
    // frenara MÁS que hoy — el anti-patrón que este issue existe para cerrar.
    const ausente = io.readSignoffAudit(6448, { pipelineRoot: path.join(os.tmpdir(), 'no-existe-6448') });
    assert.deepEqual(ausente, { available: false, corroborated: false });
    assert.equal(firmaDe(FIXTURE_6448, 6448, ausente).settled, true);

    const vacia = conTraza([]);
    assert.equal(io.readSignoffAudit(6448, { pipelineRoot: vacia }).available, false);
    assert.equal(firmaDe(FIXTURE_6448, 6448, AUDIT_AUSENTE).settled, true);

    // Y la traza del gate lo declara, en vez de fingir que corroboró.
    const firma = firmaDe(FIXTURE_6448, 6448, AUDIT_AUSENTE);
    assert.match(firma.reason, /traza local no disponible/);
    fs.rmSync(vacia, { recursive: true, force: true });
});

test('CA-35: un comentario en CRLF reconoce la firma igual', () => {
    // Verificado que hay comentarios CRLF reales en el propio #6448. Con
    // `split('\n')` a secas queda un `\r` colgando al final de la línea del
    // marcador y la regex anclada con `$` NUNCA matchea: ninguna firma se
    // reconocería.
    const crlf = FIRMA_6448_BODY.replace(/\n/g, '\r\n');
    assert.ok(crlf.includes('\r\n'), 'precondición: el fixture es CRLF');
    const firma = design.evaluateArchitectSignoff({
        issue: 6448, comments: [comentarioFirma({ body: crlf })], lastEditedAt: null, audit: AUDIT_OK,
    });
    assert.equal(firma.settled, true);

    const src = fs.readFileSync(path.join(__dirname, '..', 'design-decision-detect.js'), 'utf8');
    assert.match(src, /split\(\/\\r\?\\n\//, 'las líneas se separan tolerando CRLF');
});

// =============================================================================
// Regresión: el detector sigue siendo el de #5337
// =============================================================================

test('el fix NO relaja la detección: #5217 sigue escalando sin firma', () => {
    const v = design.detectDesignDecision({
        issue: 5217,
        title: 'Store de credenciales del pipeline',
        body: 'Hay que definir dónde se almacenan las credenciales del pipeline. '
            + 'Hoy viven en un archivo JSON en disco local, pero la ejecución tiene '
            + 'que poder ser distribuida multi-host.',
    });
    assert.equal(v.escalate, true);
    assert.ok(v.signals.includes('dato-critico'));
    assert.ok(v.signals.includes('local-vs-distribuido'));
    assert.ok(v.question && v.recommendation);
});

test('los cuatro copys de señal existen y no dejan ninguna key sin traducir', () => {
    for (const s of design.DESIGN_DECISION_SIGNALS) {
        const copy = design.SIGNAL_COPY[s.key];
        assert.ok(copy, `falta el copy del operador para la señal \`${s.key}\``);
        assert.ok(copy.frase && copy.pregunta);
        assert.ok(copy.pregunta.endsWith('?'));
    }
});

// =============================================================================
// #7439 — Aviso honesto cuando la firma del arquitecto NO PUDO COMPROBARSE
//
// Hoy `fetchSignoffContext` → `ok:false` (red, 5xx, ENOENT residual) produce el
// MISMO copy que "no hay firma": el operador recibe "el alcance necesita tu
// visto bueno" para un issue que ya tenía todas las firmas y no puede
// distinguir el falso positivo sin abrir `pulpo.log`. El fail-closed NO se
// relaja (escala igual); lo que cambia es que el aviso dice lo que pasó.
// =============================================================================

const dc7439 = require('../decision-card');

/** Error técnico REAL del incidente: path interno + token. Nada de esto viaja. */
const SIGNOFF_NO_VERIFICABLE = Object.freeze({
    settled: false, verifiable: false,
    reason: 'firma no verificable: gh falló: spawnSync C:/x/gh ENOENT token=abc',
    rejected: [],
});
const FUGAS = ['ENOENT', 'C:/', 'token', 'spawnSync'];

/** Un body que dispara varias señales a la vez, con marco decisorio. */
const BODY_4_SENALES = 'Hay que definir entre dos alternativas para el store: '
    + 'la opción A guarda el estado en disco local del host; '
    + 'la opción B lo centraliza en un servicio compartido. '
    + 'Hay que decidir si contratamos un servicio externo de un tercero (SaaS) para esto. '
    + 'Hay que definir dónde se almacenan las credenciales del pipeline. '
    + 'La ejecución tiene que poder ser distribuida multi-host en vez de local.';

function sinFugas(texto, rotulo) {
    for (const f of FUGAS) {
        assert.ok(!String(texto || '').includes(f), `${rotulo} filtra "${f}": ${texto}`);
    }
}

test('#7439 CA-1: con firma NO verificable escala y el copy dice que no pudo comprobarla (sin fugas)', () => {
    const v = design.detectDesignDecision({
        issue: 7113, title: 'Store del estado', body: BODY_CON_SENAL, signoff: SIGNOFF_NO_VERIFICABLE,
    });
    assert.equal(v.escalate, true, 'RS-3.2: el fail-closed no se relaja');
    assert.equal(v.reason, design.buildOperatorReasonUnverifiable(7113, v.signals));
    assert.equal(v.question, design.buildOperatorQuestionUnverifiable(7113));
    assert.match(v.reason, /no pude comprobar si el arquitecto ya la firmó \(falló la consulta a GitHub, no falta la firma\)/);
    assert.match(v.question, /^No pude comprobar si el arquitecto ya firmó #7113: falló la consulta a GitHub, no falta la firma\./);
    assert.ok(v.question.endsWith('?'));
    assert.ok(v.question.length <= design.MAX_PREGUNTA_OPERADOR, `pregunta de ${v.question.length} chars`);
    for (const campo of ['reason', 'question', 'recommendation', 'fragment', 'note']) {
        sinFugas(v[campo], `final.${campo}`);
    }
});

test('#7439 CA-1 bis: la pregunta "no verificable" entra en el tope con issues de 1 a 7 dígitos', () => {
    for (const issue of [1, 12, 123, 1234, 12345, 123456, 1234567]) {
        const q = design.buildOperatorQuestionUnverifiable(issue);
        assert.ok(q.length <= design.MAX_PREGUNTA_OPERADOR, `#${issue}: ${q.length} chars`);
        assert.ok(q.endsWith('?'));
        assert.ok(q.includes(`#${issue}`));
    }
});

test('#7439 RS-3.1: los helpers "no verificable" son templates FIJOS — reciben sólo issue/keys, nunca signoff ni ctx', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'design-decision-detect.js'), 'utf8');
    assert.match(src, /function buildOperatorReasonUnverifiable\(issue, keys\)/);
    assert.match(src, /function buildOperatorQuestionUnverifiable\(issue\)/);
    // Cuerpo de los dos helpers (sin los JSDoc): no interpolan nada que no sea
    // `issue` o la lista de señales.
    const ini = src.indexOf('function buildOperatorReasonUnverifiable');
    const fin = src.indexOf('/**', src.indexOf('function buildOperatorQuestionUnverifiable'));
    const cuerpo = src.slice(ini, fin > 0 ? fin : undefined)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/signoff|ctx\b|\.error|\.reason/.test(cuerpo), 'ningún acceso a signoff/ctx/error/reason en los templates');
    // Y el mismo string sale igual sin importar qué "reason" traiga el signoff.
    const a = design.detectDesignDecision({ issue: 7113, body: BODY_CON_SENAL, signoff: SIGNOFF_NO_VERIFICABLE });
    const b = design.detectDesignDecision({ issue: 7113, body: BODY_CON_SENAL, signoff: { ...SIGNOFF_NO_VERIFICABLE, reason: 'otra cosa completamente distinta' } });
    assert.equal(a.reason, b.reason);
    assert.equal(a.question, b.question);
});

/**
 * CA-2 — snapshot LITERAL del copy histórico por señal. Si alguien lo cambia
 * a propósito, tiene que cambiar este test a propósito (UX-3 medido).
 */
const SNAPSHOT_HISTORICO = Object.freeze({
    'alternativas-enumeradas': {
        reason: 'Freno #7113 antes de definirlo. Si ya está decidido, dejalo escrito en el issue y sigo solo. Lo que vi: el issue plantea opciones excluyentes y no elige una.',
        question: 'Antes de que el pipeline elija por su cuenta: ¿cuál de las opciones tomamos?',
    },
    'servicio-externo': {
        reason: 'Freno #7113 antes de definirlo. Si ya está decidido, dejalo escrito en el issue y sigo solo. Lo que vi: el issue propone sumar un servicio de un tercero.',
        question: 'Antes de que el pipeline elija por su cuenta: ¿sumamos ese servicio de tercero, con el costo y la dependencia que trae?',
    },
    'dato-critico': {
        reason: 'Freno #7113 antes de definirlo. Si ya está decidido, dejalo escrito en el issue y sigo solo. Lo que vi: el issue define dónde va a vivir un dato crítico.',
        question: 'Antes de que el pipeline elija por su cuenta: ¿dónde vive ese dato?',
    },
    'local-vs-distribuido': {
        reason: 'Freno #7113 antes de definirlo. Si ya está decidido, dejalo escrito en el issue y sigo solo. Lo que vi: el issue define si esto corre en una sola máquina o en varias.',
        question: 'Antes de que el pipeline elija por su cuenta: ¿una sola máquina o varias?',
    },
});

test('#7439 CA-2: con `verifiable` ausente o true el copy histórico es BYTE A BYTE el de siempre (4 señales)', () => {
    assert.deepEqual(Object.keys(SNAPSHOT_HISTORICO).sort(), Object.keys(design.SIGNAL_COPY).sort(),
        'el snapshot cubre exactamente las señales del detector');
    for (const [key, esperado] of Object.entries(SNAPSHOT_HISTORICO)) {
        assert.equal(design.buildOperatorReason(7113, [key]), esperado.reason, `reason ${key}`);
        assert.equal(design.buildOperatorQuestion([key]), esperado.question, `question ${key}`);
    }
    // De punta a punta: sin signoff, con signoff sin `verifiable`, con `verifiable:true`.
    const variantes = [
        undefined,
        { settled: false, reason: 'no hay firma', rejected: [] },
        { settled: false, verifiable: true, reason: 'no hay firma', rejected: [] },
    ];
    const ref = design.detectDesignDecision({ issue: 7113, body: BODY_CON_SENAL });
    assert.equal(ref.escalate, true);
    for (const signoff of variantes) {
        const v = design.detectDesignDecision({ issue: 7113, body: BODY_CON_SENAL, signoff });
        assert.equal(v.reason, SNAPSHOT_HISTORICO['alternativas-enumeradas'].reason);
        assert.equal(v.question, SNAPSHOT_HISTORICO['alternativas-enumeradas'].question);
        assert.deepEqual(v, ref, 'salida idéntica a la invocación sin signoff');
    }
    // La enumeración con más de MAX_SENALES_EN_COPY sigue resumiendo igual.
    const cuatro = design.buildOperatorReason(7113, Object.keys(SNAPSHOT_HISTORICO));
    assert.match(cuatro, /; y 1 cosa más\.$/);
});

test('#7439 CA-3 / RS-3.3: `{ settled:true, verifiable:false }` malformado ESCALA y no interpola signoff.reason', () => {
    const malformado = { settled: true, verifiable: false, reason: 'firma no verificable: ENOENT C:/x token=abc', rejected: [] };
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [], signoff: malformado }), false);
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [], signoff: { settled: true, verifiable: true } }), true);
    assert.equal(design.isDecisionSettled({ body: 'nada', labels: [], signoff: { settled: true } }), true, 'CA-15: sin `verifiable` nada cambia');

    const v = design.detectDesignDecision({ issue: 7113, body: BODY_CON_SENAL, signoff: malformado });
    assert.equal(v.escalate, true, 'fail-closed por construcción');
    for (const campo of ['reason', 'question', 'recommendation', 'fragment', 'note']) sinFugas(v[campo], `final.${campo}`);
    assert.equal(v.note, '', 'nunca entra a la rama que interpola signoff.reason');
});

test('#7439 CA-4 / RS-3.4: ni el copy histórico ni el "no verificable" caen en otra ficha (regex IMPORTADOS de decision-card)', () => {
    assert.ok(dc7439.RE_FIRMA instanceof RegExp && dc7439.RE_INFRA instanceof RegExp && dc7439.RE_DEP instanceof RegExp,
        'decision-card exporta los clasificadores como dato');
    const keys = Object.keys(design.SIGNAL_COPY);
    // Todas las combinaciones no vacías de las 4 señales (15) × issues de 1 a 6 dígitos.
    const combos = [];
    for (let m = 1; m < (1 << keys.length); m++) combos.push(keys.filter((_, i) => m & (1 << i)));
    assert.equal(combos.length, 15);
    let casos = 0;
    for (const issue of [1, 12, 123, 1234, 12345, 123456]) {
        for (const ks of combos) {
            const noVer = `${design.buildOperatorReasonUnverifiable(issue, ks)} ${design.buildOperatorQuestionUnverifiable(issue)}`;
            const hist = `${design.buildOperatorReason(issue, ks)} ${design.buildOperatorQuestion(ks)}`;
            assert.equal(dc7439.RE_FIRMA.test(noVer), false, `RE_FIRMA (no verificable) #${issue} ${ks}`);
            assert.equal(dc7439.RE_INFRA.test(noVer), false, `RE_INFRA (no verificable) #${issue} ${ks}`);
            assert.equal(dc7439.RE_DEP.test(noVer), false, `RE_DEP (no verificable) #${issue} ${ks}`);
            assert.equal(dc7439.RE_FIRMA.test(hist), false, `RE_FIRMA (histórico) #${issue} ${ks}`);
            assert.equal(dc7439.RE_INFRA.test(hist), false, `RE_INFRA (histórico) #${issue} ${ks}`);
            casos++;
        }
    }
    assert.equal(casos, 90);
});

test('#7439 CA-1 ter: con varias señales a la vez el copy "no verificable" enumera y no filtra nada', () => {
    const v = design.detectDesignDecision({ issue: 7113, body: BODY_4_SENALES, signoff: SIGNOFF_NO_VERIFICABLE });
    assert.equal(v.escalate, true);
    assert.ok(v.signals.length >= 2, `precondición: varias señales (${v.signals})`);
    assert.match(v.reason, /^Freno #7113: plantea una decisión de arquitectura/);
    assert.match(v.reason, /Lo que vi: el issue .+;/);
    for (const campo of ['reason', 'question', 'recommendation', 'fragment']) sinFugas(v[campo], campo);
});

test('#7439 CA-6 / RS-C.2: `cause` la produce SÓLO el gate de decisión de arquitectura en pulpo.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    // El literal aparece UNA sola vez como PRODUCTOR en todo el archivo. Los
    // filtros del auto-levantamiento (#7440 RS-4.1/4.9) lo LEEN con `===` —
    // consumidores, no productores — y se descuentan explícitamente: el del
    // evaluador `_evaluateLateSignoff` y el pre-filtro del barrido
    // `_sweepLateSignoff` (rev-2, CN-12).
    const literales = src.split("'design-decision'").length - 1;
    const lecturas = (src.match(/=== 'design-decision'/g) || []).length;
    assert.equal(lecturas, 2, 'los únicos consumidores son el filtro de _evaluateLateSignoff y el pre-filtro de _sweepLateSignoff (#7440)');
    assert.equal(literales - lecturas, 1, `el literal 'design-decision' aparece ${literales - lecturas} veces como productor en pulpo.js`);
    // …y dentro del bloque "FRENA en definición — decisión de arquitectura".
    const ini = src.indexOf('FRENA en definición — decisión de arquitectura');
    assert.ok(ini > 0, 'precondición: el bloque del gate existe');
    const fin = src.indexOf('continue; // NO entra a definición hasta que el operador decida.', ini);
    assert.ok(fin > ini, 'precondición: fin del bloque');
    const bloque = src.slice(ini, fin);
    assert.ok(bloque.includes("'design-decision'"), 'el literal vive dentro del bloque del gate');
    assert.match(bloque, /reportHumanBlock\(\{[\s\S]*?cause: causaDD,[\s\S]*?signoff_verifiable: firmaVerificableDD,/, 'el marker lleva cause + signoff_verifiable');
    assert.match(bloque, /highlight: \{[\s\S]*?cause: causaDD,[\s\S]*?signoff_verifiable: firmaVerificableDD,/, 'el highlight del aviso inicial lleva los mismos dos campos');
    // `signoff_verifiable` sólo viaja con el `false` explícito, y se calcula
    // DENTRO del `else` donde vive `const firma` (región del gate completa).
    const gateIni = src.indexOf('const veredicto = designDecision.detectDesignDecision(');
    const gate = src.slice(gateIni, fin);
    assert.match(gate, /firmaVerificableDD = firma\.verifiable === false \? false : undefined/);
    // SCOPE (bug atrapado en dev): `firma` es `const` del `else`; el bloque
    // que escala está FUERA de ese `else`. Referenciar `firma` ahí es un
    // ReferenceError que el `try/catch` externo se traga y el gate deja pasar
    // el issue en silencio. La variable se declara ANTES del `if (yaBloqueadoDD)`
    // y el bloque de escalado no toca `firma.` directamente.
    const declaracion = gate.indexOf('let firmaVerificableDD;');
    const ramaYaBloqueado = gate.indexOf('if (yaBloqueadoDD) {');
    assert.ok(declaracion > 0 && declaracion < ramaYaBloqueado,
        '`firmaVerificableDD` se declara antes de la bifurcación, en el scope que alcanza al bloque de escalado');
    assert.ok(!/\bfirma\./.test(bloque), 'el bloque que escala no referencia `firma.` (fuera de su scope)');
    // Ningún OTRO call-site de reportHumanBlock pone `cause` ni `signoff_verifiable`.
    const llamadas = [...src.matchAll(/reportHumanBlock\(\{/g)].map((m) => m.index);
    assert.ok(llamadas.length >= 3, `precondición: hay varios call-sites (${llamadas.length})`);
    for (const at of llamadas) {
        if (at > ini && at < fin) continue;
        const cierre = src.indexOf('});', at);
        const args = src.slice(at, cierre);
        assert.ok(!/\bcause:/.test(args), `call-site en offset ${at} pone cause`);
        assert.ok(!/signoff_verifiable/.test(args), `call-site en offset ${at} pone signoff_verifiable`);
    }
    // El objeto `firma` no verificable lleva `verifiable:false` y el error crudo queda en `reason` (log/traza).
    assert.match(src, /\{ settled: false, verifiable: false, reason: `firma no verificable: \$\{ctx\.error\}`, rejected: \[\] \}/);
});

test('#7439 RS-C.3: `cause` nunca se infiere del body, labels ni comentarios de GitHub', () => {
    for (const f of ['../../pulpo.js', '../human-block.js', '../decision-card.js']) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        // Toda asignación de `cause` en estos tres archivos sale de un literal
        // del enum, de un `meta`/`d`/`opts` estructurado o de `normalizeBlockCause`.
        for (const m of src.matchAll(/\bcause\s*[:=]\s*([^,\n]+)/g)) {
            const rhs = m[1].trim();
            assert.ok(!/body|labels|comments|title/i.test(rhs), `${f}: cause derivado de GitHub: ${rhs}`);
        }
    }
});
