// =============================================================================
// wave-progress.js — Serie temporal de avance de ola (#4039).
//
// Único módulo autorizado a ESCRIBIR sobre `.pipeline/wave-progress.jsonl`.
// Vive separado de `eta-wave.js` justamente para no romper el contrato
// read-only de ese módulo (guru#2 / SEC-1 / CA-7): `eta-wave.js` solo LEE esta
// serie; acá se hace el `appendFileSync` + pruning (writes).
//
// Cada línea del store es un registro JSONL con SOLO primitivos validados:
//   { ts:number, waveKey:number(entero), avancePct:number(finito) }
//
// Contratos de seguridad (SEC-2..SEC-5 / CA-10..CA-13):
//   - SEC-2: cada línea se escribe con `JSON.stringify(obj) + '\n'` sobre el
//     objeto completo (escapa `\n` embebidos). NUNCA por concatenación de
//     strings. No se persisten strings libres (nombre/goal de ola).
//   - SEC-3: `waveKey` validado como entero; el path del store es FIJO,
//     nunca interpolado con input → sin path traversal.
//   - SEC-4: pruning por waveKey cerrado + antigüedad → cota de crecimiento.
//   - SEC-5: sin paths absolutos, hostnames ni usernames en el store ni en
//     logs; logs solo agregados (counts).
//   - SEC-6: lectura tolerante a línea corrupta (descartar, no crashea).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constantes ────────────────────────────────────────────────────────────

// Retención de líneas de olas NO activas. Las líneas de la ola activa nunca se
// podan (se necesitan para medir el ritmo); las de olas viejas se descartan
// pasada esta ventana. Las olas duran horas, 7 días es holgura amplia.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Cota dura de líneas del store (defensa DoS / SEC-4). Si el archivo la supera,
// el pruning recorta dejando las más recientes.
const MAX_LINES = 5000;

// Cada cuántos appends corremos el pruning oportunista. El archivo es chico
// (una línea por refresh, ~30s) así que reescribirlo cada N appends es barato.
const PRUNE_EVERY_N = 50;

// #5836 — Versión de fórmula asumida para los registros que NO traen `formulaV`.
// Todo lo escrito antes del cambio usaba conteo plano de issues (v1).
const LEGACY_FORMULA_VERSION = 1;

// #5836 — Umbral para considerar que el denominador CRECIÓ de verdad. Absorbe
// el residuo de punto flotante del reparto proporcional de un split (~1e-15),
// muy por debajo de cualquier alta real (el peso mínimo de un issue es 1).
const WEIGHT_EPSILON = 1e-6;

let _appendCounter = 0;

// ─── Paths (con override por env para tests) ───────────────────────────────

function pipelineRoot(pipelineRootArg) {
    if (pipelineRootArg) return pipelineRootArg;
    if (process.env.PIPELINE_ROOT_OVERRIDE) return process.env.PIPELINE_ROOT_OVERRIDE;
    // .pipeline/lib/wave-progress.js → root = ../..
    return path.join(__dirname, '..', '..');
}

function pipelineDir(pipelineRootArg) { return path.join(pipelineRoot(pipelineRootArg), '.pipeline'); }

// Path FIJO (SEC-3 / CA-11): jamás se interpola input en el nombre.
function storePath(pipelineRootArg) { return path.join(pipelineDir(pipelineRootArg), 'wave-progress.jsonl'); }

// ─── Validación de inputs ──────────────────────────────────────────────────

function isValidWaveKey(k) {
    return typeof k === 'number' && Number.isInteger(k) && k > 0;
}

function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

// ─── appendSnapshot (CA-3 / CA-10 / CA-11 / CA-14) ─────────────────────────

/**
 * Agrega un punto a la serie temporal de avance de la ola.
 *
 * Valida estrictamente los inputs: `waveKey` debe ser entero positivo y
 * `avancePct` un número finito. Cualquier input inválido → no escribe y
 * devuelve `false` (CA-11/CA-14), nunca lanza.
 *
 * La línea se serializa con `JSON.stringify` del objeto completo + `\n`
 * (CA-10/SEC-2). `appendFileSync` de una línea completa es atómico, lo que
 * permite múltiples writers (loop de dashboard + handler de `/wave`) sin
 * corromper líneas.
 *
 * #5836 — El record acepta tres campos OPCIONALES más, todos primitivos
 * (SEC-2 intacto): `totalWeight`, `issueCount` y `formulaV`. Sin ellos era
 * imposible distinguir, entre dos puntos de la serie, si el avance bajó porque
 * algo retrocedió o porque entraron issues nuevos al denominador — que es
 * justamente lo que CA-5 necesita anotar. Los campos se omiten del record si no
 * vienen, así que las líneas viejas y las nuevas conviven sin migración.
 *
 * @param {{pipelineRoot?:string, waveKey:number, avancePct:number, now?:number,
 *          totalWeight?:number, issueCount?:number, formulaV?:number}} args
 * @returns {boolean} true si escribió
 */
function appendSnapshot({
    pipelineRoot: pipelineRootArg, waveKey, avancePct, now,
    totalWeight, issueCount, formulaV,
} = {}) {
    if (!isValidWaveKey(waveKey)) return false;        // CA-11
    if (!isFiniteNumber(avancePct)) return false;      // CA-10/CA-14
    const ts = isFiniteNumber(now) ? now : Date.now();

    const rec = { ts, waveKey, avancePct };            // SOLO primitivos (SEC-2)
    // Campos opcionales #5836: se agregan sólo si son primitivos válidos. Un
    // valor basura NO invalida el punto (el avance sigue siendo útil), sólo se
    // descarta el campo — degradar sin romper.
    if (isFiniteNumber(totalWeight) && totalWeight >= 0) rec.totalWeight = totalWeight;
    if (isFiniteNumber(issueCount) && Number.isInteger(issueCount) && issueCount >= 0) rec.issueCount = issueCount;
    if (isFiniteNumber(formulaV) && Number.isInteger(formulaV) && formulaV > 0) rec.formulaV = formulaV;
    const file = storePath(pipelineRootArg);
    try {
        fs.appendFileSync(file, JSON.stringify(rec) + '\n');  // objeto completo, nunca concat
    } catch {
        return false;  // FS no disponible → no rompemos al caller
    }

    // Pruning oportunista (CA-12 / SEC-4): cada N appends mantenemos la cota.
    _appendCounter++;
    if (_appendCounter >= PRUNE_EVERY_N) {
        _appendCounter = 0;
        try { pruneStore({ pipelineRoot: pipelineRootArg, activeWaveKey: waveKey, now: ts }); } catch { /* no-op */ }
    }
    return true;
}

// ─── readSnapshots (reader tolerante) ──────────────────────────────────────

/**
 * Lee la serie completa (o filtrada por `waveKey`) de forma tolerante a
 * líneas corruptas (SEC-6): cada línea se parsea con try/catch; una línea
 * inválida se descarta sin abortar.
 *
 * `eta-wave.js` NO usa este reader (stremea el JSONL por su cuenta para
 * respetar su patrón readline); esta función existe para tests y consumidores
 * que ya están del lado de escritura.
 *
 * @param {{pipelineRoot?:string, waveKey?:number}} [args]
 * @returns {Array<{ts:number, waveKey:number, avancePct:number}>} ordenada por ts asc
 */
function readSnapshots({ pipelineRoot: pipelineRootArg, waveKey } = {}) {
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }

    const filterKey = isValidWaveKey(waveKey) ? waveKey : null;
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }   // SEC-6
        if (!rec || typeof rec !== 'object') continue;
        if (!isValidWaveKey(rec.waveKey)) continue;
        if (!isFiniteNumber(rec.ts) || !isFiniteNumber(rec.avancePct)) continue;
        if (filterKey !== null && rec.waveKey !== filterKey) continue;
        const out1 = { ts: rec.ts, waveKey: rec.waveKey, avancePct: rec.avancePct };
        // #5836 — Campos opcionales, PURAMENTE ADITIVOS: sólo se copian si el
        // record los trae. La ausencia de `formulaV` ES la señal de "punto de la
        // serie vieja" y `classifyProgressDelta` ya la normaliza a
        // LEGACY_FORMULA_VERSION, así que rellenarla acá sería redundante y
        // además cambiaría la forma del objeto para los consumidores que ya
        // existen (el dashboard y `pulpo.js` leen esta serie). Mantener la forma
        // estable evita romper una lectura que hoy funciona.
        if (isFiniteNumber(rec.totalWeight)) out1.totalWeight = rec.totalWeight;
        if (isFiniteNumber(rec.issueCount)) out1.issueCount = rec.issueCount;
        if (isFiniteNumber(rec.formulaV)) out1.formulaV = rec.formulaV;
        out.push(out1);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
}

// ─── classifyProgressDelta (#5836 / CA-5) ──────────────────────────────────

/**
 * Explica POR QUÉ cambió el avance entre dos puntos de la serie.
 *
 * El operador lee una caída del indicador como pérdida de productividad. Casi
 * nunca lo es: si entraron issues nuevos a la ola, el denominador creció y el
 * porcentaje baja aunque no se haya deshecho un solo trabajo. Esta función
 * separa los dos casos usando el peso total, que antes de #5836 no se
 * persistía (con dos `avancePct` sueltos el caso era indecidible).
 *
 * Clasificación:
 *   - `series-break`: los puntos vienen de fórmulas distintas (v1 conteo plano
 *     vs v2 ponderado). NO son comparables — recalcular los viejos sería
 *     inventar el peso que nunca se guardó, así que se marca el corte.
 *   - `altas`: el avance bajó Y el denominador creció. La caída se explica por
 *     issues nuevos, no por retroceso.
 *   - `retroceso`: el avance bajó SIN que creciera el denominador. Acá sí algo
 *     volvió para atrás.
 *   - `avance` / `estable`: subió o no se movió.
 *   - `unknown`: falta info para decidir (punto sin peso ni conteo).
 *
 * @param {object} prev — record anterior (de `readSnapshots`)
 * @param {object} curr — record actual
 * @returns {{kind:string, deltaPp:number, deltaWeight:number|null, deltaIssues:number|null}}
 */
function classifyProgressDelta(prev, curr) {
    const none = { kind: 'unknown', deltaPp: 0, deltaWeight: null, deltaIssues: null };
    if (!prev || !curr || typeof prev !== 'object' || typeof curr !== 'object') return none;
    if (!isFiniteNumber(prev.avancePct) || !isFiniteNumber(curr.avancePct)) return none;

    const deltaPp = curr.avancePct - prev.avancePct;

    // Corte de serie: comparar un punto de conteo plano con uno ponderado
    // mezcla peras con manzanas. Se avisa y no se atribuye causa.
    const vPrev = isFiniteNumber(prev.formulaV) ? prev.formulaV : LEGACY_FORMULA_VERSION;
    const vCurr = isFiniteNumber(curr.formulaV) ? curr.formulaV : LEGACY_FORMULA_VERSION;
    if (vPrev !== vCurr) {
        return { kind: 'series-break', deltaPp, deltaWeight: null, deltaIssues: null };
    }

    const deltaWeight = isFiniteNumber(prev.totalWeight) && isFiniteNumber(curr.totalWeight)
        ? curr.totalWeight - prev.totalWeight
        : null;
    const deltaIssues = isFiniteNumber(prev.issueCount) && isFiniteNumber(curr.issueCount)
        ? curr.issueCount - prev.issueCount
        : null;

    if (deltaPp > 0) return { kind: 'avance', deltaPp, deltaWeight, deltaIssues };
    if (deltaPp === 0) return { kind: 'estable', deltaPp, deltaWeight, deltaIssues };

    // Bajó. ¿Creció el denominador? Con peso disponible, ese es el criterio
    // fino; si no hay peso, caemos al conteo de issues.
    //
    // El peso se compara contra un EPSILON, no contra 0: el reparto proporcional
    // de un split deja residuos de punto flotante (~1e-15), y sin el margen un
    // split perfectamente neutro se reportaría como "caída por altas". El peso
    // ya viene cuantizado a 6 decimales desde `wave-weight`, así que cualquier
    // crecimiento real del denominador queda muy por encima de este umbral.
    const denominadorCrecio = deltaWeight !== null
        ? deltaWeight > WEIGHT_EPSILON
        : (deltaIssues !== null ? deltaIssues > 0 : null);

    if (denominadorCrecio === null) return { kind: 'unknown', deltaPp, deltaWeight, deltaIssues };
    return {
        kind: denominadorCrecio ? 'altas' : 'retroceso',
        deltaPp,
        deltaWeight,
        deltaIssues,
    };
}

/**
 * `appendSnapshot` + clasificación del punto nuevo contra el anterior (#5836).
 *
 * Existe para que el orden de las dos operaciones no quede librado al caller:
 * el punto previo hay que leerlo ANTES de escribir, porque una vez apendeado el
 * último registro del store es el actual y el delta daría siempre 0. Ese error
 * de orden es fácil de cometer y silencioso (la nota de CA-5 simplemente nunca
 * aparecería), así que la secuencia vive acá, en un solo lugar, y los dos
 * writers (dashboard y handler `/wave`) la comparten.
 *
 * @param {object} args — mismos campos que `appendSnapshot`
 * @returns {{written:boolean, delta:object|null}} delta null si no hay punto
 *          previo con el cual comparar (primer snapshot de la ola)
 */
function appendSnapshotWithDelta(args = {}) {
    const { pipelineRoot, waveKey } = args || {};

    // Punto previo: última lectura de ESTA ola, antes de escribir la nueva.
    let prev = null;
    try {
        const prior = readSnapshots({ pipelineRoot, waveKey });
        if (Array.isArray(prior) && prior.length > 0) prev = prior[prior.length - 1];
    } catch { prev = null; }   // sin histórico → simplemente no hay nota

    const written = appendSnapshot(args);
    if (!written || !prev) return { written, delta: null };

    const curr = {
        avancePct: args.avancePct,
        totalWeight: args.totalWeight,
        issueCount: args.issueCount,
        formulaV: args.formulaV,
    };
    return { written, delta: classifyProgressDelta(prev, curr) };
}

// ─── pruneStore (CA-12 / SEC-4) ────────────────────────────────────────────

/**
 * Reescribe el store descartando líneas de olas NO activas más viejas que
 * `RETENTION_MS`. Las líneas de la ola activa (`activeWaveKey`) se conservan
 * siempre. Adicionalmente impone una cota dura `MAX_LINES`, dejando las más
 * recientes.
 *
 * Es idempotente y tolerante: si el archivo no existe, no hace nada.
 *
 * @param {{pipelineRoot?:string, activeWaveKey:number, now?:number}} args
 * @returns {{kept:number, dropped:number}} counts agregados (sin contenido raw, SEC-5)
 */
function pruneStore({ pipelineRoot: pipelineRootArg, activeWaveKey, now } = {}) {
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { kept: 0, dropped: 0 }; }

    const ts = isFiniteNumber(now) ? now : Date.now();
    const cutoff = ts - RETENTION_MS;
    const active = isValidWaveKey(activeWaveKey) ? activeWaveKey : null;

    let kept = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { dropped++; continue; }  // corrupta → fuera
        if (!rec || !isValidWaveKey(rec.waveKey) || !isFiniteNumber(rec.ts) || !isFiniteNumber(rec.avancePct)) {
            dropped++;
            continue;
        }
        // Mantener si es la ola activa O si es reciente (CA-12).
        const keep = (active !== null && rec.waveKey === active) || rec.ts >= cutoff;
        if (keep) kept.push(line);
        else dropped++;
    }

    // Cota dura de líneas: dejar las más recientes.
    if (kept.length > MAX_LINES) {
        dropped += kept.length - MAX_LINES;
        kept = kept.slice(kept.length - MAX_LINES);
    }

    if (dropped === 0) return { kept: kept.length, dropped: 0 };

    try {
        fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
    } catch {
        return { kept: kept.length, dropped: 0 };  // no pudimos reescribir → estado previo intacto
    }
    return { kept: kept.length, dropped };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    appendSnapshot,
    readSnapshots,
    pruneStore,
    classifyProgressDelta,
    appendSnapshotWithDelta,
    // Constantes / helpers expuestos para tests
    RETENTION_MS,
    MAX_LINES,
    PRUNE_EVERY_N,
    LEGACY_FORMULA_VERSION,
    WEIGHT_EPSILON,
    _internal: {
        storePath,
        pipelineDir,
        isValidWaveKey,
        isFiniteNumber,
        _resetCounter: () => { _appendCounter = 0; },
    },
};
