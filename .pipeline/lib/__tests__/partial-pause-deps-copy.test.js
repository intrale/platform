// =============================================================================
// partial-pause-deps-copy.test.js — Copy de la alerta de dependencias
// faltantes (issue #6118).
//
// El test central es el ANTI-JERGA (CA-8). Barre el texto RENDERIZADO FINAL de
// las cuatro superficies que ve el operador —mensaje, labels de los botones,
// consecuencia del doble tap y confirmaciones/errores post-acción— y falla si
// reaparece vocabulario interno.
//
// Por qué sobre el texto renderizado y no sobre el archivo: el defecto que este
// issue vino a corregir no era una constante fea, era lo que el operador LEÍA.
// Un test que grepea el fuente pasa en verde con un template que interpola la
// jerga desde otro lado.
//
// FRONTERA (H-5): el barrido corre SÓLO sobre este módulo. En el dashboard
// "allowlist" es vocabulario legítimo y no se toca (CA-14); por eso
// `partial-pause-resolution.js` separa `msg` (dashboard) de `operatorMsg`
// (Telegram). Barrer ese archivo entero forzaría a empobrecer el copy del
// dashboard para arreglar el de Telegram.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const copy = require('../partial-pause-deps-copy');

const ISSUE = 6033;
const UNA = [6032];
const DOS = [6032, 6031];
const TRES = [6032, 6031, 6030];
const CASOS = [UNA, DOS, TRES];
const TTL_24H = 24 * 60 * 60 * 1000;

/**
 * Todas las superficies visibles, renderizadas, para un caso concreto.
 * Si mañana se agrega una superficie nueva y no entra acá, el anti-jerga deja
 * de cubrirla — por eso la lista se arma en un solo lugar.
 */
function superficiesVisibles(issue, deps, muteTtlMs = TTL_24H) {
    const labels = copy.buildButtonLabels({ issue, deps, muteTtlMs });
    const textos = [copy.buildAlertMessage({ issue, deps }), ...Object.values(labels)];
    for (const action of copy.ACTIONS) {
        // Con contexto Y sin contexto: el fallback genérico también es visible.
        textos.push(copy.buildConsequence({ action, issue, deps, muteTtlMs }));
        textos.push(copy.buildConsequence({ action, muteTtlMs }));
        textos.push(copy.buildConfirmation({ action, issue, deps, muteTtlMs }));
    }
    for (const kind of ['not-blocked', 'stale', 'forbidden', 'unknown']) {
        textos.push(copy.buildErrorMessage({ kind, issue }));
    }
    return textos;
}

// ─── CA-8 · el test anti-jerga ───────────────────────────────────────────────

test('#6118 CA-8 ninguna superficie visible contiene jerga interna, con 1, 2 o 3 dependencias', () => {
    for (const deps of CASOS) {
        for (const texto of superficiesVisibles(ISSUE, deps)) {
            const hits = copy.findForbiddenTerms(texto);
            assert.deepEqual(hits, [],
                `con ${deps.length} dependencia(s) reapareció ${JSON.stringify(hits)} en: "${texto}"`);
        }
    }
});

test('#6118 CA-8 el barrido detecta de verdad: un texto con jerga tiene que fallar', () => {
    // Sin esto el test de arriba podría estar pasando por un regex que no matchea
    // nada. Se verifica el detector contra el copy VIEJO, que es el caso real.
    const viejo = '⚠️ *Pausa parcial trabada*\n\nEl issue *#6033* está habilitado pero '
        + 'depende de issues abiertas que NO están en el allowlist:';
    const hits = copy.findForbiddenTerms(viejo);
    assert.ok(hits.length >= 2, 'el copy viejo tiene que dar positivo en varios términos');
    assert.ok(copy.findForbiddenTerms('Vas a levantar la pausa parcial').length > 0);
    assert.ok(copy.findForbiddenTerms('el dispatch quedó suspendido').length > 0);
    assert.ok(copy.findForbiddenTerms('se aplicó el cooldown de 30 min').length > 0);
    assert.ok(copy.findForbiddenTerms('las deps abiertas quedan asumidas').length > 0);
});

// ─── CA-2 / CA-3 · el mensaje ────────────────────────────────────────────────

test('#6118 CA-2 el título nombra el issue frenado y afirma que ESE issue no avanza', () => {
    for (const deps of CASOS) {
        const msg = copy.buildAlertMessage({ issue: ISSUE, deps });
        const titulo = msg.split('\n')[0];
        assert.match(titulo, /#6033/, 'el título nombra al issue, no al pipeline');
        assert.match(titulo, /no puede avanzar/, 'el sujeto del bloqueo es el issue');
        assert.doesNotMatch(titulo, /trabad|pipeline|ola/i, 'el pipeline no es el sujeto');
    }
});

test('#6118 CA-3 el cuerpo enumera las dependencias y concuerda en número', () => {
    const una = copy.buildAlertMessage({ issue: ISSUE, deps: UNA });
    assert.match(una, /Depende de #6032, que no está habilitado en esta ola\./);

    const tres = copy.buildAlertMessage({ issue: ISSUE, deps: TRES });
    assert.match(tres, /Depende de #6032, #6031 y #6030, que no están habilitados en esta ola\./);
    for (const d of TRES) assert.match(tres, new RegExp(`#${d}\\b`), `falta #${d} en el cuerpo`);
});

test('#6118 la enumeración usa comas y `y` final, sin coma de Oxford', () => {
    assert.equal(copy.enumerateRefs([6032]), '#6032');
    assert.equal(copy.enumerateRefs([6032, 6031]), '#6032 y #6031');
    assert.equal(copy.enumerateRefs([6032, 6031, 6030]), '#6032, #6031 y #6030');
    assert.equal(copy.enumerateRefs([]), '');
});

// ─── CA-4 / CA-5 · los botones ───────────────────────────────────────────────

test('#6118 CA-5 con una dependencia el botón la nombra; con varias, dice la cantidad', () => {
    assert.equal(
        copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H })['include-deps-for-issue'],
        '✅ Habilitar #6032 y continuar');
    assert.equal(
        copy.buildButtonLabels({ issue: ISSUE, deps: TRES, muteTtlMs: TTL_24H })['include-deps-for-issue'],
        '✅ Habilitar las 3 dependencias');
    assert.equal(
        copy.buildButtonLabels({ issue: ISSUE, deps: DOS, muteTtlMs: TTL_24H })['include-deps-for-issue'],
        '✅ Habilitar las 2 dependencias');
});

test('#6118 CA-4 / UX-D-1 el botón de continuar NO promete que el issue quede bloqueado', () => {
    // `markDepRiskAccepted` mergea un flag y no filtra nada: el issue sigue
    // avanzando. Un label que dijera "bloqueado" reproduciría, en el mismo
    // commit, el defecto que este issue vino a corregir.
    const label = copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H })['keep-original'];
    assert.equal(label, '🎯 Seguir sin las dependencias');
    assert.doesNotMatch(label, /bloquead|frenad|deten/i);
});

test('#6118 UX-D-2 el botón de silencio DECLARA su ventana y la deriva del TTL', () => {
    const con24 = copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H })['mute-alert'];
    assert.equal(con24, '🔕 No avisarme por 24 h');
    // Si el TTL configurado cambia, el texto acompaña SOLO. Nada de "24 h"
    // hardcodeado: el silencio tiene vencimiento y prometer lo contrario sería
    // la misma mentira que "Mantener bloqueado".
    const con6 = copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: 6 * 3600 * 1000 })['mute-alert'];
    assert.equal(con6, '🔕 No avisarme por 6 h');
    const con30m = copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: 30 * 60 * 1000 })['mute-alert'];
    assert.equal(con30m, '🔕 No avisarme por 30 min');
    assert.doesNotMatch(con30m, /\d{4,}/, 'nunca milisegundos en un botón');
});

test('#6118 formatWindow: minutos por debajo de la hora, horas enteras por encima', () => {
    assert.equal(copy.formatWindow(30 * 60 * 1000), '30 min');
    assert.equal(copy.formatWindow(59 * 60 * 1000), '59 min');
    assert.equal(copy.formatWindow(60 * 60 * 1000), '1 h');
    assert.equal(copy.formatWindow(90 * 60 * 1000), '2 h', 'sin decimales');
    assert.equal(copy.formatWindow(TTL_24H), '24 h');
    // Valores basura no rompen el botón: caen al default.
    for (const malo of [0, -1, NaN, null, undefined, 'x']) {
        assert.equal(copy.formatWindow(malo), '24 h');
    }
});

test('#6118 CA-4 los tres labels declaran un efecto, no un concepto interno', () => {
    const labels = copy.buildButtonLabels({ issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H });
    assert.deepEqual(Object.keys(labels).sort(), [...copy.ACTIONS].sort());
    for (const [action, text] of Object.entries(labels)) {
        assert.ok(text.length > 0 && text.length <= 40, `${action}: "${text}" tiene largo razonable`);
        // Un emoji al inicio y texto que se explica solo (no depende del color).
        assert.match(text, /^\p{Extended_Pictographic}️? \S/u, `${action} arranca con emoji + texto`);
    }
});

// ─── CA-7 · confirmaciones ───────────────────────────────────────────────────

test('#6118 CA-7 la confirmación del silencio dice que NO cambió nada', () => {
    // Es la diferencia entre un silencio informado y un punto ciego. Silenciar
    // no destraba, y el operador tiene que salir del tap sabiéndolo.
    const c = copy.buildConfirmation({ action: 'mute-alert', issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H });
    assert.match(c, /#6033/);
    assert.match(c, /24 h/, 'la ventana se declara también acá');
    assert.match(c, /No cambió nada/i);
    assert.match(c, /sigue frenado/i);
});

test('#6118 CA-7 la confirmación de habilitar nombra las deps y al issue destrabado', () => {
    const una = copy.buildConfirmation({ action: 'include-deps-for-issue', issue: ISSUE, deps: UNA });
    assert.equal(una, 'Listo: #6032 quedó habilitado en esta ola. #6033 ya puede avanzar.');
    const tres = copy.buildConfirmation({ action: 'include-deps-for-issue', issue: ISSUE, deps: TRES });
    assert.equal(tres, 'Listo: #6032, #6031 y #6030 quedaron habilitados en esta ola. #6033 ya puede avanzar.');
});

test('#6118 CA-7 la confirmación de continuar dice que el riesgo queda asumido, no que se bloqueó', () => {
    const c = copy.buildConfirmation({ action: 'keep-original', issue: ISSUE, deps: UNA });
    assert.match(c, /#6033 va a seguir avanzando sin esperar a #6032/);
    assert.match(c, /riesgo queda asumido/i);
    assert.doesNotMatch(c, /bloquead/i);
});

// ─── Fallback genérico del doble tap ─────────────────────────────────────────

test('#6118 el fallback genérico del consequence existe y NO repite el texto viejo', () => {
    // `PP_META` es estático y congelado: no tiene issue ni deps a mano. Sin
    // fallback propio, el handler caería al consequence viejo — que es
    // justamente donde se concentraba la jerga.
    for (const action of copy.ACTIONS) {
        const generico = copy.buildConsequence({ action, muteTtlMs: TTL_24H });
        assert.ok(generico.length > 0, `${action} necesita fallback genérico`);
        assert.deepEqual(copy.findForbiddenTerms(generico), []);
        assert.match(generico, /issue/i, 'habla del issue en abstracto');
        assert.doesNotMatch(generico, /#\d/, 'sin contexto no puede inventar un número');

        const conCtx = copy.buildConsequence({ action, issue: ISSUE, deps: UNA, muteTtlMs: TTL_24H });
        assert.match(conCtx, /#6033|#6032/, 'con contexto sí nombra los issues concretos');
    }
});

// ─── REQ-SEC-6 · sólo enteros validados ──────────────────────────────────────

test('#6118 REQ-SEC-6 sólo se interpolan enteros: nada de títulos ni markup ajeno', () => {
    // El título de un issue lo controla cualquiera que abra uno. Interpolarlo en
    // un mensaje con parse_mode Markdown sería inyección de markup/links.
    const veneno = '6033*](https://evil.example)[x';
    for (const entrada of [veneno, '../../etc/passwd', '<script>', '6033; DROP', null, undefined, {}, [], -1, 1.5]) {
        const msg = copy.buildAlertMessage({ issue: entrada, deps: [entrada] });
        assert.doesNotMatch(msg, /evil\.example|script|passwd|DROP/i, `se filtró: ${msg}`);
        assert.deepEqual(copy.findForbiddenTerms(msg), []);
        // El único markup permitido es el par de asteriscos del título.
        assert.equal((msg.match(/\*/g) || []).length, 2, 'no se desbalancea el Markdown');
    }
    assert.equal(copy.issueRef(veneno), null);
    assert.equal(copy.issueRef('6033'), '#6033');
    assert.equal(copy.toIssueNumber('0'), null);
});

test('#6118 deps con basura mezclada se normalizan sin romper la enumeración', () => {
    const msg = copy.buildAlertMessage({ issue: ISSUE, deps: [6032, 'x', null, 6032, -3, 6031] });
    // Duplicados y basura fuera; queda la enumeración limpia.
    assert.match(msg, /Depende de #6032 y #6031, que no están habilitados en esta ola\./);
});

test('#6118 sin dependencias el mensaje sigue siendo honesto y sin jerga', () => {
    const msg = copy.buildAlertMessage({ issue: ISSUE, deps: [] });
    assert.match(msg, /#6033 no puede avanzar/);
    assert.deepEqual(copy.findForbiddenTerms(msg), []);
    assert.doesNotMatch(msg, /undefined|null|NaN/);
});
