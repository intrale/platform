// =============================================================================
// validate-copy.js — Validador del copy del aviso de respuesta perdida
//                    (#6440, UX)
//
// Valida contra los criterios vinculantes de
// `.pipeline/assets/mockups/6440/ux-criterios-6440.md`. Valida sobre el TEXTO
// VISIBLE ya interpolado, no sobre el JSON crudo: lo que le llega al operador
// es lo que hay que auditar.
//
//   CA-12  · la regex literal del criterio de aceptación del issue
//   UX-4.1 · vocabulario cerrado (nada de la lista prohibida)
//   UX-4.2 · la palabra interna "huérfano" no le llega nunca al operador
//   UX-4.3 · no se filtra contenido del pedido: un solo dato interpolado libre
//   UX-4.4 · sin metacaracteres de Markdown
//   UX-4.5 · largos máximos, por mensaje y por línea
//   UX-4.6 · todo aviso de pérdida advierte "no lo repitas a ciegas"
//   UX-4.7 · todo aviso lleva el identificador de la sesión con su fecha/hora
//   UX-6   · el consolidado lista hasta 3 y resume el resto
//   UX-7   · el badge del dashboard está completo y no colisiona con el enum
//   pureza · el renderer exige `now` inyectado y falla sin él
//
// Uso:  node .pipeline/assets/copy/orphan-turn/validate-copy.js
// Exit: 0 copy válido · 1 copy inválido (lista qué regla y en qué mensaje)
//
// Si una regla falla, el problema está en el copy o en la lectura del criterio:
// `copy.json` es normativo y sólo se toca pasando por UX.
// =============================================================================

'use strict';

const { COPY, AVISOS, renderAviso, formatAntiguedad, formatListaSesiones } = require('./render');

const fallos = [];
const fallo = (regla, detalle) => fallos.push(`${regla} · ${detalle}`);

// --- Inventario de textos visibles -------------------------------------------
// Se renderiza cada aviso con datos de peor caso: identificador largo real del
// episodio, antigüedad de días (el lapso más largo del formato).

const AHORA = Date.parse('2026-08-24T13:40:00-03:00');
const INICIADO = Date.parse('2026-08-24T09:26:16-03:00');
const HACE_DIAS = AHORA - (2 * 86400000 + 5 * 3600000);
const SESION = '6529617704-1787574376808';

const CASOS = [
    {
        aviso: 'H1_respuesta_perdida',
        datos: { sesion: SESION, iniciadoEn: INICIADO },
        perdida: true,
    },
    {
        aviso: 'H2_entrega_no_verificable',
        datos: { sesion: SESION, iniciadoEn: HACE_DIAS },
        perdida: true,
    },
    {
        aviso: 'H3_varias_respuestas_perdidas',
        datos: {
            pedidos: [
                { sesion: SESION, iniciadoEn: INICIADO },
                { sesion: '6529617704-1787578588947', iniciadoEn: INICIADO + 70 * 60000 },
                { sesion: '6529617704-1787361669699', iniciadoEn: HACE_DIAS },
                { sesion: '6529617704-1787253709858', iniciadoEn: HACE_DIAS - 3600000 },
                { sesion: '6529617704-1785437647193', iniciadoEn: HACE_DIAS - 7200000 },
            ],
        },
        perdida: true,
    },
];

const textos = CASOS.map((c) => ({
    ...c,
    texto: renderAviso(c.aviso, c.datos, { now: AHORA }),
}));

// --- CA-12 · la regex literal del issue ---------------------------------------
// "el texto del aviso no matchea /eof_premature|empty_output|delivery_pending|
//  delivered=false|stack|Error:/"
const RE_CA12 = /eof_premature|empty_output|delivery_pending|delivered=false|stack|Error:/i;
for (const t of textos) {
    if (RE_CA12.test(t.texto)) fallo('CA-12', `${t.aviso}: el texto matchea la regex de jerga prohibida`);
}

// --- UX-4.1 · vocabulario cerrado ---------------------------------------------
// Lista derivada de `reglas.vocabulario_prohibido`. Se chequea sobre el texto
// visible en minúsculas y sin tildes, para que "transcripcion" no se cuele.
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PROHIBIDAS = [
    'eof_premature', 'empty_output', 'delivery_pending', 'delivered', 'stack', 'error:',
    'huerfano', 'orphan', 'turno', 'etapa', 'transcripcion', 'dispatch', 'barrido',
    'sweep', 'sidecar', 'jsonl', 'dead-letter', 'reqid', 'correlationid', 'correlacion',
    'reconcile', 'fallback', 'proveedor', 'provider', 'motor', 'spawn', 'proceso',
    'exit code', 'timeout', 'cuota', 'quota', 'clearflag', 'inflight', 'in-flight',
    'allowlist', 'chat_id', 'epoch', 'meta.json', '.log', '.js', 'pulpo', 'commander',
];
for (const t of textos) {
    const plano = sinTildes(t.texto);
    for (const palabra of PROHIBIDAS) {
        if (plano.includes(palabra)) fallo('UX-4.1', `${t.aviso}: usa vocabulario interno "${palabra}"`);
    }
}

// --- UX-4.2 · la palabra interna nunca sale ------------------------------------
// Redundante con UX-4.1 a propósito: es el error más fácil de cometer al
// implementar (el enum se llama `huerfano` y está a mano). Falla con nombre
// propio para que el diagnóstico sea inmediato.
for (const t of textos) {
    if (/hu[eé]rfan/i.test(t.texto)) {
        fallo('UX-4.2', `${t.aviso}: le dice "huérfano" al operador; el enum interno no es vocabulario de usuario`);
    }
}

// --- UX-4.3 · no se filtra contenido del pedido --------------------------------
// Los únicos slots del copy son los declarados. Si aparece un slot nuevo, o uno
// sin resolver, es que alguien metió un dato que no está en el contrato.
const SLOTS_PERMITIDOS = ['{HORA}', '{FECHA_HORA}', '{ANTIGUEDAD}', '{SESION}', '{CANTIDAD}',
    '{LISTA_SESIONES}', '{MARCADOR}', '{TITULAR}', '{CONSECUENCIA}', '{DONDE_MIRAR}',
    '{IDENTIFICADOR}', '{N}', '{H}', '{M}', '{D}'];
const crudos = [];
for (const aviso of AVISOS) {
    const def = COPY.avisos[aviso];
    for (const campo of ['titular', 'consecuencia', 'donde_mirar', 'identificador']) {
        if (def[campo]) crudos.push({ id: `${aviso}.${campo}`, texto: def[campo] });
    }
}
for (const c of crudos) {
    for (const slot of c.texto.match(/\{[A-Z_]+\}/g) || []) {
        if (!SLOTS_PERMITIDOS.includes(slot)) fallo('UX-4.3', `${c.id}: slot no declarado ${slot}`);
    }
}
for (const t of textos) {
    if (/\{[A-Z_]+\}/.test(t.texto)) fallo('UX-4.3', `${t.aviso}: quedó un slot sin resolver`);
}

// --- UX-4.4 · sin metacaracteres de Markdown ----------------------------------
// El dropfile va `plain: true`, pero el servicio tiene un default histórico a
// Markdown: si alguien lo reactiva, el texto tiene que seguir leyéndose igual.
for (const t of textos) {
    const metas = t.texto.match(/[*_`[\]]/g);
    if (metas) fallo('UX-4.4', `${t.aviso}: contiene metacaracteres de Markdown (${[...new Set(metas)].join(' ')})`);
}

// --- UX-4.5 · largos ----------------------------------------------------------
const MAX_TEXTO = COPY.reglas.texto_max_chars;
const MAX_LINEA = COPY.reglas.linea_max_chars;
for (const t of textos) {
    if (t.texto.length > MAX_TEXTO) {
        fallo('UX-4.5', `${t.aviso}: ${t.texto.length} chars > ${MAX_TEXTO}`);
    }
    for (const linea of t.texto.split('\n')) {
        if (linea.length > MAX_LINEA) {
            fallo('UX-4.5', `${t.aviso}: línea de ${linea.length} chars > ${MAX_LINEA} ("${linea.slice(0, 40)}…")`);
        }
    }
    if (t.texto.split('\n').some((l) => l.trim() === '')) {
        fallo('UX-4.5', `${t.aviso}: tiene líneas en blanco — la plantilla es compacta a propósito`);
    }
}

// --- UX-4.6 · "no lo repitas a ciegas" ----------------------------------------
// Es el bloque que evita el daño real del episodio: el operador reenviando un
// pedido que ya se ejecutó. Se verifica por sentido, no por literal: el aviso
// tiene que decir que ya está hecho Y advertir qué pasa si lo repite.
for (const t of textos.filter((x) => x.perdida)) {
    const plano = sinTildes(t.texto);
    const dice_hecho = /ya esta hecho|se ejecuto/.test(plano);
    const advierte_repetir = /si lo repet|si los repet|antes de volver a|antes de volver a mandar|revisa la conversacion/.test(plano);
    if (!dice_hecho) fallo('UX-4.6', `${t.aviso}: no dice que el pedido ya se ejecutó`);
    if (!advierte_repetir) fallo('UX-4.6', `${t.aviso}: no advierte qué pasa si el operador lo vuelve a mandar`);
}

// --- UX-4.7 · identificador con marca de tiempo -------------------------------
for (const t of textos) {
    if (!t.texto.includes(SESION)) fallo('UX-4.7', `${t.aviso}: no lleva el identificador de la sesión`);
    if (!/\d{2}\/\d{2} \d{2}:\d{2}/.test(t.texto)) {
        fallo('UX-4.7', `${t.aviso}: no lleva la marca de tiempo en formato DD/MM HH:MM`);
    }
}
for (const t of textos.filter((x) => x.aviso !== 'H3_varias_respuestas_perdidas')) {
    if (!/hace /.test(t.texto)) fallo('UX-4.7', `${t.aviso}: no dice hace cuánto fue`);
}

// --- UX-6 · el consolidado no inunda ------------------------------------------
const consolidado = textos.find((t) => t.aviso === 'H3_varias_respuestas_perdidas');
const listados = (consolidado.texto.match(/\d{10}-\d{13}/g) || []).length;
if (listados > COPY.identificador.max_items_listados) {
    fallo('UX-6', `el consolidado lista ${listados} sesiones > ${COPY.identificador.max_items_listados}`);
}
if (!/y 2 m[aá]s/.test(consolidado.texto)) {
    fallo('UX-6', 'el consolidado no resume las sesiones que no lista');
}
if (!consolidado.texto.includes('5 pedidos')) {
    fallo('UX-6', 'el consolidado no dice cuántos pedidos son en total');
}
// Con 2 o 3 pedidos se listan todos y no aparece el resumen.
const corto = renderAviso('H3_varias_respuestas_perdidas', {
    pedidos: [
        { sesion: SESION, iniciadoEn: INICIADO },
        { sesion: '6529617704-1787578588947', iniciadoEn: INICIADO + 60000 },
    ],
}, { now: AHORA });
if (/m[aá]s\./.test(corto)) fallo('UX-6', 'con 2 pedidos el consolidado igual resume — no corresponde');

// --- UX-7 · badge del dashboard -----------------------------------------------
const badge = COPY.dashboard.badge;
for (const campo of ['enum', 'glyph', 'label', 'title', 'clase_css', 'token_color', 'token_fondo', 'token_borde']) {
    if (!badge[campo]) fallo('UX-7', `al badge le falta ${campo}`);
}
const GLIFOS_EN_USO = ['✓', '✎', '↪', '✗'];
if (GLIFOS_EN_USO.includes(badge.glyph)) {
    fallo('UX-7', `el glifo ${badge.glyph} ya lo usa otro resultado`);
}
if (badge.enum !== 'huerfano') fallo('UX-7', 'el valor del enum tiene que ser `huerfano`, sin tilde (enum cerrado de request-classify)');
if (badge.clase_css !== `cmd-result-${badge.enum}`) {
    fallo('UX-7', 'la clase CSS tiene que seguir el patrón cmd-result-<enum>');
}
if (/hu[eé]rfan/i.test(badge.title) === false && badge.title.length < 10) {
    fallo('UX-7', 'el tooltip del badge está vacío o es demasiado corto');
}

// --- pureza -------------------------------------------------------------------
let tiroSinNow = false;
try { renderAviso('H1_respuesta_perdida', { sesion: SESION, iniciadoEn: INICIADO }, {}); }
catch { tiroSinNow = true; }
if (!tiroSinNow) fallo('pureza', 'el renderer aceptó renderizar sin `now` inyectado');

let tiroAvisoDesconocido = false;
try { renderAviso('H9_inventado', {}, { now: AHORA }); }
catch { tiroAvisoDesconocido = true; }
if (!tiroAvisoDesconocido) fallo('pureza', 'un aviso desconocido no falló — fail-closed roto');

let tiroSesionForjada = false;
try {
    renderAviso('H1_respuesta_perdida',
        { sesion: '../../etc/passwd', iniciadoEn: INICIADO }, { now: AHORA });
} catch { tiroSesionForjada = true; }
if (!tiroSesionForjada) fallo('pureza', 'un identificador de sesión forjado no falló');

// --- formato de lapso ---------------------------------------------------------
const LAPSOS = [
    [30000, 'hace menos de un minuto'],
    [5 * 60000, 'hace 5 min'],
    [3 * 3600000, 'hace 3 h'],
    [3 * 3600000 + 5 * 60000, 'hace 3 h 05 min'],
    [2 * 86400000 + 4 * 3600000, 'hace 2 d 4 h'],
];
for (const [ms, esperado] of LAPSOS) {
    const got = formatAntiguedad(ms);
    if (got !== esperado) fallo('UX-4.7', `lapso ${ms}ms => "${got}", esperado "${esperado}"`);
}

// --- Salida -------------------------------------------------------------------
console.log('=== Texto visible ===\n');
for (const t of textos) {
    console.log(`--- ${t.aviso} (${t.texto.length} chars)`);
    console.log(t.texto);
    console.log('');
}
console.log(`--- H3 con 2 pedidos (${corto.length} chars)`);
console.log(corto);
console.log('');
console.log(`--- badge dashboard: ${COPY.dashboard.badge.glyph} ${COPY.dashboard.badge.label}`);
console.log('');

if (fallos.length > 0) {
    console.error(`✗ copy inválido — ${fallos.length} incumplimiento(s):`);
    for (const f of fallos) console.error(`  · ${f}`);
    process.exit(1);
}
console.log(`✓ copy válido — ${textos.length + 1} textos visibles auditados, 0 incumplimientos.`);
console.log(`  formatListaSesiones (5 pedidos): ${formatListaSesiones(CASOS[2].datos.pedidos)}`);
