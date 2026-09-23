'use strict';

// =============================================================================
// process-audit / publish — hallazgo → propuesta en el registro único (#6809)
// =============================================================================
//
// Único canal: `propuestas-registry.publicar(payload, { productor:
// 'auditor-proceso' })` (D3 / SEC-6809-4). Si el registro rechaza o está
// degradado, se loguea el motivo y NO se degrada a Telegram, a un comentario ni
// a ningún otro canal.
//
// Reglas del payload (CA-4 / CA-5 / SEC-6809-3):
//   - Sin métrica numérica finita + ventana ⇒ no se publica (`sin_metrica`).
//   - Veredicto `mantener` / `sin_evidencia_suficiente` ⇒ no se publica (D7).
//   - Métrica sin banda congelada ⇒ no se publica (`sin_banda`).
//   - Todos los textos salen de PLANTILLAS FIJAS con números interpolados e
//     identificadores re-validados por regex (`skill`, `fase`, `provider`,
//     `control`, `causa`). Nunca viaja texto libre de la telemetría.
//   - `accion` (entra al hash de dedup) no lleva valores medidos: sólo
//     identificadores y valores de config. Los números medidos van en
//     `evidencia.resumen` y en `costo/riesgo.detalle`, que NO entran al hash;
//     la estabilidad de la dedup la da la banda de `evidencia.referencia`.
//   - Lo que sube costo o riesgo (concurrencia, plan, schedule, cadena) sale
//     como `cambio-de-configuracion` (SEC-6809-6): requiere la firma humana.
//
// No arma Markdown ni URLs. `publicar()` además pasa todo por
// `detectInjection` + `redactObject`.

const { referenciaDe } = require('./bands');

const PRODUCTOR = 'auditor-proceso';
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
const PLAN_RE = /^[A-Za-z0-9 ._+-]{1,40}$/;
const FUENTE_RE = /^[a-z0-9][a-z0-9+_.-]{0,59}$/;
const NO_PUBLICABLES = Object.freeze(['mantener', 'sin_evidencia_suficiente']);

function id(v) { return (typeof v === 'string' && ID_RE.test(v)) ? v : 'desconocido'; }
function n(v) { return (typeof v === 'number' && Number.isFinite(v)) ? String(Math.round(v * 100) / 100) : '?'; }
function plan(v) { return (typeof v === 'string' && PLAN_RE.test(v)) ? v : 'no declarado'; }
function sinGuion(v) { return id(v).replace(/_/g, ' '); }
function recortar(s, max) { return s.length > max ? `${s.slice(0, max - 3)}...` : s; }
function descarte(p) { return typeof p.descarte === 'string' && /^[0-9a-z .,:]{1,200}$/i.test(p.descarte) ? p.descarte : ''; }

const ESCALA_BAJA = Object.freeze({ costo: { nivel: 'bajo' }, riesgo: { nivel: 'bajo' } });

/**
 * Plantillas por clave: `(params, metrica) => { titulo, accion, beneficio, extra, costo, riesgo }`.
 * `extra` se suma a `evidencia.resumen` (números medidos).
 */
const PLANTILLAS = Object.freeze({
    paso_determinizable: (p) => ({
        titulo: `Volver deterministico el paso ${id(p.skill)} en ${id(p.fase)}`,
        accion: `Evaluar reemplazar el agente con modelo ${id(p.skill)} de la fase ${id(p.fase)} por un paso deterministico: su veredicto fue siempre ${id(p.resultado)} en la ventana.`,
        beneficio: 'Ahorra tokens y latencia de modelo en un paso cuyo resultado no cambia.',
        extra: `veredicto constante ${id(p.resultado)}`,
        ...ESCALA_BAJA,
    }),
    paso_sobra: (p) => ({
        titulo: `Revisar paso redundante ${id(p.skill)} en ${id(p.fase)}`,
        accion: `Evaluar quitar el paso ${id(p.skill)} de la fase ${id(p.fase)}: su veredicto fue siempre ${id(p.resultado)} en la ventana y no cambia el resultado.`,
        beneficio: 'Acorta el flujo quitando un paso que nunca cambia el resultado.',
        extra: `veredicto constante ${id(p.resultado)}`,
        ...ESCALA_BAJA,
    }),
    fallo_recurrente: (p) => ({
        titulo: `Automatizar fallo recurrente de ${id(p.skill)} (${id(p.death_kind)}, exit ${n(p.exit_code)})`,
        accion: `Automatizar el tratamiento del fallo recurrente de ${id(p.skill)} con firma ${id(p.firma)} (${id(p.death_kind)}, exit ${n(p.exit_code)}).`,
        beneficio: 'Evita repetir a mano el mismo diagnostico y relanzamiento.',
        extra: `en ${n(p.dias)} dias distintos`,
        ...ESCALA_BAJA,
    }),
    fase_costosa: (p) => ({
        titulo: `Revisar el costo de la fase ${id(p.fase)}`,
        accion: `Revisar la fase ${id(p.fase)}: concentra el costo en tokens de la ventana y su veredicto casi no varia.`,
        beneficio: 'Reduce el costo de una fase que aporta poca variacion al resultado.',
        extra: `variacion del veredicto ${n(p.variacion)}%, ${n(p.corridas)} corridas, ${n(p.rebotes)} rebotes, ${n(p.reintentos)} reintentos`,
        ...ESCALA_BAJA,
    }),
    control_apagado: (p) => ({
        titulo: `Revisar control apagado: ${sinGuion(id(p.control).replace(/.enabled$/, ''))}`,
        accion: `Decidir si el control ${id(p.control)} sigue apagado o se retira de la configuracion.`,
        beneficio: 'Evita controles muertos que confunden sobre que protege al pipeline.',
        extra: '',
        ...ESCALA_BAJA,
    }),
    ociosidad_sin_trabajo: (p) => ({
        titulo: 'Atacar la falta de trabajo elegible antes que el paralelismo',
        accion: `Atacar la causa del trabajo no elegible (causa dominante: ${id(p.causa)}) en lugar de subir el limite de agentes en paralelo.`,
        beneficio: 'Aumenta el rendimiento sin sumar riesgo: la maquina ya tiene capacidad ociosa.',
        extra: `${n(p.horas_sin_trabajo)} de ${n(p.horas_ociosas)} horas ociosas sin trabajo elegible, causa ${id(p.causa)}; no se sugiere subir el paralelismo`,
        ...ESCALA_BAJA,
    }),
    ociosidad_con_trabajo: (p) => ({
        titulo: 'Revisar el gate que frena trabajo elegible',
        accion: `Revisar el gate de despacho que deja la cola ociosa con trabajo elegible esperando (causa dominante: ${id(p.causa)}); no es falta de capacidad de la maquina.`,
        beneficio: 'Destraba trabajo ya elegible sin tocar el paralelismo.',
        extra: `${n(p.horas_con_trabajo)} de ${n(p.horas_ociosas)} horas ociosas con trabajo elegible, causa ${id(p.causa)}`,
        ...ESCALA_BAJA,
    }),
    concurrencia_subir: (p) => ({
        titulo: `Ajuste gradual de concurrencia ${id(p.regimen)} a ${n(p.objetivo)} agentes`,
        accion: `Subir ${id(p.clave_config)} de ${n(p.cap)} a ${n(p.objetivo)} (paso +1, gradual y reversible). Condicion de reversion: volver a ${n(p.cap)} si mem_p95 >= yellow_max_percent (${n(p.yellow)}%) durante 2 h seguidas.`,
        beneficio: 'Mas trabajo en paralelo en las horas en que el limite estuvo lleno con margen de RAM medido.',
        extra: `mem_p95 con cap lleno ${n(p.mem_p95)}%, costo ${n(p.costo_marginal)} pp por agente, margen ${n(p.margen)} pp hasta yellow`,
        costo: { nivel: 'medio', detalle: recortar(`Costo marginal medido: ${n(p.costo_marginal)} pp de RAM por agente; margen ${n(p.margen)} pp hasta yellow_max_percent.`, 300) },
        riesgo: { nivel: 'medio', detalle: `Presion de RAM; reversion si mem_p95 >= ${n(p.yellow)}% durante 2 h seguidas.` },
    }),
    concurrencia_bajar: (p) => ({
        titulo: `Bajar concurrencia ${id(p.regimen)} a ${n(p.objetivo)} agentes`,
        accion: `Bajar ${id(p.clave_config)} de ${n(p.cap)} a ${n(p.objetivo)}: el pico de RAM con el limite lleno alcanzo orange_max_percent (${n(p.orange)}%). Condicion de reversion: volver a ${n(p.cap)} cuando el pico con el limite lleno quede bajo ${n(p.orange)}% una ventana completa.`,
        beneficio: 'Aleja al pipeline del umbral naranja y del riesgo de swap.',
        extra: `umbral naranja ${n(p.orange)}%`,
        costo: { nivel: 'medio', detalle: 'Menos trabajo en paralelo en las horas pico.' },
        riesgo: { nivel: 'medio', detalle: `Pico de RAM con el limite lleno sobre ${n(p.orange)}%.` },
    }),
    detector_revisar: (p) => ({
        titulo: `Revisar el detector de cuota de ${id(p.provider)}`,
        accion: `Revisar el detector de cuota de ${id(p.provider)}: gateo por cuota sin que la ventana observada llegara al 100 por ciento. No destrabar a mano.`,
        beneficio: 'Recupera horas de proveedor frenadas por un flag que no coincide con la medicion.',
        extra: `pico observado ${n(p.max_observado)}% en ${n(p.muestras)} muestras; descarte: ${descarte(p)}`,
        ...ESCALA_BAJA,
    }),
    schedule_mover: (p) => ({
        titulo: `Revisar horario de reposo: ${id(p.pata)} queda como unica pata`,
        accion: `Correr el horario de reposo de ${(Array.isArray(p.en_reposo) ? p.en_reposo : []).map(id).join(', ')} o sumar otra pata: ${id(p.pata)} queda como unica pata viva y gateada por cuota.`,
        beneficio: 'Evita horas con una sola pata viva y frenada.',
        extra: `unica pata ${n(p.horas_unica_por_dia)} h por dia, gateada ${n(p.horas_gateada_por_dia)} h por dia; descarte: ${descarte(p)}`,
        costo: { nivel: 'medio', detalle: 'Mas horas de uso del proveedor que hoy reposa.' },
        riesgo: { nivel: 'medio', detalle: 'Cambia la ventana de reposo pactada para el proveedor.' },
    }),
    cadena_reordenar: (p) => ({
        titulo: `Reordenar cadena de proveedores antes de evaluar el plan de ${id(p.provider)}`,
        accion: p.otra_pata_detras === true
            ? `Reordenar la cadena: poner ${id(p.otra_pata)} antes que ${id(p.provider)} mientras ${id(p.provider)} este agotado por cuota; no subir el plan de ${id(p.provider)}.`
            : `Rebalancear el uso entre ${id(p.provider)} y ${id(p.otra_pata)}: ${id(p.otra_pata)} tenia saldo mientras ${id(p.provider)} estaba agotado; no subir el plan de ${id(p.provider)}.`,
        beneficio: 'Usa el saldo disponible de otra pata antes de pagar mas plan.',
        extra: `saldo de ${id(p.otra_pata)} ${n(p.saldo_otra_pata)} pts (consumo ${n(p.consumo_pct_otra_pata)}%); descarte: ${descarte(p)}`,
        costo: { nivel: 'bajo', detalle: `Saldo actual de ${id(p.otra_pata)}: ${n(p.saldo_otra_pata)} pts.` },
        riesgo: { nivel: 'medio', detalle: 'Cambia el orden de fallback de todos los agentes.' },
    }),
    plan_subir: (p) => ({
        titulo: `Evaluar subir el plan de ${id(p.provider)}`,
        accion: `Evaluar subir el plan de ${id(p.provider)} (plan actual ${plan(p.plan)}, techo ${n(p.techo)} ${id(p.unidad)}): agotamiento sostenido con trabajo frenado y sin otra pata con saldo.`,
        beneficio: 'Recupera las horas de trabajo elegible frenado por cuota agotada.',
        extra: `${n(p.horas_frenadas)} h frenadas, ${n(p.issues_afectados)} issues afectados, ${n(p.horas_gateado)} h gateado, ${n(p.creditos_confusores)} creditos excluidos; descarte: ${descarte(p)}`,
        costo: { nivel: 'alto', detalle: `Techo actual ${n(p.techo)} ${id(p.unidad)} (${plan(p.plan)}); el plan superior no esta declarado en la config: cotizar antes de decidir.` },
        riesgo: { nivel: 'medio', detalle: 'Compromiso de gasto recurrente.' },
    }),
    plan_bajar: (p) => ({
        titulo: `Evaluar bajar el plan de ${id(p.provider)}`,
        accion: `Evaluar bajar el plan de ${id(p.provider)} (plan actual ${plan(p.plan)}): consumo semanal maximo bajo y sin horas gateadas por cuota.`,
        beneficio: 'Ahorro recurrente sin frenar trabajo.',
        extra: `${n(p.creditos_confusores)} creditos excluidos; descarte: ${descarte(p)}`,
        costo: { nivel: 'bajo', detalle: `Plan actual ${plan(p.plan)}, techo ${n(p.techo)} ${id(p.unidad)}.` },
        riesgo: { nivel: 'medio', detalle: 'Menos margen ante un pico de demanda.' },
    }),
});

/**
 * Construye el payload del registro o explica por qué no se publica. Pura.
 * @returns {{ok:true, payload:object}|{ok:false, motivo:string}}
 */
function construirPayload(h) {
    if (!h || typeof h !== 'object') return { ok: false, motivo: 'hallazgo_invalido' };
    if (NO_PUBLICABLES.includes(h.veredicto)) return { ok: false, motivo: h.veredicto };
    const m = h.metrica;
    if (!m || typeof m.valor !== 'number' || !Number.isFinite(m.valor) || typeof m.ventana !== 'string' || !m.ventana) {
        return { ok: false, motivo: 'sin_metrica' };
    }
    const plantilla = Object.prototype.hasOwnProperty.call(PLANTILLAS, h.clave) ? PLANTILLAS[h.clave] : null;
    if (!plantilla) return { ok: false, motivo: 'sin_plantilla' };
    const referencia = referenciaDe(id(h.eje), m.nombre, m.valor);
    if (!referencia) return { ok: false, motivo: 'sin_banda' };
    const t = plantilla(h.params || {}, m);
    const ventana = /^[0-9a-z .:-]{1,60}$/i.test(m.ventana) ? m.ventana : 'ventana';
    const unidad = /^[a-z%]{1,12}$/i.test(m.unidad || '') ? m.unidad : '';
    const resumen = recortar(`${id(m.nombre)} ${n(m.valor)}${unidad === '%' ? '%' : unidad ? ` ${unidad}` : ''} en ${ventana}${t.extra ? `; ${t.extra}` : ''}`, 300);
    const payload = {
        // UX-1 del schema: el título no admite `*` ni `_`.
        titulo: recortar(t.titulo.replace(/[_*]/g, ' '), 90),
        tipo: h.sube_costo_o_riesgo === true ? 'cambio-de-configuracion' : 'mejora-de-proceso',
        accion: t.accion,
        evidencia: {
            tipo: (typeof h.fuente === 'string' && FUENTE_RE.test(h.fuente)) ? h.fuente : 'desconocida',
            referencia,
            resumen,
        },
        beneficio: recortar(t.beneficio, 300),
        costo: t.costo,
        riesgo: t.riesgo,
        sensible: false,
        categoria: `auditor-proceso-${id(h.eje)}`,
    };
    return { ok: true, payload };
}

/**
 * Publica un hallazgo. Nunca lanza; nunca usa otro canal.
 * @param {object} h
 * @param {{registry?:object, logger?:Function, ahora?:string, config?:object}} [ctx]
 * @returns {{publicado:boolean, motivo:string, id?:string}}
 */
function publicarHallazgo(h, ctx = {}) {
    const logger = typeof ctx.logger === 'function' ? ctx.logger : () => {};
    const armado = construirPayload(h);
    if (!armado.ok) return { publicado: false, motivo: armado.motivo };
    let registry = ctx.registry;
    try {
        if (!registry) registry = require('../propuestas-registry');
    } catch {
        logger('registro de propuestas no disponible; no se degrada a otro canal');
        return { publicado: false, motivo: 'registro_no_disponible' };
    }
    let r;
    try {
        const c = { productor: PRODUCTOR };
        if (ctx.ahora) c.ahora = ctx.ahora;
        if (ctx.config) c.config = ctx.config;
        r = registry.publicar(armado.payload, c);
    } catch (e) {
        logger(`registro lanzó (${(e && e.name) || 'Error'}); no se degrada a otro canal`);
        return { publicado: false, motivo: 'registro_fallo' };
    }
    if (r && r.ok && !r.duplicada) return { publicado: true, motivo: 'publicada', id: r.id };
    if (r && r.ok && r.duplicada) return { publicado: false, motivo: 'duplicada', id: r.id };
    const motivo = (r && typeof r.motivo === 'string') ? r.motivo : 'registro_rechazo';
    if (motivo !== 'rechazada_previamente' && motivo !== 'ya_decidida') {
        logger(`registro rechazó la propuesta ${id(h.clave)}: ${id(motivo)}`);
    }
    return { publicado: false, motivo };
}

module.exports = { PRODUCTOR, PLANTILLAS, NO_PUBLICABLES, construirPayload, publicarHallazgo };
