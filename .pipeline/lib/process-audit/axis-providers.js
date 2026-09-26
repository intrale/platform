// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / axis-providers — eje proveedores, cuota y plan (#6809 H4)
// =============================================================================
//
// Evalúa a los proveedores de IA como recurso con precio y techo. Sólo
// CONSUME lo que calcula el programa de contabilidad de cuota (#6558-#6560):
// `quota-series` (horas gateado, única pata viva, cadena agotada) y
// `quota-balance` (muestras preparadas, reinicios por crédito, saldo). PURO:
// recibe los eventos y muestras ya leídos.
//
// Orden de descarte FIJO (CA-12), que viaja textual en cada propuesta:
//
//   1. Flag falso      — el detector gateó por cuota, pero la ventana observada
//                        (muestras frescas del mismo bucket) nunca pasó de
//                        `FLAG_FALSO_MAX_PCT` ⇒ `revisar_detector`.
//   2. Schedule        — hubo horas de única pata viva con esa pata gateada y
//                        otro proveedor fuera por horario de reposo
//                        ⇒ `mover_schedule`.
//   3. Cadena          — un proveedor gateado por cuota, otro en circulación,
//                        sin gate y CON muestras en la ventana, y aun así la
//                        cadena quedó agotada con trabajo elegible (la cadena
//                        de esos agentes no llega a la pata con saldo)
//                        ⇒ `reordenar_cadena` (cita el saldo de la otra pata).
//                        Si el fallback absorbió el agotamiento no hay nada
//                        que reordenar. Con otra pata viva NUNCA se sugiere
//                        subir el plan.
//   4. Plan            — recién después: `subir_plan` exige ≥2 ventanas
//                        semanales LIMPIAS (posteriores a `QUOTA_CLEAN_SINCE`),
//                        las dos últimas agotadas, cadena agotada con trabajo
//                        elegible (`cadena_agotada.horas > 0`) y ninguna otra
//                        pata con saldo. `bajar_plan` exige ≥2 ventanas limpias
//                        con consumo máximo < `PLAN_BAJAR_MAX_PCT` y cero horas
//                        gateado por cuota.
//
// Los reinicios de ventana por canje de crédito (#7185) son CONFUSORES: se
// cuentan y se informan, y su salto nunca suma consumo.

const qs = require('../multi-provider/quota-series');
const qb = require('../multi-provider/quota-balance');
const vqc = require('../multi-provider/validate-quota-ceilings');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const STEP_MS = 5 * 60000;

/** Corrección del detector de cuota (10/09): antes, la serie está contaminada. */
const QUOTA_CLEAN_SINCE = '2026-09-10';
const MIN_SEMANAS_LIMPIAS = 2;
const FLAG_FALSO_MAX_PCT = 95;
const FLAG_FALSO_MIN_MUESTRAS = 3;
const MIN_HORAS_HALLAZGO = 1;
const PLAN_BAJAR_MAX_PCT = 30;

const DESCARTE_ORDEN = Object.freeze(['flag_falso', 'schedule', 'cadena', 'plan']);

function r2(v) { return Math.round(v * 100) / 100; }

function inAt(intervals, t, motivos) {
    return (intervals || []).some((i) => motivos.includes(i.motivo) && t >= i.desde && t < i.hasta);
}

function bucketDeMotivo(motivo) {
    return motivo === 'quota_exhausted_sesion' ? 'session' : 'weekly';
}

/** Paso 1: flag de cuota sin agotamiento observado. */
function flagFalso(raw, muestras) {
    let horas = 0;
    let n = 0;
    let max = -Infinity;
    for (const i of raw || []) {
        if (!qs.MOTIVOS_CUOTA.includes(i.motivo)) continue;
        const dentro = (muestras[bucketDeMotivo(i.motivo)] || [])
            .filter((s) => s.confidence === 'fresh' && s.ts >= i.desde && s.ts <= i.hasta);
        if (!dentro.length) continue;
        horas += (i.hasta - i.desde) / HOUR_MS;
        n += dentro.length;
        for (const s of dentro) max = Math.max(max, s.valor);
    }
    if (n < FLAG_FALSO_MIN_MUESTRAS || !(max < FLAG_FALSO_MAX_PCT)) return null;
    return { horas: r2(horas), muestras: n, max_observado: r2(max) };
}

/**
 * Paso 3: por cada otra pata Q (sólo las que tienen muestras en la ventana:
 * una pata sin datos no es "saldo disponible"), las horas en que P estaba
 * gateado por cuota con Q viva y sin gate (`horas`), y cuántas de ellas la
 * cadena igual quedó agotada con trabajo elegible (`frenadas`). Q viva + cadena
 * agotada ⇒ la cadena de esos agentes no llega a Q: está desalineada con el
 * saldo real. Q viva sin cadena agotada ⇒ el fallback absorbió el agotamiento.
 */
function horasConOtraPata(gated, p, desde, hasta, conEvidencia, bloqueos) {
    const out = {};
    const raw = (gated[p] && gated[p]._raw) || [];
    const otros = Object.keys(gated).filter((q) => q !== p && conEvidencia.has(q));
    for (const q of otros) out[q] = { horas: 0, frenadas: 0 };
    const frenado = (t) => (bloqueos || []).some((b) => t >= b.desde && t < b.hasta);
    for (let t = desde; t < hasta; t += STEP_MS) {
        if (!inAt(raw, t, qs.MOTIVOS_CUOTA)) continue;
        const bloqueado = frenado(t);
        for (const q of otros) {
            const rq = (gated[q] && gated[q]._raw) || [];
            if (inAt(rq, t, qs.MOTIVOS_FUERA_DE_CIRCULACION) || inAt(rq, t, qs.MOTIVOS_CUOTA)) continue;
            out[q].horas += STEP_MS;
            if (bloqueado) out[q].frenadas += STEP_MS;
        }
    }
    for (const q of Object.keys(out)) out[q] = { horas: r2(out[q].horas / HOUR_MS), frenadas: r2(out[q].frenadas / HOUR_MS) };
    return out;
}

/** Bloques semanales completos, del más viejo al más nuevo, dentro de la ventana limpia. */
function bloquesLimpios(desde, hasta) {
    const inicio = Math.max(desde, Date.parse(`${QUOTA_CLEAN_SINCE}T00:00:00.000Z`));
    const n = Math.max(0, Math.floor((hasta - inicio) / WEEK_MS));
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push({ desde: hasta - (i + 1) * WEEK_MS, hasta: hasta - i * WEEK_MS });
    return { inicio, bloques: out };
}

/** Por bloque: pico observado, consumo (deltas positivos sin reinicios) y confusores. */
function consumoPorBloque(muestrasSemanales, bloques) {
    return bloques.map((b) => {
        const s = (muestrasSemanales || []).filter((x) => x.ts >= b.desde && x.ts < b.hasta);
        let consumo = 0;
        let creditos = 0;
        let max = null;
        for (let i = 0; i < s.length; i++) {
            max = max === null ? s[i].valor : Math.max(max, s[i].valor);
            if (s[i].window_reset) {
                if (s[i].reset_motivo === 'credito') creditos++;
                continue; // el salto de un reinicio nunca es consumo
            }
            if (i > 0) {
                const d = s[i].valor - s[i - 1].valor;
                if (d > 0) consumo += d;
            }
        }
        return { desde: b.desde, hasta: b.hasta, muestras: s.length, max, consumo: r2(consumo), creditos, agotada: max !== null && max >= 100 };
    });
}

function textoDescarte(pasos) {
    return DESCARTE_ORDEN.map((k, i) => `${i + 1}. ${k.replace('_', ' ')}: ${pasos[k]}`).join(', ');
}

/**
 * @param {object} p
 * @param {object} p.cfgRoot
 * @param {object} p.agentModels
 * @param {Array}  p.samples            `quota-ledger.readSamples()`
 * @param {Array}  p.detectorEvents     `quota-ledger.readDetectorEvents()`
 * @param {Array}  p.healthEvents
 * @param {object} p.scheduleEntries
 * @param {Array}  p.creditRedemptions
 * @param {Array}  p.costRecords
 * @param {number} p.desde
 * @param {number} p.hasta
 * @param {string} p.ventana
 * @param {Function} [p.isActiveAt]
 * @returns {{veredicto:string, hallazgos:Array, detalle:object}}
 */
function evaluarProveedores(p = {}) {
    const { cfgRoot, agentModels, desde, hasta, ventana } = p;
    const detalle = { ventana_limpia_desde: null, providers: {} };
    let ceilings = {};
    try { ceilings = vqc.listQuotaCeilings(cfgRoot) || {}; } catch { ceilings = {}; }
    const providers = Object.keys(ceilings);
    const samples = Array.isArray(p.samples) ? p.samples : [];
    if (!providers.length || !samples.length) {
        return { veredicto: 'sin_evidencia_suficiente', hallazgos: [], detalle: { ...detalle, motivo: providers.length ? 'sin_muestras' : 'sin_techos' } };
    }

    const base = { detectorEvents: p.detectorEvents, healthEvents: p.healthEvents, scheduleEntries: p.scheduleEntries, providers, desde, hasta, isActiveAt: p.isActiveAt };
    const gated = qs.gatedByProvider(base);
    const unica = qs.singleLeg(gated, desde, hasta);
    const cadena = qs.chainExhausted(base);
    const semanal = qb.prepareSamples(samples, { bucket: 'weekly', creditRedemptions: p.creditRedemptions });
    const sesion = qb.prepareSamples(samples, { bucket: 'session', creditRedemptions: p.creditRedemptions });
    let balance = { providers: {} };
    try { balance = qb.computeQuotaBalance(cfgRoot, samples, { now: hasta, creditRedemptions: p.creditRedemptions, costRecords: p.costRecords }); } catch { /* sin saldo */ }
    const conEvidencia = new Set(Object.keys(semanal).concat(Object.keys(sesion)).filter((q) => [...(semanal[q] || []), ...(sesion[q] || [])].some((x) => x.ts >= desde && x.ts <= hasta)));
    const bloqueos = (cadena.intervalos || [])
        .map((i) => ({ desde: Date.parse(i.desde), hasta: Date.parse(i.hasta) }))
        .filter((b) => Number.isFinite(b.desde) && Number.isFinite(b.hasta));
    let cadenaOrden = [];
    try { cadenaOrden = vqc.activeProviders(agentModels, cfgRoot); } catch { cadenaOrden = []; }
    const idx = (q) => { const i = cadenaOrden.indexOf(q); return i < 0 ? Infinity : i; };
    const { inicio, bloques } = bloquesLimpios(desde, hasta);
    detalle.ventana_limpia_desde = new Date(inicio).toISOString().slice(0, 10);
    detalle.semanas_limpias = bloques.length;
    detalle.cadena = cadenaOrden;
    detalle.cadena_agotada_horas = cadena.horas_total;
    detalle.unica_pata = { horas: unica.horas_unica_pata, horas_gateada: unica.horas_unica_pata_gateada };

    const hallazgos = [];
    const dias = Math.max(1, (hasta - desde) / DAY_MS);

    // ── 2. Schedule (global: la única pata viva la define el conjunto) ─────
    let patasPorSchedule = new Set();
    const enReposo = providers.filter((q) => gated[q] && gated[q].horas.schedule > 0);
    if (unica.horas_unica_pata_gateada >= MIN_HORAS_HALLAZGO && enReposo.length) {
        const [pata, dat] = Object.entries(unica.por_pata).sort((a, b) => b[1].horas_unica_gateada - a[1].horas_unica_gateada)[0];
        patasPorSchedule = new Set([pata]);
        hallazgos.push({
            eje: 'proveedores',
            clave: 'schedule_mover',
            veredicto: 'mover_schedule',
            fuente: 'quota-series',
            sube_costo_o_riesgo: true,
            metrica: { nombre: 'horas_unica_pata_gateada', valor: unica.horas_unica_pata_gateada, unidad: 'h', ventana },
            params: {
                pata,
                en_reposo: enReposo.slice(0, 5),
                horas_unica_por_dia: r2(unica.horas_unica_pata / dias),
                horas_gateada_por_dia: r2(dat.horas_unica_gateada / dias),
                descarte: textoDescarte({ flag_falso: 'no evaluado', schedule: 'causa', cadena: 'no evaluado', plan: 'no evaluado' }),
            },
        });
    }

    for (const prov of providers) {
        const d = { veredicto: 'mantener' };
        detalle.providers[prov] = d;
        const raw = (gated[prov] && gated[prov]._raw) || [];
        const horasCuota = (gated[prov] && gated[prov].horas)
            ? r2(gated[prov].horas.quota_exhausted_sesion + gated[prov].horas.quota_exhausted_semanal) : 0;
        d.horas_gateado_cuota = horasCuota;
        const pasos = { flag_falso: 'no', schedule: patasPorSchedule.has(prov) ? 'causa' : 'no', cadena: 'no', plan: 'no evaluado' };

        // ── 1. Flag falso ──────────────────────────────────────────────────
        const ff = flagFalso(raw, { weekly: semanal[prov] || [], session: sesion[prov] || [] });
        if (ff) {
            d.veredicto = 'revisar_detector';
            hallazgos.push({
                eje: 'proveedores',
                clave: 'detector_revisar',
                veredicto: 'revisar_detector',
                fuente: 'quota-detector+quota-ledger',
                sube_costo_o_riesgo: false,
                metrica: { nombre: 'horas_flag_sin_agotamiento', valor: ff.horas, unidad: 'h', ventana },
                params: { provider: prov, max_observado: ff.max_observado, muestras: ff.muestras,
                    descarte: textoDescarte({ ...pasos, flag_falso: 'causa', plan: 'no evaluado' }) },
            });
            continue;
        }
        if (patasPorSchedule.has(prov)) { d.veredicto = 'mover_schedule'; continue; }

        // ── 3. Cadena ──────────────────────────────────────────────────────
        const otras = horasConOtraPata(gated, prov, desde, hasta, conEvidencia, bloqueos);
        // Otra pata viva y sin gate mientras ésta estaba agotada y la cadena
        // igual frenó trabajo: el remedio es la cadena (o el balanceo), nunca
        // más plan. Se prefiere la pata que está DETRÁS en la cadena
        // (reordenar); si está delante, se informa como rebalanceo.
        const candidatas = Object.entries(otras)
            .filter(([, o]) => o.frenadas >= MIN_HORAS_HALLAZGO)
            .sort((a, b) => (Number(idx(b[0]) > idx(prov)) - Number(idx(a[0]) > idx(prov))) || (b[1].frenadas - a[1].frenadas));
        // Cualquier pata viva mientras ésta estaba agotada descarta "más plan".
        const conSaldo = Object.entries(otras).filter(([, o]) => o.horas > 0).map(([q]) => q);
        d.otra_pata_viva_horas = Object.fromEntries(Object.entries(otras).map(([q, o]) => [q, o.horas]));
        if (candidatas.length) {
            const [q, o] = candidatas[0];
            const h = o.frenadas;
            const bq = (balance.providers || {})[q] || {};
            d.veredicto = 'reordenar_cadena';
            pasos.cadena = 'causa';
            hallazgos.push({
                eje: 'proveedores',
                clave: 'cadena_reordenar',
                veredicto: 'reordenar_cadena',
                fuente: 'quota-series+quota-balance',
                sube_costo_o_riesgo: true,
                metrica: { nombre: 'horas_gateado_con_otra_pata', valor: h, unidad: 'h', ventana },
                params: {
                    provider: prov,
                    otra_pata: q,
                    otra_pata_detras: idx(q) > idx(prov),
                    saldo_otra_pata: Number.isFinite(bq.saldo_pts) ? r2(bq.saldo_pts) : null,
                    consumo_pct_otra_pata: Number.isFinite(bq.consumo_pct) ? r2(bq.consumo_pct) : null,
                    descarte: textoDescarte({ ...pasos, plan: 'no evaluado' }),
                },
            });
            continue;
        }

        // ── 4. Plan ────────────────────────────────────────────────────────
        const porBloque = consumoPorBloque(semanal[prov] || [], bloques);
        d.semanas = porBloque.map((b) => ({ max: b.max, consumo: b.consumo, creditos: b.creditos, agotada: b.agotada }));
        const creditos = porBloque.reduce((s, b) => s + b.creditos, 0);
        if (bloques.length < MIN_SEMANAS_LIMPIAS || porBloque.some((b) => b.muestras === 0)) {
            d.veredicto = 'sin_evidencia_suficiente';
            continue;
        }
        const ultimas = porBloque.slice(-MIN_SEMANAS_LIMPIAS);
        const agotadas = porBloque.filter((b) => b.agotada).length;
        const ceiling = ceilings[prov] || {};
        if (ultimas.every((b) => b.agotada) && cadena.horas_total > 0 && conSaldo.length === 0) {
            pasos.plan = 'causa';
            const issues = new Set((cadena.intervalos || []).map((i) => i.issue).filter((n) => Number.isInteger(n)));
            d.veredicto = 'subir_plan';
            hallazgos.push({
                eje: 'proveedores',
                clave: 'plan_subir',
                veredicto: 'subir_plan',
                fuente: 'quota-ledger+quota-series',
                sube_costo_o_riesgo: true,
                metrica: { nombre: 'semanas_agotadas', valor: agotadas, unidad: 'semanas', ventana },
                params: {
                    provider: prov,
                    plan: typeof ceiling.plan === 'string' ? ceiling.plan : null,
                    techo: Number.isFinite(ceiling.techo) ? ceiling.techo : null,
                    unidad: typeof ceiling.unidad === 'string' ? ceiling.unidad : null,
                    horas_frenadas: cadena.horas_union,
                    issues_afectados: issues.size,
                    horas_gateado: horasCuota,
                    creditos_confusores: creditos,
                    descarte: textoDescarte(pasos),
                },
            });
            continue;
        }
        const maxConsumo = Math.max(...porBloque.map((b) => b.max));
        if (maxConsumo < PLAN_BAJAR_MAX_PCT && horasCuota === 0) {
            pasos.plan = 'causa';
            d.veredicto = 'bajar_plan';
            hallazgos.push({
                eje: 'proveedores',
                clave: 'plan_bajar',
                veredicto: 'bajar_plan',
                fuente: 'quota-ledger',
                sube_costo_o_riesgo: true,
                metrica: { nombre: 'pct_consumo_semanal_max', valor: r2(maxConsumo), unidad: '%', ventana },
                params: {
                    provider: prov,
                    plan: typeof ceiling.plan === 'string' ? ceiling.plan : null,
                    techo: Number.isFinite(ceiling.techo) ? ceiling.techo : null,
                    unidad: typeof ceiling.unidad === 'string' ? ceiling.unidad : null,
                    creditos_confusores: creditos,
                    descarte: textoDescarte(pasos),
                },
            });
            continue;
        }
        d.veredicto = 'mantener';
    }

    const veredicto = hallazgos.length ? 'sugerir' : (Object.values(detalle.providers).every((x) => x.veredicto === 'sin_evidencia_suficiente') ? 'sin_evidencia_suficiente' : 'mantener');
    return { veredicto, hallazgos, detalle };
}

module.exports = {
    QUOTA_CLEAN_SINCE,
    MIN_SEMANAS_LIMPIAS,
    FLAG_FALSO_MAX_PCT,
    PLAN_BAJAR_MAX_PCT,
    DESCARTE_ORDEN,
    flagFalso,
    horasConOtraPata,
    bloquesLimpios,
    consumoPorBloque,
    textoDescarte,
    evaluarProveedores,
};
