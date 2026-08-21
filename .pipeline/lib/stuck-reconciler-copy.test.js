'use strict';

// =============================================================================
// #6150 — La alerta del auto-reparador de fases varadas: destinatario + copy.
//
// Dos familias de aserciones:
//  - CLASIFICACIÓN (CA-1/CA-2): quién merece un mensaje a Telegram. El bug de
//    producción era acá, no en el texto: 177 decisiones y cero tareas frenadas
//    disparaban un aviso igual.
//  - COPY (CA-3…CA-6): que el texto sea accionable por una persona y no filtre
//    jerga ni estructura interna.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');

const {
    isRealRisk,
    selectRealRisk,
    buildEpisodeFingerprint,
    formatAgeEs,
    scrubTitle,
    buildStuckAlertCopy,
    FORBIDDEN_TERMS,
    FORBIDDEN_PATTERNS,
} = require('./stuck-reconciler-copy');

const { evaluateSilenceHealth } = require('./stuck-reconciler-deps');

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const NOW = 1_800_000_000_000;

const dec = (over = {}) => ({
    issue: 100, pipeline: 'desarrollo', fase: 'validacion',
    action: 'none', suppression: 'cache', stuckSinceMs: NOW - 2 * HORA,
    ...over,
});

/** El caso real que documentó `guru`: 177 decisiones, 0 en riesgo real. */
function produccion177() {
    const out = [];
    for (let i = 0; i < 68; i++) out.push(dec({ issue: 1000 + i, suppression: 'ola' }));
    for (let i = 0; i < 3; i++) out.push(dec({ issue: 2000 + i, suppression: 'dedupe' }));
    for (let i = 0; i < 106; i++) out.push(dec({ issue: 3000 + i, suppression: 'otro' }));
    return out;
}

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — clasificación por decisión, no agregada
// -----------------------------------------------------------------------------

test('0 tareas en riesgo real no envía nada aunque la racha sea larga', () => {
    const decisions = produccion177();
    assert.equal(decisions.length, 177);
    const risks = selectRealRisk(decisions);
    assert.equal(risks.length, 0, 'ninguna de las 177 es riesgo real');

    // Racha de 9 ciclos, que es lo que había en producción cuando disparó.
    let prev = null;
    let avisos = 0;
    for (let i = 0; i < 9; i++) {
        const r = evaluateSilenceHealth(prev, {
            agg: { evaluados: 177, escalados: 0, requeued: 0, suprimidos_por_ola: 68, suprimidos_por_dedupe: 3, suprimidos_por_cache: 0 },
            risks,
        });
        if (r.emitSignal) avisos++;
        prev = r.next;
    }
    assert.equal(avisos, 0, 'el silencio diagnóstico NO llega a Telegram');
    assert.equal(prev.ciclos_revisando_sin_actuar, 9, 'pero la racha sigue registrada (CA-2)');
    assert.equal(prev.motivos.fuera_de_la_ola, 68, 'y los contadores por motivo también');
});

test('una decisión fail-closed sí es riesgo real', () => {
    const decisions = produccion177();
    decisions.push(dec({ issue: 4242, suppression: 'cache' }));
    const risks = selectRealRisk(decisions);
    assert.equal(risks.length, 1);
    assert.equal(risks[0].issue, 4242);

    const r = evaluateSilenceHealth(null, { agg: { evaluados: 178 }, risks });
    assert.equal(r.emitSignal, true, '1 entre 178 basta: el filtro es por tarea');
    assert.match(buildStuckAlertCopy({ risks, nowMs: NOW }), /#4242/);
});

test('los buckets de diagnóstico nunca son riesgo real', () => {
    for (const s of ['ola', 'cerrado', 'dedupe', 'otro', undefined, null]) {
        assert.equal(isRealRisk(dec({ suppression: s })), false, `bucket ${s}`);
    }
    assert.equal(isRealRisk(dec({ action: 'escalate' })), false, 'si actuó, no está frenada');
    assert.equal(isRealRisk(null), false);
    assert.equal(isRealRisk(dec()), true);
});

// -----------------------------------------------------------------------------
// CA-3 / CA-8 — los cinco elementos del mensaje
// -----------------------------------------------------------------------------

test('el copy contiene los cinco elementos exigidos', () => {
    const risks = [
        dec({ issue: 501, stuckSinceMs: NOW - 2 * HORA - 15 * MIN }),
        dec({ issue: 502, stuckSinceMs: NOW - 45 * MIN }),
        dec({ issue: 503, stuckSinceMs: NOW - 20 * MIN }),
    ];
    const titulos = { 501: 'Migrar el login a Cognito', 502: 'Arreglar el alta de negocio', 503: null };
    const out = buildStuckAlertCopy({ risks, nowMs: NOW, titleOf: (i) => titulos[i] });

    // 1 · qué está frenado (cantidad + número + título)
    assert.match(out, /3 tareas frenadas/);
    assert.match(out, /#501 Migrar el login a Cognito/);
    assert.match(out, /#502 Arreglar el alta de negocio/);
    // 2 · hace cuánto
    assert.match(out, /hace 2 h 15 min/);
    assert.match(out, /hace 45 min/);
    // 3 · por qué, en castellano y derivado del enum
    assert.match(out, /Por qué siguen ahí: no se pudo confirmar en qué estado quedaron/);
    // 4 · qué pasa si no hace nada
    assert.match(out, /Si no hacés nada: siguen ahí; el sistema no las va a mover solo\./);
    assert.doesNotMatch(out, /\(s\)|\(n\)/, 'sin atajos de programador');
    // 5 · al menos dos opciones concretas, con comandos que existen
    assert.match(out, /Podés:/);
    assert.match(out, /\/unblock/);
    assert.match(out, /\/wave add/);
    assert.doesNotMatch(out, /`/, 'texto plano: los backticks se renderizarían literales');
});

test('la primera línea responde cuántas y desde cuándo', () => {
    const out = buildStuckAlertCopy({
        risks: [dec({ issue: 7, stuckSinceMs: NOW - 3 * 24 * HORA })],
        nowMs: NOW,
    });
    const primera = out.split('\n')[0];
    assert.match(primera, /^🙋 1 tarea frenada esperando una decisión tuya — la más vieja hace 3 d$/);
});

test('pluralización real, sin paréntesis de programador', () => {
    const una = buildStuckAlertCopy({ risks: [dec({ issue: 1 })], nowMs: NOW });
    const dos = buildStuckAlertCopy({ risks: [dec({ issue: 1 }), dec({ issue: 2 })], nowMs: NOW });
    assert.match(una, /1 tarea frenada/);
    assert.match(dos, /2 tareas frenadas/);
    for (const out of [una, dos]) {
        assert.doesNotMatch(out, /\(s\)/, 'nada de "tarea(s)"');
    }
    // El motivo también concuerda en número.
    assert.match(una, /Por qué sigue ahí: no se pudo confirmar en qué estado quedó y el sistema prefiere no tocarla a ciegas\./);
    assert.match(dos, /Por qué siguen ahí: no se pudo confirmar en qué estado quedaron y el sistema prefiere no tocarlas a ciegas\./);

    // Y la consecuencia y las opciones también: una sola tarea no se anuncia en
    // plural (es el mismo defecto que "tarea(s)", una línea más abajo).
    assert.match(una, /Si no hacés nada: sigue ahí; el sistema no la va a mover solo\./);
    assert.match(una, /Podés: destrabarla con \/unblock, sumarla al trabajo activo con \/wave add, o dejarla así a propósito\./);
    assert.match(dos, /Si no hacés nada: siguen ahí; el sistema no las va a mover solo\./);
    assert.match(dos, /Podés: destrabarlas con \/unblock, sumarlas al trabajo activo con \/wave add, o dejarlas así a propósito\./);
});

test('el emoji de apertura no es el de pipeline pausado', () => {
    const out = buildStuckAlertCopy({ risks: [dec()], nowMs: NOW });
    assert.ok(out.startsWith('🙋'), 'pide intervención humana');
    assert.doesNotMatch(out, /⏸️/, '⏸️ ya significa "pipeline pausado" en este chat');
    assert.doesNotMatch(out, /🚨|🛑/, 'no es una emergencia');
});

test('el motivo se agrupa por causa con cantidades, no se toma de la primera', () => {
    // Dos motivos distintos: el snippet original habría atribuido a las 4 tareas
    // el motivo de la primera.
    const risks = [
        dec({ issue: 1, suppression: 'cache' }),
        dec({ issue: 2, suppression: 'cache' }),
        dec({ issue: 3, suppression: 'cache' }),
        dec({ issue: 4, suppression: 'otro-futuro' }),
    ];
    const out = buildStuckAlertCopy({ risks, nowMs: NOW });
    assert.match(out, /Por qué siguen ahí:\n/);
    assert.match(out, /• 3 tareas: no se pudo confirmar/);
    assert.match(out, /• 1 tarea: hacía falta una acción automática que no se pudo completar/);
    // Orden determinista: cantidad descendente.
    assert.ok(out.indexOf('• 3 tareas:') < out.indexOf('• 1 tarea:'));
});

test('el título sin entrada fresca no se inventa', () => {
    const out = buildStuckAlertCopy({ risks: [dec({ issue: 909 })], nowMs: NOW, titleOf: () => null });
    assert.match(out, /• #909 — hace 2 h/);
    assert.doesNotMatch(out, /#909 [A-Za-z]/, 'sale sólo el número');
});

test('sin antigüedad conocida no se imprime basura', () => {
    const out = buildStuckAlertCopy({ risks: [dec({ issue: 11, stuckSinceMs: null })], nowMs: NOW });
    assert.doesNotMatch(out, /NaN|Invalid|undefined|null/);
    assert.match(out, /• #11$/m, 'la tarea sale igual, sin la antigüedad');
});

// -----------------------------------------------------------------------------
// CA-4 / CA-6 / SEC-7 — higiene del texto
// -----------------------------------------------------------------------------

test('el copy no contiene jerga interna', () => {
    // Un caso por término: cada término prohibido se prueba contra un copy real
    // generado por el módulo, no contra una copia hardcodeada.
    const risks = [
        dec({ issue: 1, suppression: 'cache' }),
        dec({ issue: 2, suppression: 'otro-futuro' }),
    ];
    const out = buildStuckAlertCopy({
        risks, nowMs: NOW,
        titleOf: (i) => (i === 1 ? 'Revisar el dedupe del reconciler y la allowlist' : null),
    });
    for (const term of FORBIDDEN_TERMS) {
        assert.ok(
            !out.toLowerCase().includes(term.toLowerCase()),
            `el copy filtró jerga interna: "${term}"\n---\n${out}\n---`,
        );
    }
});

test('el copy no filtra rutas ni nombres de archivo', () => {
    const out = buildStuckAlertCopy({
        risks: [dec({ issue: 3 })],
        nowMs: NOW,
        titleOf: () => 'Falla en .pipeline/logs/pulpo.log y en C:\\Workspaces\\config.json',
    });
    for (const re of FORBIDDEN_PATTERNS) {
        assert.ok(!re.test(out), `el copy filtró estructura interna: ${re}\n---\n${out}\n---`);
    }
    assert.doesNotMatch(out, /revisá el log|ver el log/i, 'no deriva a leer un log');
});

test('el título hostil se sanea antes de interpolarse', () => {
    const hostil = 'Alta\u0000 de\u001b[31m negocio\u200b con \u202Ebidi';
    const out = buildStuckAlertCopy({ risks: [dec({ issue: 5 })], nowMs: NOW, titleOf: () => hostil });
    assert.doesNotMatch(out, /[\x00-\x08\x0B-\x1F\x7F]/, 'sin control chars');
    assert.ok(!out.includes('\u202E'), 'sin override bidi');
    assert.equal(out.split('\n').length, 5, 'un título con saltos no rompe la estructura');
});

test('rebote rev-2 · el sanitize inyectado no deja el CSI suelto como texto', () => {
    // Regresión: `sanitizeForTelegram` borra  - —el ESC incluido—, así
    // que si corre ANTES del strip de ANSI el CSI queda huérfano y el "[31m"
    // sobrevive como texto inerte. El scrub tiene que sacar la secuencia COMPLETA.
    const sanitizeQueBorraControles = (t) => String(t).replace(/[ -]/g, '');
    const out = buildStuckAlertCopy({
        risks: [dec({ issue: 7 })],
        nowMs: NOW,
        titleOf: () => '[31mAlta de negocio[0m',
        sanitize: sanitizeQueBorraControles,
    });
    assert.ok(!out.includes('[31m'), `residuo ANSI en la salida: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('[0m'), 'residuo del reset ANSI');
    assert.match(out, /Alta de negocio/, 'el texto legible del título sí sobrevive');
});

test('el título largo se acota', () => {
    const out = buildStuckAlertCopy({
        risks: [dec({ issue: 6 })], nowMs: NOW, titleOf: () => 'x'.repeat(500),
    });
    const linea = out.split('\n').find((l) => l.startsWith('• #6'));
    assert.ok(linea.length < 160, `línea de ${linea.length} chars`);
});

test('scrubTitle usa el sanitize inyectado', () => {
    assert.equal(scrubTitle('  hola   mundo  ', null), 'hola mundo');
    assert.equal(scrubTitle('algo', (s) => `[${s}]`), '[algo]');
    assert.equal(scrubTitle(null, null), '');
    // Un sanitize que explota no puede tumbar el copy.
    assert.equal(scrubTitle('crudo', () => { throw new Error('boom'); }), 'crudo');
});

test('el listado se acota a 5 tareas y las opciones sobreviven', () => {
    const risks = Array.from({ length: 12 }, (_, i) => dec({ issue: 800 + i }));
    const out = buildStuckAlertCopy({ risks, nowMs: NOW });
    const items = out.split('\n').filter((l) => /^• #/.test(l));
    assert.equal(items.length, 5, 'cap del emisor, no del transporte');
    assert.match(out, /• y 7 más/);
    assert.match(out, /12 tareas frenadas/, 'el total real se sigue diciendo');
    // Lo último que se lee —y lo primero que el truncado se comería— son las opciones.
    assert.match(out.split('\n').pop(), /Podés: .*\/unblock.*\/wave add/);
});

// -----------------------------------------------------------------------------
// CA-5 — un aviso por episodio
// -----------------------------------------------------------------------------

const evalWith = (prev, risks) => evaluateSilenceHealth(prev, { agg: { evaluados: 10 }, risks });

test('mismo conjunto en el ciclo siguiente no re-avisa', () => {
    const risks = [dec({ issue: 1 }), dec({ issue: 2 })];
    const primero = evalWith(null, risks);
    assert.equal(primero.emitSignal, true);

    let prev = primero.next;
    for (let i = 0; i < 20; i++) {
        const r = evalWith(prev, risks);
        assert.equal(r.emitSignal, false, `re-avisó en el ciclo ${i + 2}`);
        prev = r.next;
    }
});

test('la huella ignora tiempos y contadores', () => {
    const a = [dec({ issue: 1, stuckSinceMs: NOW - HORA }), dec({ issue: 2, stuckSinceMs: NOW - 2 * HORA })];
    const b = [dec({ issue: 1, stuckSinceMs: NOW - 9 * HORA }), dec({ issue: 2, stuckSinceMs: NOW - 30 * HORA })];
    assert.equal(buildEpisodeFingerprint(a), buildEpisodeFingerprint(b),
        'si el tiempo entrara en la huella, el aviso se repetiría cada ciclo');

    // Y el orden de llegada tampoco la cambia.
    assert.equal(buildEpisodeFingerprint(a), buildEpisodeFingerprint([...a].reverse()));

    const prev = evalWith(null, a).next;
    assert.equal(evalWith(prev, b).emitSignal, false, 'mismo episodio, más viejo → no re-avisa');
});

test('si entra una tarea nueva se re-avisa', () => {
    const prev = evalWith(null, [dec({ issue: 1 }), dec({ issue: 2 })]).next;
    const r = evalWith(prev, [dec({ issue: 1 }), dec({ issue: 2 }), dec({ issue: 3 })]);
    assert.equal(r.emitSignal, true, 'el episodio empeoró: el operador tiene que enterarse');
    assert.equal(r.next.tareas_en_riesgo, 3);
});

test('si cambia el motivo se re-avisa', () => {
    const prev = evalWith(null, [dec({ issue: 1, suppression: 'cache' })]).next;
    const r = evalWith(prev, [dec({ issue: 1, suppression: 'otro-futuro' })]);
    assert.equal(r.emitSignal, true);
});

test('si el conjunto queda vacío el episodio se cierra y uno posterior vuelve a avisar', () => {
    const risks = [dec({ issue: 1 })];
    let prev = evalWith(null, risks).next;
    assert.equal(prev.episodio, '1|validacion|cache');

    const vacio = evalWith(prev, []);
    assert.equal(vacio.emitSignal, false);
    assert.equal(vacio.next.episodio, '', 'episodio cerrado');
    assert.equal(vacio.next.tareas_en_riesgo, 0);

    assert.equal(evalWith(vacio.next, risks).emitSignal, true, 'un episodio nuevo vuelve a avisar');
});

test('el archivo de estado es legible por una persona', () => {
    const { next } = evaluateSilenceHealth(null, {
        agg: { evaluados: 177, suprimidos_por_ola: 68, suprimidos_por_dedupe: 3, suprimidos_por_cache: 0 },
        risks: [],
    });
    assert.deepEqual(Object.keys(next).sort(), [
        'ciclos_revisando_sin_actuar', 'episodio', 'motivos', 'streak',
        'tareas_en_riesgo', 'ultimo_aviso_iso', 'umbral_ciclos',
    ]);
    assert.deepEqual(next.motivos, { fuera_de_la_ola: 68, estado_no_confirmado: 0, ya_avisadas: 3 });
});

// -----------------------------------------------------------------------------
// CA-7 — robustez
// -----------------------------------------------------------------------------

test('un fallo al construir el copy no propaga excepción', () => {
    const explota = () => { throw new Error('title-cache roto'); };
    let out;
    assert.doesNotThrow(() => {
        out = buildStuckAlertCopy({ risks: [dec({ issue: 77 })], nowMs: NOW, titleOf: explota });
    });
    assert.match(out, /#77/, 'la tarea sale por número: el aviso no se pierde');
});

test('entradas degeneradas no rompen', () => {
    assert.equal(buildStuckAlertCopy(), '');
    assert.equal(buildStuckAlertCopy({ risks: [] }), '');
    assert.equal(buildStuckAlertCopy({ risks: null }), '');
    assert.deepEqual(selectRealRisk(null), []);
    assert.equal(buildEpisodeFingerprint(null), '');
});

test('formatAgeEs cubre la escala completa', () => {
    assert.equal(formatAgeEs(30 * 1000), 'recién');
    assert.equal(formatAgeEs(5 * MIN), 'hace 5 min');
    assert.equal(formatAgeEs(3 * HORA), 'hace 3 h');
    assert.equal(formatAgeEs(2 * HORA + 15 * MIN), 'hace 2 h 15 min');
    assert.equal(formatAgeEs(3 * 24 * HORA), 'hace 3 d');
    assert.equal(formatAgeEs(3 * 24 * HORA + 5 * HORA), 'hace 3 d 5 h');
    assert.equal(formatAgeEs(NaN), '');
    assert.equal(formatAgeEs(-1000), '');
});
