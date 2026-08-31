// =============================================================================
// Tests del resolver del sello de evidencia de QA — #6498
//
// Cubre:
//   - CA-1  contrato cerrado de 4 estados; fuera de la allowlist => null.
//   - CA-1  prioridad escalado > re-sellando > caduco > sellado > null.
//   - CA-2  cada estado resuelve a su tupla icono/copy/clase.
//   - CA-3  --danger / ic-estado-needs-human SOLO en `escalado`.
//   - CA-4  variante SEC-1 (hash declarado descartado) con copy propio.
//   - CA-6  sin jerga (sha256|dropfile|HEAD|seal|manifest|freshness) en la
//           superficie primaria (copy, registro corto y tooltip).
//   - CA-11 el copy de la ficha de decision SALE de este modulo (fuente unica).
//   - UX-G3 dos registros del mismo mensaje: completo (a11y) y corto (pill).
//
// Modulo puro: sin fs, sin dashboard, sin side effects.
// =============================================================================

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveSelloEvidenciaState,
    selloPersistido,
    SELLO_ESTADOS,
    SELLO_ICONOS,
    SELLO_CSS_KEYS,
    SELLO_COPY,
    SELLO_COPY_CORTO,
    SELLO_DETALLE,
    MAX_INTENTOS_DEFAULT,
    JERGA_PROHIBIDA,
} = require('../sello-evidencia-state');

// Fases con un dropfile de QA que trae el bloque `sello:` (campos derivados,
// tal como los expone el scanner del dashboard).
function fasesConSello(descartes = 0) {
    return {
        'desarrollo/verificacion': [
            { skill: 'qa', estado: 'procesado', resultado: 'aprobado', sello: { presente: true, descartes } },
        ],
    };
}

// -----------------------------------------------------------------------------
// CA-1 — contrato cerrado
// -----------------------------------------------------------------------------

test('CA-1: la allowlist tiene exactamente los 4 estados del contrato', () => {
    assert.deepEqual([...SELLO_ESTADOS], ['sellado', 'caduco', 're-sellando', 'escalado']);
    assert.equal(Object.isFrozen(SELLO_ESTADOS), true);
});

test('CA-1: sin ningun dato el resolver devuelve null (cero badge, camino feliz)', () => {
    assert.equal(resolveSelloEvidenciaState(null, null), null);
    assert.equal(resolveSelloEvidenciaState({}, {}), null);
    assert.equal(resolveSelloEvidenciaState({ 'desarrollo/dev': [] }, undefined), null);
});

test('CA-1: cada uno de los 4 estados declarados resuelve a su constante', () => {
    for (const estado of SELLO_ESTADOS) {
        const info = resolveSelloEvidenciaState(fasesConSello(), { estado, maxIntentos: 2 });
        assert.ok(info, `estado ${estado} deberia resolver`);
        assert.equal(info.estado, estado);
        assert.equal(info.icono, SELLO_ICONOS[estado]);
        assert.equal(info.cssKey, SELLO_CSS_KEYS[estado]);
        assert.ok(info.copy.length > 0);
        assert.ok(info.copyCorto.length > 0);
    }
});

test('CA-1/CA-9: un estado fuera de la allowlist devuelve null, nunca passthrough', () => {
    const payloads = [
        'pwned',
        '"><script>alert(1)</script>',
        'estado-stale',        // nombre de icono valido pero no es un estado
        '',
        42,
        {},
        ['sellado'],
        true,
    ];
    for (const estado of payloads) {
        const info = resolveSelloEvidenciaState(fasesConSello(), { estado, maxIntentos: 2 });
        assert.equal(info, null, `estado ${JSON.stringify(estado)} no puede renderizarse`);
    }
});

test('CA-1: un estado invalido NO cae al camino derivado (fail-closed, no fallback silencioso)', () => {
    // Hay sello persistido y contador agotado: por el camino derivado daria
    // `escalado`. Con un `estado` explicito invalido tiene que dar null.
    const info = resolveSelloEvidenciaState(fasesConSello(), {
        estado: 'sellado-por-el-agente', intentos: 5, maxIntentos: 2,
    });
    assert.equal(info, null);
});

// -----------------------------------------------------------------------------
// CA-1 — prioridad de la derivacion desde el estado real del filesystem
// -----------------------------------------------------------------------------

test('derivacion: sin contador y con bloque sello: => sellado', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 0, requeueAbierto: false, maxIntentos: 2 });
    assert.equal(info.estado, 'sellado');
});

test('derivacion: sin contador y sin bloque sello: => null', () => {
    const fases = { 'desarrollo/verificacion': [{ skill: 'qa', estado: 'procesado', resultado: 'aprobado' }] };
    assert.equal(resolveSelloEvidenciaState(fases, { intentos: 0, maxIntentos: 2 }), null);
});

test('derivacion: contador > 0 con orden abierta => re-sellando, con el intento REAL', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 1, requeueAbierto: true, maxIntentos: 2 });
    assert.equal(info.estado, 're-sellando');
    assert.equal(info.intento, 1);
    assert.equal(info.copy, 'Reintentando el sellado (1 de 2)');
    assert.equal(info.copyCorto, 'resellando 1/2');
});

test('derivacion: contador > 0 sin orden abierta => caduco (la reparacion ya fue consumida)', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 1, requeueAbierto: false, maxIntentos: 2 });
    assert.equal(info.estado, 'caduco');
});

test('derivacion: contador agotado => escalado, y gana sobre la orden abierta (prioridad)', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 2, requeueAbierto: true, maxIntentos: 2 });
    assert.equal(info.estado, 'escalado');
});

test('derivacion: contador corrupto llega como agotado y escala (fail-closed de #6496)', () => {
    // readSealRetries devuelve {intentos: MAX, corrupto: true} para un contador
    // ilegible: un contador que se resetea corrompiendolo no acota nada.
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 2, corrupto: true, maxIntentos: 2 });
    assert.equal(info.estado, 'escalado');
});

test('derivacion: el estado transitorio gana sobre el sello persistido', () => {
    // Hay bloque `sello:` (sellado OK en su momento) y ademas caducidad viva:
    // lo que el operador tiene que ver es la reparacion en curso.
    const info = resolveSelloEvidenciaState(fasesConSello(3), { intentos: 1, requeueAbierto: false, maxIntentos: 2 });
    assert.equal(info.estado, 'caduco');
    assert.equal(info.variante, null, 'la variante de descarte es propia de `sellado`');
});

test('derivacion: valores basura en el contador degradan a 0, no rompen', () => {
    for (const intentos of ['2', -1, 1.5, NaN, null, undefined, {}]) {
        const info = resolveSelloEvidenciaState(fasesConSello(), { intentos, maxIntentos: 2 });
        assert.equal(info && info.estado, 'sellado');
    }
});

test('maxIntentos: se usa el del emisor; sin el, el default es 2', () => {
    assert.equal(resolveSelloEvidenciaState(fasesConSello(), { intentos: 1 }).estado, 'caduco');
    assert.equal(MAX_INTENTOS_DEFAULT, 2);
    // Con un tope de 3, dos intentos todavia no escalan.
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 2, requeueAbierto: true, maxIntentos: 3 });
    assert.equal(info.estado, 're-sellando');
    assert.equal(info.copy, 'Reintentando el sellado (2 de 3)');
});

// -----------------------------------------------------------------------------
// CA-2 / CA-3 — caduco es reparacion, no falla. El rojo es solo del escalado.
// -----------------------------------------------------------------------------

test('CA-2/UX-1: caduco NO usa el icono de needs-human ni habla de intervencion', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 1, maxIntentos: 2 });
    assert.equal(info.estado, 'caduco');
    assert.equal(info.icono, 'estado-stale');
    assert.notEqual(info.icono, 'estado-needs-human');
    assert.equal(info.copy, 'Evidencia desactualizada — se repite la verificación');
    assert.equal(info.cssKey, 'caduco');
    assert.notEqual(info.cssKey, 'stale', 'clase propia: no se repinta .lc-state-stale (R-1/CA-8)');
});

test('CA-3: `ic-estado-needs-human` aparece en EXACTAMENTE uno de los 4 estados', () => {
    const conNeedsHuman = SELLO_ESTADOS.filter(estado => SELLO_ICONOS[estado] === 'estado-needs-human');
    assert.deepEqual(conNeedsHuman, ['escalado']);
});

test('CA-3: los 4 estados tienen icono distinto entre si (distinguibles sin color)', () => {
    const iconos = SELLO_ESTADOS.map(e => SELLO_ICONOS[e]);
    assert.equal(new Set(iconos).size, 4);
});

test('CA-3: escalado usa el copy del PO verbatim', () => {
    const info = resolveSelloEvidenciaState({}, { estado: 'escalado', maxIntentos: 2 });
    assert.equal(info.copy, 'No se pudo sellar la evidencia — necesita revisión');
    assert.equal(info.icono, 'estado-needs-human');
    assert.equal(info.cssKey, 'escalado');
});

test('CA-2: sellado usa el copy del PO verbatim y el token de info', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(0), {});
    assert.equal(info.copy, 'Evidencia sellada por el pipeline');
    assert.equal(info.icono, 'info');
});

// -----------------------------------------------------------------------------
// CA-4 / SEC-1 — variante anti-falsificacion
// -----------------------------------------------------------------------------

test('CA-4/SEC-1: con descartes > 0 el copy distingue el hash que no coincidia', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(1), {});
    assert.equal(info.estado, 'sellado');
    assert.equal(info.variante, 'descarte');
    assert.equal(info.copy, 'El sello declarado no coincidía con el archivo — se usó el archivo real');
    assert.equal(info.copyCorto, 'sello corregido');
});

test('CA-4/CA-3: la variante de descarte NO se pinta de rojo (mismo token e icono que sellado)', () => {
    const rutina = resolveSelloEvidenciaState(fasesConSello(0), {});
    const descarte = resolveSelloEvidenciaState(fasesConSello(2), {});
    assert.equal(descarte.icono, rutina.icono);
    assert.equal(descarte.cssKey, rutina.cssKey);
    assert.notEqual(descarte.copy, rutina.copy, 'la senal de SEC-1 es el copy, y tiene que existir');
});

test('CA-4: normalizacion benigna (descartes vacio) NO activa la variante', () => {
    assert.equal(resolveSelloEvidenciaState(fasesConSello(0), {}).variante, null);
    const fases = { 'desarrollo/verificacion': [{ skill: 'qa', estado: 'procesado', sello: { presente: true } }] };
    assert.equal(resolveSelloEvidenciaState(fases, {}).variante, null);
});

test('selloPersistido: ignora entries sin bloque sello y toma el mayor conteo de descartes', () => {
    assert.equal(selloPersistido(null), null);
    assert.equal(selloPersistido({ 'a': [{ skill: 'qa' }] }), null);
    assert.equal(selloPersistido({ 'a': [{ sello: { presente: false, descartes: 3 } }] }), null);
    assert.deepEqual(
        selloPersistido({ a: [{ sello: { presente: true, descartes: 1 } }], b: [{ sello: { presente: true, descartes: 4 } }] }),
        { presente: true, descartes: 4 },
    );
});

// -----------------------------------------------------------------------------
// CA-5 / CA-6 / UX-G3 — dos registros, sin jerga
// -----------------------------------------------------------------------------

test('UX-G3: el registro corto entra en la fila (<= 15 chars) y el completo es el del PO', () => {
    for (const clave of Object.keys(SELLO_COPY_CORTO)) {
        const corto = SELLO_COPY_CORTO[clave].replace('{intento}', '1').replace('{max}', '2');
        assert.ok(corto.length > 0, `${clave} sin registro corto`);
        assert.ok(corto.length <= 15, `${clave}: "${corto}" (${corto.length}) no entra en la fila`);
        assert.ok(corto.length < SELLO_COPY[clave].length, `${clave}: el corto no es mas corto`);
    }
});

test('UX-G3/CA-5: los 5 registros cortos son distinguibles entre si (unica senal sin color)', () => {
    const cortos = Object.values(SELLO_COPY_CORTO);
    assert.equal(new Set(cortos).size, cortos.length);
});

test('CA-6: la superficie primaria no contiene jerga tecnica', () => {
    const superficies = []
        .concat(Object.values(SELLO_COPY))
        .concat(Object.values(SELLO_COPY_CORTO))
        .concat(Object.values(SELLO_DETALLE));
    for (const texto of superficies) {
        for (const termino of JERGA_PROHIBIDA) {
            assert.equal(
                new RegExp(termino, 'i').test(texto), false,
                `"${texto}" contiene la jerga prohibida "${termino}"`,
            );
        }
    }
});

test('CA-10/SEC-3: el detalle del tooltip no trae rutas, URLs ni hashes', () => {
    for (const texto of Object.values(SELLO_DETALLE)) {
        assert.equal(/https?:\/\//i.test(texto), false, `URL en "${texto}"`);
        assert.equal(/[A-Za-z]:[\\/]|\/(home|Users)\//.test(texto), false, `ruta absoluta en "${texto}"`);
        assert.equal(/\b[0-9a-f]{16,}\b/i.test(texto), false, `hash en "${texto}"`);
        assert.equal(/[\\/]/.test(texto), false, `separador de ruta en "${texto}"`);
    }
});

test('el detalle de re-sellando interpola el intento real, y nunca deja el placeholder crudo', () => {
    const info = resolveSelloEvidenciaState(fasesConSello(), { intentos: 1, requeueAbierto: true, maxIntentos: 2 });
    assert.match(info.detalle, /Intento 1 de 2/);
    for (const texto of [info.copy, info.copyCorto, info.detalle]) {
        assert.equal(/\{\w+\}/.test(texto), false, `placeholder sin resolver en "${texto}"`);
    }
});

// -----------------------------------------------------------------------------
// CA-11 — fuente unica del copy: la ficha de decision lo IMPORTA
// -----------------------------------------------------------------------------

test('CA-11: la ficha de decision usa el copy de SELLO_COPY.escalado, sin copiarlo', () => {
    const decisionCard = require('../decision-card');
    assert.equal(decisionCard.INFRA_POR_QUE.sello_evidencia, SELLO_COPY.escalado);
});

test('CA-11: la escalada del sello mapea al TIPO existente `infra` (no amplia la lista congelada)', () => {
    const decisionCard = require('../decision-card');
    const card = decisionCard.buildDecisionCard({
        issue: 6498,
        title: 'Comunicacion al operador de los estados del sello',
        reason: 'No se pudo sellar la evidencia — necesita revisión',
        question: '¿Repetimos la verificación?',
        blocked_at: new Date(Date.now() - 3600000).toISOString(),
    }, Date.now());
    assert.equal(card.tipo, 'infra');
    assert.ok(decisionCard.TIPOS.includes(card.tipo));
    assert.equal(card.por_que_esta_frenado, SELLO_COPY.escalado);
    // La escalada no se decide entre proveedores de IA.
    const etiquetas = card.opciones.map(o => o.etiqueta).join(' | ');
    assert.equal(/proveedor/i.test(etiquetas), false, `opciones de proveedor en la ficha del sello: ${etiquetas}`);
});
