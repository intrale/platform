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
// Y qué se rompió arreglándolo (rev-2, lo que encontró la revisión de
// `security`): la rev-1 adelantó el techo de PRESENTACION (512) delante de
// `redactAll`. Eso arregla el DoS y ROMPE la redacción — toda credencial más
// larga que el techo queda partida por el corte, `redactAll` deja de matchear el
// token completo y el prefijo sale visible. Un JWT de Cognito (~1,5 KB, sin un
// solo separador donde retroceder) dejaba a la vista un pedazo de payload que
// decodifica a `sub`, `email` y `cognito_groups`, y la ficha alimenta el aviso
// de Telegram. Los techos son DOS y distintos: anti-DoS (4096, antes de
// redactar) y presentación (512, después).
//
// Este archivo lo fija por CUATRO vías, para que la regresión no vuelva en
// silencio si alguna se ablanda:
//   1. ESTRUCTURAL — `redactAll` nunca ve más de `MAX_ENTRADA_REDACCION`
//      caracteres. Es la invariante exacta que se violó, y no depende del reloj.
//   2. TEMPORAL — el armado de una ficha con `evidence` >= 30 KB termina en
//      tiempo acotado (exigido por la revisión de security).
//   3. SEGURIDAD — el tope es corte de ENTRADA y no parte tokens, así que no
//      reintroduce por la ventana el defecto que el orden `redactar → truncar`
//      de `sec()` viene a evitar: media credencial visible.
//   4. REGRESION rev-1 — una credencial más larga que el techo de presentación
//      se redacta ENTERA. Es lo que los otros tres no cubrían: miden el costo,
//      no la corrección de la redacción, y por eso la regresión pasó verde.
//
// Se ejecuta con: node --test .pipeline/lib/__tests__/decision-card-dos-6191.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CARD_PATH = require.resolve('..' + path.sep + 'decision-card.js');
const SHERLOCK_PATH = require.resolve('..' + path.sep + 'sherlock-audit-jsonl.js');

const {
    buildDecisionCard,
    topearEntradaSaneo,
    MAX_ENTRADA_SANEO,
    topearEntradaRedaccion,
    MAX_ENTRADA_REDACCION,
} = require(CARD_PATH);

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

test('#6191 SEC-F `redactAll` nunca recibe mas de MAX_ENTRADA_REDACCION caracteres', () => {
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
            maxVisto <= MAX_ENTRADA_REDACCION,
            'el saneador vio ' + maxVisto + ' caracteres; el tope anti-DoS es ' +
            MAX_ENTRADA_REDACCION + '. El tope tiene que aplicarse ANTES de `redactAll`, ' +
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
    // El corte de presentación (512) corre YA sobre texto redactado, así que no
    // puede filtrar una credencial. Igual retrocede hasta el último separador:
    // la función se exporta y nada garantiza que un llamador futuro respete el
    // orden, y en ese escenario un corte al medio de un token dejaría el prefijo
    // visible. Este test fija esa propiedad de la función.
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

// ---------------------------------------------------------------------------
// 4. REGRESION SEC-F rev-1 — el techo anti-DoS no puede partir credenciales.
//
// La rev-1 de SEC-F adelantó el techo de PRESENTACION (512) delante de
// `redactAll`. Arreglaba el DoS y rompía la redacción: toda credencial más larga
// que el techo quedaba partida por el corte, `redactAll` ya no matcheaba el
// token completo y el prefijo salía visible. Los tests de arriba pasaron en
// verde porque sólo miden el COSTO, no la CORRECCION de la redacción.
//
// El caso canónico es un JWT de Cognito —el mecanismo de auth de este
// proyecto—: ~1,5 KB, sin un solo separador donde el retroceso pueda apoyarse, y
// el payload en base64 decodifica a `sub`, `email` y `cognito_groups`. La misma
// ficha alimenta el aviso de Telegram (CA-4), así que el fragmento se va del
// equipo hacia un chat.
// ---------------------------------------------------------------------------

// JWT sintético con la forma exacta de uno de Cognito. Se arma en runtime y no
// como literal a propósito: un JWT pegado entero es un literal con forma de
// credencial y el scanner de secretos —pre-commit y CI— bloquea el commit.
function jwtDeCognito(relleno) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = b64({ alg: 'RS256', kid: 'kid-de-prueba', typ: 'JWT' });
    const payload = b64({
        sub: '1111-2222-3333',
        email: 'operador@example.com',
        cognito_groups: ['admin', 'ops'],
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/pool-de-prueba',
        exp: 1900000000,
        relleno: 'z'.repeat(relleno),
    });
    return header + '.' + payload + '.' + 'S'.repeat(342);
}

test('#6191 SEC-F un JWT mas largo que el techo de presentacion se redacta ENTERO', () => {
    const jwt = jwtDeCognito(700);
    assert.ok(
        jwt.length > MAX_ENTRADA_SANEO,
        'el caso de prueba debe cruzar el techo de presentacion, si no no prueba nada'
    );
    const card = buildDecisionCard(bloqueo('token ' + jwt + ' fin.'), NOW);
    const ev = card.evidencia_minima[0];
    // El aserto que pidió la revisión de security: ni el prefijo de un JWT.
    assert.doesNotMatch(ev, /eyJ/, 'quedo visible el arranque de un JWT: ' + ev);
    // Y tampoco un pedazo del payload en base64, que es lo que decodifica a los
    // claims aunque el `eyJ` inicial se lo haya comido otro paso del saneador.
    const payload = jwt.split('.')[1];
    for (const largo of [24, 40]) {
        for (let i = 0; i + largo <= payload.length; i += largo) {
            assert.ok(
                !ev.includes(payload.slice(i, i + largo)),
                'quedo visible un fragmento del payload del JWT: ' + ev
            );
        }
    }
    assert.match(ev, /\[REDACTED\]/, 'la credencial tiene que aparecer redactada: ' + ev);
});

test('#6191 SEC-F el techo anti-DoS entra cualquier credencial de los patrones vigentes', () => {
    // `redact.js` no le pone tope superior a jwt, google_refresh_token ni
    // telegram_bot_token. El techo tiene que ser holgado para que entren
    // enteras: si algún día baja, este test lo frena antes que un secreto salga
    // por Telegram.
    assert.ok(
        MAX_ENTRADA_REDACCION >= 4096,
        'el techo anti-DoS bajo a ' + MAX_ENTRADA_REDACCION + '. Por debajo de 4096 ' +
        'una credencial larga queda partida y `redactAll` deja el prefijo visible.'
    );
    assert.ok(
        MAX_ENTRADA_REDACCION > MAX_ENTRADA_SANEO,
        'el techo anti-DoS no puede ser mas bajo que el de presentacion'
    );
});

test('#6191 SEC-F un token indivisible mas largo que el techo no deja prefijo visible', () => {
    // Sin separadores no hay dónde retroceder. Fail-closed: se descarta entero.
    // Mostrar el prefijo de un token de 5 KB es exactamente la fuga que este
    // techo viene a evitar.
    const indivisible = jwtDeCognito(MAX_ENTRADA_REDACCION);
    assert.ok(indivisible.length > MAX_ENTRADA_REDACCION, 'el caso debe cruzar el techo');
    assert.equal(topearEntradaRedaccion(indivisible), '');
    const card = buildDecisionCard(bloqueo(indivisible), NOW);
    assert.doesNotMatch(String(card.evidencia_minima[0] || ''), /eyJ/);
});

test('#6191 SEC-F el techo anti-DoS retrocede al separador y es no-op para texto real', () => {
    const normal = 'El operador tiene que decidir si el rebote sigue o para.';
    assert.equal(topearEntradaRedaccion(normal), normal);
    assert.equal(topearEntradaRedaccion(''), '');
    assert.equal(topearEntradaRedaccion(null), '');
    assert.equal(topearEntradaRedaccion(undefined), '');
    const justo = 'b'.repeat(MAX_ENTRADA_REDACCION);
    assert.equal(topearEntradaRedaccion(justo), justo);
    // Con separadores, el corte cae en el último y no parte la palabra final.
    const conEspacios = 'pa la '.repeat(2000);
    const topeado = topearEntradaRedaccion(conEspacios);
    assert.ok(topeado.length <= MAX_ENTRADA_REDACCION);
    assert.ok(topeado.length > MAX_ENTRADA_REDACCION - 16, 'retrocedio de mas');
});

test('#6191 SEC-F redactar con el techo holgado sigue lejos del techo de tiempo', () => {
    // El techo subió de 512 a 4096 y `redactAll` es cuadrático: hay que
    // confirmar que el costo sigue acotado, que es lo que motivó SEC-F.
    const jwt = jwtDeCognito(3000);
    const b = bloqueo('token ' + jwt + ' y mas texto ' + 'x '.repeat(20000));
    buildDecisionCard(b, NOW); // warm-up
    const t0 = Date.now();
    buildDecisionCard(b, NOW);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, 'armar la ficha con el techo holgado tardo ' + ms + 'ms (techo 200ms)');
});
