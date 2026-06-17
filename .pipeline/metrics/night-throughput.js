#!/usr/bin/env node
// =============================================================================
// night-throughput.js — Reporte de throughput nocturno del pipeline (#4051, CA-5).
//
// Lee `.pipeline/metrics-history.jsonl` (snapshot cada ~30s con cpu/mem/level/
// agents/byFase) y, filtrando las muestras cuya hora local cae en la franja
// nocturna (22:00–07:00, tz configurable), reporta POR NOCHE:
//   - promedio de agentes simultáneos (la métrica que el issue rastrea: bajó a
//     ~0,67 la noche del incidente),
//   - pico de agentes simultáneos,
//   - distribución de niveles de presión (green/yellow/orange/red),
//   - un proxy de throughput: drenaje neto de backlog total (pending) por hora.
//
// Permite comparar el estado previo (~0,67 agentes) con el posterior al cambio.
//
// NOTA sobre el throughput: `metrics-history.jsonl` NO registra eventos
// discretos de promoción (issue movido de fase), solo snapshots de estado. Por
// eso "issues promovidos/hora" se ESTIMA como el drenaje neto de la cola total
// (suma de `pending` de todas las fases) entre el primer y último snapshot de
// cada noche, normalizado por hora y clampeado a ≥0. Es un proxy: el intake
// nocturno y los splits lo pueden enmascarar. La métrica dura y directa es el
// promedio de agentes simultáneos.
//
// Uso:
//   node .pipeline/metrics/night-throughput.js              # todas las noches
//   node .pipeline/metrics/night-throughput.js --json       # salida JSON
//   node .pipeline/metrics/night-throughput.js --nights 7   # últimas 7 noches
//
// Salida humana por defecto; `--json` para consumo programático.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

// Franja nocturna por defecto (espejo del config.yaml night_window). El reporte
// es independiente del gate: si querés otra franja, pasá --start/--end.
const DEFAULT_START = '22:00';
const DEFAULT_END = '07:00';

function hhmmToMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

/**
 * Devuelve { hour, minute, dateKey } de un timestamp ms en la tz dada.
 * dateKey es 'YYYY-MM-DD' del día local — sirve para agrupar por noche.
 */
function partsInTz(ms, tz) {
    const d = new Date(ms);
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d);
    } catch (e) {
        parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'UTC',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d);
    }
    const map = Object.create(null);
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    return {
        hour,
        minute: parseInt(map.minute, 10),
        dateKey: `${map.year}-${map.month}-${map.day}`,
    };
}

/** ¿La hora local (min desde medianoche) cae en la franja [start, end)? */
function inWindow(curMin, startMin, endMin) {
    if (startMin === endMin) return false;
    return startMin < endMin
        ? (curMin >= startMin && curMin < endMin)
        : (curMin >= startMin || curMin < endMin);
}

/**
 * Clave de "noche" para agrupar. Una muestra a las 03:00 del día D pertenece a
 * la noche que ARRANCÓ la tarde del día D-1. Para que ambos lados del cruce de
 * medianoche caigan en el mismo bucket, restamos `end` minutos a la fecha local
 * cuando la hora está antes del fin de ventana.
 */
function nightKey(parts, startMin, endMin) {
    const curMin = parts.hour * 60 + parts.minute;
    // Si cruza medianoche y estamos en la madrugada (< end), la noche pertenece
    // al día anterior.
    if (startMin > endMin && curMin < endMin) {
        const d = new Date(`${parts.dateKey}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
    }
    return parts.dateKey;
}

function totalPending(sample) {
    const byFase = sample && sample.byFase;
    if (!byFase || typeof byFase !== 'object') return 0;
    let sum = 0;
    for (const fase of Object.keys(byFase)) {
        const f = byFase[fase];
        if (f && typeof f.pending === 'number') sum += f.pending;
    }
    return sum;
}

function round(n, d = 2) {
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
}

/**
 * Procesa las muestras y devuelve un array de noches con sus métricas.
 * @param {object[]} samples — objetos parseados de metrics-history.jsonl.
 * @param {object} opts — { tz, startMin, endMin }
 */
function computeNights(samples, opts) {
    const { tz, startMin, endMin } = opts;
    const byNight = new Map();

    for (const s of samples) {
        if (!s || typeof s.ts !== 'number') continue;
        const parts = partsInTz(s.ts, tz);
        const curMin = parts.hour * 60 + parts.minute;
        if (!inWindow(curMin, startMin, endMin)) continue;

        const key = nightKey(parts, startMin, endMin);
        if (!byNight.has(key)) {
            byNight.set(key, {
                night: key,
                samples: 0,
                agentsSum: 0,
                agentsPeak: 0,
                levels: { green: 0, yellow: 0, orange: 0, red: 0 },
                firstTs: s.ts,
                lastTs: s.ts,
                firstPending: totalPending(s),
                lastPending: totalPending(s),
            });
        }
        const n = byNight.get(key);
        const agents = typeof s.agents === 'number' ? s.agents : 0;
        n.samples += 1;
        n.agentsSum += agents;
        if (agents > n.agentsPeak) n.agentsPeak = agents;
        if (s.level && n.levels[s.level] != null) n.levels[s.level] += 1;
        if (s.ts < n.firstTs) { n.firstTs = s.ts; n.firstPending = totalPending(s); }
        if (s.ts > n.lastTs) { n.lastTs = s.ts; n.lastPending = totalPending(s); }
    }

    const nights = [];
    for (const n of byNight.values()) {
        const hours = Math.max((n.lastTs - n.firstTs) / 3600000, 0);
        const drain = Math.max(n.firstPending - n.lastPending, 0);
        nights.push({
            night: n.night,
            samples: n.samples,
            avgAgents: n.samples ? round(n.agentsSum / n.samples) : 0,
            peakAgents: n.agentsPeak,
            hoursCovered: round(hours),
            levelPct: {
                green: n.samples ? round(100 * n.levels.green / n.samples, 1) : 0,
                yellow: n.samples ? round(100 * n.levels.yellow / n.samples, 1) : 0,
                orange: n.samples ? round(100 * n.levels.orange / n.samples, 1) : 0,
                red: n.samples ? round(100 * n.levels.red / n.samples, 1) : 0,
            },
            // Proxy de throughput (ver cabecera): drenaje neto de cola/hora.
            throughputPerHourEstimate: hours > 0 ? round(drain / hours) : 0,
        });
    }
    nights.sort((a, b) => a.night.localeCompare(b.night));
    return nights;
}

function readSamples(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch (e) { /* skip línea corrupta */ }
    }
    return out;
}

function parseArgs(argv) {
    const args = { json: false, nights: null, tz: DEFAULT_TIMEZONE, start: DEFAULT_START, end: DEFAULT_END };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') args.json = true;
        else if (a === '--nights') args.nights = parseInt(argv[++i], 10);
        else if (a === '--tz') args.tz = argv[++i];
        else if (a === '--start') args.start = argv[++i];
        else if (a === '--end') args.end = argv[++i];
    }
    return args;
}

function formatHuman(nights, opts) {
    if (!nights.length) {
        return `Sin muestras nocturnas (${opts.start}–${opts.end}, ${opts.tz}) en metrics-history.jsonl.`;
    }
    const lines = [];
    lines.push(`🌙 Throughput nocturno (${opts.start}–${opts.end} ${opts.tz}) — ${nights.length} noche(s)`);
    lines.push('');
    lines.push('noche       | muestras | avg agentes | pico | horas | thru/h~ | presión (G/Y/O/R %)');
    lines.push('------------|----------|-------------|------|-------|---------|---------------------');
    for (const n of nights) {
        const lp = n.levelPct;
        lines.push(
            `${n.night} | ${String(n.samples).padStart(8)} | ${String(n.avgAgents).padStart(11)} | ` +
            `${String(n.peakAgents).padStart(4)} | ${String(n.hoursCovered).padStart(5)} | ` +
            `${String(n.throughputPerHourEstimate).padStart(7)} | ` +
            `${lp.green}/${lp.yellow}/${lp.orange}/${lp.red}`
        );
    }
    lines.push('');
    lines.push('thru/h~ = proxy (drenaje neto de cola/hora); la métrica dura es "avg agentes".');
    return lines.join('\n');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const file = path.join(PIPELINE_DIR, 'metrics-history.jsonl');
    const samples = readSamples(file);
    let nights = computeNights(samples, {
        tz: opts.tz,
        startMin: hhmmToMinutes(opts.start),
        endMin: hhmmToMinutes(opts.end),
    });
    if (opts.nights && opts.nights > 0) {
        nights = nights.slice(-opts.nights);
    }
    if (opts.json) {
        process.stdout.write(JSON.stringify({ window: { start: opts.start, end: opts.end, tz: opts.tz }, nights }, null, 2) + '\n');
    } else {
        process.stdout.write(formatHuman(nights, opts) + '\n');
    }
}

if (require.main === module) {
    main();
}

module.exports = { computeNights, partsInTz, inWindow, nightKey, totalPending, hhmmToMinutes };
