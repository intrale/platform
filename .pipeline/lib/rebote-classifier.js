// =============================================================================
// rebote-classifier.js — Clasificación unificada de rebotes (issue #3167)
//
// CONTEXTO
// --------
// Antes de esta capa, el Pulpo decidía qué hacer con un rebote usando una
// cascada de heurísticas dispersas:
//
//   1. precheck.classifyError(motivo) → 'infra' | 'codigo'
//   2. humanBlock.isHumanBlockReason(motivo) → true | false  (binario)
//   3. routing-classifier (motivo, faseDestino) → routing mismatch sí/no
//
// La capa de bloqueo humano (paso 2) era el "catch-all" cuando un agente
// detectaba que el issue dependía de otro issue OPEN o de un asset todavía
// no mergeado a `main`. No había forma de comunicar al Pulpo "esperá una
// dependencia"; el issue terminaba en `bloqueado-humano/` esperando que
// un operador lo destrabe manualmente (incidente #3086).
//
// Esta capa introduce una clasificación de 5 categorías declarativa y
// extensible, ordenada por especificidad (más específica gana):
//
//   1. cross_phase       — out-of-scope, rebote a otra fase
//   2. dependency_block  — espera merge/cierre de otro issue o asset
//   3. human_block       — requiere intervención humana (merge manual, etc)
//   4. infra             — red/timeout (no cuenta para circuit breaker)
//   5. code              — fallback técnico (cuenta para circuit breaker)
//
// CONTRATO CON EL BRAZO DE DESBLOQUEO
// -----------------------------------
// Cuando se detecta `dependency_block`, NO se crea marker en
// `bloqueado-humano/`. En su lugar:
//
//   a) Se aplica label GitHub `blocked:dependencies` (excluye al issue
//      del intake en pulpo.js:3764-3767 y del recuento de cola en 1883,
//      2085).
//   b) Se postea un comentario con el marker exacto
//      `## Dependencias detectadas por el pipeline` seguido de bullets
//      `- #N` (formato parseable por `dep-comment-parser.js`).
//   c) El brazo de desbloqueo (pulpo.js:7838+, intervalo configurable
//      `desbloqueo.interval_min`) escanea cada N min los issues con ese
//      label, parsea las deps, y cuando todas están CLOSED quita el
//      label automáticamente + notifica Telegram.
//
// Resultado: cero tokens consumidos mientras espera + cero intervención
// humana cuando las deps cierren.
//
// SEGURIDAD
// ---------
// Todos los patrones son regex con quantifiers acotados, sin backtracking
// exponencial. Parsing line-based donde es posible. Complejidad lineal
// O(n) sobre el motivo (bounded a 5000 chars en `truncateForClassify`).
//
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const trace = require('./traceability');
const humanBlock = require('./human-block');
const { isMarkerArtifact } = require('./marker-artifact');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const GH_QUEUE_DIR = path.join(PIPELINE_DIR, 'servicios', 'github', 'pendiente');
const DEPS_LABEL = 'blocked:dependencies';
const MAX_MOTIVO_LEN = 5000;
const MAX_DEPS_PER_BLOCK = 20;

// #3229 — Segregación filesystem entre los dos estados conceptualmente distintos:
//   - bloqueado-humano/         → needs-human, solo libera con /unblock manual
//   - bloqueado-dependencias/   → blocked:dependencies, libera automático al
//                                  cerrar todas las deps (brazoDesbloqueo).
//
// Antes de #3229, `bloqueado-humano/` recibía AMBOS estados: el barrido del
// pulpo invocaba reportHumanBlock cuando el motivo no incluía la cadena
// literal `rebote_categoria: dependency_block` en el texto, aunque el agente
// emitiese el campo como YAML estructurado. Resultado: dashboards confusos,
// labels equivocados, tokens desperdiciados en issues que podían destrabarse
// solos.
const DEPS_BLOCK_SUBDIR = 'bloqueado-dependencias';

// -----------------------------------------------------------------------------
// PATRONES DEPENDENCY_BLOCK
//
// Cada patrón captura el issue number del que se depende. Los patrones son
// case-insensitive, sin alternaciones anidadas, sin lookbehind variable.
// El número se captura en el grupo 1 — el caller hace dedup numérico.
// -----------------------------------------------------------------------------
const DEPENDENCY_PATTERNS = [
    // "depende de #N" / "depende del issue #N"
    /\bdepende(?:n)?\s+(?:de|del)\s+(?:la\s+|el\s+)?(?:issue\s+|PR\s+)?#(\d+)\b/i,
    // "bloqueado por #N" / "bloqueada por #N"
    /\bbloqu(?:ead|ad)[oa]s?\s+por\s+(?:la\s+|el\s+)?(?:issue\s+|PR\s+)?#(\d+)\b/i,
    // "espera/esperando merge de #N"
    /\bespera(?:ndo)?\s+(?:el\s+)?(?:merge|cierre)\s+(?:de|del)\s+#(\d+)\b/i,
    // "pendiente de merge #N" / "pendiente del merge de #N"
    /\bpendiente\s+(?:de\s+|del\s+)?(?:merge|cierre)(?:\s+de)?\s+#(\d+)\b/i,
    // "#N está open/abierta/sin mergear/todavía abierta" — admite paréntesis
    // intermedios cortos (ej: "#3083 (S5 audit trail) está OPEN") con bound
    // estricto para evitar matches cross-párrafo y backtracking exponencial.
    /#(\d+)(?:\s+\([^)\n]{0,80}\))?\s+(?:est[aá]\s+|todav[ií]a\s+|sigue\s+|continua\s+)?(?:open|abierta|abierto|sin\s+mergear|sin\s+cerrar|sin\s+merge|no\s+mergead[oa])\b/i,
    // "issue #N (no) está cerrado" / "issue #N OPEN"
    /\bissue\s+#(\d+)\s+(?:est[aá]\s+|no\s+est[aá]\s+|todav[ií]a\s+)?(?:open|abierta|abierto|pendiente|sin\s+cerrar)\b/i,
    // "S5/H6/Mx/Ux #N abierta/open"
    /\b[A-Z]\d{1,2}\s+\(?#?(\d+)\)?\s+.{0,30}\b(?:open|abierta|sin\s+mergear)\b/i,
    // "dependencia #N" / "dep #N"
    /\bdependenc(?:ia|y)\s+#(\d+)\b/i,
    /\bdep\s+#(\d+)\s+(?:open|abierta|pendiente)/i,
    // "PR #N (mergeable|pendiente|esperando|no mergeado)"  — pre-empt a humanBlock
    // si claramente es espera-de-merge automático y no merge-manual
    /\bPR\s+#(\d+)\s+(?:pendiente\s+de\s+merge|todav[ií]a\s+sin\s+mergear|esperando\s+autom?[áa]tico)\b/i,
];

// Patrones de assets/recursos que están "pendientes" sin un #N explícito.
// Estos no producen dependsOn numéricas (no hay issue concreto), pero igual
// son dependency_block — el agente debe especificar manualmente o se rutea
// a la fase que falta (UX típicamente).
const DEPENDENCY_ASSET_PATTERNS = [
    /\basset(?:s)?\s+(?:UX|de\s+UX)\s+(?:no\s+est[aá]n?\s+en\s+main|falta(?:n)?|pendiente(?:s)?)\b/i,
    /\brecurs(?:o|os)\s+(?:UX|de\s+UX|de\s+dise[ñn]o)\s+(?:no\s+est[aá]n?\s+en\s+main|falta(?:n)?|pendiente(?:s)?)\b/i,
    /\bdise[ñn]o\s+(?:UX|de\s+UX)\s+todav[ií]a\s+no\s+entregad[oa]\b/i,
    /\bmockup(?:s)?\s+(?:UX|de\s+UX)\s+(?:falta|pendiente|no\s+est[aá]n?\s+en\s+main)\b/i,
];

// Hint estructural: el motivo ya viene preformateado por un agente que
// usa la convención del classifier (campos explícitos en YAML/JSON).
// Ejemplo de motivo del agente:
//
//   "rebote_categoria: dependency_block; depende_de: [3083, 3084]; ..."
const STRUCTURED_DEPENDENCY_HINT = /\brebote_categoria\s*[:=]\s*['"]?dependency_block\b/i;
const STRUCTURED_DEPS_LIST = /\b(?:depende_de|depends_on|dependencias)\s*[:=]\s*\[?\s*([\d,\s#]+)\]?/i;

// -----------------------------------------------------------------------------
// API PÚBLICA
// -----------------------------------------------------------------------------

/**
 * Clasifica un motivo de rebote en una de las 5 categorías canónicas.
 *
 * @param {object} opts
 * @param {string} opts.motivo               — texto crudo del rebote
 * @param {number[]} [opts.dependsOn=[]]     — hint estructural de dependencias
 *                                              (si el agente ya las parseó)
 * @param {string} [opts.rebote_categoria]   — #3229: si el agente ya clasificó
 *                                              explícitamente como
 *                                              'dependency_block' o 'human_block'
 *                                              vía campo YAML top-level, este
 *                                              hint gana sobre regex sobre el
 *                                              motivo. Sin esta vía el puente
 *                                              guru → barrido quedaba roto
 *                                              cuando la cadena literal no
 *                                              aparecía en `motivo`.
 * @param {string} [opts.faseDestino]        — fase destino para cross_phase
 * @param {string} [opts.classifyErrorResult] — resultado de precheck.classifyError
 *                                              ('infra' | 'codigo'). Si no se
 *                                              pasa, este módulo no infiere
 *                                              infra (lo deja al caller).
 * @param {boolean} [opts.isRoutingMismatch=false] — flag externo del routing-classifier
 *
 * @returns {{
 *   category: 'cross_phase'|'dependency_block'|'human_block'|'infra'|'code',
 *   label: string|null,
 *   dependsOn: number[],
 *   counts_against_circuit_breaker: boolean,
 *   autounlock: object|null,
 *   reason_summary: string,
 * }}
 */
function classifyRebote(opts = {}) {
    const rawMotivo = String(opts.motivo || '');
    const motivo = truncateForClassify(rawMotivo);
    const hintDeps = sanitizeDepsList(opts.dependsOn);

    // 1. cross_phase — hint externo del routing-classifier
    if (opts.isRoutingMismatch === true && opts.faseDestino) {
        return {
            category: 'cross_phase',
            label: null,
            dependsOn: [],
            counts_against_circuit_breaker: false,
            autounlock: null,
            reason_summary: 'Rebote routing mismatch → fase destino: ' + String(opts.faseDestino),
        };
    }

    // 2. dependency_block — primer matcher específico
    //
    // Precedencia interna:
    //   (a) Hint YAML estructurado `rebote_categoria: dependency_block`  [#3229]
    //   (b) Hint estructural en motivo `rebote_categoria: dependency_block`
    //   (c) Regex sobre el texto del motivo
    //
    // (a) es el camino limpio para agentes que emiten YAML típado; (b) y (c)
    // siguen vigentes como compat para motivos en texto plano.
    const explicitCategory = typeof opts.rebote_categoria === 'string'
        ? opts.rebote_categoria.trim().toLowerCase()
        : null;

    // 1.5 infra_no_apk — Issue #4046
    //
    // Issues de dashboard/pipeline (sin flavor real de app) que cayeron en el
    // path de "APK faltante" NO deben contar contra el circuit breaker ni
    // disparar la alerta de atascamiento. El bypass primario vive en
    // `preflightQaChecks` (corta antes de retornar `apk_missing`), pero si el
    // motivo `infra-no-apk` llega al barrido general por otra vía, lo
    // clasificamos explícitamente como infra que no penaliza.
    if (explicitCategory === 'infra_no_apk' || /infra[-_]no[-_]apk/i.test(motivo)) {
        return {
            category: 'infra',
            label: null,
            dependsOn: [],
            counts_against_circuit_breaker: false,
            autounlock: null,
            reason_summary: 'Issue de dashboard/pipeline sin APK — no genera artefacto, no penaliza circuit breaker',
        };
    }

    if (explicitCategory === 'dependency_block') {
        // Confiamos en el agente — usamos el dependsOn que pasó (sanitizado)
        // y NO corremos los regex (evitamos falsos negativos por motivos
        // demasiado cortos o sin patrón estándar).
        return {
            category: 'dependency_block',
            label: DEPS_LABEL,
            dependsOn: hintDeps,
            counts_against_circuit_breaker: false,
            autounlock: {
                source: 'github-label',
                mechanism: 'brazo-desbloqueo',
                label: DEPS_LABEL,
                note: 'El Pulpo destraba automáticamente cuando todas las dependencias estén CLOSED en GitHub.',
            },
            reason_summary: hintDeps.length > 0
                ? 'Depende de issue(s) abierto(s): ' + hintDeps.map(n => '#' + n).join(', ')
                : 'Espera asset/recurso no en main (agente declaró dependency_block sin issue numbers)',
        };
    }

    const depDetect = detectDependencyBlock(motivo, hintDeps);
    if (depDetect.matched) {
        return {
            category: 'dependency_block',
            label: DEPS_LABEL,
            dependsOn: depDetect.dependsOn,
            counts_against_circuit_breaker: false,
            autounlock: {
                source: 'github-label',
                mechanism: 'brazo-desbloqueo',
                label: DEPS_LABEL,
                note: 'El Pulpo destraba automáticamente cuando todas las dependencias estén CLOSED en GitHub.',
            },
            reason_summary: depDetect.assetOnly
                ? 'Espera asset/recurso no en main'
                : 'Depende de issue(s) abierto(s): ' + depDetect.dependsOn.map(n => '#' + n).join(', '),
        };
    }

    // 2.5 — #3229: si el agente declaró `rebote_categoria: human_block` como
    // hint YAML explícito, lo respetamos sin pasar por el regex de
    // isHumanBlockReason. Cubre casos donde el motivo no incluye un patrón
    // canónico pero el agente sabe que necesita humano (PO ambiguo, etc).
    if (explicitCategory === 'human_block') {
        return {
            category: 'human_block',
            label: humanBlock.NEEDS_HUMAN_LABEL,
            dependsOn: [],
            counts_against_circuit_breaker: false,
            autounlock: null,
            reason_summary: 'Bloqueo humano (agente declaró human_block explícitamente)',
        };
    }

    // 3. human_block — heurística existente (intacta)
    if (humanBlock.isHumanBlockReason(motivo)) {
        return {
            category: 'human_block',
            label: humanBlock.NEEDS_HUMAN_LABEL,
            dependsOn: [],
            counts_against_circuit_breaker: false,
            autounlock: null,
            reason_summary: 'Bloqueo humano (merge manual / CODEOWNERS / decisión)',
        };
    }

    // 4. infra — si el caller pre-clasificó como infra
    if (opts.classifyErrorResult === 'infra') {
        return {
            category: 'infra',
            label: null,
            dependsOn: [],
            counts_against_circuit_breaker: false,
            autounlock: null,
            reason_summary: 'Error de infra (red/timeout) — reintenta solo',
        };
    }

    // 5. code — fallback
    return {
        category: 'code',
        label: null,
        dependsOn: [],
        counts_against_circuit_breaker: true,
        autounlock: null,
        reason_summary: 'Rechazo técnico — rebota a fase de rechazo',
    };
}

/**
 * Detecta si un motivo describe una dependency_block. Combina hint
 * estructural (rebote_categoria/depende_de) + pattern matching.
 *
 * @returns {{ matched: boolean, dependsOn: number[], assetOnly: boolean }}
 */
function detectDependencyBlock(motivo, hintDeps = []) {
    if (typeof motivo !== 'string' || !motivo.trim()) {
        return { matched: false, dependsOn: [], assetOnly: false };
    }

    // 2a. Hint estructural (agente ya clasificó explícitamente)
    if (STRUCTURED_DEPENDENCY_HINT.test(motivo)) {
        const deps = new Set(hintDeps);
        const m = STRUCTURED_DEPS_LIST.exec(motivo);
        if (m && m[1]) {
            for (const raw of m[1].split(/[\s,]+/)) {
                const n = Number(raw.replace(/^#/, ''));
                if (Number.isFinite(n) && n > 0) deps.add(n);
            }
        }
        const sorted = Array.from(deps).sort((a, b) => a - b).slice(0, MAX_DEPS_PER_BLOCK);
        // Si solo hubo hint pero no logramos extraer números, igual lo
        // marcamos como matched: el agente sabe lo que hace.
        return { matched: true, dependsOn: sorted, assetOnly: sorted.length === 0 };
    }

    // 2b. Patrones de texto (issue numbers)
    const found = new Set(hintDeps);
    for (const pat of DEPENDENCY_PATTERNS) {
        // Aplicar global manualmente porque algunos patterns no llevan /g
        const globalPat = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
        let m;
        let safetyBudget = 100; // anti-runaway si una regex captura todo
        while ((m = globalPat.exec(motivo)) !== null && safetyBudget-- > 0) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > 0) found.add(n);
            if (m.index === globalPat.lastIndex) globalPat.lastIndex++;
        }
    }

    if (found.size > 0) {
        const sorted = Array.from(found).sort((a, b) => a - b).slice(0, MAX_DEPS_PER_BLOCK);
        return { matched: true, dependsOn: sorted, assetOnly: false };
    }

    // 2c. Patrones de assets/recursos (sin issue number explícito)
    for (const pat of DEPENDENCY_ASSET_PATTERNS) {
        if (pat.test(motivo)) {
            return { matched: true, dependsOn: [], assetOnly: true };
        }
    }

    return { matched: false, dependsOn: [], assetOnly: false };
}

/**
 * Construye el body del comentario GitHub que el brazo de desbloqueo parsea.
 * Formato compatible con `dep-comment-parser.js` (planner style — heading
 * limpio + bullets `- #N`).
 *
 * @param {object} opts
 * @param {number[]} opts.dependsOn  — issue numbers (sin #, ya sanitizados)
 * @param {string}   [opts.reason]   — texto explicativo del agente
 * @param {string}   [opts.skill]    — agente que detectó la dependencia
 */
function buildDependencyComment(opts) {
    const deps = sanitizeDepsList(opts.dependsOn);
    const lines = [
        '## Dependencias detectadas por el pipeline',
        '',
    ];
    if (deps.length === 0) {
        lines.push('_(El agente detectó dependencia de un asset/recurso sin issue number concreto.)_');
        lines.push('');
        lines.push('Este issue queda bloqueado hasta que un operador resuelva la dependencia o agregue el `#N` correspondiente.');
    } else {
        for (const n of deps) lines.push('- #' + n);
        lines.push('');
        lines.push('Este issue queda bloqueado hasta que se resuelvan las dependencias listadas. El brazo de desbloqueo del Pulpo quita el label automáticamente cuando todas estén CLOSED.');
    }

    if (opts.reason) {
        lines.push('');
        lines.push('### Motivo detectado');
        lines.push('```');
        lines.push(String(opts.reason).slice(0, 1500));
        lines.push('```');
    }
    if (opts.skill) {
        lines.push('');
        lines.push('_Detectado por agente `' + String(opts.skill) + '` (categoría `dependency_block`)._');
    }

    return lines.join('\n');
}

/**
 * Encola los artefactos GitHub necesarios para que el brazo de desbloqueo
 * tome al issue:
 *   1. Aplicar label `blocked:dependencies`
 *   2. Postear comment con marker parseable
 *
 * Side effects: escribe archivos JSON en `.pipeline/servicios/github/pendiente/`.
 * No invoca gh directamente — el `servicio-github.js` los procesa.
 *
 * @param {object} opts
 * @param {number} opts.issue        — número del issue (obligatorio)
 * @param {number[]} opts.dependsOn  — lista de issue numbers de las que depende
 * @param {string} [opts.reason]     — motivo detallado del agente
 * @param {string} [opts.skill]      — agente que detectó la dependencia
 * @param {string} [opts.phase]      — fase del agente
 *
 * @returns {{ ok: boolean, issue: number, label_queued: boolean, comment_queued: boolean, error?: string }}
 */
function reportDependencyBlock(opts) {
    const issue = Number(opts.issue);
    if (!Number.isFinite(issue) || issue <= 0) {
        return { ok: false, issue: 0, label_queued: false, comment_queued: false, error: 'reportDependencyBlock requiere issue numérico' };
    }
    const dependsOn = sanitizeDepsList(opts.dependsOn);

    let labelQueued = false;
    let commentQueued = false;

    try {
        fs.mkdirSync(GH_QUEUE_DIR, { recursive: true });
    } catch (e) {
        return { ok: false, issue, label_queued: false, comment_queued: false, error: 'No se pudo crear cola GitHub: ' + e.message };
    }

    // 1. Encolar label
    try {
        const labelFile = path.join(GH_QUEUE_DIR, `${issue}-${DEPS_LABEL.replace(/:/g, '-')}-block-${Date.now()}.json`);
        fs.writeFileSync(labelFile, JSON.stringify({
            action: 'label',
            issue,
            label: DEPS_LABEL,
        }));
        labelQueued = true;
    } catch (e) {
        // Si falla el label NO encolamos comment: sin label, el brazo de
        // desbloqueo nunca va a barrer este issue (fail-closed).
        return { ok: false, issue, label_queued: false, comment_queued: false, error: 'No se pudo encolar label: ' + e.message };
    }

    // 2. Encolar comment con marker
    try {
        const body = buildDependencyComment({ dependsOn, reason: opts.reason, skill: opts.skill });
        const commentFile = path.join(GH_QUEUE_DIR, `${issue}-deps-comment-${Date.now() + 1}.json`);
        fs.writeFileSync(commentFile, JSON.stringify({
            action: 'comment',
            issue,
            body,
        }));
        commentQueued = true;
    } catch (e) {
        // Label ya aplicado, comment falló: el brazo lo va a interpretar
        // como "fail-closed" (no encuentra marker) y dejarlo para revisión.
        // Eso ya es comportamiento seguro; reportamos error pero ok=true.
        emitBlocked({ issue, dependsOn, skill: opts.skill, phase: opts.phase, reason: opts.reason });
        return { ok: true, issue, label_queued: true, comment_queued: false, error: 'Comment falló (label sí aplicado): ' + e.message };
    }

    emitBlocked({ issue, dependsOn, skill: opts.skill, phase: opts.phase, reason: opts.reason });

    return { ok: true, issue, label_queued: labelQueued, comment_queued: commentQueued };
}

// =============================================================================
// #3229 — Segregación filesystem bloqueado-dependencias/
// =============================================================================
//
// Antes de #3229 el barrido del pulpo movía los archivos del issue a
// `archivado/` y dejaba al brazoDesbloqueo trabajar solo desde la GitHub-label.
// El problema: al destrabar, no había forma simple de reingresar el archivo a
// `pendiente/` (estaba enterrado en archivado/ junto a basura técnica).
//
// El nuevo flujo:
//   1. Barrido detecta dependency_block → mueve archivos a
//      <pipeline>/<phase>/bloqueado-dependencias/<issue>.<skill>
//      + .reason.json adyacente con metadata (depende_de, skill, fase, ts).
//   2. Aplica label `blocked:dependencias` en GitHub (vía reportDependencyBlock).
//   3. brazoDesbloqueo descubre que todas las deps cerraron → quita label
//      + escanea `bloqueado-dependencias/` y mueve archivos a `pendiente/`
//      de la fase original (que está en el .reason.json).
//
// `bloqueado-humano/` queda INTACTO — su contrato (release vía /unblock) no
// cambia. Las dos carpetas son hermanas, mutuamente excluyentes por issue.

/**
 * Crea/actualiza el marker filesystem para un issue bloqueado por dependencias.
 * Pareja simétrica de `humanBlock.reportHumanBlock` para el otro estado.
 *
 * @param {object} opts
 * @param {number} opts.issue
 * @param {string} opts.skill        — skill del agente que detectó la dep
 * @param {string} opts.phase        — fase donde se detectó (validacion, dev, etc)
 * @param {string} opts.pipeline     — pipeline (desarrollo/definicion)
 * @param {number[]} opts.dependsOn  — issue numbers de las dependencias
 * @param {string} [opts.reason]     — motivo del agente
 *
 * @returns {{ ok: boolean, marker_path?: string, error?: string }}
 */
function writeDependencyBlockMarker(opts) {
    const issue = Number(opts.issue);
    const skill = String(opts.skill || '').trim();
    const phase = String(opts.phase || '').trim();
    const pipeline = String(opts.pipeline || 'desarrollo').trim();
    if (!issue || !skill || !phase) {
        return { ok: false, error: 'writeDependencyBlockMarker requiere issue, skill, phase' };
    }

    const targetDir = path.join(PIPELINE_DIR, pipeline, phase, DEPS_BLOCK_SUBDIR);
    try { fs.mkdirSync(targetDir, { recursive: true }); }
    catch (e) { return { ok: false, error: 'No se pudo crear ' + DEPS_BLOCK_SUBDIR + ': ' + e.message }; }

    const marker = `${issue}.${skill}`;
    const targetFile = path.join(targetDir, marker);
    if (!fs.existsSync(targetFile)) {
        try { fs.writeFileSync(targetFile, ''); }
        catch (e) { return { ok: false, error: 'No se pudo crear marker: ' + e.message }; }
    }

    // Metadata adyacente — el brazoDesbloqueo la lee para saber a qué fase
    // devolver el archivo cuando destraba.
    try {
        fs.writeFileSync(targetFile + '.reason.json', JSON.stringify({
            issue, skill, phase, pipeline,
            depends_on: sanitizeDepsList(opts.dependsOn),
            reason: String(opts.reason || '').slice(0, 1500),
            blocked_at: new Date().toISOString(),
        }, null, 2));
    } catch (e) {
        // Fail-open: el marker ya está; sin .reason.json el brazo de
        // desbloqueo cae a defaults (skill='build', phase=BLOCK_SUBDIR padre).
    }

    return { ok: true, marker_path: targetFile };
}

/**
 * Mueve los archivos del issue (desde pendiente/trabajando/listo de la fase
 * actual) a `bloqueado-dependencias/`. Asociado a `writeDependencyBlockMarker`.
 *
 * @param {object} opts
 * @param {number} opts.issue
 * @param {string} opts.pipeline
 * @param {string} opts.phase
 *
 * @returns {{ moved: number, target_dir: string }}
 */
function moveIssueFilesToDependencyBlock(opts) {
    const issue = Number(opts.issue);
    const pipeline = String(opts.pipeline || 'desarrollo').trim();
    const phase = String(opts.phase || '').trim();
    if (!issue || !phase) return { moved: 0, target_dir: '' };

    const targetDir = path.join(PIPELINE_DIR, pipeline, phase, DEPS_BLOCK_SUBDIR);
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}

    const prefix = String(issue) + '.';
    let moved = 0;
    for (const state of ['pendiente', 'trabajando', 'listo']) {
        const dir = path.join(PIPELINE_DIR, pipeline, phase, state);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const f of entries) {
            if (!f.startsWith(prefix) || f === '.gitkeep') continue;
            const src = path.join(dir, f);
            const dst = path.join(targetDir, f);
            try {
                fs.renameSync(src, dst);
                moved++;
            } catch {
                // Si rename falla (cross-device, lock), copiamos+unlink
                try {
                    fs.copyFileSync(src, dst);
                    fs.unlinkSync(src);
                    moved++;
                } catch {}
            }
        }
    }
    return { moved, target_dir: targetDir };
}

/**
 * Lista markers presentes en `bloqueado-dependencias/` para todos los
 * pipelines/fases. Usado por el brazoDesbloqueo para reingresar archivos
 * cuando las dependencias cierran.
 *
 * @returns {Array<{issue, skill, phase, pipeline, file, reason}>}
 */
function listDependencyBlockedMarkers() {
    const PIPELINES = ['desarrollo', 'definicion'];
    const out = [];
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try {
            phases = fs.readdirSync(pipeRoot).filter(f => {
                try { return fs.statSync(path.join(pipeRoot, f)).isDirectory(); }
                catch { return false; }
            });
        } catch { continue; }
        for (const phase of phases) {
            const dir = path.join(pipeRoot, phase, DEPS_BLOCK_SUBDIR);
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const f of entries) {
                if (f === '.gitkeep' || f.endsWith('.reason.json')) continue;
                // Markers válidos tienen forma <issue>.<skill> (≤2 segmentos)
                if (f.split('.').length > 2) continue;
                const dot = f.indexOf('.');
                if (dot <= 0) continue;
                const issue = Number(f.slice(0, dot));
                const skill = f.slice(dot + 1);
                if (!Number.isFinite(issue)) continue;
                let reason = null;
                try { reason = JSON.parse(fs.readFileSync(path.join(dir, f + '.reason.json'), 'utf8')); }
                catch {}
                out.push({
                    issue, skill, phase, pipeline,
                    file: path.join(dir, f),
                    reason,
                });
            }
        }
    }
    return out;
}

/**
 * Reingresa el archivo de un issue desde `bloqueado-dependencias/` a
 * `pendiente/` de la fase declarada en `.reason.json` (o `phase` si se pasa).
 * Idempotente: si el archivo ya no está, devuelve `moved: 0`.
 *
 * #3373 — Además de mover desde `bloqueado-dependencias/`, ejecuta un sweep
 * defensivo sobre `<pipeline>/<phase>/procesado/` buscando archivos del mismo
 * issue con `cancelado_por === 'fast-fail-rebote'` (strict equality) y los
 * reingresa a `pendiente/`. Recupera archivos legacy que el fast-fail-rebote
 * pre-#3373 drenó a procesado/ y dejó varados. NO toca archivos con
 * `cancelado_por: 'cross-phase-rebote'` (otra semántica).
 *
 * @param {object} opts
 * @param {number} opts.issue
 * @param {string} [opts.targetPhase] — fase explícita; default = lo que dice
 *                                       el .reason.json del marker.
 *
 * @returns {{ moved: number, files: string[], pipeline?: string, phase?: string, swept?: number }}
 */
function releaseDependencyBlockToPendiente(opts) {
    const issue = Number(opts.issue);
    if (!Number.isInteger(issue) || issue <= 0) return { moved: 0, files: [] };

    const markers = listDependencyBlockedMarkers().filter(m => m.issue === issue);
    if (markers.length === 0) {
        // Sin marker no podemos inferir (pipeline, phase). El sweep necesita ese
        // contexto — sin él no escaneamos a ciegas todo el filesystem.
        return { moved: 0, files: [] };
    }

    // Agrupar por pipeline+phase (debería ser único, pero defense-in-depth)
    let pipeline = null;
    let phase = null;
    const movedFiles = [];

    for (const m of markers) {
        const dstPhase = String(opts.targetPhase || m.phase);
        const dstDir = path.join(PIPELINE_DIR, m.pipeline, dstPhase, 'pendiente');
        try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
        const dst = path.join(dstDir, path.basename(m.file));
        try {
            fs.renameSync(m.file, dst);
            movedFiles.push(dst);
            pipeline = m.pipeline;
            phase = dstPhase;
        } catch {
            try {
                fs.copyFileSync(m.file, dst);
                fs.unlinkSync(m.file);
                movedFiles.push(dst);
                pipeline = m.pipeline;
                phase = dstPhase;
            } catch {}
        }
        // Limpiar el .reason.json adyacente (su info ya está en el archivo
        // movido o ya no aplica — el agente reentra a pendiente/).
        try { fs.unlinkSync(m.file + '.reason.json'); } catch {}
    }

    // #3373 — Sweep defensivo: recuperar archivos legacy en procesado/ con
    // `cancelado_por: fast-fail-rebote` para los (pipeline, phase) donde
    // encontramos markers. Sin esto, issues que sufrieron el bug pre-#3373
    // quedan trabados aunque las deps cierren.
    const sweptFiles = [];
    const sweepedPhases = new Set();
    for (const m of markers) {
        const key = `${m.pipeline}/${m.phase}`;
        if (sweepedPhases.has(key)) continue;
        sweepedPhases.add(key);
        try {
            const sweepRes = sweepFastFailRebotesFromProcesado({
                issue,
                pipeline: m.pipeline,
                phase: m.phase,
            });
            for (const f of sweepRes.files) sweptFiles.push(f);
        } catch {
            // sweep defensivo — nunca debe romper el destrabe principal
        }
    }

    return {
        moved: movedFiles.length + sweptFiles.length,
        files: [...movedFiles, ...sweptFiles],
        pipeline,
        phase,
        swept: sweptFiles.length,
    };
}

/**
 * #3373 — Sweep defensivo: escanea `<pipeline>/<phase>/procesado/` buscando
 * archivos del mismo issue con flag `cancelado_por === 'fast-fail-rebote'`
 * (strict equality, NO laxer match) y los reingresa a `pendiente/`. Recupera
 * archivos legacy varados por el bug pre-#3373.
 *
 * Caps de seguridad (recomendación security #3373):
 *   - Máximo 3 archivos reingresados por issue (anti-abuso).
 *   - Máximo 100 archivos escaneados por invocación (anti-DOS).
 *   - Strict equality `=== 'fast-fail-rebote'`: NO restituye 'cross-phase-rebote'
 *     ni motivos parciales/regex.
 *   - Filtrado por prefix de filename ANTES de leer YAML (perf + defensa).
 *   - try/catch envolviendo cada operación de FS (idempotencia + corrupciones).
 *
 * @param {object} opts
 * @param {number} opts.issue
 * @param {string} opts.pipeline
 * @param {string} opts.phase
 *
 * @returns {{ moved: number, files: string[], scanned: number, capped: boolean }}
 */
function sweepFastFailRebotesFromProcesado(opts) {
    const issue = Number(opts.issue);
    const pipeline = String(opts.pipeline || '').trim();
    const phase = String(opts.phase || '').trim();
    if (!Number.isInteger(issue) || issue <= 0) return { moved: 0, files: [], scanned: 0, capped: false };
    if (!pipeline || !phase) return { moved: 0, files: [], scanned: 0, capped: false };

    const MAX_FILES_PER_ISSUE = 3;
    const MAX_FILES_SCANNED = 100;

    const procesadoDir = path.join(PIPELINE_DIR, pipeline, phase, 'procesado');
    const pendienteDir = path.join(PIPELINE_DIR, pipeline, phase, 'pendiente');

    const prefix = String(issue) + '.';
    const moved = [];
    let scanned = 0;
    let capped = false;

    let entries = [];
    try { entries = fs.readdirSync(procesadoDir); } catch { return { moved: 0, files: [], scanned: 0, capped: false }; }

    for (const f of entries) {
        if (scanned >= MAX_FILES_SCANNED) { capped = true; break; }
        // Early-continue: descarta cualquier archivo que NO sea de este issue
        // antes de leer YAML (perf + defensa contra fanout enorme).
        if (!f.startsWith(prefix)) continue;
        if (f === '.gitkeep') continue;
        // #3638 CA-F-1: filtro centralizado de artifacts auxiliares y > 2
        // segmentos. Importado de `lib/marker-artifact.js`.
        if (isMarkerArtifact(f)) continue;
        scanned++;
        if (moved.length >= MAX_FILES_PER_ISSUE) { capped = true; break; }

        const src = path.join(procesadoDir, f);
        let data = null;
        try {
            const raw = fs.readFileSync(src, 'utf8');
            data = yaml.load(raw) || {};
        } catch {
            // YAML corrupto o I/O failure: skip silencioso. No relanzar.
            continue;
        }
        // Strict equality — NO 'cross-phase-rebote', NO regex, NO includes.
        if (data.cancelado_por !== 'fast-fail-rebote') continue;

        try { fs.mkdirSync(pendienteDir, { recursive: true }); } catch {}
        const dst = path.join(pendienteDir, f);

        // Reescribir YAML limpiando los flags de cancelación — el agente
        // re-entra a pendiente/ como ciclo nuevo, no como reintento marcado.
        const clean = { ...data };
        delete clean.cancelado_por;
        delete clean.cancelado_ts;

        try {
            fs.writeFileSync(dst, yaml.dump(clean, { lineWidth: -1 }));
            fs.unlinkSync(src);
            moved.push(dst);
        } catch {
            // ENOENT u otro race: idempotencia, capturar y seguir.
        }
    }

    return { moved: moved.length, files: moved, scanned, capped };
}

// -----------------------------------------------------------------------------
// HELPERS INTERNOS
// -----------------------------------------------------------------------------

function truncateForClassify(s) {
    if (typeof s !== 'string') return '';
    return s.length > MAX_MOTIVO_LEN ? s.slice(0, MAX_MOTIVO_LEN) : s;
}

function sanitizeDepsList(input) {
    if (!Array.isArray(input)) return [];
    const out = new Set();
    for (const raw of input) {
        const n = Number(typeof raw === 'string' ? raw.replace(/^#/, '') : raw);
        if (Number.isFinite(n) && n > 0) out.add(n);
    }
    return Array.from(out).sort((a, b) => a - b).slice(0, MAX_DEPS_PER_BLOCK);
}

function emitBlocked(opts) {
    try {
        trace.appendEvent({
            event: 'dependency:blocked',
            issue: Number(opts.issue) || null,
            depends_on: Array.isArray(opts.dependsOn) ? opts.dependsOn : [],
            skill: opts.skill || null,
            phase: opts.phase || null,
            reason: opts.reason || '',
            ts: new Date().toISOString(),
            pid: process.pid,
        });
    } catch {
        // appendEvent ya es fail-tolerant; ignoramos
    }
}

module.exports = {
    classifyRebote,
    detectDependencyBlock,
    buildDependencyComment,
    reportDependencyBlock,
    sanitizeDepsList,
    // #3229 — segregación filesystem bloqueado-dependencias/
    writeDependencyBlockMarker,
    moveIssueFilesToDependencyBlock,
    listDependencyBlockedMarkers,
    releaseDependencyBlockToPendiente,
    // #3373 — sweep defensivo de fast-fail-rebote varados en procesado/
    sweepFastFailRebotesFromProcesado,
    DEPENDENCY_PATTERNS,
    DEPENDENCY_ASSET_PATTERNS,
    DEPS_LABEL,
    DEPS_BLOCK_SUBDIR,
    MAX_DEPS_PER_BLOCK,
};
