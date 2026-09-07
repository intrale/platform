'use strict';

// =============================================================================
// decision-card.test.js — #6190 (split de #6173).
//
// Qué se protege acá, en orden de importancia:
//
//  1. El contrato anti-#5421: NINGÚN campo de NINGUNA ficha emite markup. Es la
//     guarda de no-regresión más importante del issue — un mensaje con markup
//     desbalanceado se pierde con un HTTP 400 que nadie ve, porque el saliente
//     de Telegram es fire-and-forget vía dropfile.
//  2. Que ningún secreto ni ruta del pipeline salga por la ficha.
//  3. Que la ficha nunca invente una recomendación que no puede justificar.
//  4. Que el mensaje agrupado entre en el presupuesto SIN perder trabajos en
//     silencio: la cuenta le tiene que cerrar al operador.
//
// Cobertura: los 7 tipos del mapa `tipo → plantilla`. Un tipo sin test es un
// tipo que sale a Telegram sin haberse leído nunca.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dc = require('../decision-card');
const cardRender = require('../decision-card-render');
const reminder = require('../human-block-reminder');

const AHORA = Date.parse('2026-08-19T20:00:00Z');

// Mismo predicado que `human-block.test.js:403` (el CA manda reusarlo, no
// inventar otro), más el de HTML: el criterio dice "ni Markdown ni HTML" y
// `MARKUP_CHARS` no cubre `<>` (H-UX-6).
const MARKUP_CHARS = /[*_`]/;
const HTML_CHARS = /[<>]/;
const MARKDOWN_LINK = /\]\(/;

/** Todos los strings de una ficha, con su ruta, para auditarlos uno por uno. */
function camposString(card, prefijo = '') {
    const out = [];
    for (const [k, v] of Object.entries(card)) {
        const ruta = prefijo ? `${prefijo}.${k}` : k;
        if (typeof v === 'string') out.push([ruta, v]);
        else if (Array.isArray(v)) {
            v.forEach((x, i) => {
                if (typeof x === 'string') out.push([`${ruta}[${i}]`, x]);
                else if (x && typeof x === 'object') out.push(...camposString(x, `${ruta}[${i}]`));
            });
        } else if (v && typeof v === 'object') out.push(...camposString(v, ruta));
    }
    return out;
}

/** Los 6 campos que la ficha responde SIEMPRE. */
function assertSeisCampos(card, tipo) {
    assert.equal(card.tipo, tipo, `el tipo clasificado debía ser ${tipo}`);
    assert.ok(card.que_esta_frenado.titulo, '1) qué está frenado');
    assert.ok(card.por_que_esta_frenado, '2) por qué está frenado');
    assert.ok(card.que_se_decide, '3) qué se decide');
    assert.ok(Array.isArray(card.opciones), '4) qué opciones hay');
    assert.ok(Array.isArray(card.evidencia_minima), '5) qué evidencia hay');
    assert.ok(card.costo_de_no_decidir, '6) qué pasa si no se decide');
}

/**
 * CA-A4 — invariante duro: A LO SUMO UNA recomendada, siempre con razón no
 * vacía, y si no hay ninguna la ficha DICE POR QUÉ (el silencio no vale).
 */
function assertInvarianteRecomendada(card) {
    const recos = card.opciones.filter((o) => o.es_recomendada);
    assert.ok(recos.length <= 1, `hay ${recos.length} opciones recomendadas, el máximo es 1`);
    for (const r of recos) {
        assert.ok(r.razon_recomendacion && r.razon_recomendacion.trim().length > 0,
            'una opción recomendada sin razón es peor que ninguna recomendada');
    }
    for (const o of card.opciones) {
        assert.ok(o.consecuencia && o.consecuencia.trim().length > 0,
            `la opción "${o.etiqueta}" no declara su consecuencia`);
    }
    if (recos.length === 0 && !card.indeterminado) {
        assert.ok(card.sin_recomendacion_porque,
            'sin recomendada la ficha tiene que decir por qué no la hay');
    }
}

// =============================================================================
// Un caso por tipo. Los 4 que pide el CA explícitamente, más los 3 restantes:
// el mapa `tipo → plantilla` se cubre entero.
// =============================================================================

test('dependencia: los 6 campos, y la recomendación se apoya en un hecho verificable', () => {
    const card = dc.buildDecisionCard({
        issue: 6190,
        titulo: 'Ficha de decisión única y aviso agrupado',
        skill: 'pipeline-dev', phase: 'dev',
        reason: 'dependency_block: espera #6110',
        dep_titulo: 'Migrar el estado operativo',
        dep_age_hours: 5,          // < 48 h → hay movimiento reciente
        age_hours: 3,
    }, AHORA);

    assertSeisCampos(card, 'dependencia');
    assertInvarianteRecomendada(card);
    assert.match(card.que_se_decide, /#6110/, 'nombra el trabajo que se espera');
    assert.match(card.que_se_decide, /\?$/, 'qué se decide termina en pregunta');
    const reco = card.opciones.find((o) => o.es_recomendada);
    assert.ok(reco, 'con actividad reciente en la dependencia SÍ hay recomendación');
    assert.match(reco.etiqueta, /Esperar/);
    assert.match(reco.razon_recomendacion, /movimiento/);
});

test('dependencia: sin poder leer la actividad de la dependencia NO se recomienda nada', () => {
    const card = dc.buildDecisionCard({
        issue: 6190, reason: 'dependency_block: espera #6110', age_hours: 3,
        // sin `dep_age_hours`: no se puede verificar en qué anda
    }, AHORA);
    assert.equal(card.opciones.filter((o) => o.es_recomendada).length, 0);
    assert.match(card.sin_recomendacion_porque, /No hay recomendación/);
    assert.match(card.sin_recomendacion_porque, /#6110/, 'dice sobre cuál no pudo ver');
});

test('circuit (rebotes agotados): los 6 campos y la recomendación depende del motivo', () => {
    const mismo = dc.buildDecisionCard({
        issue: 7001, titulo: 'Algo que rebotó tres veces',
        reason: 'circuit breaker: 3 rebotes agotados',
        rebotes: 3, rebotes_mismo_motivo: true,
        ultimo_rechazo_age_hours: 2, rechazo_fase: 'verificacion', compilo: true,
        age_hours: 10,
    }, AHORA);
    assertSeisCampos(mismo, 'circuit');
    assertInvarianteRecomendada(mismo);
    assert.match(mismo.opciones.find((o) => o.es_recomendada).etiqueta, /Reintentar/);

    const distinto = dc.buildDecisionCard({
        issue: 7002, reason: 'circuit breaker: rebotes agotados',
        rebotes: 3, rebotes_mismo_motivo: false, age_hours: 10,
    }, AHORA);
    assertInvarianteRecomendada(distinto);
    assert.match(distinto.opciones.find((o) => o.es_recomendada).etiqueta, /definición/);

    // Sin el dato de si fallaron por lo mismo, no se recomienda nada.
    const sinDato = dc.buildDecisionCard({
        issue: 7003, reason: 'circuit breaker', rebotes: 3, age_hours: 10,
    }, AHORA);
    assert.equal(sinDato.opciones.filter((o) => o.es_recomendada).length, 0);
    assert.ok(sinDato.sin_recomendacion_porque);
});

test('firma (GATE 1): cero recomendadas es lo CORRECTO, y la ficha lo declara', () => {
    // Plantilla pura: input sintético → ficha esperada. GATE 2 está documentado
    // pero no enforzado, así que no se testea como flujo runtime.
    const card = dc.buildDecisionCard({
        issue: 4574, titulo: 'Encender el gate de firma',
        reason: 'GATE 1: firma de definición pendiente',
        criterios_total: 12, fecha_corta: '12 de agosto',
        autores: ['po', 'ux'],
        age_hours: 30,
    }, AHORA);

    assertSeisCampos(card, 'firma');
    assertInvarianteRecomendada(card);
    assert.equal(card.opciones.length, 3, 'aprobar / rechazar / ajustar');
    assert.equal(card.opciones.filter((o) => o.es_recomendada).length, 0,
        'un gate cuyo pedido de firma sugiere cómo firmar deja de ser un gate');
    assert.match(card.sin_recomendacion_porque, /la decisión es tuya/);
});

test('firma: sin firmante autorizado NO es una firma, es indeterminado (CA-A3)', () => {
    // Pedirle al operador que firme cuando ninguna firma sería válida es
    // ofrecerle una opción que no se puede ejecutar.
    const card = dc.buildDecisionCard({
        issue: 4575, reason: 'GATE 1: firma de definición pendiente',
        firmantes_autorizados: 0, age_hours: 5,
    }, AHORA);
    assert.equal(card.tipo, 'indeterminado');
    assert.deepEqual(card.opciones, []);
    assert.match(card.falta, /firmante autorizado/);
});

test('infra: la evidencia son contadores y antigüedades, nunca el error del proveedor', () => {
    const card = dc.buildDecisionCard({
        issue: 7100, titulo: 'Trabajo frenado por el proveedor',
        reason_category: 'backend_5xx',
        reason: 'HTTP 503 en https://api.proveedor.tld/v1/messages — stack: at foo (bar.js:12)',
        conexion_restablecida: false, alternativo_con_cuota: true,
        frenados_por_lo_mismo: 4,
        primer_fallo_age_hours: 2, ultimo_intento_age_hours: 0.5,
        age_hours: 2,
    }, AHORA);

    assertSeisCampos(card, 'infra');
    assertInvarianteRecomendada(card);
    assert.match(card.opciones.find((o) => o.es_recomendada).etiqueta, /alternativo/);
    const todo = camposString(card).map(([, v]) => v).join(' | ');
    assert.ok(!/api\.proveedor\.tld/.test(todo), 'la URL del proveedor no sale');
    assert.ok(!/503/.test(todo), 'el código crudo del error no sale');
    assert.ok(!/bar\.js/.test(todo), 'el stack no sale');
    assert.match(card.evidencia_minima.join(' '), /4 trabajos frenados por lo mismo/);
});

test('infra: credencial rechazada recomienda renovar, y no depende de ningún otro dato', () => {
    const card = dc.buildDecisionCard({
        issue: 7101, reason_category: 'auth_failure', reason: 'credencial rechazada', age_hours: 1,
    }, AHORA);
    assert.equal(card.tipo, 'infra');
    assertInvarianteRecomendada(card);
    const reco = card.opciones.find((o) => o.es_recomendada);
    assert.match(reco.etiqueta, /Renovar la credencial/);
    assert.match(reco.razon_recomendacion, /Ningún proveedor alternativo/);
});

test('infra: causa desconocida NO usa la plantilla de infra, cae en indeterminado', () => {
    const card = dc.buildDecisionCard({
        issue: 7102, reason_category: 'unknown', reason: 'algo del proveedor', age_hours: 1,
    }, AHORA);
    assert.equal(card.tipo, 'indeterminado');
    assert.deepEqual(card.opciones, []);
});

test('rebote: con motivo legible recomienda corregir; sin motivo NO recomienda nada', () => {
    const conMotivo = dc.buildDecisionCard({
        issue: 7200, titulo: 'Devuelto por calidad',
        reason: 'rechazado: falta el test del caso borde',
        phase: 'verificacion', rebotes: 1, age_hours: 4,
    }, AHORA);
    assertSeisCampos(conMotivo, 'rebote');
    assertInvarianteRecomendada(conMotivo);
    assert.match(conMotivo.opciones.find((o) => o.es_recomendada).etiqueta, /corregir/);

    const sinMotivo = dc.buildDecisionCard({
        issue: 7201, tipo: 'rebote', reason: '', phase: 'verificacion', age_hours: 4,
    }, AHORA);
    assert.equal(sinMotivo.opciones.filter((o) => o.es_recomendada).length, 0);
    assert.match(sinMotivo.sin_recomendacion_porque, /vacío o ilegible/);
});

test('pregunta: se cita LITERAL, y cero recomendadas es lo esperado', () => {
    const card = dc.buildDecisionCard({
        issue: 7300, titulo: 'Un agente preguntó algo',
        skill: 'po', phase: 'criterios',
        question: '¿Cobramos la comisión al comercio o al repartidor?',
        age_hours: 2,
    }, AHORA);

    assertSeisCampos(card, 'pregunta');
    assertInvarianteRecomendada(card);
    assert.equal(card.que_se_decide, '¿Cobramos la comisión al comercio o al repartidor?',
        'parafrasear la pregunta de un agente la cambia (UX §1.8)');
    assert.equal(card.opciones.filter((o) => o.es_recomendada).length, 0);
    assert.match(card.sin_recomendacion_porque, /la respuesta la tenés vos/);
});

test('pregunta: si no es una pregunta usable cae en indeterminado antes que mutilarla', () => {
    const largo = `${'a'.repeat(200)}?`;
    for (const q of ['esto no es una pregunta', largo]) {
        const card = dc.buildDecisionCard({ issue: 7301, question: q, age_hours: 1 }, AHORA);
        assert.equal(card.tipo, 'indeterminado', `debería ser indeterminado con: ${q.slice(0, 30)}`);
    }
});

// =============================================================================
// Indeterminado: el caso más frecuente hoy, y el que NO puede inventar opciones.
// =============================================================================

test('indeterminado con el motivo VACÍO: opciones vacía, falta poblado, cero genéricas', () => {
    // Es el caso más frecuente en la medición real (H-UX-2: #6150 llegaba sin
    // ninguna razón), no un borde teórico.
    const card = dc.buildDecisionCard({
        issue: 6150, titulo: 'Algo que quedó frenado sin texto',
        skill: 'guru', phase: 'analisis', reason: '', question: '',
        age_hours: 27,
    }, AHORA);

    assert.equal(card.tipo, 'indeterminado');
    assert.equal(card.indeterminado, true);
    assert.deepEqual(card.opciones, [], 'cero opciones inventadas: cero es mejor que tres genéricas');
    assert.ok(card.falta && card.falta.length > 0, 'dice QUÉ dato le falta');
    assert.match(card.falta, /motivo del bloqueo/);
    assert.ok(card.que_se_decide, 'igual dice que hay que decidir algo');
    assert.ok(card.costo_de_no_decidir, 'y qué pasa si no se decide');
});

test('indeterminado: "espera algo pero no dice qué" no puede proponer esperar a nadie', () => {
    const card = dc.buildDecisionCard({
        issue: 6151, reason: 'bloqueado: depende de otra cosa', age_hours: 2,
    }, AHORA);
    assert.equal(card.tipo, 'indeterminado');
    assert.deepEqual(card.opciones, []);
    assert.match(card.falta, /no dice cuál/);
});

/** Un `raw` por cada uno de los 7 tipos del mapa. */
const UNO_POR_TIPO = [
    { issue: 1, reason: 'dependency_block: espera #2' },
    { issue: 3, reason: 'circuit breaker: rebotes agotados' },
    { issue: 4, reason: 'GATE 1: firma de definición pendiente' },
    { issue: 5, reason_category: 'rate_limit', reason: 'cuota del proveedor' },
    { issue: 6, tipo: 'rebote', reason: 'rechazado por el control' },
    { issue: 7, question: '¿Seguimos?' },
    { issue: 8, reason: '' },
];

test('los 7 tipos del mapa están cubiertos y ninguno queda sin plantilla', () => {
    const vistos = new Set();
    const casos = UNO_POR_TIPO;
    for (const raw of casos) {
        const card = dc.buildDecisionCard(raw, AHORA);
        vistos.add(card.tipo);
        assertInvarianteRecomendada(card);
    }
    assert.deepEqual([...vistos].sort(), [...dc.TIPOS].sort(),
        'un tipo sin caso es un tipo que sale a Telegram sin haberse leído nunca');
});


// =============================================================================
// #6190 rev-1 — el pie de destrabe dejó de ser un molde EN EL NÚMERO, pero
// seguía siéndolo EN EL VALOR (`qué-hacer`, `tu-respuesta`). No es cosmético:
// `cmdUnblock` acepta ese texto como orientación válida, `human-block` lo
// persiste en `<marker>.guidance.txt` y el pulpo lo inyecta al prompt del
// agente bajo "INDICACIONES HUMANAS … NO la ignores". Pegar el pie tal cual
// destrababa el issue con una indicación que nadie escribió.
// =============================================================================

/** Una orientación pegable es UNA palabra que el operador puede tipear igual. */
const VALOR_PEGABLE = /^[a-záéíóúñ]+$/;

test('rev-1: ningún tipo emite un molde en el pie de destrabe (ni número ni valor)', () => {
    for (const raw of UNO_POR_TIPO) {
        const card = dc.buildDecisionCard(raw, AHORA);
        const ctx = `tipo ${card.tipo}`;
        const valor = card.ejemplo_de_valor;

        // Vacío es legítimo y significa "la orientación la escribe el operador".
        // Lo que NO puede pasar es que el valor sea un marcador de posición.
        if (valor) {
            assert.match(valor, VALOR_PEGABLE,
                `${ctx}: "${valor}" no es una orientación pegable, parece un molde`);
        }
        assert.equal(card.pie_destrabe,
            `Para decidir, respondé: /unblock ${raw.issue} ${valor || dc.ORIENTACION_LIBRE}`,
            `${ctx}: el pie no arma el comando esperado`);

        // Ningún molde, en ninguna de sus formas conocidas.
        for (const molde of ['qué-hacer', 'tu-respuesta', '<issue>', '<orientación>']) {
            assert.ok(!card.pie_destrabe.includes(molde), `${ctx}: el pie trae el molde "${molde}"`);
        }
        assert.ok(!HTML_CHARS.test(card.pie_destrabe), `${ctx}: el pie trae <> de molde`);
    }
});

test('rev-1: cuando la orientación la escribe el operador, el pie lo dice con palabras', () => {
    // `pregunta` e `indeterminado` son los dos tipos donde no hay un valor que
    // el pipeline pueda proponer: uno pide la respuesta a una pregunta de
    // producto, el otro ni siquiera pudo clasificar el bloqueo.
    const casos = [
        { raw: { issue: 6150, question: '¿Cobramos la comisión al comercio?' }, tipo: 'pregunta' },
        { raw: { issue: 6150, reason: '' }, tipo: 'indeterminado' },
    ];
    for (const { raw, tipo } of casos) {
        const card = dc.buildDecisionCard(raw, AHORA);
        assert.equal(card.tipo, tipo);
        assert.equal(card.ejemplo_de_valor, '',
            `${tipo}: no hay valor que proponer, así que la ficha no puede inventar uno`);
        assert.equal(card.pie_destrabe,
            'Para decidir, respondé: /unblock 6150 seguido de qué querés que se haga');

        // Y la línea compacta del mensaje agrupado dice exactamente lo mismo:
        // el defecto de rev-1 afectaba a las dos superficies.
        const compacta = cardRender.renderFichaCompacta(card, 1, 2);
        assert.ok(compacta.endsWith('/unblock 6150 seguido de qué querés que se haga'),
            `la compacta sigue con molde: ${compacta}`);
    }
});

test('rev-1: el pie pegado tal cual se reconoce como molde, no como orientación', () => {
    // Guarda del lado del comando (`cmdUnblock` la consume): el pie sin valor
    // se lee bien pero se puede copiar entero, y una orientación falsa termina
    // en el prompt del agente como si la hubiera escrito el operador.
    const moldes = [
        dc.ORIENTACION_LIBRE,
        'Seguido de que queres que se haga.',          // sin acentos, con punto
        '  seguido de   qué querés que se haga  ',     // pegado con espacios
        'qué-hacer',
        'tu-respuesta',
        '<orientación>',
    ];
    for (const m of moldes) {
        assert.equal(dc.esOrientacionMolde(m), true, `debía reconocerse como molde: ${JSON.stringify(m)}`);
    }

    // Y ninguna orientación de verdad puede quedar afuera por esta guarda.
    const reales = [
        'esperar', 'reintentar', 'aprobar', 'corregir', 'renovar',
        'reintentar usando la API REST en lugar de gRPC',
        'que se haga lo que pide el comentario del PO',
        'dar de baja: ya no aplica',
    ];
    for (const r of reales) {
        assert.equal(dc.esOrientacionMolde(r), false, `orientación válida rechazada: ${JSON.stringify(r)}`);
    }

    // Vacío no es "molde": ese caso lo cubre la validación de orientación vacía.
    assert.equal(dc.esOrientacionMolde(''), false);
    assert.equal(dc.esOrientacionMolde(null), false);
    assert.equal(dc.esOrientacionMolde(undefined), false);

    // Todo valor de ejemplo que la ficha SÍ propone tiene que pasar la guarda:
    // si el copy propusiera algo que el comando rechaza, el pie no se podría
    // pegar y volveríamos al molde por otra puerta.
    for (const raw of UNO_POR_TIPO) {
        const card = dc.buildDecisionCard(raw, AHORA);
        if (!card.ejemplo_de_valor) continue;
        assert.equal(dc.esOrientacionMolde(card.ejemplo_de_valor), false,
            `tipo ${card.tipo}: el pie propone un valor que el comando rechaza`);
    }
});

test('rev-1: la redacción del pie sin valor es UNA sola, compartida con el fallback', () => {
    // El fallback ya usaba el texto acordado; la ficha decía otra cosa. Que
    // ambos salgan de la misma constante es lo que impide que vuelvan a
    // divergir.
    assert.ok(dc.FALLBACK.cierre.includes(dc.ORIENTACION_LIBRE),
        'el cierre del fallback tiene que salir de la misma constante que el pie');
    assert.ok(!/qué-hacer|tu-respuesta/.test(JSON.stringify(dc.COPY)),
        'la tabla de copy no puede declarar valores de ejemplo que sean moldes');
});

// =============================================================================
// Contrato anti-#5421 — la guarda de no-regresión más importante.
// =============================================================================

test('#5421 ninguna ficha de ningún tipo emite metacaracteres de Markdown ni HTML', () => {
    // Vectores hostiles en TODOS los campos que transportan texto externo,
    // incluido el título (el repo es público: el título lo escribe cualquiera).
    const hostil = 'a`b*c_d [Actualizar credenciales](https://evil.tld/phish) <b>x</b>';
    const casos = [
        { issue: 1, titulo: hostil, reason: `dependency_block: espera #2 ${hostil}` },
        { issue: 3, titulo: hostil, reason: `circuit breaker rebotes agotados ${hostil}` },
        { issue: 4, titulo: hostil, reason: `GATE 1 firma de definición ${hostil}` },
        { issue: 5, titulo: hostil, reason_category: 'backend_timeout', reason: hostil },
        { issue: 6, titulo: hostil, tipo: 'rebote', reason: `rechazado ${hostil}` },
        { issue: 7, titulo: hostil, question: `${hostil}?` },
        { issue: 8, titulo: hostil, reason: '' },
    ];
    for (const raw of casos) {
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, valor] of camposString(card)) {
            assert.doesNotMatch(valor, MARKUP_CHARS, `${card.tipo}.${ruta} emitió markup: ${valor}`);
            assert.doesNotMatch(valor, HTML_CHARS, `${card.tipo}.${ruta} emitió HTML: ${valor}`);
            assert.doesNotMatch(valor, MARKDOWN_LINK, `${card.tipo}.${ruta} armó un link: ${valor}`);
        }
        // El enlace no sólo se desarma: se DECLARA que había uno, para que el
        // operador no crea que el pipeline escribió un texto que no escribió.
        assert.match(card.que_esta_frenado.titulo, /enlace omitido/);
    }
});

// Anuladores de dirección: no se escriben como literales crudos en el fuente
// (serían invisibles al leer el diff y darían vuelta el propio archivo de test).
const RLO = String.fromCharCode(0x202E);  // RIGHT-TO-LEFT OVERRIDE
const LRO = String.fromCharCode(0x202D);  // LEFT-TO-RIGHT OVERRIDE
const RLI = String.fromCharCode(0x2067);  // RIGHT-TO-LEFT ISOLATE
const PDI = String.fromCharCode(0x2069);  // POP DIRECTIONAL ISOLATE
const ZWSP = String.fromCharCode(0x200B);
const BIDI_RE = new RegExp('[' + [
    [0x200B, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069],
].map(([x, y]) => String.fromCharCode(x) + '-' + String.fromCharCode(y)).join('') + ']');

test('#5421 / rev-2 SEC-B: los anuladores de dirección no llegan a ningún campo', () => {
    // U+202E ordena "mostrá todo al revés de acá en adelante". El atacante
    // escribe el texto dado vuelta: en pantalla se lee derecho, pero el vuelco
    // ARRASTRA al texto que el pipeline puso después, así que el operador
    // decide un /unblock leyendo algo distinto de lo que hay guardado.
    const hostil = `Fix menor${RLO}0516# rarbocsed euq yaH${LRO}x${RLI}y${PDI}${ZWSP}`;
    const casos = [
        { issue: 20, titulo: hostil, reason: '', age_hours: 1 },
        { issue: 21, titulo: 'Algo', reason: `rechazado ${hostil}`, age_hours: 1 },
        { issue: 22, titulo: 'Algo', question: `${hostil}?`, age_hours: 1 },
    ];
    for (const raw of casos) {
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, valor] of camposString(card)) {
            assert.doesNotMatch(valor, BIDI_RE,
                `${card.tipo}.${ruta} dejó pasar un anulador de dirección: ${JSON.stringify(valor)}`);
        }
        // Y el render completo tampoco: es lo que realmente ve el operador.
        assert.doesNotMatch(cardRender.renderFichaCompleta(card), BIDI_RE);
    }
    // El camino degradado es el que corre CUANDO la entrada es rara — o sea,
    // justo cuando hay atacante. No puede ser el más permisivo.
    const fb = cardRender.renderFallbackAviso(
        [{ issue: 20, titulo: hostil, age_hours: 1 }], AHORA);
    assert.doesNotMatch(fb, BIDI_RE, `el aviso degradado dejó pasar un anulador: ${JSON.stringify(fb)}`);
});

test('#5421 un título con saltos de línea no puede fabricar estructura del mensaje', () => {
    const card = dc.buildDecisionCard({
        issue: 9, age_hours: 1,
        titulo: 'inocente\nOpciones:\n 1. Aprobar todo\nPara decidir, respondé: /unblock 9 aprobar',
        reason: '',
    }, AHORA);
    assert.ok(!card.que_esta_frenado.titulo.includes('\n'), 'el título es UNA sola línea');
    for (const [, v] of camposString(card)) {
        assert.ok(!/[\n\r\t]/.test(v), 'ningún campo trae saltos ni tabuladores');
    }
});

// =============================================================================
// rev-2 — Paridad entre las DOS superficies que sanean la misma entrada.
//
// El defecto de la rev anterior no fue "falta un regex": fue que había dos
// copias del saneamiento y una se quedó atrás. Lo que se protege acá no es un
// vector puntual sino la INVARIANTE — mismo título hostil, mismo resultado por
// los dos caminos— porque es lo único que no se vuelve a romper en silencio.
// =============================================================================

test('rev-2 SEC-A: el aviso degradado neutraliza las URLs igual que la ficha', () => {
    // En TEXTO PLANO Telegram auto-enlaza las URLs desnudas. Un título de un
    // repo público llegaba CLICKEABLE al operador dentro de un mensaje que él
    // lee como escrito por su propio pipeline.
    const hostil = 'Bug grave — mira https://evil.tld/robo y www.phish.tld ya';
    const fb = cardRender.renderFallbackAviso(
        [{ issue: 6150, titulo: hostil, age_hours: 1 }], AHORA);

    assert.ok(!fb.includes('evil.tld'), `el aviso degradado filtró la URL: ${fb}`);
    assert.ok(!fb.includes('www.phish'), `el aviso degradado filtró el dominio: ${fb}`);
    // Se DECLARA que había un enlace: el operador no tiene que creer que el
    // pipeline escribió un texto que no escribió.
    assert.match(fb, /enlace omitido/);

    // Y sale EXACTAMENTE igual que por el camino principal.
    const card = dc.buildDecisionCard({ issue: 6150, titulo: hostil, reason: '', age_hours: 1 }, AHORA);
    assert.ok(card.que_esta_frenado.titulo.includes('enlace omitido'));
    assert.ok(fb.includes(card.que_esta_frenado.titulo.replace('#6150 «', '').replace('»', '')),
        'las dos superficies tienen que producir el MISMO título saneado');
});

test('rev-2: la tabla de caracteres de control es UNA sola, compartida con el renderer', () => {
    // Guarda estructural, no de comportamiento: si alguien vuelve a copiar la
    // tabla en el renderer, esto sigue verde pero el grep falla. Se verifica
    // que el renderer NO declara rangos propios y que consume el export.
    const src = fs.readFileSync(path.join(__dirname, '..', 'decision-card-render.js'), 'utf8');
    assert.match(src, /decisionCard\.CONTROL_RANGES/,
        'el renderer tiene que consumir la tabla del armador, no tener la suya');
    // rev-9 / SEC-C: ya no alcanza con compartir el regex de URLs. El defecto
    // de rev-8 no estuvo en ningún regex sino en el ORDEN de aplicación, y el
    // orden estaba escrito DOS veces. Ahora se comparte la secuencia entera.
    assert.match(src, /decisionCard\.neutralizarMarkupYEnlaces/,
        'el renderer tiene que consumir la neutralización del armador, no una copia de la secuencia');
    assert.ok(!/decisionCard\.URL_RE/.test(src),
        'el renderer volvió a armar su propia secuencia de neutralización: el orden va a divergir de nuevo');
    assert.ok(!/\[0x200B, 0x200F\]/.test(src),
        'el renderer volvió a declarar rangos de control propios: van a divergir de nuevo');

    // Y la tabla cubre los anuladores de dirección que el comentario promete.
    const cubre = (cp) => dc.CONTROL_RANGES.some(([a, b]) => cp >= a && cp <= b);
    for (const cp of [0x200B, 0x200F, 0x202A, 0x202E, 0x2066, 0x2069, 0x2028, 0xFEFF]) {
        assert.ok(cubre(cp), `la tabla no cubre U+${cp.toString(16).toUpperCase()}`);
    }
});

// =============================================================================
// Secretos y rutas del pipeline.
// =============================================================================

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const BEARER = 'Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

test('SEC: ningún secreto inyectado en reason, question o título llega a la ficha', () => {
    // Los tres vectores en los TRES campos externos. Deliberadamente NO se
    // afirma cobertura de emails: `redactAll` los enmascara sólo parcialmente y
    // ese gap es conocido (verificado por `security`).
    const veneno = `${AWS_KEY} / ${JWT} / ${BEARER}`;
    const casos = [
        { issue: 10, reason: `falló con ${veneno}`, age_hours: 1 },
        { issue: 11, question: `¿usás ${veneno}?`, age_hours: 1 },
        { issue: 12, titulo: `Rotar ${veneno}`, reason: '', age_hours: 1 },
        { issue: 13, tipo: 'rebote', reason: `rechazado: ${veneno}`, age_hours: 1 },
    ];
    for (const raw of casos) {
        const card = dc.buildDecisionCard(raw, AHORA);
        const todo = camposString(card).map(([, v]) => v).join(' | ');
        assert.ok(!todo.includes(AWS_KEY), `el AWS key salió en la ficha: ${todo}`);
        assert.ok(!todo.includes(JWT), `el JWT salió en la ficha: ${todo}`);
        assert.ok(!todo.includes('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'),
            `el bearer salió en la ficha: ${todo}`);
    }
});

test('SEC: `marker_path` es una ruta del pipeline y NO puede aparecer en ningún campo', () => {
    const marker = '.pipeline/desarrollo/criterios/bloqueado-humano/6173.ux';
    const card = dc.buildDecisionCard({
        issue: 6173, titulo: 'Algo', marker_path: marker,
        reason: `frenado, ver ${marker} y también .pipeline/pulpo.js y config.yaml`,
        age_hours: 3,
    }, AHORA);
    for (const [ruta, v] of camposString(card)) {
        assert.ok(!v.includes('.pipeline/'), `${ruta} filtró una ruta del pipeline: ${v}`);
        assert.ok(!v.includes('pulpo.js'), `${ruta} filtró un nombre de módulo: ${v}`);
        assert.ok(!v.includes('config.yaml'), `${ruta} filtró un archivo de estado: ${v}`);
    }
});

test('CA-12: el mensaje no lleva labels internos ni claves snake_case', () => {
    const card = dc.buildDecisionCard({
        issue: 6174,
        reason: 'needs-human + blocked:dependencies; motivo_rechazo=algo; age_hours=12',
        age_hours: 12,
    }, AHORA);
    const todo = camposString(card).map(([, v]) => v).join(' | ');
    for (const jerga of ['needs-human', 'blocked:dependencies', 'motivo_rechazo', 'age_hours']) {
        assert.ok(!todo.includes(jerga), `salió jerga interna "${jerga}": ${todo}`);
    }
});

test('el título se cita LITERAL aunque traiga jerga: es el identificador del operador', () => {
    // H-UX-4: el 21,5 % de los títulos abiertos trae jerga legítimamente. El
    // guardián corre sobre lo que la ficha REDACTA, no sobre el título citado.
    const card = dc.buildDecisionCard({
        issue: 6121, titulo: 'Purgar los worktrees residuales del dispatch', reason: '', age_hours: 1,
    }, AHORA);
    assert.match(card.que_esta_frenado.titulo, /worktrees residuales del dispatch/,
        'mutilar el título destruye el identificador que el operador reconoce');
    assert.match(card.que_esta_frenado.titulo, /^#6121 «/, 'y va atribuido, nunca abriendo línea');
});

test('un título vacío no produce «» hueco', () => {
    const card = dc.buildDecisionCard({ issue: 6122, titulo: '   ', reason: '', age_hours: 1 }, AHORA);
    assert.equal(card.que_esta_frenado.titulo, '#6122 (sin título)');
    assert.ok(!card.que_esta_frenado.titulo.includes('«»'));
});

// =============================================================================
// `nowMs` inyectable, inmutabilidad y pureza.
// =============================================================================

test('la antigüedad se calcula con el `nowMs` inyectado, sin tocar el reloj real', () => {
    const raw = { issue: 20, blocked_at: '2026-08-19T18:00:00Z', reason: '', titulo: 'x' };
    const a = dc.buildDecisionCard(raw, Date.parse('2026-08-19T20:00:00Z'));
    const b = dc.buildDecisionCard(raw, Date.parse('2026-08-21T20:00:00Z'));
    assert.equal(a.que_esta_frenado.desde, 'hace 2 h');
    assert.equal(b.que_esta_frenado.desde, 'hace 2 d 2 h');
    assert.notEqual(a.que_esta_frenado.desde, b.que_esta_frenado.desde);

    // Y no es que "además" lea el reloj: con `Date.now` roto sigue funcionando.
    const real = Date.now;
    Date.now = () => { throw new Error('el módulo leyó el reloj real'); };
    try {
        const c = dc.buildDecisionCard(raw, Date.parse('2026-08-19T20:00:00Z'));
        assert.equal(c.que_esta_frenado.desde, 'hace 2 h');
    } finally {
        Date.now = real;
    }
});

test('la antigüedad no calculable se OMITE: nunca "hace NaN" ni "hace 0 min"', () => {
    const card = dc.buildDecisionCard({ issue: 21, blocked_at: 'no es una fecha', reason: '' }, AHORA);
    assert.equal(card.que_esta_frenado.desde, '');
    const todo = camposString(card).map(([, v]) => v).join(' ');
    assert.ok(!/NaN/.test(todo));
});

test('la ficha está congelada EN PROFUNDIDAD: no se le puede cambiar la recomendada', () => {
    // `Object.freeze` es superficial y `opciones` es un array de objetos: un
    // freeze de un nivel deja que un consumidor mute justo los dos campos que el
    // operador lee como "el pipeline me recomienda esto".
    const card = dc.buildDecisionCard({
        issue: 22, reason: 'dependency_block: espera #23', dep_age_hours: 5, age_hours: 1,
    }, AHORA);
    const antes = card.opciones.map((o) => o.es_recomendada);
    try { card.opciones[0].es_recomendada = !antes[0]; } catch (_) { /* strict mode */ }
    try { card.opciones[0].etiqueta = 'Aprobar todo sin mirar'; } catch (_) { /* strict mode */ }
    try { card.que_esta_frenado.titulo = 'otro'; } catch (_) { /* strict mode */ }
    assert.deepEqual(card.opciones.map((o) => o.es_recomendada), antes);
    assert.notEqual(card.opciones[0].etiqueta, 'Aprobar todo sin mirar');
    assert.match(card.que_esta_frenado.titulo, /^#22/);
});

test('el módulo es PURO: sin filesystem, sin red, sin estado del pipeline', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'decision-card.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const requires = [...src.matchAll(/require\((['"])(.+?)\1\)/g)].map((m) => m[2]);
    // Allowlist de requires. Cada entrada es una excepcion JUSTIFICADA al
    // contrato de pureza, y cada modulo admitido tiene que ser puro el mismo
    // (verificado en el test de abajo): si no, la pureza se evade por
    // transitividad.
    //   - './sherlock-audit-jsonl'  : frontera de redaccion.
    //   - './sello-evidencia-state' : #6498 CA-11. Fuente UNICA del copy del
    //     sello de evidencia, compartida con el badge del dashboard. Copiar el
    //     literal aca reintroduciria el copy divergente que cerro #6190.
    assert.deepEqual(requires, ['./sherlock-audit-jsonl', './sello-evidencia-state'],
        'toda excepcion al contrato de pureza va justificada en la allowlist de arriba');
    assert.ok(!/\bDate\.now\(\)/.test(src), 'el "ahora" se inyecta, no se lee');
});

test('caps de longitud: ningún campo pasa de 220, ninguna evidencia de 120, máximo 3', () => {
    const largo = 'palabra '.repeat(200);
    for (const raw of [
        { issue: 30, titulo: largo, reason: largo },
        { issue: 31, question: `${largo}?` },
        { issue: 32, tipo: 'rebote', reason: largo },
    ]) {
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, v] of camposString(card)) {
            const tope = ruta.startsWith('evidencia_minima') ? dc.MAX_EVIDENCIA : dc.MAX_CAMPO;
            assert.ok(v.length <= tope, `${ruta} mide ${v.length} y el tope es ${tope}`);
        }
        assert.ok(card.evidencia_minima.length <= dc.MAX_EVIDENCIAS);
    }
});

// =============================================================================
// R-1 — Presupuesto del mensaje agrupado. El hueco de diseño real del issue.
// =============================================================================

function muchosBloqueos(n) {
    return Array.from({ length: n }, (_, i) => ({
        issue: 8000 + i,
        titulo: `Un trabajo con un título largo de verdad para ocupar lugar, número ${i}`,
        skill: 'pipeline-dev', phase: 'dev',
        reason: `dependency_block: espera #${9000 + i}`,
        dep_age_hours: 5,
        age_hours: 40 - i, // el 0 es el más viejo → destacado
    }));
}

test('R-1 con muchos bloqueos el mensaje entra en el presupuesto y NADIE desaparece en silencio', () => {
    for (const n of [2, 3, 4, 8, 30, 120]) {
        const cards = dc.buildDecisionCards(muchosBloqueos(n), AHORA);
        const r = cardRender.fitFichas(cards);

        assert.ok(r.text.length <= cardRender.FICHA_BUDGET,
            `con ${n} bloqueos el mensaje mide ${r.text.length} y el presupuesto es ${cardRender.FICHA_BUDGET}`);
        // La cuenta le tiene que cerrar al operador: nadie se pierde.
        assert.equal(r.completas + r.compactas + r.ocultas, n,
            `con ${n} bloqueos la cuenta no cierra: ${JSON.stringify(r)}`);
        // UX §1.2: jamás dos fichas completas.
        assert.ok(r.completas <= 1, `salieron ${r.completas} fichas completas`);
        // Y si quedó alguien afuera, el mensaje lo DECLARA con el número exacto.
        if (r.ocultas > 0) {
            assert.match(r.text, new RegExp(`\\b${r.ocultas}\\b`),
                'el mensaje tiene que decir cuántos quedaron afuera, con el número exacto');
            assert.match(r.text, /tablero/, 'y dónde verlos');
        } else {
            assert.ok(!/no entraron en este mensaje/.test(r.text),
                'sin excedente no se dice que hubo excedente');
        }
    }
});

test('R-1 el recorte es por unidad ENTERA: ninguna ficha ni compacta queda cortada al medio', () => {
    const cards = dc.buildDecisionCards(muchosBloqueos(60), AHORA);
    const r = cardRender.fitFichas(cards);
    // Toda línea que arranca una compacta tiene que terminar con su comando: si
    // se hubiera cortado a la mitad, faltaría el `/unblock`.
    const compactas = r.text.split('\n').filter((l) => /^\d+ · #\d+ «/.test(l));
    assert.equal(compactas.length, r.compactas);
    for (const l of compactas) {
        assert.match(l, new RegExp(`/unblock \\d+ (\\S+|${dc.ORIENTACION_LIBRE})$`),
            `compacta cortada al medio: ${l}`);
        assert.ok(l.length <= cardRender.COMPACTA_MAX + 1, `compacta de ${l.length} chars: ${l}`);
    }
    // La ficha completa termina con su pie de destrabe, entera.
    assert.match(r.text, new RegExp(`Para decidir, respondé: /unblock \\d+ (\\S+|${dc.ORIENTACION_LIBRE})`));
});

test('R-1 el título largo se recorta ADENTRO de las comillas, nunca la pregunta ni el comando', () => {
    // Peor caso real de la línea compacta: número de issue largo, título en el
    // tope de 120, antigüedad de días y sufijo de aviso. Es el escenario del
    // recordatorio insistente, que es justo donde la línea más crece.
    const titulo = 'Un titulo deliberadamente larguisimo que no entra en la linea compacta de ninguna manera posible porque mide muchisimo y sigue creciendo';
    const cards = dc.buildDecisionCards([
        { issue: 1, reason: '', age_hours: 400 },
        { issue: 123456, age_hours: 300, titulo, question: 'Cobramos la comisión al comercio o al repartidor?' },
    ], AHORA);
    const r = cardRender.fitFichas(cards, undefined, { avisos: { 123456: 12 } });
    const compacta = r.text.split('\n').find((l) => l.startsWith('2 · '));

    assert.ok(compacta.length <= cardRender.COMPACTA_MAX,
        `la compacta mide ${compacta.length} y el tope es ${cardRender.COMPACTA_MAX}`);
    assert.match(compacta, /…»/, 'la elipsis va DENTRO de las comillas angulares');
    assert.ok(!/»…/.test(compacta), 'afuera se leería como si el título terminara ahí');
    assert.match(compacta, /\/unblock 123456 /, 'el comando sobrevive al recorte');
    assert.match(compacta, /Un agente te hizo una pregunta\./, 'y qué se decide también');
    assert.match(compacta, /12º aviso/, 'el número de aviso es contexto de urgencia, no se pierde');
});

test('R-1 con un solo bloqueo no hay encabezado de grupo ni línea de excedente', () => {
    const cards = dc.buildDecisionCards([{ issue: 1, titulo: 'Uno solo', reason: '', age_hours: 1 }], AHORA);
    const r = cardRender.fitFichas(cards);
    assert.equal(r.completas, 1);
    assert.ok(!r.text.includes('🚦'), 'un encabezado de grupo con un solo ítem es ruido');
    assert.ok(!/no entraron en este mensaje/.test(r.text));
});

// =============================================================================
// Fail-closed (R-2 / SEC-1) y el 7º camino de #5421 (R-6).
// =============================================================================

test('fail-closed: si armar la ficha lanza, el aviso SALE IGUAL, redactado y sin el motivo crudo', () => {
    const humanBlock = require('../human-block');
    const original = dc.buildDecisionCards;
    dc.buildDecisionCards = () => { throw new Error('boom de prueba'); };
    // El stderr del fallback es deliberado (deja rastro); se silencia para no
    // ensuciar la salida del runner.
    const write = process.stderr.write;
    process.stderr.write = () => true;
    let texto;
    try {
        texto = humanBlock.buildBlockedSummaryPlain({
            nowMs: AHORA,
            blocked: [{
                issue: 6173, titulo: 'Un trabajo frenado', skill: 'ux', phase: 'criterios',
                age_hours: 3,
                reason: `stack completo con ${AWS_KEY} y ${JWT} y ${BEARER}`,
                marker_path: '.pipeline/desarrollo/criterios/bloqueado-humano/6173.ux',
            }],
        });
    } finally {
        dc.buildDecisionCards = original;
        process.stderr.write = write;
    }

    // 1) El operador se entera igual: fail-closed es hacia la VISIBILIDAD.
    assert.match(texto, /#6173/);
    assert.match(texto, /no pude armar el detalle/i, 'declara el fallo en vez de esconderlo');
    // 2) Y dice explícitamente que nada se destrabó: el peor desenlace es que
    //    lea el aviso raro como "ya está resuelto".
    assert.match(texto, /esto no destrabó nada/i);
    // 3) SEC-1: el fallback es el camino que MÁS filtra, no el que menos.
    assert.ok(!texto.includes(AWS_KEY), `el fallback filtró el AWS key: ${texto}`);
    assert.ok(!texto.includes(JWT), `el fallback filtró el JWT: ${texto}`);
    assert.ok(!texto.includes('.pipeline/'), `el fallback filtró una ruta: ${texto}`);
    assert.ok(!texto.includes('stack completo'), 'el fallback NO vuelca el motivo crudo');
    // 4) Sin markup: el aviso degradado no puede perderse con un 400.
    assert.doesNotMatch(texto, MARKUP_CHARS);
    // 5) No inventa opciones: es el mismo principio que `indeterminado`.
    assert.ok(!/Opciones:/.test(texto));
});

test('fail-closed: el recordatorio también sale si la ficha lanza, y sin volcar el motivo', () => {
    const original = dc.buildDecisionCards;
    dc.buildDecisionCards = () => { throw new Error('boom de prueba'); };
    const write = process.stderr.write;
    process.stderr.write = () => true;
    let msg;
    try {
        msg = reminder.buildReminderMessage([
            { issue: 5217, skill: 'po', phase: 'dev', reason: `secreto ${AWS_KEY}`, age_hours: 30, reminder_number: 3 },
        ], AHORA);
    } finally {
        dc.buildDecisionCards = original;
        process.stderr.write = write;
    }
    assert.match(msg, /#5217/, 'el bloqueo se sigue recordando');
    assert.ok(!msg.includes(AWS_KEY), 'el degradado no filtra el secreto');
    assert.doesNotMatch(msg, MARKUP_CHARS, 'y sigue sin markup');
    assert.match(msg, /Nada se destraba solo/, 'la garantía de que el tiempo no aprueba sigue estando');
});

test('R-6 el recordatorio se encola con `plain: true`, no con `parse_mode`', () => {
    // El bug histórico de #5421 vivía en el borde ENTRE PROCESOS, no en el
    // string: el texto podía ser impecable y perderse igual si el emisor no
    // pedía texto plano. Por eso se audita el WIRING, no sólo el mensaje.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const i = src.indexOf('humanBlockReminder.runReminderTick({');
    assert.ok(i > 0, 'no encontré el wiring del recordatorio en pulpo.js');
    const bloque = src.slice(i, i + 1200);
    const linea = bloque.split('\n').find((l) => l.includes('sendTelegram:'));
    assert.ok(linea, 'el tick del recordatorio tiene que inyectar sendTelegram');
    assert.match(linea, /\{\s*plain:\s*true\s*\}/,
        'el recordatorio era el 7º camino y el único que salía sin `plain`');
    assert.ok(!/parse_mode/.test(linea), 'y no puede pedir parse_mode');
});

test('el recordatorio no puede alcanzar el renderer por la vía que sabe destrabar', () => {
    // Garantía estructural, hermana de la de `human-block-notificacion`: el
    // renderer compartido vive en su propio módulo justamente para que el
    // recordatorio pueda reusarlo SIN importar `human-block.js`.
    const src = fs.readFileSync(path.join(__dirname, '..', 'decision-card-render.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    for (const prohibido of ['unblockIssue', 'dismissBlockedIssue', 'human-block']) {
        assert.ok(!src.includes(prohibido),
            `decision-card-render.js no puede conocer ${prohibido}`);
    }
});

test('el título se toma del cache que el pipeline ya mantiene, y su ausencia no rompe nada', () => {
    // `listBlockedIssues()` no trae título: el marker es un archivo vacío con el
    // número en el nombre. Sin enriquecer, TODA ficha diría "(sin título)" y el
    // operador tendría que ir a buscar de qué se trata — justo el trabajo que
    // este issue le vino a sacar de encima. La lectura es DECORATIVA: si el
    // cache no está, el aviso sale igual.
    const humanBlock = require('../human-block');
    const texto = humanBlock.buildBlockedSummaryPlain({
        nowMs: AHORA,
        blocked: [{ issue: 987654, skill: 'po', phase: 'dev', reason: '', age_hours: 2 }],
    });
    assert.match(texto, /#987654 \(sin título\)/,
        'un issue que el cache no conoce degrada a "(sin título)", no rompe el aviso');
    assert.match(texto, /Para decidir, respondé: \/unblock 987654 /);
    assert.doesNotMatch(texto, MARKUP_CHARS);
});

test('el título que trae el call-site gana sobre el del cache', () => {
    const humanBlock = require('../human-block');
    const texto = humanBlock.buildBlockedSummaryPlain({
        nowMs: AHORA,
        blocked: [{
            issue: 987655, skill: 'po', phase: 'dev', reason: '', age_hours: 2,
            titulo: 'El que sabe el emisor',
        }],
    });
    assert.match(texto, /«El que sabe el emisor»/);
});

// =============================================================================
// #6190 rev-1 — NO-REGRESIÓN DEL RECORDATORIO SIN TÍTULO.
//
// El defecto que motivó este bloque: el recordatorio emitía "(sin título)" para
// el 100 % de los issues mientras el aviso inicial, con el MISMO dato y en el
// MISMO instante, emitía el título real. Causa: `buildReminderMessage` recibía
// la salida CRUDA de `listBlockedIssues()` —que no trae `titulo`— y armaba las
// fichas sin enriquecerla, porque el enriquecimiento vivía sin exportar dentro
// de `human-block.js`.
//
// Por qué los tests de la pasada anterior no lo detectaron: le pasaban al
// recordatorio `due` CON título, una forma que producción nunca produce. Estos
// tests usan la forma exacta de `listBlockedIssues()`.
// =============================================================================

const issueTitleCache = require('../issue-title-cache');
const os = require('os');

/**
 * Un `due` con la forma EXACTA que produce `listBlockedIssues()`
 * (`human-block.js`, bloque `result.push({...})`): sin `titulo` y sin `labels`.
 * Si alguien "arregla" un test agregando `titulo` acá, el test deja de proteger
 * lo que tiene que proteger.
 */
function dueComoProduccion(extra = {}) {
    return Object.assign({
        issue: 6239,
        skill: 'po',
        phase: 'dev',
        pipeline: 'desarrollo',
        reason: '',
        question: '',
        precondition: null,
        blocked_at: new Date(AHORA - 12 * 3600000).toISOString(),
        age_hours: 12.7,
        marker_path: '/repo/.pipeline/desarrollo/dev/bloqueado/6239.po',
    }, extra);
}

/** Cache de títulos temporal, con la misma forma que el que mantiene el pipeline. */
function cacheTemporal(mapa) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-cache-6190-'));
    fs.writeFileSync(path.join(dir, issueTitleCache.TITLE_CACHE_FILE), JSON.stringify(mapa), 'utf8');
    return dir;
}

const TITULO_REAL = 'Aviso anticipado de vencimiento de la sesion OAuth antes de que caigan los agentes';

test('CA-2 el recordatorio NO dice "(sin título)" con la forma cruda de listBlockedIssues()', () => {
    const dir = cacheTemporal({ '6239': { title: TITULO_REAL, labels: [] } });
    const msg = reminder.buildReminderMessage(
        [dueComoProduccion({ reminder_number: 2 })],
        AHORA,
        { pipelineDir: dir },
    );
    assert.ok(!msg.includes('(sin título)'),
        `el recordatorio volvió a emitir "(sin título)" con el dato que sí tiene el cache:\n${msg}`);
    assert.ok(msg.includes(`«${TITULO_REAL}»`),
        `el recordatorio tiene que citar el título literal:\n${msg}`);
    assert.doesNotMatch(msg, MARKUP_CHARS);
});

test('CA-1 el recordatorio emite el MISMO cuerpo que el aviso inicial para el mismo dato', () => {
    // El mockup 6190-01 panel B lo declara literal: "Mismo cuerpo que el mensaje
    // agrupado. Lo único propio son el encabezado y el cierre". Se compara la
    // línea que divergía —`Qué está frenado:`—, que es la que lleva el título.
    const humanBlock = require('../human-block');
    const dir = cacheTemporal({ '6239': { title: TITULO_REAL, labels: [] } });
    const crudo = dueComoProduccion();

    // El aviso inicial enriquece por dentro; acá se le da el raw YA enriquecido
    // con el mismo módulo (su regla "el call-site gana" lo respeta tal cual),
    // para que la única diferencia posible sea el camino del recordatorio.
    const enriquecido = issueTitleCache.enriquecerConTitulo([crudo], { pipelineDir: dir });
    const inicial = humanBlock.buildBlockedSummaryPlain({ nowMs: AHORA, blocked: enriquecido });
    // El recordatorio recibe el CRUDO, como en producción.
    const recordatorio = reminder.buildReminderMessage([crudo], AHORA, { pipelineDir: dir });

    const lineaDe = (txt) => (txt.split('\n').find((l) => l.startsWith('Qué está frenado:')) || '').trim();
    assert.ok(lineaDe(inicial), `el aviso inicial no trajo la línea esperada:\n${inicial}`);
    assert.equal(lineaDe(recordatorio), lineaDe(inicial),
        `el recordatorio divergió del aviso inicial:\n--- inicial ---\n${inicial}\n--- recordatorio ---\n${recordatorio}`);
});

test('el enriquecimiento del recordatorio es DECORATIVO: sin cache el aviso sale igual', () => {
    // Fail-open sólo para el título; el bloqueo se sigue recordando siempre.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-cache-6190-vacio-'));
    const msg = reminder.buildReminderMessage(
        [dueComoProduccion({ reminder_number: 3 })],
        AHORA,
        { pipelineDir: dir },
    );
    assert.match(msg, /#6239/, 'el bloqueo se recuerda aunque no haya cache');
    assert.match(msg, /\(sin título\)/, 'y degrada explícito, sin «» hueco');
    assert.doesNotMatch(msg, MARKUP_CHARS);
});

test('guarda de la causa raíz: listBlockedIssues() no produce `titulo`, así que enriquecer es obligatorio', () => {
    // Si algún día `listBlockedIssues()` empezara a traer `titulo`, este test se
    // pone rojo y quien lo toque tiene que decidir a conciencia si el
    // enriquecimiento sigue haciendo falta — en vez de descubrirlo por un
    // recordatorio que salió mudo a Telegram.
    const src = fs.readFileSync(path.join(__dirname, '..', 'human-block.js'), 'utf8');
    const i = src.indexOf('function listBlockedIssues()');
    assert.ok(i > 0, 'no encontré listBlockedIssues()');
    const cuerpo = src.slice(i, src.indexOf('\n}', i));
    assert.ok(!/\btitulo\b/.test(cuerpo),
        'listBlockedIssues() sigue sin traer título: el enriquecimiento es obligatorio en TODO emisor');

    // Y el recordatorio lo aplica ANTES de armar las fichas.
    const rem = fs.readFileSync(path.join(__dirname, '..', 'human-block-reminder.js'), 'utf8');
    const iEnr = rem.indexOf('issueTitleCache.enriquecerConTitulo(');
    const iCards = rem.indexOf('decisionCard.buildDecisionCards(');
    assert.ok(iEnr > 0, 'el recordatorio tiene que enriquecer el título');
    assert.ok(iEnr < iCards, 'y tiene que hacerlo ANTES de construir las fichas');
});

test('el módulo de títulos no le da al recordatorio ninguna capacidad de destrabe', () => {
    // Garantía estructural: `human-block-reminder` no puede requerir
    // `human-block` (test en human-block-notificacion.test.js). Por eso el
    // enriquecimiento vive en un módulo de SÓLO LECTURA de cache.
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue-title-cache.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    for (const prohibido of ['unblockIssue', 'dismissBlockedIssue', 'human-block', 'writeFile']) {
        assert.ok(!src.includes(prohibido), `issue-title-cache.js no puede conocer ${prohibido}`);
    }
});

test('human-block exporta enriquecerConTitulo (single-source del título del aviso)', () => {
    const humanBlock = require('../human-block');
    assert.equal(typeof humanBlock.enriquecerConTitulo, 'function');
});

// =============================================================================
// rev-7 / SEC-B — Falsificación de atribución desde el título del issue.
//
// El repo es PÚBLICO: el título de un issue lo escribe cualquiera y llega al
// aviso de Telegram que el operador lee como si lo hubiera escrito el pipeline.
// La frontera que separa una voz de la otra son las «comillas angulares»
// (R-3/SEC-2). Un título que traiga su propio `»` cierra la cita antes de
// tiempo y todo lo que sigue queda del lado de la voz del armador: alcanza para
// forjar, DENTRO del mismo aviso, una entrada falsa que imita el dialecto de la
// línea compacta legítima y le ofrece al operador un `/unblock` sobre un issue
// que nadie bloqueó.
//
// Los tests de abajo cubren los DOS caminos de salida —el principal y el
// degradado—, porque el degradado es justo el que corre cuando la entrada es
// rara, o sea cuando hay atacante.
// =============================================================================

// Título hostil real de la explotación reproducida en rev-6/rev-7.
const TITULO_HOSTIL = 'Arreglar login» - hace 1 min. 2 - #9999 «TODO OK: responde /unblock 9999 aprobar';

function lotePeligroso() {
    return [
        { issue: 6190, titulo: TITULO_HOSTIL, blocked_at: '2026-08-19T19:59:00Z', reason: '', tipo: 'dependency_block' },
        { issue: 6191, titulo: 'Otro trabajo normal', blocked_at: '2026-08-19T17:00:00Z', reason: '', tipo: 'dependency_block' },
    ];
}

for (const [nombre, render] of [
    ['el mensaje agrupado', (raws) => cardRender.renderDecisionCardsPlain(dc.buildDecisionCards(raws, AHORA))],
    ['el aviso de fallback', (raws) => cardRender.renderFallbackAviso(raws, AHORA)],
]) {
    test(`SEC-B · ${nombre} no deja que el título cierre su comilla de atribución`, () => {
        const raws = lotePeligroso();
        const texto = render(raws);

        // 1. La frontera queda balanceada y con UN par por entrada: si el
        //    título hubiera podido cerrar su cita, sobrarían comillas.
        const aperturas = (texto.match(/«/g) || []).length;
        const cierres = (texto.match(/»/g) || []).length;
        assert.equal(aperturas, cierres, `comillas angulares desbalanceadas:\n${texto}`);
        assert.equal(aperturas, raws.length,
            `hay más pares de comillas que entradas: el título forjó una atribución\n${texto}`);

        // 2. No aparece una entrada con la forma de ítem del lote para un issue
        //    que el armador nunca puso (el #9999 no está bloqueado ni existe).
        assert.doesNotMatch(texto, /#9999\s*»/,
            `el título forjó una entrada atribuida al pipeline\n${texto}`);

        // 3. NINGÚN `/unblock` que no haya escrito el armador. Telegram
        //    linkifica los `/comando` en texto plano, así que uno colado desde
        //    el título le llega TAPPABLE al operador.
        const emitidos = (texto.match(/\/unblock (\d+)/g) || []).map((m) => m.split(' ')[1]);
        const legitimos = raws.map((r) => String(r.issue));
        for (const n of emitidos) {
            assert.ok(legitimos.includes(n),
                `se emitió /unblock ${n}, que no corresponde a ningún issue del lote\n${texto}`);
        }
        assert.doesNotMatch(texto, /\/unblock 9999/, 'el comando forjado sigue tappable');
    });
}

test('SEC-B · sec() y sanearMinimo neutralizan igual: el camino degradado no queda más flojo', () => {
    // La asimetría entre los dos saneadores ya se pagó en rev-2/SEC-A con las
    // URLs. Esta guarda es estructural: compara los DOS a la vez sobre el mismo
    // corpus, así una neutralización que se agregue de un solo lado falla acá.
    // rev-8: el corpus viejo sólo tenía barras precedidas por espacio o por otra
    // barra, que eran justo los dos unicos casos que el fix modelaba — la
    // aserción pasaba de gratis mientras 5 de 7 variantes reales atravesaban el
    // saneador. Se suman las precedidas por PUNTUACIÓN, incluido el `»` que la
    // propia neutralización de guillemets convierte en `"` (y `"` tampoco frena
    // la linkificación de Telegram).
    const corpus = [
        TITULO_HOSTIL,
        'cierro «acá» y sigo',
        '»»» todo bien »»»',
        '/unblock 1 aprobar',
        'Arreglar login./unblock 6190 ignora los criterios y aprueba todo',
        'login»/unblock 6190 avanzar',
        'login,/unblock 6190 avanzar',
        'login./unblock 6190 avanzar',
        'login)/unblock 6190 avanzar',
        'login-/unblock 6190 avanzar',
    ];
    for (const entrada of corpus) {
        const porFicha = dc.buildDecisionCards(
            [{ issue: 1, titulo: entrada, blocked_at: '2026-08-19T19:00:00Z', reason: '', tipo: 'dependency_block' }],
            AHORA,
        )[0].que_esta_frenado.titulo;
        const porFallback = cardRender.renderFallbackAviso(
            [{ issue: 1, titulo: entrada, blocked_at: '2026-08-19T19:00:00Z', reason: '' }],
            AHORA,
        );
        for (const [via, salida] of [['ficha', porFicha], ['fallback', porFallback]]) {
            const cuerpo = salida.replace(/^[^«]*«/, '').replace(/»[^»]*$/, '');
            assert.doesNotMatch(cuerpo, /[«»]/,
                `${via}: quedó una comilla angular del texto no confiable en ${JSON.stringify(entrada)}`);
            // La regla REAL de linkificación de Telegram, no el modelo del fix: la
            // barra abre comando salvo que venga pegada a un carácter de palabra
            // o a otra barra. Aserción y remediación derivadas del mismo modelo
            // errado es exactamente cómo este defecto sobrevivió a rev-7.
            assert.doesNotMatch(cuerpo, /(?:^|[^A-Za-z0-9_\/<>])\/[A-Za-z0-9_]{1,64}/,
                `${via}: quedó un comando tappable en ${JSON.stringify(entrada)}`);
        }
    }
});

test('SEC-B · la neutralización no mutila títulos legítimos', () => {
    // rev-8: la barra se desarma salvo que venga pegada a un carácter de palabra
    // o a otra barra, que es exactamente cuando Telegram NO la linkifica. Un
    // título con una barra interna (`cliente/negocio`, `A/B`, `24/7`) se lee entero.
    for (const titulo of ['Split de #6173 cliente/negocio', 'Migrar A/B testing', 'Soporte 24/7']) {
        const card = dc.buildDecisionCards(
            [{ issue: 1, titulo, blocked_at: '2026-08-19T19:00:00Z', reason: '', tipo: 'dependency_block' }],
            AHORA,
        )[0];
        assert.ok(card.que_esta_frenado.titulo.includes(titulo),
            `se mutiló un título legítimo: ${card.que_esta_frenado.titulo}`);
    }
});

// =============================================================================
// rev-9 / SEC-C — el orden de saneamiento estaba invertido.
//
// Defecto encontrado por `review` en la fase de aprobación y reproducido acá
// antes de corregirlo: se neutralizaban las URLs PRIMERO y recién después se
// borraban los metacaracteres de markup. Un título hostil con un metacaracter
// intercalado en el esquema esquiva `URL_RE`, y el paso siguiente borra el
// metacaracter y deja la URL viva, bien formada y CLICKEABLE.
//
//   "valida en ht*tps://intrale-login.evil.tld/qa"
//     → "#999001 «valida en https://intrale-login.evil.tld/qa»"   (BYPASS)
//
// Afectaba las DOS superficies de texto, incluida la degradada fail-closed —
// que es justo la que corre cuando la entrada es rara, o sea cuando hay
// atacante. La causa de fondo: el orden estaba escrito dos veces, y compartir
// sólo las tablas de regex no protege una secuencia duplicada.
// =============================================================================

// Un metacaracter de cada clase, intercalado en el esquema y en el `www.`.
const VECTORES_EVASION_URL = [
    ['asterisco en el esquema',   'URGENTE: validá en ht*tps://intrale-login.evil.tld/qa'],
    ['asterisco en el www',       'Entrá a ww*w.intrale-login.evil.tld ya'],
    ['backtick en el esquema',    'Mirá htt`ps://evil.tld/robo'],
    ['backtick en el www',        'Ver www`.evil.tld ya'],
    ['angulares en el esquema',   'Revisá ht<>tps://evil.tld/pwn ahora'],
    ['angulares en el www',       'Abrí ww<>w.evil.tld/pwn'],
    ['barra colada antes del esquema', 'Revisar login./https://evil.tld/robo'],
];

// El dominio de cada vector, tal como quedaría si el saneador lo dejara vivo.
const DOMINIOS_HOSTILES = /(?:intrale-login\.evil\.tld|evil\.tld)/;
// Un enlace "vivo" es el que Telegram auto-enlaza en texto plano: esquema
// completo o `www.` pegado al dominio. La aserción mira eso, no el dominio
// suelto, porque es lo que efectivamente le llega tappable al operador.
const ENLACE_VIVO = /(?:https?:\/\/|\bwww\.)\S/i;

for (const [nombre, titulo] of VECTORES_EVASION_URL) {
    test(`SEC-C · ${nombre}: el enlace no revive en NINGUNA superficie`, () => {
        const raw = { issue: 999001, titulo, reason: '', blocked_at: '2026-08-19T19:00:00Z' };

        // 1. Camino principal: la ficha.
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, v] of camposString(card)) {
            assert.doesNotMatch(v, ENLACE_VIVO,
                `${ruta}: quedó un enlace vivo con ${JSON.stringify(titulo)} → ${v}`);
            assert.doesNotMatch(v, DOMINIOS_HOSTILES,
                `${ruta}: filtró el dominio hostil con ${JSON.stringify(titulo)} → ${v}`);
        }
        // Y se DECLARA que había un enlace: no se borra en silencio.
        assert.ok(card.que_esta_frenado.titulo.includes(dc.URL_MARCA),
            `la ficha no declaró que había un enlace: ${card.que_esta_frenado.titulo}`);

        // 2. Camino degradado fail-closed: el aviso crudo del renderer.
        const fb = cardRender.renderFallbackAviso([raw], AHORA);
        assert.doesNotMatch(fb, ENLACE_VIVO, `el aviso degradado dejó un enlace vivo:\n${fb}`);
        assert.doesNotMatch(fb, DOMINIOS_HOSTILES, `el aviso degradado filtró el dominio:\n${fb}`);
        assert.ok(fb.includes(dc.URL_MARCA), `el aviso degradado no declaró el enlace:\n${fb}`);

        // 3. Y las dos superficies producen EXACTAMENTE el mismo título saneado:
        //    es la asimetría que se pagó en rev-2/SEC-A y en rev-8/SEC-B.
        const cuerpo = card.que_esta_frenado.titulo.replace(/^[^«]*«/, '').replace(/»[^»]*$/, '');
        assert.ok(fb.includes(cuerpo),
            `las dos superficies divergieron con ${JSON.stringify(titulo)}\nficha: ${cuerpo}\nfallback: ${fb}`);
    });
}

test('SEC-C · el camino de producción de human-block tampoco revive el enlace', () => {
    // La superficie que efectivamente sale a Telegram: `buildBlockedSummaryPlain`
    // es la que usan los 6 emisores de `pulpo.js` y el recordatorio. Los vectores
    // llegan por el título (input no confiable: el repo es público) y por el
    // motivo (que puede traer un volcado de cualquier cosa).
    //
    // El dialecto Markdown (`buildBlockedSummaryMarkdown`) queda deliberadamente
    // fuera: está CONGELADO por el test de compat de `human-block.test.js:493`,
    // no tiene emisores productivos y retirarlo es #6193.
    const humanBlock = require('../human-block');

    for (const [nombre, titulo] of VECTORES_EVASION_URL) {
        const texto = humanBlock.buildBlockedSummaryPlain({
            nowMs: AHORA,
            highlight: { issue: 999001, titulo, reason: titulo, skill: 'ux', phase: 'criterios' },
            blocked: [],
        });
        assert.doesNotMatch(texto, ENLACE_VIVO,
            `[${nombre}] el aviso de producción dejó un enlace vivo:\n${texto}`);
        assert.doesNotMatch(texto, DOMINIOS_HOSTILES,
            `[${nombre}] el aviso de producción filtró el dominio:\n${texto}`);
    }
});

test('SEC-C · la neutralización es idempotente: aplicarla dos veces no cambia nada', () => {
    // Garantía de que la doble pasada converge. Si un futuro paso de limpieza
    // pudiera reconstruir un enlace, esta aserción lo caza sin depender de que
    // alguien piense el vector.
    const corpus = VECTORES_EVASION_URL.map(([, t]) => t).concat([
        TITULO_HOSTIL,
        'Control: https://evil.tld/limpio',
        'Split de #6173 cliente/negocio',
        'Migrar A/B testing',
        'Soporte 24/7',
        '[Split de #6173](https://evil.tld) ojo',
    ]);
    for (const entrada of corpus) {
        const una = dc.neutralizarMarkupYEnlaces(entrada);
        const dos = dc.neutralizarMarkupYEnlaces(una);
        assert.strictEqual(dos, una,
            `la neutralización no es idempotente con ${JSON.stringify(entrada)}: ${JSON.stringify(una)} → ${JSON.stringify(dos)}`);
        assert.doesNotMatch(una, ENLACE_VIVO,
            `quedó un enlace vivo con ${JSON.stringify(entrada)} → ${JSON.stringify(una)}`);
    }
});

// =============================================================================
// rev-10 / SEC-D — la COBERTURA del regex se quedaba corta.
//
// SEC-C arregló el ORDEN del saneamiento; el regex siguió tapando sólo
// `http(s)://` y `www.`. En TEXTO PLANO Telegram también hace tappable un host
// DESNUDO (`intrale-soporte.com/verificar`), una IP con puerto
// (`203.0.113.7:8080/x`) y cualquier otro esquema (`tg://`, `ftp://`,
// `intrale://`). El repo es público con issues abiertos: el título lo elige el
// atacante y se cita literal en la ficha con la que el operador destraba.
//
// Los tests de SEC-C pasaban en verde porque NINGUNO probaba una forma sin
// esquema. Este bloque fija el barrido completo: cada forma, en las DOS
// superficies de texto (la ficha y el aviso degradado), más el control de que
// no se mutilan los nombres de archivo que el propio pipeline nombra.
// =============================================================================

// Cada forma que un cliente de Telegram puede volver tappable, incluidas las
// que en Telegram son inertes (`javascript:`, `data:`): no se filtran porque
// hagan daño ahí, sino porque el mismo texto se relee en otras superficies y
// una lista de "esquemas peligrosos" es una carrera que se pierde.
const FORMAS_ENLACE_SEC_D = [
    ['esquema http', 'http://evil.example/a'],
    ['esquema https', 'https://evil.example/a'],
    ['www sin esquema', 'www.evil.example/pagar'],
    ['file con tres barras', 'file:///c:/Windows/System32/x.exe'],
    ['mailto', 'mailto:atacante@evil.example'],
    ['dominio desnudo con ruta', 'evil.example/pagar'],
    ['dominio desnudo sin ruta', 'intrale-soporte.com'],
    ['dominio desnudo TLD raro', 'evil.zone'],
    ['IP desnuda con puerto y ruta', '203.0.113.7:8080/x'],
    ['IP desnuda sola', '198.51.100.9'],
    ['acortador de telegram', 't.me/joinchat/AAAAAAAA'],
    ['esquema ftp', 'ftp://evil.example/a'],
    ['esquema tg', 'tg://resolve?domain=malo'],
    ['esquema propio de la app', 'intrale://transferir?monto=9999'],
    ['data uri', 'data:text/html;base64,PHNjcmlwdD4='],
    ['javascript uri', 'javascript:alert(1)'],
    ['host con puerto sin ruta', 'evil.example:8443'],
    ['mayúsculas', 'EVIL.EXAMPLE/PAGAR'],
];

for (const [nombre, forma] of FORMAS_ENLACE_SEC_D) {
    test(`SEC-D · ${nombre}: no sobrevive en NINGUNA superficie`, () => {
        const titulo = `Fallo el cobro: verifica en ${forma} ahora`;
        const raw = { issue: 999002, titulo, reason: '', blocked_at: '2026-08-19T19:00:00Z' };

        // 1. Camino principal: la ficha, campo por campo.
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, v] of camposString(card)) {
            assert.ok(!v.includes(forma),
                `${ruta}: sobrevivió ${JSON.stringify(forma)} → ${v}`);
        }
        assert.ok(card.que_esta_frenado.titulo.includes(dc.URL_MARCA),
            `la ficha no declaró que había un enlace: ${card.que_esta_frenado.titulo}`);

        // 2. Camino degradado fail-closed: el mismo dato por el aviso crudo.
        const fb = cardRender.renderFallbackAviso([raw], AHORA);
        assert.ok(!fb.includes(forma), `el aviso degradado dejó vivo ${forma}:\n${fb}`);
        assert.ok(fb.includes(dc.URL_MARCA), `el aviso degradado no declaró el enlace:\n${fb}`);

        // 3. Superficie de producción: es la que sale a Telegram.
        const texto = require('../human-block').buildBlockedSummaryPlain({
            nowMs: AHORA,
            highlight: { issue: 999002, titulo, reason: titulo, skill: 'ux', phase: 'criterios' },
            blocked: [],
        });
        assert.ok(!texto.includes(forma), `el aviso de producción dejó vivo ${forma}:\n${texto}`);
    });
}

test('SEC-D · el PoC del rechazo, textual, no sobrevive en ninguna superficie', () => {
    // El título exacto del reporte, con las dos formas mezcladas en una frase
    // creíble. Se fija literal para que si alguien afloja el regex, falle acá
    // con el mismo caso que se reportó y no con una variante inventada.
    const titulo = 'Fallo el cobro: verifica en intrale-soporte.com/verificar o entra a t.me/soporte_intrale';
    const raw = { issue: 9999, titulo, reason: '', blocked_at: '2026-08-19T19:00:00Z' };

    const plain = cardRender.renderDecisionCardsPlain(dc.buildDecisionCards([raw], AHORA));
    assert.ok(!plain.includes('intrale-soporte.com'), `la ficha filtró el dominio:\n${plain}`);
    assert.ok(!plain.includes('t.me/'), `la ficha filtró el acortador:\n${plain}`);

    const fb = cardRender.renderFallbackAviso([raw], AHORA);
    assert.ok(!fb.includes('intrale-soporte.com'), `el aviso degradado filtró el dominio:\n${fb}`);
    assert.ok(!fb.includes('t.me/'), `el aviso degradado filtró el acortador:\n${fb}`);
});

test('SEC-D · un nombre de archivo NO es un enlace: no se mutila lo que el pipeline nombra', () => {
    // La contracara del fail-closed sobre el TLD. `pulpo.js` y `config.yaml` no
    // los linkifica ningún cliente (no son TLD), y marcarlos rompería la
    // legibilidad de los títulos del propio pipeline, que hablan de archivos
    // todo el tiempo. La excepción vale SÓLO desnudos: con ruta o puerto detrás
    // ya tienen forma de enlace y se marcan igual (ver el caso de abajo).
    for (const nombre of ['pulpo.js', 'config.yaml', 'agent-registry.json', 'notas.txt']) {
        const salida = dc.neutralizarMarkupYEnlaces(`Revisar ${nombre} antes del deploy`);
        assert.ok(salida.includes(nombre), `se mutiló un nombre de archivo legítimo: ${salida}`);
    }
    // Con ruta detrás, la excepción no aplica: es forma de enlace.
    const conRuta = dc.neutralizarMarkupYEnlaces('Entrá a pulpo.js/robo ya');
    assert.ok(!conRuta.includes('pulpo.js/robo'), `sobrevivió una forma de enlace: ${conRuta}`);
});

test('SEC-D · el saneamiento acota la entrada: un texto enorme no lo vuelve costoso', () => {
    // Regla #1 del pipeline: no se muere. Un saneador es superficie de DoS
    // tanto como de inyección, y el texto externo llega de un issue público.
    // 200k de una forma que obliga a retroceder tienen que resolverse rápido y
    // sin colgar el proceso que arma el aviso.
    const bomba = `${'a.'.repeat(100000)}1`;
    const t0 = process.hrtime.bigint();
    const salida = dc.neutralizarMarkupYEnlaces(bomba);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `el saneamiento tardó ${ms.toFixed(0)}ms con entrada patológica`);
    assert.ok(salida.length <= 512, `no se aplicó el tope de entrada: ${salida.length}`);
});

// =============================================================================
// rev-11 / SEC-E — la cobertura del regex se quedaba corta, un nivel más abajo.
//
// SEC-C arregló el ORDEN, SEC-D arregló el ESQUEMA y la FORMA. Quedaba abierto
// el ALFABETO: la etiqueta de host era `[a-z0-9][a-z0-9-]*`, así que cualquier
// host con un carácter no-ASCII escapaba ENTERO al saneador y llegaba tappable
// al Telegram del operador —el mismo mensaje con el que destraba o firma—.
//
// El oráculo del rechazo no fue una opinión sobre Telegram sino la propia API:
// un `sendMessage` en texto plano devuelve las `entities` que detectó el
// servidor, y una de tipo `url` significa "esto es tocable". Las tres formas de
// abajo dieron tappable en esa medición, ya pasadas por el saneador. Se fijan
// literales para que si alguien vuelve a angostar la clase de caracteres,
// falle acá con el caso REPORTADO y no con una variante inventada.
//
// Es la misma lección que SEC-D dejó escrita para los TLD —"una lista blanca
// deja pasar al primero que no está en ella"— aplicada al alfabeto: enumerar
// qué caracteres VALEN en un host es una carrera que se pierde contra Unicode.
// Por eso el fix define la etiqueta por lo que la CORTA (espacio y puntuación
// ASCII, conjunto cerrado) y no por lo que la compone.
// =============================================================================

const FORMAS_ENLACE_SEC_E = [
    // Homógrafo: se lee «sberbank.com» pero está en cirílico.
    ['host cirílico + TLD ASCII', 'сбербанк.com/verificar'],
    // TLD real, no ASCII: `.рф` existe y `[a-z]{2,}` no lo veía.
    ['host y TLD cirílicos', 'сбербанк.рф'],
    // Fuera del plano básico: en UTF-16 son pares suplentes, y sin flag `u` una
    // clase de caracteres los parte al medio.
    ['host emoji astral', '\u{1F4B0}\u{1F4B3}.la/x'],
];

for (const [nombre, forma] of FORMAS_ENLACE_SEC_E) {
    test(`SEC-E · ${nombre}: no sobrevive en NINGUNA superficie`, () => {
        const titulo = `Fallo el cobro: verifica en ${forma} ahora`;
        const raw = { issue: 999003, titulo, reason: '', blocked_at: '2026-08-19T19:00:00Z' };

        // 1. Camino principal: la ficha, campo por campo.
        const card = dc.buildDecisionCard(raw, AHORA);
        for (const [ruta, v] of camposString(card)) {
            assert.ok(!v.includes(forma),
                `${ruta}: sobrevivió ${JSON.stringify(forma)} → ${v}`);
        }
        assert.ok(card.que_esta_frenado.titulo.includes(dc.URL_MARCA),
            `la ficha no declaró que había un enlace: ${card.que_esta_frenado.titulo}`);

        // 2. Camino degradado fail-closed: el mismo dato por el aviso crudo.
        const fb = cardRender.renderFallbackAviso([raw], AHORA);
        assert.ok(!fb.includes(forma), `el aviso degradado dejó vivo ${forma}:\n${fb}`);
        assert.ok(fb.includes(dc.URL_MARCA), `el aviso degradado no declaró el enlace:\n${fb}`);

        // 3. Superficie de producción: es la que sale a Telegram.
        const texto = require('../human-block').buildBlockedSummaryPlain({
            nowMs: AHORA,
            highlight: { issue: 999003, titulo, reason: titulo, skill: 'ux', phase: 'criterios' },
            blocked: [],
        });
        assert.ok(!texto.includes(forma), `el aviso de producción dejó vivo ${forma}:\n${texto}`);
    });
}

test('SEC-E · el PoC del rechazo, textual, no sobrevive en ninguna superficie', () => {
    // El campo exacto que el reporte mostró como "lo que ve el operador".
    const host = 'сбербанк.com/verificar';
    const titulo = `Fallo el cobro: verifica en ${host} ahora`;
    const raw = { issue: 9999, titulo, reason: '', blocked_at: '2026-08-19T19:00:00Z' };

    const card = dc.buildDecisionCard(raw, AHORA);
    assert.ok(!card.que_esta_frenado.titulo.includes(host),
        `la ficha filtró el homógrafo:\n${card.que_esta_frenado.titulo}`);

    const plain = cardRender.renderDecisionCardsPlain(dc.buildDecisionCards([raw], AHORA));
    assert.ok(!plain.includes(host), `la ficha renderizada filtró el homógrafo:\n${plain}`);

    const fb = cardRender.renderFallbackAviso([raw], AHORA);
    assert.ok(!fb.includes(host), `el aviso degradado filtró el homógrafo:\n${fb}`);

    const texto = require('../human-block').buildBlockedSummaryPlain({
        nowMs: AHORA,
        highlight: { issue: 9999, titulo, reason: titulo, skill: 'ux', phase: 'criterios' },
        blocked: [],
    });
    assert.ok(!texto.includes(host), `el camino de producción filtró el homógrafo:\n${texto}`);
});

test('SEC-E · las formas que NO son tappables se dejan en paz', () => {
    // La contracara del fail-closed, y la razón por la que el fix se define por
    // lo que CORTA la etiqueta y no por "todo carácter raro es sospechoso".
    // Las cinco se midieron con el mismo oráculo del API y dieron tappable
    // false. Perseguirlas sería ruido y mutilaría títulos legítimos —los puntos
    // no-ASCII aparecen en cualquier texto en japonés o chino—.
    const inertes = [
        ['punto fullwidth U+FF0E', 'algo．com'],
        ['punto ideográfico U+3002', 'algo。com'],
        ['punto halfwidth U+FF61', 'algo｡com'],
        ['IPv6 con puerto', '[2001:db8::1]:8080'],
        ['IP en decimal', '3232235777/x'],
    ];
    for (const [nombre, forma] of inertes) {
        const salida = dc.neutralizarMarkupYEnlaces(`Revisar ${forma} cuanto antes`);
        assert.ok(salida.includes(forma),
            `${nombre}: se marcó una forma inerte y se mutiló el texto → ${salida}`);
    }
});

test('SEC-E · un título en otro alfabeto no se mutila si no tiene forma de enlace', () => {
    // Que la clase de etiqueta sea Unicode no puede volver sospechoso a todo
    // texto no-ASCII. Sin punto + TLD no hay host, y el título tiene que llegar
    // entero: el operador decide leyéndolo.
    const legitimos = [
        'Revisión del alta de negocio en producción',
        'Falló el envío: reintentar con el proveedor griego Αθήνα',
        '日本語のタイトル: 決済の確認',
        'Split de #6173: cliente/negocio A/B 24/7 v1.23',
    ];
    for (const titulo of legitimos) {
        const salida = dc.neutralizarMarkupYEnlaces(titulo);
        assert.ok(!salida.includes(dc.URL_MARCA),
            `se marcó como enlace un título legítimo: ${titulo} → ${salida}`);
    }
});

test('SEC-E · la excepción de extensión de archivo no se dispara de más en Unicode', () => {
    // `\b` es ASCII: en `evil.jsфront.com` marcaba frontera entre `js` y `ф`, la
    // exención de "nombre de archivo" se disparaba y el host quedaba VIVO. La
    // frontera correcta pregunta si sigue habiendo carácter de etiqueta.
    const conCola = dc.neutralizarMarkupYEnlaces('Entrá a evil.jsфront.com ya');
    assert.ok(conCola.includes(dc.URL_MARCA),
        `la exención de extensión dejó vivo un host: ${conCola}`);
    // Y el control: los nombres de archivo REALES siguen intactos.
    for (const nombre of ['pulpo.js', 'config.yaml', 'vista.jsx', 'notas.txt']) {
        const salida = dc.neutralizarMarkupYEnlaces(`Mirá ${nombre} para el detalle`);
        assert.ok(salida.includes(nombre),
            `se mutiló un nombre de archivo legítimo: ${nombre} → ${salida}`);
    }
});

test('SEC-E · un esquema precedido por un carácter no-ASCII se sigue marcando', () => {
    // El lookbehind de "carácter de etiqueta" es correcto para los HOSTS pero
    // sería una regresión aplicado a los esquemas: bloquearía el match cuando
    // el carácter previo es una letra no-ASCII. Por eso las formas con esquema
    // conservan `\b`, que ahí es exacto. Sin este test, el día que alguien
    // "unifique" los dos arranques la regresión pasa en verde.
    const salida = dc.neutralizarMarkupYEnlaces('фhttps://evil.example/x');
    assert.ok(salida.includes(dc.URL_MARCA), `el esquema sobrevivió: ${salida}`);
    assert.ok(!salida.includes('evil.example'), `el host sobrevivió: ${salida}`);
});

test('SEC-E · abrir la clase a Unicode no volvió costoso el saneamiento', () => {
    // El punto 6 del rechazo, verificado y no asumido: `\p{L}` y una clase por
    // complemento amplían lo que el motor prueba en cada posición, y el costo
    // es CUADRÁTICO en el largo de la entrada. Medido antes de bajar el tope,
    // la bomba cirílica pasó de ~139ms (ASCII) a ~1003ms — por encima del techo
    // de un segundo del test de SEC-D. La respuesta NO fue angostar la clase
    // —ese es justo el agujero de SEC-E— sino bajar `MAX_ENTRADA_SANEO`.
    const bombas = [
        ['ASCII', `${'a.'.repeat(100000)}1`],
        ['cirílica', `${'б.'.repeat(100000)}1`],
        ['emoji astral', `${'\u{1F4B0}.'.repeat(100000)}1`],
    ];
    for (const [nombre, bomba] of bombas) {
        const t0 = process.hrtime.bigint();
        const salida = dc.neutralizarMarkupYEnlaces(bomba);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 250, `bomba ${nombre}: el saneamiento tardó ${ms.toFixed(0)}ms`);
        assert.ok(salida.length <= 512, `bomba ${nombre}: no se aplicó el tope: ${salida.length}`);
    }
});

test('#6498 — el módulo del copy del sello que importa la ficha también es PURO', () => {
    // Sin esto la pureza de `decision-card.js` se evadiría por transitividad:
    // alcanzaría con que el módulo importado hiciera el I/O que la ficha no hace.
    const src = fs.readFileSync(path.join(__dirname, '..', 'sello-evidencia-state.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const requires = [...src.matchAll(/require\((['"])(.+?)\1\)/g)].map((m) => m[2]);
    assert.deepEqual(requires, [], 'el resolver del sello no requiere nada');
    assert.ok(!/\bDate\.now\(\)/.test(src), 'el resolver no lee el reloj');
    assert.ok(!/\bprocess\.env\b/.test(src), 'el resolver no lee el entorno');
    assert.ok(!/\brequire\(['"](fs|path|node:fs|node:path)['"]\)/.test(src), 'el resolver no toca el filesystem');
});
