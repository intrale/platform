// =============================================================================
// waiting-operator.js — Lector unificado de los pendientes de firma del operador
// para la bandeja "Esperando tu firma" del dashboard V3.
//
// Issue: #4580 (épico #4570 — gates de firma del operador).
// Diseño: docs/pipeline/gates-firma-operador.md.
//
// QUÉ RESUELVE
// ------------
// La firma del operador vive en TRES orígenes distintos del filesystem:
//   1. `waiting-operator/`  → GATE 0 → veredicto `requires-operator` (definición /
//      `waiting-operator-def`). Un criterio solo-humano retiene la promoción y el
//      pulpo mueve los work-files a `<pipeline>/<fase>/waiting-operator/`.
//   2. `esperando-firma/`   → GATE 2 → firma de aceptación (`waiting-operator-acc`).
//      El pulpo mueve los work-files a `<pipeline>/<fase>/esperando-firma/` antes
//      del merge a `entrega`.
//   3. GATE 3 (`waiting-operator-autonomo/`) → gobernanza de acciones autónomas
//      del kernel. Tercer origen; su productor es hijo #7 del épico. El lector lo
//      soporta aunque el subdir todavía no exista (degradación con gracia).
//
// Este módulo ESPEJA el patrón de `human-block.listBlockedIssues()` (#2478): un
// barrido read-only sobre `<pipeline>/<fase>/<subdir>/<issue>.<skill>`, sin tocar
// estado. Devuelve un array plano de pendientes que el dashboard pinta.
//
// MODELO DE SEGURIDAD (los 5 REQ-SEC del issue son CA no negociables)
// -------------------------------------------------------------------
// [REQ-SEC-4580-3 · A01 Path Traversal] El id de issue se valida como entero
//   (`^\d+$`) ANTES de tocar el filesystem. Un marker con id no numérico se
//   descarta silenciosamente (nunca se usa como path).
// [REQ-SEC-4580-5 · A02 Sensitive Data Exposure] La evidencia (índice de
//   deliverables del issue) pasa por el pipeline de redacción existente
//   (`redact.redactObject`) ANTES de emitirse. Paths/tokens/secrets enmascarados.
//
// El módulo es READ-ONLY: NO muta `.pipeline/**`. La transición de estado la
// ejecuta el kernel (invariante "el adaptador pide, el kernel ejecuta", #4571
// §5.1). El dashboard sólo lista y emite el POST endurecido.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const trace = require('./traceability');
const redact = require('./redact');
const { decomposeConfidence, contarSoloHumanos } = require('./confidence-index');
const { isMarkerArtifact } = require('./marker-artifact');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const PIPELINES = ['desarrollo', 'definicion'];

// REQ-SEC-4580-3 — allowlist estricta del id de issue. Se aplica ANTES de
// construir cualquier path derivado del nombre del marker.
const ISSUE_ID_RE = /^\d+$/;

// Los tres orígenes de firma. `origen` es el identificador estable que consume la
// bandeja; `gate`/`label` son metadata de presentación (dual-encoding en la UI).
const SOURCES = Object.freeze([
    { subdir: 'waiting-operator', origen: 'waiting-operator-def', gate: 'GATE 0' },
    { subdir: 'esperando-firma', origen: 'waiting-operator-acc', gate: 'GATE 2' },
    { subdir: 'waiting-operator-autonomo', origen: 'gate3', gate: 'GATE 3' },
]);

const DELIVERABLES_DIR = path.join(PIPELINE_DIR, 'deliverables');

/**
 * REQ-SEC-4580-3 — ¿`raw` es un id de issue válido (entero positivo)? Acepta el
 * segmento textual previo al primer punto del nombre del marker.
 * @param {string} raw
 * @returns {boolean}
 */
function isValidIssueId(raw) {
    return typeof raw === 'string' && ISSUE_ID_RE.test(raw) && Number(raw) > 0;
}

/**
 * REQ-SEC-4580-5 — Carga el índice de deliverables del issue como EVIDENCIA
 * redactada. Devuelve un array compacto de entradas `{agente, fase, tipo,
 * artefacto, sensible, timestamp}` (nunca el path absoluto crudo). Si el índice
 * no existe o está corrupto ⇒ `[]` (la bandeja muestra "sin evidencia").
 *
 * @param {string} issueId — id ya validado (`^\d+$`).
 * @param {object} [deps] — { fsImpl, deliverablesDir } inyectable para tests.
 * @returns {Array<object>}
 */
function loadEvidence(issueId, deps = {}) {
    const _fs = deps.fsImpl || fs;
    const dir = deps.deliverablesDir || DELIVERABLES_DIR;
    // El id ya está validado como entero: `${issueId}.json` no puede escapar el dir.
    const file = path.join(dir, `${issueId}.json`);
    // Defensa redundante anti-traversal.
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return [];
    let parsed;
    try {
        parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    const compact = entries.map((e) => ({
        agente: e && e.agente != null ? String(e.agente) : '',
        fase: e && e.fase != null ? String(e.fase) : '',
        tipo: e && e.tipo != null ? String(e.tipo) : '',
        // Sólo el basename del artefacto (nunca el path absoluto crudo).
        artefacto: e && e.path != null ? path.basename(String(e.path)) : '',
        motivo: e && e.motivo != null ? String(e.motivo) : '',
        sensible: !!(e && e.sensible),
        timestamp: e && e.timestamp != null ? String(e.timestamp) : '',
    }));
    // REQ-SEC-4580-5 — redacción del pipeline existente sobre TODA la evidencia
    // antes de emitirla (paths/tokens/secrets/emails enmascarados).
    return redact.redactObject(compact);
}

/**
 * Sugerencia inline = índice de confiabilidad (#4576) DESCOMPUESTO. Consume
 * `confidence-index.decomposeConfidence` cuando hay una fuente local de
 * criterios+gateResults adjunta al marker (sidecar `<marker>.criterios.json`) o
 * inyectada por el caller. Sin fuente ⇒ `null` (la bandeja muestra "sin
 * sugerencia disponible"); NUNCA inventa un número.
 *
 * El payload es honesto (CA-1/CA-2 de #4576): array por criterio + contadores,
 * sin un escalar agregado que dispare decisiones.
 *
 * @param {object} args — { markerFile, deps }
 * @returns {object|null} `{ items, solo_humanos, total, verbo }` o null.
 */
function loadSuggestion({ markerFile, deps = {} } = {}) {
    const _fs = deps.fsImpl || fs;
    let source = null;
    // Fuente inyectada (tests / futuros productores) tiene prioridad.
    if (deps.criteriaSource && typeof deps.criteriaSource === 'object') {
        source = deps.criteriaSource;
    } else if (markerFile) {
        const sidecar = `${markerFile}.criterios.json`;
        try {
            source = JSON.parse(_fs.readFileSync(sidecar, 'utf8'));
        } catch {
            source = null;
        }
    }
    if (!source || !Array.isArray(source.criterios) || source.criterios.length === 0) {
        return null;
    }
    let items;
    try {
        items = decomposeConfidence({
            criterios: source.criterios,
            gateResults: source.gateResults || {},
        });
    } catch {
        return null;
    }
    if (!Array.isArray(items) || items.length === 0) return null;
    const soloHumanos = contarSoloHumanos(items);
    // Verbo honesto: si hay criterios solo-humanos ⇒ "revisar" (requiere ojo);
    // si todos son máquina-verificables y ninguno falló ⇒ "aprobar"; si alguno
    // falló ⇒ "rechazar". No es un score: es una etiqueta derivada de evidencia.
    let verbo = 'revisar';
    if (soloHumanos === 0) {
        const algunoFallo = items.some((c) => c && c.confianza === 'baja');
        const todosAlta = items.every((c) => c && c.confianza === 'alta');
        verbo = algunoFallo ? 'rechazar' : (todosAlta ? 'aprobar' : 'revisar');
    }
    return {
        items,
        solo_humanos: soloHumanos,
        total: items.length,
        verbo,
    };
}

/**
 * Barre UN subdir de firma de UNA fase y devuelve sus pendientes. Read-only.
 * Descarta `.gitkeep`, artefactos de marker y markers con id no válido.
 *
 * @param {object} args — { pipeline, phase, source, dir, deps }
 * @returns {Array<object>}
 */
function scanSource({ pipeline, phase, source, dir, deps = {} }) {
    const _fs = deps.fsImpl || fs;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    let entries = [];
    try { entries = _fs.readdirSync(dir); } catch { return []; }

    const out = [];
    for (const f of entries) {
        if (f === '.gitkeep' || isMarkerArtifact(f)) continue;
        const dot = f.indexOf('.');
        if (dot <= 0) continue;
        const issueId = f.slice(0, dot);
        const skill = f.slice(dot + 1);
        // REQ-SEC-4580-3 — validación estricta ANTES de tocar el filesystem.
        if (!isValidIssueId(issueId)) continue;

        const markerFile = path.join(dir, f);
        let waitingSinceMs;
        try { waitingSinceMs = _fs.statSync(markerFile).mtimeMs; } catch { waitingSinceMs = now(); }

        out.push({
            issue: Number(issueId),
            origen: source.origen,
            gate: source.gate,
            phase,
            pipeline,
            skill,
            evidencia: loadEvidence(issueId, deps),
            sugerencia: loadSuggestion({ markerFile, deps }),
            waiting_since: new Date(waitingSinceMs).toISOString(),
            age_hours: Math.round(((now() - waitingSinceMs) / 3600000) * 10) / 10,
        });
    }
    return out;
}

/**
 * CA-1 — Lista TODOS los pendientes de firma del operador, unificando los tres
 * orígenes. Cada ítem: `{ issue, origen, gate, phase, pipeline, skill, evidencia,
 * sugerencia, waiting_since, age_hours }`. Read-only, nunca lanza (un error de FS
 * degrada a lista parcial). Ordena por antigüedad descendente (el que más espera
 * primero), tie-break por issue.
 *
 * @param {object} [deps] — inyectable para tests herméticos:
 *   { pipelineDir, pipelines, fsImpl, now, deliverablesDir, criteriaSource }
 * @returns {Array<object>}
 */
function listWaitingOperator(deps = {}) {
    const _fs = deps.fsImpl || fs;
    const pipelineDir = deps.pipelineDir || PIPELINE_DIR;
    const pipelines = Array.isArray(deps.pipelines) && deps.pipelines.length ? deps.pipelines : PIPELINES;

    const result = [];
    for (const pipeline of pipelines) {
        const pipeRoot = path.join(pipelineDir, pipeline);
        let phases = [];
        try {
            phases = _fs.readdirSync(pipeRoot).filter((f) => {
                try { return _fs.statSync(path.join(pipeRoot, f)).isDirectory(); } catch { return false; }
            });
        } catch { continue; }

        for (const phase of phases) {
            for (const source of SOURCES) {
                const dir = path.join(pipeRoot, phase, source.subdir);
                const found = scanSource({ pipeline, phase, source, dir, deps });
                for (const item of found) result.push(item);
            }
        }
    }

    return result.sort((a, b) => (b.age_hours - a.age_hours) || (a.issue - b.issue));
}

module.exports = {
    listWaitingOperator,
    // Helpers/constantes exportados para tests y callers.
    isValidIssueId,
    loadEvidence,
    loadSuggestion,
    scanSource,
    SOURCES,
    PIPELINES,
    PIPELINE_DIR,
    ISSUE_ID_RE,
};
