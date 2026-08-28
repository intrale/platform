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
    io.fetchSignoffContext(6431, { exec: (file, args) => { argv = { file, args }; return '{}'; } });
    assert.equal(argv.file, 'gh', 'se invoca por argv, nunca por shell');
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
