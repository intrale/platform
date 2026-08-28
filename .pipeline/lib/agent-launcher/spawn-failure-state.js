// =============================================================================
// agent-launcher/spawn-failure-state.js — Marker persistido de spawn-failures
// del provider (issue #4052, puente CA-1 → CA-3).
//
// PROBLEMA QUE RESUELVE
// ---------------------
// La instrumentación del spawn (CA-1, en agent-launcher.js) detecta la muerte
// temprana del proceso del provider en el mismo tick del spawn. Pero el
// `brazoHuerfanos` del pulpo (CA-3) corre en un TIMER independiente, minutos
// después, y necesita saber que la última muerte de ese (skill, issue) fue un
// spawn-failure del provider para NO penalizar el retry del issue.
//
// Este módulo es el canal de estado entre ambos: la instrumentación **registra**
// un marker cuando clasifica un spawn-failure; el brazoHuerfanos lo **consume**
// (one-shot) para decidir no rebotar.
//
// #6612 — El canal nació cableado a Codex de punta a punta. Hoy la
// instrumentación cubre TODOS los providers LLM, y el consumidor busca por
// (skill, issue) vía `consumeSpawnFailureAnyProvider` porque el barrido de
// huérfanos no sabe con qué eslabón de la cadena de fallback salió el agente.
// El provider a apagar sale del marker, nunca de una constante.
//
// PERSISTENCIA: `.pipeline/state/spawn-failures.json`
//   {
//     "failures": [
//       { "key": "openai-codex::pipeline-dev::4052",
//         "provider": "openai-codex", "skill": "pipeline-dev", "issue": 4052,
//         "signature": "exit_code:127", "launcher_kind": "cmd-shim",
//         "recorded_at": "2026-06-16T...", "ttl_expires_at": "2026-06-16T..." }
//     ]
//   }
//
// GARANTÍAS DE SEGURIDAD / ROBUSTEZ
// ---------------------------------
// - **Fail-open**: cualquier error de IO/parseo → no-op / null. Este marker
//   NUNCA debe romper el lifecycle del agente ni el barrido de huérfanos.
// - **0o600**: el archivo se escribe con permisos restringidos (espejo de
//   provider-disabled.js). NO contiene secrets — solo metadata de control
//   (provider, skill, issue, signature, launcher kind).
// - **Sin contenido del issue ni stderr crudo**: el marker guarda solo la
//   `signature` corta de la clasificación, nunca el prompt ni el stderr.
// - **TTL**: las entradas vencidas se drenan en lectura (default 15 min) para
//   que un marker viejo no afecte una corrida futura del mismo issue.
//
// Sin dependencias externas (Node puro: fs, path).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// TTL default del marker. Generoso respecto del orphan_timeout (~10min) para
// que el brazoHuerfanos alcance a consumirlo, pero acotado para no contaminar
// corridas futuras del mismo issue.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function stateFile(pipelineDir) {
    return path.join(pipelineDir, 'state', 'spawn-failures.json');
}

function makeKey(provider, skill, issue) {
    return `${provider}::${skill}::${issue}`;
}

// -----------------------------------------------------------------------------
// Lectura defensiva. Cualquier error → { failures: [] }. NUNCA lanza.
// -----------------------------------------------------------------------------
function readRaw(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        const file = stateFile(pipelineDir);
        if (!_fs.existsSync(file)) return { failures: [] };
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.failures)) {
            return { failures: [] };
        }
        return { failures: parsed.failures.filter((e) => e && typeof e === 'object' && typeof e.key === 'string') };
    } catch {
        return { failures: [] };
    }
}

// Drena entradas con TTL vencido. Devuelve solo las activas.
function activeEntries(entries, now) {
    return entries.filter((e) => {
        const exp = e.ttl_expires_at ? Date.parse(e.ttl_expires_at) : NaN;
        // Sin ttl válido ⇒ se considera vencida (defensivo: no acumular basura).
        if (!Number.isFinite(exp)) return false;
        return now < exp;
    });
}

// Escritura atómica con 0o600 (espejo de provider-disabled.js). Best-effort:
// errores de IO se silencian (fail-open).
function writeAtomic(pipelineDir, data, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        const file = stateFile(pipelineDir);
        const dir = path.dirname(file);
        _fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        const fd = _fs.openSync(tmp, 'w', 0o600);
        try {
            _fs.writeSync(fd, JSON.stringify(data, null, 2));
            try { _fs.fsyncSync(fd); } catch { /* best-effort */ }
        } finally {
            try { _fs.closeSync(fd); } catch { /* best-effort */ }
        }
        _fs.renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/**
 * recordSpawnFailure — registra (o refresca) un marker de spawn-failure.
 * Idempotente por (provider, skill, issue): re-registrar refresca el TTL.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {string} opts.provider
 * @param {string} opts.skill
 * @param {number|string} opts.issue
 * @param {string} [opts.signature]      firma corta de la clasificación
 * @param {string} [opts.launcherKind]   tier del launcher (native-exe/cmd-shim/...)
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @param {object} [opts.fsImpl]
 * @returns {boolean} true si persistió.
 */
function recordSpawnFailure(opts = {}) {
    const { pipelineDir, provider, skill, issue } = opts;
    if (!pipelineDir || !provider || !skill || issue == null) return false;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    try {
        const { failures } = readRaw(pipelineDir, _fs);
        const active = activeEntries(failures, now);
        const key = makeKey(provider, skill, issue);
        const next = active.filter((e) => e.key !== key);
        next.push({
            key,
            provider: String(provider),
            skill: String(skill),
            issue: Number(issue) || String(issue),
            // signature corta y acotada — sin stderr crudo ni contenido del issue.
            signature: typeof opts.signature === 'string' ? opts.signature.slice(0, 80) : null,
            launcher_kind: typeof opts.launcherKind === 'string' ? opts.launcherKind.slice(0, 40) : null,
            recorded_at: new Date(now).toISOString(),
            ttl_expires_at: new Date(now + ttlMs).toISOString(),
        });
        return writeAtomic(pipelineDir, { failures: next }, _fs);
    } catch {
        return false;
    }
}

/**
 * peekSpawnFailure — devuelve el marker activo (sin removerlo). null si no hay.
 */
function peekSpawnFailure(opts = {}) {
    const { pipelineDir, provider, skill, issue } = opts;
    if (!pipelineDir || !provider || !skill || issue == null) return null;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const { failures } = readRaw(pipelineDir, _fs);
        const active = activeEntries(failures, now);
        const key = makeKey(provider, skill, issue);
        return active.find((e) => e.key === key) || null;
    } catch {
        return null;
    }
}

/**
 * consumeSpawnFailure — devuelve el marker activo y lo REMUEVE (one-shot).
 * Fail-open: cualquier error → null. Aprovecha la lectura para drenar vencidos.
 *
 * @returns {object|null} la entrada consumida, o null si no había.
 */
function consumeSpawnFailure(opts = {}) {
    const { pipelineDir, provider, skill, issue } = opts;
    if (!pipelineDir || !provider || !skill || issue == null) return null;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const { failures } = readRaw(pipelineDir, _fs);
        const active = activeEntries(failures, now);
        const key = makeKey(provider, skill, issue);
        const found = active.find((e) => e.key === key) || null;
        // Reescribimos siempre que haya cambios (consumo del found o drenado de
        // vencidos). Si no hay nada que cambiar, evitamos IO.
        const remaining = active.filter((e) => e.key !== key);
        const changed = found != null || remaining.length !== failures.length;
        if (changed) writeAtomic(pipelineDir, { failures: remaining }, _fs);
        return found;
    } catch {
        return null;
    }
}

/**
 * consumeSpawnFailureAnyProvider — igual que `consumeSpawnFailure` pero SIN
 * exigir el nombre del provider (#6612).
 *
 * POR QUÉ EXISTE
 * --------------
 * El consumidor real (el `brazoHuerfanos` del Pulpo) NO sabe con qué provider
 * se lanzó el agente que murió: la cadena de fallback la resolvió el
 * dispatcher minutos antes, en otro proceso, y esa decisión no viaja al
 * barrido de huérfanos. Cuando el consumo se hacía con un provider hardcodeado
 * (`'openai-codex'`), la muerte al spawnear de CUALQUIER otro provider de la
 * cadena (kimi-moonshot, gemini, cerebras, nvidia) no encontraba su marker y
 * se le cobraba al ISSUE: consumía sus 3 reintentos y terminaba en un rechazo
 * de contenido sintetizado. Este lector cierra ese hueco: busca por
 * (skill, issue) y devuelve el marker con el provider que efectivamente falló,
 * para que el caller apague ESE provider y no otro.
 *
 * Si hay más de un marker activo para el mismo (skill, issue) — puede pasar si
 * la cadena reintentó con dos providers dentro de la misma ventana de TTL —
 * devuelve el MÁS RECIENTE (`recorded_at` mayor) y consume sólo ese: es el que
 * explica la muerte que el barrido está mirando ahora.
 *
 * Fail-open igual que el resto del módulo: cualquier error → null.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {string} opts.skill
 * @param {number|string} opts.issue
 * @returns {object|null} la entrada consumida (incluye `.provider`), o null.
 */
function consumeSpawnFailureAnyProvider(opts = {}) {
    const { pipelineDir, skill, issue } = opts;
    if (!pipelineDir || !skill || issue == null) return null;
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const { failures } = readRaw(pipelineDir, _fs);
        const active = activeEntries(failures, now);
        // El sufijo `::skill::issue` de la key es el mismo que arma makeKey; lo
        // comparamos por campos (no por substring de la key) para que un
        // provider con `::` en el nombre no pueda colisionar.
        const matches = active.filter(
            (e) => String(e.skill) === String(skill) && String(e.issue) === String(issue)
        );
        // Más reciente primero. `recorded_at` inválido ⇒ se ordena al final.
        const ts = (e) => {
            const t = e && e.recorded_at ? Date.parse(e.recorded_at) : NaN;
            return Number.isFinite(t) ? t : -Infinity;
        };
        const found = matches.length
            ? matches.slice().sort((a, b) => ts(b) - ts(a))[0]
            : null;
        const remaining = found ? active.filter((e) => e !== found) : active;
        // Misma disciplina de IO que `consumeSpawnFailure`: escribimos si hubo
        // consumo O si la lectura drenó vencidos. Sin cambios, cero IO — este
        // lector corre en CADA barrido de huérfanos.
        const changed = found != null || remaining.length !== failures.length;
        if (changed) writeAtomic(pipelineDir, { failures: remaining }, _fs);
        return found;
    } catch {
        return null;
    }
}

module.exports = {
    recordSpawnFailure,
    consumeSpawnFailureAnyProvider,
    peekSpawnFailure,
    consumeSpawnFailure,
    stateFile,
    makeKey,
    DEFAULT_TTL_MS,
    // internos para tests
    _readRaw: readRaw,
    _activeEntries: activeEntries,
};
