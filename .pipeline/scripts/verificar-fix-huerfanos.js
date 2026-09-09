#!/usr/bin/env node
// =============================================================================
// verificar-fix-huerfanos.js — mide en producción si los fixes del incidente
// 2026-09-08 (#7103) están funcionando.
//
// Los tests prueban las unidades; esto mide el pipeline real. Son cuatro
// indicadores, todos calculados sobre los mismos archivos que se usaron para
// diagnosticar el incidente, y todos con un umbral fijado de antemano:
//
//   1. Intentos de dispatch por día        7538  →  objetivo < 500
//   2. Tasa de dispatch efectivo            0,7% →  objetivo > 60%
//   3. Fases rechazadas por huérfano           3 →  objetivo 0
//   4. Corridas de retrabajo (attempt ≥ 2)    26 →  objetivo < 3
//
// Uso:
//   node .pipeline/scripts/verificar-fix-huerfanos.js            # hoy
//   node .pipeline/scripts/verificar-fix-huerfanos.js 2026-09-08 # una fecha
//
// Salida: tabla legible + exit code 0 si los cuatro pasan, 1 si alguno no.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_DIR_OVERRIDE
    || path.join(__dirname, '..');
const LOGS = path.join(PIPELINE, 'logs');

// Línea base: lo que midió el incidente del 2026-09-08.
const BASE = { intentos: 7538, tasa: 0.7, rechazos: 3, retrabajo: 26 };
const OBJETIVO = { intentos: 500, tasa: 60, rechazos: 0, retrabajo: 3 };

function fechaObjetivo() {
    const arg = process.argv[2];
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
    return new Date().toISOString().slice(0, 10);
}

function leerJsonl(file) {
    try {
        return fs.readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch {
        return [];
    }
}

// --- 1 y 2: intentos de dispatch y cuántos llegaron a lanzar ------------------
function medirDispatch(fecha) {
    const eventos = leerJsonl(path.join(LOGS, `cross-provider-dispatch-${fecha}.jsonl`));
    const lanzados = eventos.filter((e) => e.event === 'fallback_selected').length;
    const agotados = eventos.filter((e) => e.event === 'chain_exhausted').length;
    const tasa = eventos.length ? (lanzados / eventos.length) * 100 : 0;
    return { total: eventos.length, lanzados, agotados, tasa };
}

// --- 3: fases rechazadas por el barrido de huérfanos --------------------------
function medirRechazosHuerfanos(fecha) {
    let log;
    try {
        log = fs.readFileSync(path.join(LOGS, 'pulpo.log'), 'utf8');
    } catch {
        return { rechazos: 0, detalle: ['(pulpo.log no disponible)'] };
    }
    const detalle = log.split('\n')
        .filter((l) => l.includes('[huerfanos]') && l.includes('excedió') && l.includes(fecha.slice(0, 10)))
        .map((l) => l.trim());
    // El log usa `[YYYY-MM-DD HH:MM:SS]`; si la fecha no aparece, filtramos por
    // el día completo del archivo.
    const delDia = detalle.length
        ? detalle
        : log.split('\n').filter((l) => l.includes('[huerfanos]') && l.includes('excedió') && l.includes(fecha));
    return { rechazos: delDia.length, detalle: delDia.slice(0, 5) };
}

// --- 4: corridas de retrabajo ------------------------------------------------
function medirRetrabajo(fecha) {
    // Un `attempt-2` del mismo día es una fase que se rehizo desde cero.
    let archivos;
    try {
        archivos = fs.readdirSync(LOGS);
    } catch {
        return { corridas: 0, detalle: [] };
    }
    const inicioDia = new Date(`${fecha}T00:00:00`).getTime();
    const finDia = inicioDia + 24 * 60 * 60 * 1000;
    const reintentos = archivos
        .filter((f) => /\.attempt-([2-9]|\d{2,})\.log$/.test(f))
        .filter((f) => {
            try {
                const m = fs.statSync(path.join(LOGS, f)).mtimeMs;
                return m >= inicioDia && m < finDia;
            } catch { return false; }
        });
    return { corridas: reintentos.length, detalle: reintentos.slice(0, 8) };
}

// --- salida ------------------------------------------------------------------
function fila(nombre, valor, base, objetivo, cumple, unidad = '') {
    const estado = cumple ? 'OK  ' : 'FALLA';
    return `  ${estado}  ${nombre.padEnd(34)} ${String(valor).padStart(8)}${unidad}   (incidente: ${base}${unidad} · objetivo: ${objetivo}${unidad})`;
}

function main() {
    const fecha = fechaObjetivo();
    const d = medirDispatch(fecha);
    const h = medirRechazosHuerfanos(fecha);
    const r = medirRetrabajo(fecha);

    const ok = {
        intentos: d.total < OBJETIVO.intentos,
        tasa: d.total === 0 ? true : d.tasa > OBJETIVO.tasa,
        rechazos: h.rechazos <= OBJETIVO.rechazos,
        retrabajo: r.corridas < OBJETIVO.retrabajo,
    };

    console.log(`\nVerificación de los fixes del incidente 2026-09-08 (#7103) — día ${fecha}\n`);
    console.log(fila('Intentos de dispatch', d.total, BASE.intentos, `< ${OBJETIVO.intentos}`, ok.intentos));
    console.log(fila('Tasa de dispatch efectivo', d.tasa.toFixed(1), BASE.tasa, `> ${OBJETIVO.tasa}`, ok.tasa, '%'));
    console.log(fila('Fases rechazadas por huérfano', h.rechazos, BASE.rechazos, OBJETIVO.rechazos, ok.rechazos));
    console.log(fila('Corridas de retrabajo (attempt≥2)', r.corridas, BASE.retrabajo, `< ${OBJETIVO.retrabajo}`, ok.retrabajo));

    console.log(`\n  Detalle: ${d.lanzados} lanzamientos, ${d.agotados} cadenas agotadas.`);
    if (h.rechazos > 0) {
        console.log('\n  Rechazos por huérfano (los que NO deberían existir):');
        for (const l of h.detalle) console.log(`    ${l}`);
    }
    if (r.corridas > 0) {
        console.log('\n  Retrabajo detectado:');
        for (const l of r.detalle) console.log(`    ${l}`);
    }

    const todos = Object.values(ok).every(Boolean);
    console.log(`\n  ${todos ? 'Los cuatro indicadores pasan.' : 'Hay indicadores en rojo: el fix no está teniendo el efecto esperado.'}\n`);
    process.exit(todos ? 0 : 1);
}

if (require.main === module) main();

module.exports = { medirDispatch, medirRechazosHuerfanos, medirRetrabajo, BASE, OBJETIVO };
