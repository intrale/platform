'use strict';

// =============================================================================
// wave-coherence-gate.js — Motor del gate de coherencia a nivel ola (#4578).
//
// Épico #4570 · hijo #8 (último de la cadena de gates).
// Diseño: docs/pipeline/gates-firma-operador.md §10.2 / §8.8.
// Contrato: docs/pipeline/contrato-kernel-adaptador.md — puertos `gates` (§3)
//           y `e2e` (§3), estado `waiting-operator` (§5), veredicto
//           `requires-operator` (§3, agregado por #4571).
//
// Problema que resuelve (CA del issue): los gates POR-ISSUE pueden pasar
// individualmente y la ola cerrar incoherente (coherencia dashboard↔consola).
// Este módulo es un GATE AGREGADO que corre al cerrar la ola: evalúa la
// coherencia CROSS-ISSUE de los entregables y emite un veredicto ESTRUCTURADO
// que permite al operador vetar el cierre.
//
// El gate es un SUPERCONJUNTO del GATE 2 por-issue (#4575/#4643): compone sobre
// la aceptación por-issue ya existente, no la reemplaza.
//
// PRINCIPIOS DE SEGURIDAD (del análisis de security/guru/po del issue):
//   [A04] FAIL-CLOSED (NO NEGOCIABLE): ante evidencia ausente/corrupta o
//         cualquier error interno → veredicto `fail`, NUNCA `pass` silencioso.
//         El cierre se DENIEGA. La incoherencia no detectada es el riesgo que
//         motiva el feature.
//   [A08] CONTENIDO = DATO, NO INSTRUCCIÓN: el texto agregado de
//         issues/handoffs/comentarios se sanitiza con `handoff.detectInjection`
//         antes de evaluar. El texto ingerido NUNCA tiene autoridad decisoria
//         (patrón del handoff #2993): la coherencia se computa sobre `claims`
//         ESTRUCTURADOS, no interpretando prosa.
//   [A05] SIN SECRETS EN LA EVIDENCIA: la evidencia agregada se redacta antes
//         de persistir, reutilizando `write-deliverable.redactContent`.
//   [A09] AUDIT APPEND-ONLY: toda decisión de cierre/veto se registra con
//         `fs.appendFileSync` modo `'a'` en un JSONL inmutable (no-repudio).
//   [A01] El veto lo emite SOLO el operador humano vía superficies #4579/#4580.
//         Este módulo NO promueve/archiva olas — el lifecycle es propiedad
//         exclusiva del kernel (Pulpo, invariante §5). El gate sólo EMITE un
//         veredicto; el Pulpo decide qué hacer con él.
//
// LIB DE KERNEL: se construye contra los puertos del contrato, NO pegada al
// dashboard. El dashboard (#4580) y Telegram (#4579) son adaptadores/superficies
// del veto — fuera del scope de ESTE módulo (que es el motor).
//
// ROLLOUT: flag `enabled` default OFF en config.yaml (`wave_coherence_gate`).
// El Pulpo hace cortocircuito con el flag apagado — comportamiento igual a hoy.
// =============================================================================

const fs = require('fs');
const path = require('path');

const handoff = require('./handoff');
const { redactContent } = require('./write-deliverable');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const VERDICT = Object.freeze({
    PASS: 'pass',
    REQUIRES_OPERATOR: 'requires-operator',
    FAIL: 'fail',
});

// Env var de habilitación (patrón visual-gate.js / gate-verdict.js). Default OFF.
const ENABLED_ENV = 'PIPELINE_WAVE_COHERENCE_GATE_ENABLED';

// Cota defensiva: nunca ingerir un texto agregado gigante (anti-OOM / anti-DoS).
const MAX_TEXT_BYTES = 256 * 1024;

// Archivo de audit append-only (no-repudio). Relativo a `<pipelineDir>/audit/`.
const AUDIT_FILE = 'wave-coherence-gate.jsonl';

// -----------------------------------------------------------------------------
// Helpers de path / config
// -----------------------------------------------------------------------------

function resolvePipelineDir(options = {}) {
    if (options && typeof options.pipelineDir === 'string' && options.pipelineDir) {
        return options.pipelineDir;
    }
    // Consistencia con waves.js: honrar PIPELINE_DIR_OVERRIDE (apunta AL dir
    // `.pipeline`) para que evidencia/audit caigan junto al estado de la ola.
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    const root = (options && options.pipelineRoot) || process.cwd();
    return path.join(root, '.pipeline');
}

function auditPath(options = {}) {
    return path.join(resolvePipelineDir(options), 'audit', AUDIT_FILE);
}

/**
 * ¿Está habilitado el gate? Precedencia: `config.kill_switch` corta siempre;
 * si no, `config.enabled === true` o la env var `=1`. Default OFF (fail-closed
 * de rollout: con el flag apagado el gate es INERTE, el Pulpo se comporta como
 * hoy). `env` es inyectable para test.
 *
 * @param {object} [config] — sección `wave_coherence_gate` de config.yaml.
 * @param {object} [env] — default process.env.
 * @returns {boolean}
 */
function isEnabled(config = {}, env = process.env) {
    if (config && config.kill_switch === true) return false;
    if (config && config.enabled === true) return true;
    return String((env && env[ENABLED_ENV]) || '0').trim() === '1';
}

// -----------------------------------------------------------------------------
// Sanitización de texto agregado (A08 — contenido = dato, sin autoridad)
// -----------------------------------------------------------------------------

/**
 * Sanitiza un texto agregado antes de evaluarlo. Trunca patrones de
 * prompt-injection vía `handoff.detectInjection`. El resultado NO se usa como
 * instrucción — la coherencia se computa sobre `claims` estructurados. Esta
 * sanitización es defensa en profundidad + para no persistir prosa hostil en la
 * evidencia.
 *
 * @param {*} text
 * @returns {{ text: string, injectionHits: string[] }}
 */
function sanitizeAggregatedText(text) {
    if (typeof text !== 'string') return { text: '', injectionHits: [] };
    let clipped = text;
    // Cota anti-OOM antes de correr regex de injection.
    if (Buffer.byteLength(clipped, 'utf8') > MAX_TEXT_BYTES) {
        clipped = clipped.slice(0, MAX_TEXT_BYTES);
    }
    const det = handoff.detectInjection(clipped);
    return { text: det.text, injectionHits: det.hits || [] };
}

// -----------------------------------------------------------------------------
// Verificación de evidencia (A04 — fail-closed)
// -----------------------------------------------------------------------------

/**
 * ¿La evidencia de un entregable está PRESENTE y no-corrupta? Fail-closed: ante
 * cualquier ausencia/forma inesperada → NO presente (deriva a `fail`).
 *
 * Forma esperada de `evidence`: objeto con `present:true` y una `ref` no vacía
 * (referencia a un artefacto persistido por el puerto `e2e`, #4573). Un
 * `present:false` explícito, o la ausencia del objeto, cuentan como evidencia
 * ausente.
 *
 * @param {object} evidence
 * @returns {boolean}
 */
function hasValidEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object') return false;
    if (evidence.present !== true) return false;
    if (typeof evidence.ref !== 'string' || evidence.ref.trim().length === 0) return false;
    // `corrupt:true` es una señal explícita de artefacto ilegible/hash mismatch.
    if (evidence.corrupt === true) return false;
    return true;
}

// -----------------------------------------------------------------------------
// Detección de conflictos cross-issue (coherencia estructurada, no "vibes")
// -----------------------------------------------------------------------------

/**
 * Normaliza los `claims` de un entregable. Un claim es una afirmación
 * ESTRUCTURADA y verificable: `{ dimension, key, value }`. La coherencia se
 * computa comparando claims con la MISMA `dimension`+`key` entre issues
 * distintos: si el `value` difiere → conflicto (ej. dashboard dice X, consola
 * expone Y). Un claim mal formado se ignora (no puede generar coherencia falsa).
 *
 * @param {object} deliverable
 * @returns {Array<{dimension:string, key:string, value:string}>}
 */
function normalizeClaims(deliverable) {
    if (!deliverable || !Array.isArray(deliverable.claims)) return [];
    const out = [];
    for (const c of deliverable.claims) {
        if (!c || typeof c !== 'object') continue;
        const dimension = typeof c.dimension === 'string' ? c.dimension.trim() : '';
        const key = typeof c.key === 'string' ? c.key.trim() : '';
        if (!dimension || !key) continue;
        const value = c.value === undefined || c.value === null ? '' : String(c.value).trim();
        out.push({ dimension, key, value });
    }
    return out;
}

/**
 * Detecta conflictos cross-issue sobre los claims agregados. Agrupa por
 * `dimension::key`; si dos ISSUES distintos afirman valores distintos para la
 * misma dimensión+clave → conflicto estructurado.
 *
 * @param {Array<{issue:number, claims:Array}>} normalized
 * @returns {Array<{issues:number[], dimension:string, detail:string}>}
 */
function detectConflicts(normalized) {
    const groups = new Map(); // dimension::key → Map(value → Set(issue))
    for (const entry of normalized) {
        for (const claim of entry.claims) {
            const gk = `${claim.dimension}::${claim.key}`;
            if (!groups.has(gk)) groups.set(gk, new Map());
            const byValue = groups.get(gk);
            if (!byValue.has(claim.value)) byValue.set(claim.value, new Set());
            byValue.get(claim.value).add(entry.issue);
        }
    }

    const conflicts = [];
    for (const [gk, byValue] of groups.entries()) {
        if (byValue.size < 2) continue; // un único valor → coherente.
        const [dimension, key] = gk.split('::');
        const issuesInvolved = new Set();
        const parts = [];
        // Orden determinístico para reproducibilidad del reporte/tests.
        const values = [...byValue.keys()].sort();
        for (const value of values) {
            const issues = [...byValue.get(value)].sort((a, b) => a - b);
            issues.forEach((i) => issuesInvolved.add(i));
            parts.push(`${issues.map((i) => `#${i}`).join(',')} → "${value || '(vacío)'}"`);
        }
        conflicts.push({
            issues: [...issuesInvolved].sort((a, b) => a - b),
            dimension,
            detail: `Dimensión "${dimension}" (clave "${key}") incoherente: ${parts.join(' | ')}`,
        });
    }
    // Orden estable por dimensión para veredicto reproducible.
    conflicts.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.detail.localeCompare(b.detail));
    return conflicts;
}

// -----------------------------------------------------------------------------
// Persistencia de evidencia agregada (A05 — redactada, sin secrets)
// -----------------------------------------------------------------------------

/**
 * Construye el markdown legible de la evidencia agregada (guideline UX #1/#5:
 * veredicto arriba, conflictos escaneables). El texto agregado de los issues
 * ya viene sanitizado por `sanitizeAggregatedText`.
 */
function buildEvidenceMarkdown({ wave, verdict, reason, conflicts, deliverables, excerpts = [] }) {
    const lines = [];
    lines.push(`# Evidencia de coherencia — Ola ${wave.number}${wave.name ? ` · ${wave.name}` : ''}`);
    lines.push('');
    lines.push(`- **Veredicto:** \`${verdict}\``);
    lines.push(`- **Motivo:** ${reason}`);
    lines.push(`- **Issues evaluados:** ${deliverables.map((d) => `#${d.issue}`).join(', ') || '(ninguno)'}`);
    lines.push('');
    if (conflicts.length > 0) {
        lines.push('## Conflictos detectados');
        lines.push('');
        for (const c of conflicts) {
            lines.push(`- **${c.dimension}** — issues ${c.issues.map((i) => `#${i}`).join(', ')}`);
            lines.push(`  - ${c.detail}`);
        }
    } else {
        lines.push('## Conflictos detectados');
        lines.push('');
        lines.push('_Ninguno — entregables agregados coherentes._');
    }
    // Extractos por-issue (texto YA sanitizado por sanitizeAggregatedText; la
    // redacción de secrets la aplica el choke point de persistencia). Cota de
    // longitud por extracto para mantener el reporte escaneable (guideline UX).
    if (Array.isArray(excerpts) && excerpts.length > 0) {
        lines.push('');
        lines.push('## Extractos agregados (dato, no instrucción)');
        lines.push('');
        for (const ex of excerpts) {
            const text = typeof ex.text === 'string' ? ex.text.slice(0, 500) : '';
            lines.push(`- **#${ex.issue}:** ${text || '_(sin texto)_'}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Persiste la evidencia agregada REDACTADA en `<pipelineDir>/wave-evidence/`.
 * Reutiliza `write-deliverable.redactContent` como CHOKE POINT de redacción
 * (mismo camino que `writeDeliverable`, A05) — NUNCA se escribe prosa cruda con
 * potenciales secrets. Escritura atómica (tmp+rename). Best-effort en el sentido
 * de que un fallo de FS deriva a fail-closed en el caller (no silencioso).
 *
 * @returns {string} referencia relativa a `.pipeline/` del artefacto persistido.
 */
function persistEvidence(md, wave, options = {}) {
    // Inyección para test: si el caller provee su propio persistor, se usa.
    if (options && typeof options.persistEvidenceFn === 'function') {
        return options.persistEvidenceFn(redactContent(md), wave);
    }
    const dir = path.join(resolvePipelineDir(options), 'wave-evidence');
    fs.mkdirSync(dir, { recursive: true });
    const safe = redactContent(md);
    const stamp = (options.now instanceof Date ? options.now : new Date()).toISOString().replace(/[:.]/g, '-');
    const filename = `wave-${wave.number}-coherence-${stamp}.md`;
    const abs = path.join(dir, filename);
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, safe, 'utf8');
    fs.renameSync(tmp, abs);
    return path.join('wave-evidence', filename);
}

// -----------------------------------------------------------------------------
// Audit append-only (A09 — no-repudio)
// -----------------------------------------------------------------------------

/**
 * Registra la decisión de cierre/veto en un JSONL inmutable (`appendFileSync`
 * modo `'a'`). Best-effort: NUNCA bloquea el veredicto por un fallo de audit,
 * pero el fallo se propaga como flag para observabilidad.
 *
 * @returns {boolean} true si el registro se escribió.
 */
function appendAudit(record, options = {}) {
    if (options && typeof options.appendAuditFn === 'function') {
        try { options.appendAuditFn(record); return true; } catch { return false; }
    }
    const file = auditPath(options);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const ts = (options.now instanceof Date ? options.now : new Date()).toISOString();
        const line = JSON.stringify({ ts, ...record }) + '\n';
        // Append-only inmutable (A09): flag 'a' explícito (no truncar jamás).
        fs.appendFileSync(file, line, { encoding: 'utf8', flag: 'a' });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// Motor del gate
// -----------------------------------------------------------------------------

/**
 * Evalúa la coherencia agregada de una ola y emite un veredicto ESTRUCTURADO.
 *
 * Mapeo de veredictos:
 *   - evidencia ausente/corrupta, entrada inválida o error interno → `fail`
 *     (A04, cierre denegado).
 *   - conflictos cross-issue detectados → `requires-operator` (la ola queda
 *     retenida en `waiting-operator`; el operador decide vetar/cerrar).
 *   - todo coherente + evidencia presente → `pass`.
 *
 * SIEMPRE persiste evidencia redactada (salvo error catastrófico previo) y
 * SIEMPRE registra la decisión en el audit append-only.
 *
 * @param {object} args
 * @param {object} args.wave — { number, name?, issues? }.
 * @param {Array<object>} args.deliverables — entregables agregados por-issue:
 *        `{ issue, evidence:{present, ref, corrupt?}, text?, claims?:[{dimension,key,value}] }`.
 * @param {object} [args.config] — sección `wave_coherence_gate` de config.yaml.
 * @param {object} [args.options] — inyección de deps/paths para test:
 *        `{ pipelineDir, pipelineRoot, now, actor, persistEvidenceFn, appendAuditFn, env }`.
 * @returns {{verdict:string, reason:string, conflicts:Array, evidenceRef:(string|null)}}
 */
function evaluateWaveCoherence({ wave, deliverables, config = {}, options = {} } = {}) {
    const actor = (options && options.actor) || 'kernel';
    let verdict = VERDICT.FAIL;
    let reason = 'fail-closed: gate no evaluado';
    let conflicts = [];
    let evidenceRef = null;

    try {
        // Guard de entrada (A04): wave/deliverables mal formados → fail-closed.
        if (!wave || typeof wave !== 'object' || !Number.isInteger(wave.number)) {
            reason = 'fail-closed: `wave` inválida (se requiere { number:int, ... })';
            appendAudit({ decision: verdict, wave: null, actor, reason }, options);
            return { verdict, reason, conflicts, evidenceRef };
        }
        if (!Array.isArray(deliverables) || deliverables.length === 0) {
            reason = 'fail-closed: sin entregables agregados para evaluar';
            appendAudit({ decision: verdict, wave: wave.number, actor, reason }, options);
            return { verdict, reason, conflicts, evidenceRef };
        }

        // Normalización + verificación de evidencia (A04) y sanitización (A08).
        const normalized = [];
        const missingEvidence = [];
        let totalInjectionHits = 0;
        for (const d of deliverables) {
            if (!d || typeof d !== 'object' || !Number.isInteger(d.issue)) {
                missingEvidence.push('(entregable sin issue válido)');
                continue;
            }
            if (!hasValidEvidence(d.evidence)) {
                missingEvidence.push(`#${d.issue}`);
            }
            // Sanitizar prosa agregada — se usa SÓLO para la evidencia legible,
            // NUNCA como instrucción (A08).
            const san = sanitizeAggregatedText(d.text);
            totalInjectionHits += san.injectionHits.length;
            normalized.push({ issue: d.issue, claims: normalizeClaims(d), text: san.text });
        }

        // A04 — evidencia ausente/corrupta en cualquier issue → fail-closed.
        if (missingEvidence.length > 0) {
            verdict = VERDICT.FAIL;
            reason = `fail-closed: evidencia ausente/corrupta para ${missingEvidence.join(', ')}`;
            // Persistimos evidencia igual (deja rastro del intento) + audit.
            const md = buildEvidenceMarkdown({ wave, verdict, reason, conflicts, deliverables, excerpts: normalized });
            evidenceRef = safePersist(md, wave, options);
            appendAudit({
                decision: verdict, wave: wave.number, actor, reason,
                evidence_ref: evidenceRef, injection_hits: totalInjectionHits,
            }, options);
            return { verdict, reason, conflicts, evidenceRef };
        }

        // Detección de coherencia estructurada.
        conflicts = detectConflicts(normalized);

        if (conflicts.length > 0) {
            verdict = VERDICT.REQUIRES_OPERATOR;
            reason = `Incoherencia agregada: ${conflicts.length} conflicto(s) cross-issue. `
                + 'La ola queda retenida en `waiting-operator` a la espera de la decisión del operador.';
        } else {
            verdict = VERDICT.PASS;
            reason = 'Entregables agregados coherentes; evidencia representativa presente.';
        }

        const md = buildEvidenceMarkdown({ wave, verdict, reason, conflicts, deliverables, excerpts: normalized });
        evidenceRef = safePersist(md, wave, options);

        // A04 — si la persistencia de evidencia falló, denegamos (fail-closed):
        // no podemos ofrecer al operador una evidencia auditable.
        if (evidenceRef === null) {
            verdict = VERDICT.FAIL;
            reason = 'fail-closed: no se pudo persistir la evidencia agregada (A04/A05).';
            conflicts = [];
        }

        appendAudit({
            decision: verdict, wave: wave.number, actor, reason,
            evidence_ref: evidenceRef, conflicts_count: conflicts.length,
            injection_hits: totalInjectionHits,
        }, options);

        return { verdict, reason, conflicts, evidenceRef };
    } catch (err) {
        // A04 — cualquier excepción interna → fail-closed, con audit best-effort.
        verdict = VERDICT.FAIL;
        reason = `fail-closed: error interno del gate (${err && err.message ? err.message : 'desconocido'})`;
        conflicts = [];
        appendAudit({
            decision: verdict, wave: wave && wave.number, actor, reason,
        }, options);
        return { verdict, reason, conflicts, evidenceRef: null };
    }
}

/**
 * Persiste evidencia sin propagar excepciones (retorna null ante fallo de FS).
 * El caller convierte `null` en fail-closed.
 */
function safePersist(md, wave, options) {
    try {
        return persistEvidence(md, wave, options);
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Colector de entregables agregados (puerto `e2e` — evidencia representativa)
// -----------------------------------------------------------------------------

/**
 * Reúne los entregables agregados de los issues de una ola a partir del índice
 * de entregables por-issue (`.pipeline/deliverables/<issue>.json`, poblado por
 * el puerto `e2e`/#4573). La presencia de al menos una entry cuenta como
 * EVIDENCIA REPRESENTATIVA (CA-1); su ausencia deriva a fail-closed en el gate.
 *
 * NO ingiere prosa como instrucción: sólo marca presencia + referencia. Los
 * `claims` estructurados (fuente de la coherencia cross-issue) los alimentan las
 * superficies #4573/#4580 y se pasan aparte; por defecto van vacíos.
 *
 * @param {Array<{number:number}>} issues — issues de la ola activa.
 * @param {object} [options] — { pipelineRoot, pipelineDir, deliverableIndex }.
 * @returns {Array<object>} deliverables en el shape que consume el gate.
 */
function collectWaveDeliverables(issues, options = {}) {
    const list = Array.isArray(issues) ? issues : [];
    // Inyección para test; por defecto usa el índice real.
    const idx = (options && options.deliverableIndex) || require('./deliverable-index');
    const readOpts = {};
    if (options && options.pipelineRoot) readOpts.pipelineRoot = options.pipelineRoot;
    if (options && options.pipelineDir) readOpts.pipelineDir = options.pipelineDir;

    return list
        .map((iss) => (iss && Number.isInteger(iss.number) ? iss.number : null))
        .filter((n) => n !== null)
        .map((issue) => {
            let entries = [];
            try {
                const res = idx.readDeliverableIndex(issue, readOpts);
                entries = (res && Array.isArray(res.entries)) ? res.entries : [];
            } catch {
                entries = [];
            }
            const present = entries.length > 0;
            return {
                issue,
                evidence: present
                    ? { present: true, ref: `deliverables/${issue}.json` }
                    : { present: false },
                // Extracto seguro: sólo metadatos de fase/agente, nunca prosa cruda.
                text: entries.map((e) => `${e.agente || '?'}/${e.fase || '?'}`).join(', '),
                claims: [],
            };
        });
}

module.exports = {
    // API pública
    evaluateWaveCoherence,
    isEnabled,
    // Helpers testeables aislados
    sanitizeAggregatedText,
    hasValidEvidence,
    normalizeClaims,
    detectConflicts,
    buildEvidenceMarkdown,
    persistEvidence,
    appendAudit,
    auditPath,
    collectWaveDeliverables,
    // Constantes
    VERDICT,
    ENABLED_ENV,
    AUDIT_FILE,
    MAX_TEXT_BYTES,
};
