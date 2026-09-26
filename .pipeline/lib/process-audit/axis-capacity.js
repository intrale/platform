// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / axis-capacity — eje capacidad y paralelismo (#6809 H3)
// =============================================================================
//
// Evalúa el límite de agentes en paralelo contra el uso real de recursos y la
// causa real de la ociosidad, sobre el rollup horario (`read-hourly`). PURO:
// recibe las horas ya leídas y la config; no lee ni escribe nada.
//
// Orden OBLIGATORIO (receta del Arquitecto + CA-10/CA-11):
//
//   1. Causa antes que remedio. Si ≥50 % del tiempo hubo cero agentes, se
//      clasifica la ociosidad: si en las horas ociosas el trabajo elegible
//      mediano fue 0 ⇒ "ociosidad por falta de trabajo elegible" y `subir`
//      queda PROHIBIDO. Si había elegibles esperando ⇒ "ociosidad con trabajo
//      elegible" (la causa es un gate, no la máquina), también sin `subir`.
//   2. `bajar` si el pico de RAM con el cap lleno llegó a `orange_max_percent`.
//      Va ANTES que `subir` por el sesgo explícito a la estabilidad: si ambas
//      condiciones se cumplen (pico puntual con p95 holgado), gana bajar.
//   3. `subir` (+1) sólo si el cap se alcanzó ≥20 % de las horas del régimen y
//      `mem_p95` con cap lleno + costo marginal por agente < `yellow_max_percent`.
//      Incluye condición de reversión y nunca propone más de +1.
//   4. En cualquier otro caso: `mantener`. Sin muestras suficientes:
//      `sin_evidencia_suficiente`. Ninguno de los dos se publica (D7).
//
// Los umbrales de seguridad son los VIGENTES de `resource_limits` (diurnos y
// de `night_window`); este módulo no propone umbrales nuevos.

const OCIOSIDAD_MIN_FRAC = 0.5;
const SATURACION_MIN_FRAC = 0.2;
const MIN_HORAS_VALIDAS = 24;
const MIN_REGIMEN_HORAS = 12;
const DEFAULT_MIN_SAMPLES_HORA = 60;

const REGIMENES = Object.freeze([
    { clave: 'max_concurrent_devs', nocturna: false, etiqueta: 'diurno' },
    { clave: 'night_window.max_concurrent_devs', nocturna: true, etiqueta: 'nocturno' },
]);

function r1(v) { return Math.round(v * 10) / 10; }

function entero(v) { return Number.isInteger(v) && v >= 0 ? v : null; }

function umbrales(cfgRoot) {
    const rl = (cfgRoot && cfgRoot.resource_limits) || {};
    const nw = (rl.night_window && typeof rl.night_window === 'object') ? rl.night_window : {};
    const val = (o, k, d) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] : d);
    return {
        diurno: {
            yellow: val(rl, 'yellow_max_percent', null),
            orange: val(rl, 'orange_max_percent', null),
            cap: entero(rl.max_concurrent_devs),
        },
        nocturno: {
            yellow: val(nw, 'yellow_max_percent', val(rl, 'yellow_max_percent', null)),
            orange: val(nw, 'orange_max_percent', val(rl, 'orange_max_percent', null)),
            cap: entero(nw.max_concurrent_devs) !== null ? entero(nw.max_concurrent_devs) : entero(rl.max_concurrent_devs),
        },
    };
}

/**
 * Costo marginal de RAM por agente: pendiente de la regresión lineal simple de
 * `mem_p50` contra la cantidad de agentes, sobre los buckets agregados de la
 * ventana con al menos `minN` muestras. `null` si hay < 2 buckets distintos.
 */
function costoMarginal(horas, minN) {
    const agg = {};
    for (const h of horas) {
        for (const [k, b] of Object.entries(h.por_agentes || {})) {
            if (b.mem_p50 === null) continue;
            const a = agg[k] || (agg[k] = { n: 0, suma: 0 });
            a.n += b.n;
            a.suma += b.mem_p50 * b.n;
        }
    }
    const puntos = Object.entries(agg)
        .filter(([, a]) => a.n >= minN)
        .map(([k, a]) => ({ x: Number(k), y: a.suma / a.n, n: a.n }));
    if (puntos.length < 2) return { pendiente: null, puntos };
    const mx = puntos.reduce((s, p) => s + p.x, 0) / puntos.length;
    const my = puntos.reduce((s, p) => s + p.y, 0) / puntos.length;
    let num = 0;
    let den = 0;
    for (const p of puntos) {
        num += (p.x - mx) * (p.y - my);
        den += (p.x - mx) * (p.x - mx);
    }
    if (den === 0) return { pendiente: null, puntos };
    return { pendiente: num / den, puntos };
}

function moda(valores) {
    const c = {};
    for (const v of valores) if (v) c[v] = (c[v] || 0) + 1;
    let mejor = null;
    let max = 0;
    for (const k of Object.keys(c).sort()) if (c[k] > max) { max = c[k]; mejor = k; }
    return mejor;
}

/**
 * @param {object} p
 * @param {Array} p.horas           salida de `readHourly().horas`
 * @param {object} p.cfgRoot        config resuelta
 * @param {number} [p.minSamplesHora]
 * @param {string} p.ventana        texto de ventana ("14d hasta 2026-09-23")
 * @returns {{veredicto:string, hallazgos:Array, detalle:object}}
 */
function evaluarCapacidad({ horas, cfgRoot, minSamplesHora, ventana } = {}) {
    const minN = Number.isInteger(minSamplesHora) && minSamplesHora > 0 ? minSamplesHora : DEFAULT_MIN_SAMPLES_HORA;
    const validas = (Array.isArray(horas) ? horas : []).filter((h) => h && h.n_muestras >= minN);
    const u = umbrales(cfgRoot);
    const detalle = { horas_validas: validas.length, min_samples_hora: minN, umbrales: u };
    if (validas.length < MIN_HORAS_VALIDAS) {
        return { veredicto: 'sin_evidencia_suficiente', hallazgos: [], detalle: { ...detalle, motivo: 'pocas_horas' } };
    }

    const hallazgos = [];
    const N = validas.reduce((s, h) => s + h.n_muestras, 0);
    const Z = validas.reduce((s, h) => s + h.muestras_cero_agentes, 0);
    const fracCero = Z / N;
    detalle.pct_tiempo_cero_agentes = r1(fracCero * 100);

    // ── 1. Causa antes que remedio ─────────────────────────────────────────
    let subirProhibido = false;
    const ociosas = validas.filter((h) => h.muestras_cero_agentes / h.n_muestras >= 0.5);
    if (fracCero >= OCIOSIDAD_MIN_FRAC && ociosas.length > 0) {
        subirProhibido = true;
        const conDato = ociosas.filter((h) => h.elegibles_p50_cero !== null);
        const sinTrabajo = conDato.filter((h) => h.elegibles_p50_cero === 0);
        const causa = moda(ociosas.map((h) => h.causa_moda)) || 'desconocida';
        detalle.horas_ociosas = ociosas.length;
        detalle.horas_ociosas_sin_trabajo = sinTrabajo.length;
        detalle.causa_moda = causa;
        if (conDato.length > 0 && sinTrabajo.length * 2 >= conDato.length) {
            hallazgos.push({
                eje: 'capacidad',
                clave: 'ociosidad_sin_trabajo',
                veredicto: 'atacar_bloqueo',
                fuente: 'metrics-history-hourly',
                sube_costo_o_riesgo: false,
                metrica: { nombre: 'pct_tiempo_cero_agentes', valor: r1(fracCero * 100), unidad: '%', ventana },
                params: { causa, horas_ociosas: ociosas.length, horas_sin_trabajo: sinTrabajo.length },
            });
        } else if (conDato.length > 0) {
            hallazgos.push({
                eje: 'capacidad',
                clave: 'ociosidad_con_trabajo',
                veredicto: 'revisar_gate',
                fuente: 'metrics-history-hourly',
                sube_costo_o_riesgo: false,
                metrica: { nombre: 'pct_tiempo_cero_agentes', valor: r1(fracCero * 100), unidad: '%', ventana },
                params: { causa, horas_ociosas: ociosas.length, horas_con_trabajo: conDato.length - sinTrabajo.length },
            });
        }
    }

    // Costo marginal por agente (común a los dos regímenes).
    const cm = costoMarginal(validas, minN);
    detalle.costo_marginal_ram = cm.pendiente === null ? null : r1(cm.pendiente);

    // ── 2/3. Por régimen (diurno / nocturno) ───────────────────────────────
    let veredicto = 'mantener';
    detalle.regimenes = {};
    for (const reg of REGIMENES) {
        const th = reg.nocturna ? u.nocturno : u.diurno;
        const hs = validas.filter((h) => h.nocturna === reg.nocturna);
        const nReg = hs.reduce((s, h) => s + h.n_muestras, 0);
        const d = { horas: hs.length, cap: th.cap };
        detalle.regimenes[reg.etiqueta] = d;
        if (hs.length < MIN_REGIMEN_HORAS || th.cap === null || th.yellow === null || th.orange === null) {
            d.veredicto = 'sin_evidencia_suficiente';
            continue;
        }
        const enCap = hs.reduce((s, h) => s + (h.muestras_en_cap || 0), 0);
        const fracEnCap = nReg > 0 ? enCap / nReg : 0;
        const p95s = hs.map((h) => h.en_cap.mem_p95).filter((v) => v !== null);
        const maxs = hs.map((h) => h.en_cap.mem_max).filter((v) => v !== null);
        const memP95 = p95s.length ? Math.max(...p95s) : null;
        const memMax = maxs.length ? Math.max(...maxs) : null;
        Object.assign(d, { pct_horas_en_cap: r1(fracEnCap * 100), mem_p95_en_cap: memP95, mem_max_en_cap: memMax });

        if (memMax !== null && memMax >= th.orange && th.cap > 1) {
            d.veredicto = 'bajar';
            veredicto = 'bajar';
            hallazgos.push({
                eje: 'capacidad',
                clave: 'concurrencia_bajar',
                veredicto: 'bajar',
                fuente: 'metrics-history-hourly',
                sube_costo_o_riesgo: true,
                metrica: { nombre: 'mem_max_en_cap', valor: memMax, unidad: '%', ventana },
                params: { regimen: reg.etiqueta, clave_config: reg.clave, cap: th.cap, objetivo: th.cap - 1, orange: th.orange },
            });
            continue;
        }
        if (subirProhibido) { d.veredicto = 'mantener'; d.motivo = 'ociosidad'; continue; }
        if (fracEnCap >= SATURACION_MIN_FRAC && memP95 !== null && cm.pendiente !== null
            && memP95 + Math.max(0, cm.pendiente) < th.yellow) {
            d.veredicto = 'subir';
            if (veredicto !== 'bajar') veredicto = 'subir';
            hallazgos.push({
                eje: 'capacidad',
                clave: 'concurrencia_subir',
                veredicto: 'subir',
                fuente: 'metrics-history-hourly',
                sube_costo_o_riesgo: true,
                metrica: { nombre: 'pct_horas_en_cap', valor: r1(fracEnCap * 100), unidad: '%', ventana },
                params: {
                    regimen: reg.etiqueta,
                    clave_config: reg.clave,
                    cap: th.cap,
                    objetivo: th.cap + 1,
                    mem_p95: memP95,
                    costo_marginal: r1(Math.max(0, cm.pendiente)),
                    margen: r1(th.yellow - memP95 - Math.max(0, cm.pendiente)),
                    yellow: th.yellow,
                },
            });
            continue;
        }
        d.veredicto = 'mantener';
    }
    if (hallazgos.length === 0) veredicto = 'mantener';
    else if (veredicto === 'mantener') veredicto = 'atacar_causa';
    return { veredicto, hallazgos, detalle };
}

module.exports = {
    OCIOSIDAD_MIN_FRAC,
    SATURACION_MIN_FRAC,
    MIN_HORAS_VALIDAS,
    MIN_REGIMEN_HORAS,
    DEFAULT_MIN_SAMPLES_HORA,
    umbrales,
    costoMarginal,
    evaluarCapacidad,
};
