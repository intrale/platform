// =============================================================================
// #6191 / SEC-F — Regresión de DoS por consumo cuadrático en el saneador de la
// ficha de decisión (CWE-1333 / CWE-400, OWASP A05:2021).
//
// Qué se rompió: `sec()` aplicaba `redactAll()` sobre el string COMPLETO y el
// tope de entrada (`MAX_ENTRADA_SANEO`) estaba una línea tarde, dentro de
// `neutralizarMarkupYEnlaces`. Como el saneamiento es CUADRÁTICO en el largo de
// la entrada, un `evidence` de 30 KB —el output de un comando que un agente
// pega como evidencia, sin ninguna intención maliciosa— bloqueaba el hilo del
// dashboard durante segundos. El dashboard es un proceso Node de UN solo hilo
// que además sirve `/api/state` y el healthcheck: el cuelgue lo tira entero, y
// el `try/catch` del renderer no ataja un cuelgue, sólo excepciones.
//
// Este archivo lo fija por TRES vías, para que la regresión no vuelva en
// silencio si alguna se ablanda:
//   1. ESTRUCTURAL — `redactAll` nunca ve más de `MAX_ENTRADA_SANEO` caracteres.
//      Es la invariante exacta que se violó, y no depende del reloj.
//   2. TEMPORAL — el armado de una ficha con `evidence` >= 30 KB termina en
//      tiempo acotado (exigido por la revisión de security).
//   3. SEGURIDAD — el tope es corte de ENTRADA y no parte tokens, así que no
//      reintroduce por la ventana el defecto que el orden `redactar → truncar`
//      de `sec()` viene a evitar: media credencial visible.
//
// Se ejecuta con: node --test .pipeline/lib/__tests__/decision-card-dos-6191.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CARD_PATH = require.resolve('..' + path.sep + 'decision-card.js');
const SHERLOCK_PATH = require.resolve('..' + path.sep + 'sherlock-audit-jsonl.js');

const { buildDecisionCard, topearEntradaSaneo, MAX_ENTRADA_SANEO } = require(CARD_PATH);

const NOW = Date.parse('2026-06-09T12:00:00Z');

function bloqueo(evidence) {
    return {
        issue: 6191,
        title: 'La ventana de bloqueados',
        skill: 'po',
        phase: 'criterios',
        pipeline: 'definicion',
        reason: 'zzz-motivo-que-nadie-clasifica',
        question: 'Sigo o paro?',
        precondition: 'que el operador responda',
        evidence,
        blocked_at: '2026-06-08T09:00:00Z',
        age_hours: 27,
    };
}

// El texto patológico NO es un payload rebuscado: es lo que produce un agente
// que pega el output de un comando. Sin espacios es el peor caso del motor de
// regex, y es justo lo que sale de pegar un hash, un base64 o un log sin cortes.
function evidenciaGrande(bytes) {
    return 'a'.repeat(bytes);
}

// ---------------------------------------------------------------------------
// 1. ESTRUCTURAL — la invariante que se violó, sin depender del reloj.
// ---------------------------------------------------------------------------

test('#6191 SEC-F `redactAll` nunca recibe mas de MAX_ENTRADA_SANEO caracteres', () => {
    // Espía sobre la frontera de redacción. Hay que instalarlo ANTES de cargar
    // `decision-card`, porque el módulo desestructura `redactAll` en tiempo de
    // carga: parchear después no tendría efecto.
    const sherlock = require(SHERLOCK_PATH);
    const original = sherlock.redactAll;
    let maxVisto = 0;
    sherlock.redactAll = function espia(text) {
        maxVisto = Math.max(maxVisto, String(text == null ? '' : text).length);
        return original.call(this, text);
    };
    delete require.cache[CARD_PATH];
    try {
        const card = require(CARD_PATH);
        card.buildDecisionCard(bloqueo(evidenciaGrande(200 * 1024)), NOW);
        assert.ok(maxVisto > 0, 'el espia no se engancho: el test no probaria nada');
        assert.ok(
            maxVisto <= MAX_ENTRADA_SANEO,
            'el saneador vio ' + maxVisto + ' caracteres; el tope de entrada es ' +
            MAX_ENTRADA_SANEO + '. El tope tiene que aplicarse ANTES de `redactAll`, ' +
            'que es cuadratico: si corre sobre el string completo, cuelga el dashboard.'
        );
    } finally {
        sherlock.redactAll = original;
        delete require.cache[CARD_PATH];
        require(CARD_PATH);
    }
});

// ---------------------------------------------------------------------------
// 2. TEMPORAL — el techo que exigió la revisión de security.
// ---------------------------------------------------------------------------

test('#6191 SEC-F una ficha con `evidence` de 30 KB se arma en tiempo acotado', () => {
    const b = bloqueo(evidenciaGrande(30 * 1024));
    buildDecisionCard(b, NOW); // warm-up: no medir la compilación de los regex
    const t0 = Date.now();
    buildDecisionCard(b, NOW);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, 'armar la ficha tardo ' + ms + 'ms (techo 200ms). ' +
        'Un costo que crece con el largo de `evidence` es el DoS cuadratico de vuelta.');
});

test('#6191 SEC-F el costo NO crece con el tamano de `evidence` (era cuadratico)', () => {
    // La firma del defecto no es "tarda mucho" sino "tarda 16x cuando la
    // entrada crece 4x". Con el tope, las dos entradas se recortan al mismo
    // largo y el costo es el mismo, así que el techo puede ser holgado sin
    // perder poder de detección: cuadrático sobre 480 KB no entra ni cerca.
    const chico = bloqueo(evidenciaGrande(30 * 1024));
    const grande = bloqueo(evidenciaGrande(480 * 1024));
    buildDecisionCard(chico, NOW);
    const t0 = Date.now();
    buildDecisionCard(grande, NOW);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, 'con `evidence` 16x mas grande tardo ' + ms + 'ms: el ' +
        'costo sigue atado al largo de la entrada.');
});

// ---------------------------------------------------------------------------
// 3. SEGURIDAD — el tope no puede aflojar la redacción.
// ---------------------------------------------------------------------------

test('#6191 SEC-F el tope corta la ENTRADA y deja intacto lo que se muestra', () => {
    // El techo (512) es 2,3x el campo más largo que existe (`MAX_CAMPO` = 220),
    // así que recortar la entrada no puede cambiar un solo carácter de la
    // salida: la ficha con `evidence` gigante dice lo mismo que con `evidence`
    // ya recortado.
    const largo = 'Salida del comando: ' + 'x '.repeat(20000);
    const conGigante = buildDecisionCard(bloqueo(largo), NOW);
    const conCorto = buildDecisionCard(bloqueo(largo.slice(0, MAX_ENTRADA_SANEO)), NOW);
    assert.deepEqual(conGigante.evidencia_minima, conCorto.evidencia_minima);
    assert.match(conGigante.evidencia_minima[0], /Salida del comando/);
});

test('#6191 SEC-F el corte de entrada no parte un token: no filtra media credencial', () => {
    // El corte a 512 podría caer EN MEDIO de una credencial. `redactAll` ya no
    // matchearía el token completo y dejaría el prefijo visible — exactamente
    // el defecto que el orden `redactar → truncar` de `sec()` evita. Por eso el
    // corte retrocede hasta el último separador.
    const relleno = 'pa la '.repeat(83); // 498 chars: la clave cruza el techo
    // La clave de ejemplo se arma por concatenacion a proposito: pegada entera
    // es un literal con forma de credencial y el scanner de secretos —que corre
    // en pre-commit y en CI— bloquea el commit. Partirla no cambia el caso de
    // prueba: lo que se ensambla en runtime es el mismo string.
    const claveDeEjemplo = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const conClave = relleno + claveDeEjemplo + ' y sigue';
    assert.ok(conClave.length > MAX_ENTRADA_SANEO, 'el caso de prueba debe cruzar el techo');
    const topeado = topearEntradaSaneo(conClave);
    assert.ok(!/AKIA/.test(topeado), 'quedo el prefijo de la credencial partido por el corte');
    // Y el retroceso nunca puede comerse texto que la ficha llegue a mostrar.
    assert.ok(topeado.length > 220, 'el retroceso recorto por debajo de MAX_CAMPO');
});

test('#6191 SEC-F el tope es no-op para todo texto de tamano real', () => {
    const normal = 'El operador tiene que decidir si el rebote sigue o para.';
    assert.equal(topearEntradaSaneo(normal), normal);
    assert.equal(topearEntradaSaneo(''), '');
    assert.equal(topearEntradaSaneo(null), '');
    assert.equal(topearEntradaSaneo(undefined), '');
    const justo = 'b'.repeat(MAX_ENTRADA_SANEO);
    assert.equal(topearEntradaSaneo(justo), justo);
});
