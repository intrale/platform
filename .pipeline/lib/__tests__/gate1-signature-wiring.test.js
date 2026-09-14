// =============================================================================
// gate1-signature-wiring.test.js — #6207 · INVARIANTES ESTÁTICOS del cableado.
//
// Estos tests leen el FUENTE, no lo ejecutan. Existen porque los invariantes que
// cuidan son de la forma "este archivo NUNCA puede llamar a esto": un test de
// comportamiento sólo puede probar los caminos que se le ocurrieron al autor,
// mientras que un grep sobre el fuente cubre también el camino que alguien
// agregue el mes que viene sin leer los comentarios.
//
// Cubre:
//   CA-SEC-4 — ni el pulpo, ni el listener, ni el handler llaman a
//              `recordDefinitionSignature`: la única escritura de la firma pasa
//              por el kernel `approval-channel.submitSignature`.
//   CA-SEC-2 — ningún módulo de esta historia persiste el token del canal.
//   CA-SEC-8 — el handler no loguea el `callback_data`, el token ni el body.
//   CA-B5    — el diff no reescribe el copy ni el dedupe-por-hash que son
//              propiedad de #6192.
//   D-4      — `dispatchToCarrier` queda declaradamente fuera de alcance.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.resolve(__dirname, '..');
const PIPELINE = path.resolve(LIB, '..');

const leer = (p) => fs.readFileSync(p, 'utf8');

/**
 * Quita comentarios de línea y de bloque para grepear CÓDIGO, no prosa.
 *
 * El split es por `/\r?\n/` y NO por `'\n'`: con CRLF (el repo corre en Windows)
 * quedaría un `\r` al final de cada línea, y en JavaScript `.` no matchea `\r`
 * porque es un terminador de línea — así que `//.*$` no llegaría al final y
 * ningún comentario se borraría. El invariante pasaría a verificarse contra la
 * prosa de los encabezados en vez de contra el código, que es la forma más
 * silenciosa de que un test de grep deje de probar lo suyo.
 */
function soloCodigo(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
}

test('el helper del test borra comentarios de verdad (si no, todo esto verifica prosa)', () => {
    const limpio = soloCodigo(leer(FUENTES.dedup));
    assert.doesNotMatch(limpio, /\/\//, 'no puede quedar ningún comentario de línea');
    assert.match(limpio, /function shouldNotify/, 'y el código sí tiene que sobrevivir');
});

const FUENTES = {
    handler: path.join(LIB, 'gate1-signature-handler.js'),
    deposit: path.join(LIB, 'gate1-signature-deposit.js'),
    keyboard: path.join(LIB, 'gate1-signature-keyboard.js'),
    dedup: path.join(LIB, 'gate1-notify-dedup.js'),
    operatorGate: path.join(LIB, 'operator-gate.js'),
    listener: path.join(PIPELINE, 'listener-telegram.js'),
    pulpo: path.join(PIPELINE, 'pulpo.js'),
};

// -----------------------------------------------------------------------------
// CA-SEC-4 · la firma la escribe el kernel, nadie más
// -----------------------------------------------------------------------------

test('CA-SEC-4: ni el pulpo, ni el listener, ni el handler llaman a recordDefinitionSignature', () => {
    for (const clave of ['handler', 'deposit', 'listener', 'pulpo']) {
        const codigo = soloCodigo(leer(FUENTES[clave]));
        assert.doesNotMatch(
            codigo, /recordDefinitionSignature/,
            `${clave} no puede escribir la firma salteándose el kernel`,
        );
    }
});

test('CA-SEC-4: el handler despacha a submitSignature del canal, y sólo ahí', () => {
    const codigo = soloCodigo(leer(FUENTES.handler));
    assert.match(codigo, /submitSignature\(/, 'el camino de escritura tiene que existir');
    // Una sola invocación: dos serían dos caminos de escritura.
    assert.equal((codigo.match(/\.submitSignature\(/g) || []).length, 1);
});

test('CA-SEC-1: el handler NUNCA invoca applyTransition', () => {
    const codigo = soloCodigo(leer(FUENTES.handler));
    assert.doesNotMatch(codigo, /applyTransition/,
        'applyTransition mueve work-files: no es el ejecutor de GATE 1');
});

test('CA-SEC-1: el listener NO cae a handleSignature para un callback de GATE 1', () => {
    const codigo = soloCodigo(leer(FUENTES.listener));
    const ramaGate1 = codigo.indexOf("callbackKind === 'gate-signature'");
    const llamadaLegacy = codigo.indexOf('gate.handleSignature(');
    assert.ok(ramaGate1 > 0, 'la rama de ruteo tiene que existir');
    assert.ok(llamadaLegacy > 0);
    assert.ok(ramaGate1 < llamadaLegacy,
        'la rama de GATE 1 va ANTES del handleSignature legacy');
    // Y corta el flujo: hay un `return` entre una y otra.
    const entre = codigo.slice(ramaGate1, llamadaLegacy);
    assert.match(entre, /\breturn;/, 'la rama de GATE 1 tiene que cortar el flujo');
});

// -----------------------------------------------------------------------------
// CA-SEC-2 · el token del canal no toca el disco
// -----------------------------------------------------------------------------

test('CA-SEC-2: `channel_token` no existe en ningún módulo de esta historia', () => {
    for (const clave of Object.keys(FUENTES)) {
        assert.doesNotMatch(leer(FUENTES[clave]), /channel_token/,
            `${clave} no puede persistir el token del canal`);
    }
});

test('CA-SEC-2: el handler no escribe el token a disco ni lo devuelve', () => {
    const codigo = soloCodigo(leer(FUENTES.handler));
    // El token sólo aparece como argumento de `submitSignature`, nunca en un
    // `writeFileSync`, un `JSON.stringify` de salida ni un `return`.
    assert.doesNotMatch(codigo, /writeFileSync[\s\S]{0,200}token/);
    assert.doesNotMatch(codigo, /return[^;]{0,120}\btoken\b/);
});

test('CA-SEC-2: el depósito descarta el token del pedido', () => {
    const codigo = soloCodigo(leer(FUENTES.deposit));
    // El módulo NUNCA nombra `.token`: si lo tocara, sería para propagarlo.
    assert.doesNotMatch(codigo, /\.token\b/,
        'el depósito no lee el token del request: lo descarta sin mirarlo');
});

// -----------------------------------------------------------------------------
// CA-SEC-8 · el log no filtra material sensible
// -----------------------------------------------------------------------------

test('CA-SEC-8: el handler no loguea el callback_data, el token ni el body', () => {
    const codigo = soloCodigo(leer(FUENTES.handler));
    const llamadasLog = codigo.match(/\blog\(`[^`]*`\)/g) || [];
    assert.ok(llamadasLog.length > 0, 'el handler tiene que dejar traza de diagnóstico');
    for (const llamada of llamadasLog) {
        assert.doesNotMatch(llamada, /callbackData/, `log con callback_data: ${llamada}`);
        assert.doesNotMatch(llamada, /\btoken\b/, `log con token: ${llamada}`);
        assert.doesNotMatch(llamada, /\bbody\b/, `log con body: ${llamada}`);
        assert.doesNotMatch(llamada, /entry\.token|req\.request/, `log con capability: ${llamada}`);
    }
});

test('CA-SEC-8: el handler no interpola el `message` crudo de un error en el toast', () => {
    const codigo = soloCodigo(leer(FUENTES.handler));
    // Los toasts salen de `toastDeRechazo`/`toastDeExito`, que son copy fijo.
    assert.doesNotMatch(codigo, /toast:\s*[`'"][^`'"]*\$\{e/,
        'el detalle crudo del error no puede llegar al chat');
});

// -----------------------------------------------------------------------------
// CA-B5 · la presentación sigue siendo propiedad de #6192
// -----------------------------------------------------------------------------

test('CA-B5: `gate1-notify.js` y `decision-card*.js` no se tocan en esta historia', () => {
    // El invariante se verifica por contenido, no por git: los archivos de
    // presentación tienen que seguir sin ninguna referencia al canal de firma.
    for (const nombre of ['gate1-notify.js', 'decision-card.js', 'decision-card-render.js']) {
        const codigo = leer(path.join(LIB, nombre));
        assert.doesNotMatch(codigo, /approval-channel|submitSignature|requestSignature|channel_gate/,
            `${nombre} es presentación: no puede conocer el camino de escritura`);
    }
});

test('CA-B5: el dedupe conserva el dedupe-por-hash de #6192 y sólo suma cadencia', () => {
    const codigo = soloCodigo(leer(FUENTES.dedup));
    // La condición por hash sigue viva: el recordatorio se SUMA, no la reemplaza.
    assert.match(codigo, /prev\.hash !== hash/,
        'si cambia lo que hay que firmar, el aviso vuelve — eso no se toca');
    assert.match(codigo, /reminderMs/, 'y se agrega la cadencia acotada');
    // El copy del aviso no vive acá y sigue sin vivir acá.
    assert.doesNotMatch(codigo, /Aprobar|Rechazar|Ajustar/);
});

test('CA-B5: el único cambio del keyboard es el camino de escritura', () => {
    const codigo = soloCodigo(leer(FUENTES.keyboard));
    // Lo que #6207 agrega: revocación + `channelGate` en el register.
    assert.match(codigo, /revokeFor\(\{ issue, channelGate: 'definicion' \}\)/);
    assert.match(codigo, /channelGate: 'definicion'/);
    // Lo que NO cambia: el orden y el contrato de retorno de #6192.
    assert.match(codigo, /ACCIONES_GATE1 = Object\.freeze\(\['approve', 'reject', 'adjust-definicion'\]\)/);
    assert.match(codigo, /return \{ ok: true, keyboard, code: null \}/);
    assert.match(codigo, /return \{ ok: false, keyboard: null, code \}/);
});

// -----------------------------------------------------------------------------
// D-3 / D-4 · dónde va el depósito y qué queda afuera
// -----------------------------------------------------------------------------

test('D-3: el pulpo deposita ANTES de avisar y fuera del emit del dedupe', () => {
    const codigo = soloCodigo(leer(FUENTES.pulpo));
    const dep = codigo.indexOf('depositGate1Request');
    assert.ok(dep > 0, 'el depósito tiene que estar cableado en el barrido');
    const aviso = codigo.indexOf('notifyGate1Retention({', dep);
    assert.ok(aviso > dep, 'el depósito va ANTES del aviso');
    // Y no cuelga del `emit`: `notifyGate1Retention` no conoce el depósito.
    const notify = codigo.indexOf('function notifyGate1Retention');
    assert.doesNotMatch(codigo.slice(notify), /depositGate1Request/,
        'el depósito no puede colgar del emit deduplicado');
});

test('D-3: las ramas load-error y gate-error NO depositan', () => {
    const codigo = soloCodigo(leer(FUENTES.pulpo));
    // Sin el issue cargado no se sabe qué se firmaría: el único depósito del
    // archivo cuelga de la rama `block`, que sí tiene `opIssueJson`.
    assert.equal((codigo.match(/depositGate1Request/g) || []).length, 1,
        'un solo call-site: la rama block');
    const dep = codigo.indexOf('depositGate1Request');
    const ventana = codigo.slice(Math.max(0, dep - 3000), dep);
    assert.match(ventana, /opGateResult\.decision === 'block'/,
        'el depósito vive dentro de la rama block');
});

test('D-3: el depósito no puede levantar la retención', () => {
    const codigo = soloCodigo(leer(FUENTES.pulpo));
    const dep = codigo.indexOf('depositGate1Request');
    // Entre el `operatorSignoffBlocked = true` de la rama y el depósito no puede
    // haber ninguna reasignación a `false`.
    const ventana = codigo.slice(dep, dep + 2000);
    assert.doesNotMatch(ventana, /operatorSignoffBlocked\s*=\s*false/,
        'el depósito nunca levanta la retención');
});

test('D-4: `dispatchToCarrier` queda fuera de alcance (no se conecta acá)', () => {
    for (const clave of ['handler', 'deposit', 'keyboard']) {
        assert.doesNotMatch(soloCodigo(leer(FUENTES[clave])), /dispatchToCarrier/,
            `${clave} no conecta el carrier del dashboard: requiere issue propio`);
    }
});

// -----------------------------------------------------------------------------
// Invariante de #6209: la config no se toca
// -----------------------------------------------------------------------------

test('esta historia no agrega claves a la sección operator_signoff de config.yaml', () => {
    const codigo = soloCodigo(leer(FUENTES.dedup));
    // La cadencia es constante del módulo, no config: `operator_signoff` es
    // alcance de otra historia y esta la tiene prohibida.
    assert.doesNotMatch(codigo, /operator_signoff/);
    assert.match(codigo, /const DEFAULT_REMINDER_MS/);
});

test('el enum de gates del canal se importa, no se copia', () => {
    // Una segunda lista literal de gates se desincroniza del ruteo. El único
    // lugar donde el literal vive es `operator-gate.js`.
    const gate = soloCodigo(leer(FUENTES.operatorGate));
    assert.match(gate, /const CHANNEL_GATES = Object\.freeze\(\['definicion', 'aceptacion'\]\)/);
    for (const clave of ['handler', 'deposit', 'keyboard', 'listener']) {
        assert.doesNotMatch(soloCodigo(leer(FUENTES[clave])), /CHANNEL_GATES\s*=/,
            `${clave} no puede declarar su propia lista de gates`);
    }
});
