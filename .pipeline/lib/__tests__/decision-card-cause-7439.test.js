// =============================================================================
// #7439 CA-7 / CA-8 — Ficha de Telegram enrutada por la CAUSA estructurada.
//
// HALLAZGO UX-A de #7432: el copy "el alcance necesita tu visto bueno" no lo
// produce el detector sino `COPY.firma.por_que`, porque `clasificar` manda a
// la ficha `firma` a TODO issue con label `needs-definition` antes de mirar la
// pregunta. Cambiar sólo los templates del detector deja al operador viendo
// exactamente lo mismo (verificado abajo: sigue saliendo `firma`).
//
// Con `cause:'design-decision'` (dato estructurado del marker/highlight, jamás
// inferido del texto) la ficha es del tipo nuevo `decision`: primera línea =
// pregunta literal del gate, sin "Aprobar el alcance", y con `signoff_verifiable
// === false` el "Por qué" dice que NO SE PUDO COMPROBAR la firma.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dc = require('../decision-card');
const { renderDecisionCardsPlain } = require('../decision-card-render');
const design = require('../design-decision-detect');
const { withEnv } = require('../test-helpers/with-env');

const AHORA = Date.parse('2026-09-19T12:00:00Z');
const ISSUE = 7113;
const KEYS = Object.keys(design.SIGNAL_COPY);
const FUGAS = ['ENOENT', 'C:/', 'token', 'spawnSync', 'stderr'];
const PROHIBIDO_EN_DECISION = [/visto bueno/i, /aprob[áa]s el alcance/i, /aprobar el alcance/i, /pendiente de firma/i, /firmante/i];

/** `raw` como lo arma el gate del pulpo (highlight) o `listBlockedIssues` (marker). */
function rawGate(keys, { verifiable, cause = 'design-decision', labels = ['needs-definition'], extra = {} } = {}) {
    const noVer = verifiable === false;
    return {
        issue: ISSUE, titulo: 'Ejemplo', skill: 'definicion', phase: 'criterios',
        labels,
        reason: noVer ? design.buildOperatorReasonUnverifiable(ISSUE, keys) : design.buildOperatorReason(ISSUE, keys),
        question: noVer ? design.buildOperatorQuestionUnverifiable(ISSUE) : design.buildOperatorQuestion(keys),
        recommendation: 'Dejá la decisión escrita en el issue, con las opciones y la elegida.',
        evidence: 'Hay que decidir entre dos alternativas para el store',
        ...(cause ? { cause } : {}),
        ...(noVer ? { signoff_verifiable: false } : {}),
        ...extra,
    };
}

function primeraLinea(texto) {
    return String(texto).split('\n')[0];
}

function sinFugas(texto, rotulo) {
    for (const f of FUGAS) assert.ok(!texto.includes(f), `${rotulo} filtra "${f}"`);
}

// -----------------------------------------------------------------------------
// UX-A reproducido: sin `cause`, la ficha sigue siendo `firma`
// -----------------------------------------------------------------------------

test('#7439 UX-A — SIN cause, el copy "no pude comprobar" + needs-definition sigue saliendo como ficha `firma`', () => {
    const card = dc.buildDecisionCard(rawGate(['alternativas-enumeradas'], { verifiable: false, cause: null }), AHORA);
    assert.equal(card.tipo, 'firma', 'confirma que el cambio 1 solo no alcanza (CA-7 es imprescindible)');
    assert.match(renderDecisionCardsPlain([card]), /visto bueno/);
});

// -----------------------------------------------------------------------------
// CA-7: 4 señales × { verifiable ausente, false } ⇒ tipo `decision`
// -----------------------------------------------------------------------------

test('#7439 CA-7 — con cause:"design-decision" la ficha es `decision` para las 4 señales, con y sin verifiable', () => {
    assert.equal(KEYS.length, 4, 'precondición: 4 señales en SIGNAL_COPY');
    assert.ok(dc.TIPOS.includes('decision'));
    for (const key of KEYS) {
        for (const verifiable of [undefined, false]) {
            const raw = rawGate([key], { verifiable });
            const card = dc.buildDecisionCard(raw, AHORA);
            const rot = `${key} verifiable=${verifiable}`;
            assert.equal(card.tipo, 'decision', rot);
            assert.notEqual(card.tipo, 'firma', rot);
            assert.equal(card.indeterminado, false, rot);

            const texto = renderDecisionCardsPlain([card]);
            // Primera línea = pregunta LITERAL del gate.
            assert.equal(primeraLinea(texto), raw.question, `${rot}: primera línea`);
            // "Por qué" según el dato estructurado.
            if (verifiable === false) {
                assert.equal(card.por_que_esta_frenado, dc.COPY.decision.por_que_no_verificable, rot);
                assert.match(texto, /no pudo comprobar si el arquitecto ya la firmó: falló la consulta a GitHub, no falta la firma/);
            } else {
                assert.equal(card.por_que_esta_frenado, dc.COPY.decision.por_que, rot);
                assert.match(texto, /no encontré la firma del arquitecto/);
            }
            // Nada de GATE 1 ni fugas.
            for (const re of PROHIBIDO_EN_DECISION) assert.ok(!re.test(texto), `${rot}: contiene ${re}`);
            sinFugas(texto, rot);
            const etiquetas = card.opciones.map((o) => o.etiqueta);
            assert.deepEqual(etiquetas, [
                dc.OPCION.responder_pregunta.etiqueta,
                dc.OPCION.ya_decidido.etiqueta,
                dc.OPCION.replantear_por_pregunta.etiqueta,
            ], rot);
            assert.ok(!etiquetas.includes(dc.OPCION.aprobar_alcance.etiqueta), rot);
            assert.ok(!etiquetas.includes(dc.OPCION.rechazar_alcance.etiqueta), rot);
            assert.ok(card.opciones.every((o) => o.es_recomendada === false), `${rot}: ninguna recomendada`);
            assert.equal(card.sin_recomendacion_porque, dc.COPY.decision.sin_reco, rot);
            assert.equal(card.costo_de_no_decidir, dc.COPY.decision.costo, rot);
            // La cita del issue viaja igual que en las demás fichas (#6448 UX-1).
            assert.ok(card.evidencia_minima.some((e) => e.includes('Hay que decidir entre dos alternativas')), `${rot}: cita`);
        }
    }
});

test('#7439 CA-7 — servicio-externo: la señal que hoy cae en `indeterminado` por RE_DEP sale como `decision`', () => {
    const raw = rawGate(['servicio-externo'], { cause: null });
    assert.ok(dc.RE_DEP.test(`${raw.reason} ${raw.question}`), 'precondición: el copy dispara RE_DEP ("dependencia")');
    assert.equal(dc.buildDecisionCard(raw, AHORA).tipo, 'indeterminado', 'hoy, sin cause');
    assert.equal(dc.buildDecisionCard({ ...raw, cause: 'design-decision' }, AHORA).tipo, 'decision', 'con cause');
});

test('#7439 CA-7 — `cause` gana también sobre needs-definition, RE_INFRA y RE_FIRMA en el texto', () => {
    // Aunque el texto dispare los regex de otras fichas, la causa estructurada manda.
    const raw = rawGate(['dato-critico'], {
        verifiable: false,
        extra: { reason: 'GATE 1: pendiente de firma, timeout del proveedor, cuota' },
    });
    assert.ok(dc.RE_FIRMA.test(raw.reason) && dc.RE_INFRA.test(raw.reason), 'precondición');
    assert.equal(dc.buildDecisionCard(raw, AHORA).tipo, 'decision');
});

test('#7439 CA-7 regresión — cause:null / ausente / fuera del enum ⇒ tipo idéntico al de hoy', () => {
    for (const key of KEYS) {
        const base = rawGate([key], { cause: null });
        const hoy = dc.buildDecisionCard(base, AHORA);
        for (const cause of [undefined, null, 'otra-cosa', ' design-decision', ['design-decision'], 42]) {
            const card = dc.buildDecisionCard({ ...base, cause }, AHORA);
            assert.equal(card.tipo, hoy.tipo, `${key} cause=${JSON.stringify(cause)}`);
            assert.deepEqual(card, hoy, `${key} cause=${JSON.stringify(cause)}: ficha byte a byte igual`);
        }
    }
    // Y `signoff_verifiable:false` SIN cause no cambia nada (no reclasifica solo).
    const base = rawGate(['alternativas-enumeradas'], { cause: null });
    assert.deepEqual(dc.buildDecisionCard({ ...base, signoff_verifiable: false }, AHORA), dc.buildDecisionCard(base, AHORA));
});

test('#7439 UX-F — sólo el `false` EXPLÍCITO en signoff_verifiable elige "no pude comprobar"', () => {
    const base = rawGate(['alternativas-enumeradas']);
    for (const v of [undefined, true, null, 'false', 0]) {
        const card = dc.buildDecisionCard({ ...base, signoff_verifiable: v }, AHORA);
        assert.equal(card.por_que_esta_frenado, dc.COPY.decision.por_que, `signoff_verifiable=${JSON.stringify(v)}`);
    }
    assert.equal(dc.buildDecisionCard({ ...base, signoff_verifiable: false }, AHORA).por_que_esta_frenado, dc.COPY.decision.por_que_no_verificable);
});

// -----------------------------------------------------------------------------
// RS-D.2: opciones sin moldes de orientación, sin botones de GATE 1
// -----------------------------------------------------------------------------

test('#7439 RS-D.2 — ninguna opción de la ficha `decision` es un molde de orientación ni una opción de GATE 1', () => {
    const card = dc.buildDecisionCard(rawGate(['alternativas-enumeradas'], { verifiable: false }), AHORA);
    assert.equal(card.opciones.length, 3);
    for (const o of card.opciones) {
        assert.equal(dc.esOrientacionMolde(o.etiqueta), false, o.etiqueta);
        assert.equal(dc.esOrientacionMolde(o.consecuencia), false, o.consecuencia);
    }
    assert.equal(dc.COPY.decision.ejemplo, '', 'sin valor de ejemplo: la orientación la escribe el operador');
    assert.equal(card.ejemplo_de_valor, '');
    const texto = renderDecisionCardsPlain([card]);
    assert.match(texto, /\/unblock 7113 seguido de qué querés que se haga/);
    assert.ok(!/\/unblock 7113 aprobar/.test(texto));
});

test('#7439 RS-3.4 — ningún string del copy `decision` dispara RE_FIRMA / RE_INFRA / RE_DEP', () => {
    const strings = [
        ...Object.values(dc.COPY.decision),
        dc.CORTO.decision,
        dc.OPCION.ya_decidido.etiqueta, dc.OPCION.ya_decidido.consecuencia,
        dc.OPCION.responder_pregunta.etiqueta, dc.OPCION.responder_pregunta.consecuencia,
        dc.OPCION.replantear_por_pregunta.etiqueta, dc.OPCION.replantear_por_pregunta.consecuencia,
    ].filter(Boolean);
    assert.ok(strings.length >= 10);
    for (const s of strings) {
        assert.equal(dc.RE_FIRMA.test(s), false, `RE_FIRMA: ${s}`);
        assert.equal(dc.RE_INFRA.test(s), false, `RE_INFRA: ${s}`);
        assert.equal(dc.RE_DEP.test(s), false, `RE_DEP: ${s}`);
        assert.equal(dc.esOrientacionMolde(s), false, `molde: ${s}`);
    }
    assert.equal(dc.CORTO.decision, '¿Decidís vos o ya está firmado?');
});

// -----------------------------------------------------------------------------
// CA-8 / RS-D.3: aviso inicial (highlight) y recordatorio (fila del marker)
// clasifican IGUAL — de punta a punta con el marker persistido en disco.
// -----------------------------------------------------------------------------

test('#7439 CA-8 — highlight del gate y fila de listBlockedIssues ⇒ mismo tipo, misma primera línea, sin fugas', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-dc-cause-7439-'));
    fs.mkdirSync(path.join(TMP, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(TMP, '.pipeline', 'definicion', 'criterios', 'trabajando'), { recursive: true });
    // `traceability.REPO_ROOT` (y con él `PIPELINE_DIR` de human-block) se
    // resuelve al cargar el módulo: el require va DENTRO del `withEnv` para que
    // capture el tmpdir y el helper restaure el entorno después (#6258).
    let hb;
    withEnv({ CLAUDE_PROJECT_DIR: TMP, PIPELINE_REPO_ROOT: TMP }, () => {
        delete require.cache[require.resolve('../traceability')];
        delete require.cache[require.resolve('../human-block')];
        hb = require('../human-block');
    });
    try {
        for (const verifiable of [undefined, false]) {
            // Lo que produce el detector con la firma no verificable (error REAL con path + token).
            const signoff = verifiable === false
                ? { settled: false, verifiable: false, reason: 'firma no verificable: gh falló: spawnSync C:/x/gh ENOENT token=abc', rejected: [] }
                : { settled: false, reason: 'sin firma', rejected: [] };
            const final = design.detectDesignDecision({
                issue: ISSUE, title: 'Store del estado',
                body: 'Hay que decidir entre dos alternativas para el store: la opción A guarda el estado en disco local del host; la opción B lo centraliza en un servicio compartido.',
                labels: ['needs-definition'], signoff,
            });
            assert.equal(final.escalate, true);
            const firmaVerificable = signoff.verifiable === false ? false : undefined;

            // (1) Marker, exactamente como lo escribe el bloque del gate en pulpo.js.
            for (const f of hb.listBlockedMarkers(ISSUE)) { try { fs.unlinkSync(f.file); fs.unlinkSync(hb.reasonFilePath(f.file)); } catch {} }
            hb.reportHumanBlock({
                issue: ISSUE, skill: 'definicion', phase: 'criterios', pipeline: 'definicion',
                reason: final.reason, question: final.question, evidence: final.fragment,
                cause: 'design-decision', signoff_verifiable: firmaVerificable,
                moveFromActive: false, skipGithubLabel: true,
            });
            const fila = hb.listBlockedIssues().find((b) => b.issue === ISSUE);
            assert.ok(fila);
            const jsonCrudo = fs.readFileSync(hb.reasonFilePath(fila.marker_path), 'utf8');
            sinFugas(jsonCrudo, `.reason.json verifiable=${verifiable}`);

            // (2) Highlight del aviso inicial, exactamente como lo arma pulpo.js (sin labels).
            const highlight = {
                issue: ISSUE, skill: 'definicion', phase: 'criterios', titulo: 'Store del estado',
                reason: final.reason, question: final.question, recommendation: final.recommendation,
                evidence: final.fragment, cause: 'design-decision', signoff_verifiable: firmaVerificable,
            };

            // (3) El recordatorio enriquece la fila con el título (mismo camino que human-block-reminder).
            const [filaRecordatorio] = hb.enriquecerConTitulo([{ ...fila, labels: ['needs-definition'] }], { [ISSUE]: { title: 'Store del estado' } });

            const cardInicial = dc.buildDecisionCard(highlight, AHORA);
            const cardRecordatorio = dc.buildDecisionCard(filaRecordatorio, AHORA);
            const txtInicial = renderDecisionCardsPlain([cardInicial]);
            const txtRecordatorio = renderDecisionCardsPlain([cardRecordatorio]);

            assert.equal(cardInicial.tipo, 'decision', `inicial verifiable=${verifiable}`);
            assert.equal(cardRecordatorio.tipo, 'decision', `recordatorio verifiable=${verifiable}`);
            assert.equal(primeraLinea(txtInicial), primeraLinea(txtRecordatorio));
            assert.equal(primeraLinea(txtInicial), final.question, 'la primera línea es la pregunta literal del gate');
            assert.equal(cardInicial.por_que_esta_frenado, cardRecordatorio.por_que_esta_frenado);
            if (verifiable === false) {
                assert.match(txtInicial, /no pudo comprobar si el arquitecto ya la firmó/);
                assert.match(txtRecordatorio, /no pudo comprobar si el arquitecto ya la firmó/);
            }
            sinFugas(txtInicial, `aviso inicial verifiable=${verifiable}`);
            sinFugas(txtRecordatorio, `recordatorio verifiable=${verifiable}`);
            for (const re of PROHIBIDO_EN_DECISION) {
                assert.ok(!re.test(txtInicial) && !re.test(txtRecordatorio), `contiene ${re}`);
            }
        }
    } finally {
        // Que el resto de la suite no herede un human-block apuntado al tmpdir.
        delete require.cache[require.resolve('../traceability')];
        delete require.cache[require.resolve('../human-block')];
    }
});

// -----------------------------------------------------------------------------
// Invariantes del tipo nuevo
// -----------------------------------------------------------------------------

test('#7439 — `decision` tiene plantilla, copy corto, constructor y está en TIPOS (nada sale sin leerse)', () => {
    assert.ok(dc.COPY.decision && dc.CORTO.decision);
    assert.ok(Object.isFrozen(dc.COPY.decision));
    for (const k of ['por_que', 'por_que_no_verificable', 'costo', 'sin_reco']) {
        assert.ok(typeof dc.COPY.decision[k] === 'string' && dc.COPY.decision[k].length > 0, k);
        assert.ok(dc.COPY.decision[k].length <= dc.MAX_CAMPO, `${k} ≤ MAX_CAMPO`);
    }
    // `tipo:'decision'` explícito también se respeta (como los demás tipos).
    const card = dc.buildDecisionCard({ issue: 1, tipo: 'decision', question: '¿Seguimos?' }, AHORA);
    assert.equal(card.tipo, 'decision');
    // Y con la pregunta demasiado larga la ficha degrada honesta (no mutila la cita).
    const larga = dc.buildDecisionCard({ issue: 1, cause: 'design-decision', question: `${'palabra '.repeat(40)}?` }, AHORA);
    assert.equal(larga.tipo, 'decision');
    assert.ok(larga.que_se_decide.length <= dc.MAX_PREGUNTA_LITERAL);
});
