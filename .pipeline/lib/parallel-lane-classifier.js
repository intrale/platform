// =============================================================================
// parallel-lane-classifier.js — Carril paralelo a nivel dispatch (#4767 ·
// parte (c) del split de #4759).
//
// Interpone el clasificador mecánico-vs-decisión (`block-classifier`, parte (a)
// #4765) en el punto donde el Pulpo escala un bloqueo a humano. La lógica vive
// acá (módulo puro, testeable con `node --test`) porque `pulpo.js` NO es
// importable en aislamiento (arranca un servicio). `pulpo.js` sólo hace el
// `require` + una llamada en el punto de interposición.
//
// Contrato operativo:
//   - Un bloqueo **mecánico** (merge-conflict acotado a allowlist / desync
//     reductivo, clasificado por #4765) se AUDITA **antes** de mutar (SR-7) y
//     se NOTIFICA (`block-autoresolve` → `notify-and-proceed`). El caller lo
//     EXCLUYE del freeze humano para que los issues independientes de la ola
//     sigan (SR-6, escenario #4731). Acá NO se mueve ningún marker: el Pulpo
//     sigue siendo el único dueño del lifecycle (SR-6, sin segundo dueño).
//   - Un bloqueo de **decisión** (o `gate-reject` con `source:'security'`,
//     SR-sec-5) cae fail-closed INTACTO a la rama humanBlock del Pulpo.
//
// Reglas inquebrantables heredadas:
//   - SR-7: audit-before-mutate. Si el registro auditable falla → NO se
//     auto-resuelve (el motivo cae a decisión / fail-closed).
//   - SR-sec-5 / SR-4: un rechazo de seguridad NUNCA es mecánico, aun si el
//     clasificador base lo marcara mecánico.
//   - SR-1: la resolución determinística de merge (`-X ours/theirs` acotado por
//     allowlist) la valida el clasificador (#4765); acá NO se ejecuta merge
//     semántico — este carril sólo audita, notifica y deja de congelar.
// =============================================================================
'use strict';

/**
 * ¿El motivo proviene de un gate/skill de SEGURIDAD? (SR-sec-5 / SR-4).
 * Un rechazo de seguridad NUNCA se auto-resuelve como mecánico: sólo se limpia
 * con una pasada fresca de seguridad sobre HEAD, jamás por clasificación stale.
 *
 * @param {object} m — motivo clasificado del pulpo.
 * @returns {boolean}
 */
function isSecuritySource(m) {
    if (!m || typeof m !== 'object') return false;
    if (typeof m.source === 'string' && m.source.trim().toLowerCase() === 'security') return true;
    if (typeof m.skill === 'string' && m.skill.trim().toLowerCase() === 'security') return true;
    return false;
}

/**
 * Construye el bloque normalizado que consume `block-classifier.classifyBlock`
 * a partir de un motivo del pulpo. El `kind` se deriva del hint estructural
 * `rebote_categoria` que emite el agente:
 *   - `'merge-conflict'` → bloque de conflicto (paths para la allowlist).
 *   - `'desync'`         → bloque de desync (diff + isClosed).
 *   - cualquier otro     → `gate-reject` (el clasificador devuelve `decision`
 *                          por defecto → fail-closed, conservador SR-8).
 *
 * @param {object} m
 * @returns {{ kind: string, [k:string]: any }}
 */
function toBlock(m) {
    const cat = m && typeof m.rebote_categoria === 'string' ? m.rebote_categoria : null;
    if (cat === 'merge-conflict') {
        return { kind: 'merge-conflict', paths: Array.isArray(m.paths) ? m.paths : [] };
    }
    if (cat === 'desync') {
        return {
            kind: 'desync',
            diff: (m && typeof m.diff === 'object' && m.diff) || {},
            isClosed: (m && typeof m.isClosed === 'function') ? m.isClosed : undefined,
        };
    }
    return {
        kind: 'gate-reject',
        source: isSecuritySource(m) ? 'security' : ((m && m.source) || null),
    };
}

/**
 * Clasifica cada motivo en `mecanico` | `decision`, aplicando el guard de
 * seguridad ANTES de delegar en el clasificador base (SR-sec-5). Cualquier
 * excepción del clasificador cae a `decision` (fail-closed, SR-8).
 *
 * @param {object[]} motivos
 * @param {object} [deps]
 * @param {Function} [deps.classifyBlock] — inyectable para tests.
 * @returns {{ mecanicos: Array<{motivo, cls, block}>, decisiones: Array<{motivo, cls}> }}
 */
function classifyMotivos(motivos, deps = {}) {
    const classify = deps.classifyBlock || require('./block-classifier').classifyBlock;
    const mecanicos = [];
    const decisiones = [];
    for (const m of (Array.isArray(motivos) ? motivos : [])) {
        // SR-sec-5: seguridad SIEMPRE decisión, sin importar el clasificador base.
        if (isSecuritySource(m)) {
            decisiones.push({ motivo: m, cls: { category: 'decision', reason: 'security-source: fuerza decision (SR-sec-5)' } });
            continue;
        }
        const block = toBlock(m);
        let cls;
        try {
            cls = classify(block);
        } catch (e) {
            cls = { category: 'decision', reason: `excepcion clasificacion: ${e && e.message ? e.message : String(e)}` };
        }
        if (cls && cls.category === 'mecanico') {
            mecanicos.push({ motivo: m, cls, block });
        } else {
            decisiones.push({ motivo: m, cls: cls || { category: 'decision', reason: 'sin clasificacion' } });
        }
    }
    return { mecanicos, decisiones };
}

/**
 * Ejecuta el carril paralelo sobre los motivos de un issue que iban a escalar.
 *
 * Por cada bloqueo mecánico: AUDITA antes de mutar (SR-7) con los valores
 * reales resueltos (`reason`, `commit`, `strategy`, `paths`) y `authorizedBy:
 * 'kernel:auto'`. Si el registro auditable NO confirma OK (lanza o `ok:false`),
 * el motivo NO se auto-resuelve: se degrada a `decision` (fail-closed). Los
 * mecánicos efectivamente auto-resueltos se devuelven en un `Set` (por
 * referencia del objeto motivo) para que el caller los excluya del freeze
 * humano SIN mover markers (SR-6).
 *
 * La notificación al operador (`block-autoresolve` → `notify-and-proceed`) es
 * best-effort y corre DESPUÉS del audit: un fallo de notificación jamás
 * revierte una auto-resolución ya auditada.
 *
 * @param {object[]} motivos
 * @param {object} [ctx]
 * @param {number|string} [ctx.issue]
 * @param {string} [ctx.headOid] — commit HEAD real (SR-7, `commit`).
 * @param {object} [deps]
 * @param {Function} [deps.classifyBlock]
 * @param {Function} [deps.safeAppendAction]
 * @param {Function} [deps.enforceActionPolicy]
 * @returns {{ resueltos: Set<object>, mecanicos: Array, decisiones: Array }}
 */
function runParallelLane(motivos, ctx = {}, deps = {}) {
    const safeAppendAction = deps.safeAppendAction || require('./kernel-actions-audit').safeAppendAction;
    const enforceActionPolicy = deps.enforceActionPolicy || require('./kernel-action-policy').enforceActionPolicy;

    const { mecanicos, decisiones } = classifyMotivos(motivos, deps);
    const resueltos = new Set();
    const audited = [];

    for (const { motivo, cls, block } of mecanicos) {
        const reason = (cls && cls.reason) ? String(cls.reason) : 'bloqueo mecanico auto-resuelto';
        const strategy = (cls && cls.delegateTo) || (block && block.kind) || null;
        const paths = (block && Array.isArray(block.paths)) ? block.paths : [];

        // SR-7 — audit ANTES de mutar. `safeAppendAction` no lanza (devuelve
        // `{ok:false}`), pero envolvemos igual por defensa: si por cualquier
        // motivo el registro no confirma OK, NO auto-resolvemos (fail-closed).
        let auditRes;
        try {
            auditRes = safeAppendAction({
                action: 'block-autoresolve',
                impact: 'medio',
                authorizedBy: 'kernel:auto',
                reason,
                extra: {
                    commit: ctx.headOid || null,
                    strategy,
                    paths,
                    issue: ctx.issue != null ? Number(ctx.issue) : null,
                },
            });
        } catch (e) {
            auditRes = { ok: false, error: e && e.message ? e.message : String(e) };
        }

        if (!auditRes || auditRes.ok !== true) {
            // Fail-closed (SR-7): sin traza no-repudiable NO se muta. El motivo
            // cae a decisión → escala fail-closed a humano como siempre.
            decisiones.push({ motivo, cls: { category: 'decision', reason: 'audit-before-mutate fallo -> fail-closed (SR-7)' } });
            continue;
        }

        resueltos.add(motivo);
        audited.push({ motivo, reason, strategy, paths });
    }

    // Notificación al operador (best-effort, post-audit). Un aviso agregado por
    // el carril (no uno por motivo) para no saturar. Nunca revierte el audit.
    if (audited.length > 0) {
        try {
            enforceActionPolicy('block-autoresolve', {
                issues: ctx.issue != null ? [{ number: Number(ctx.issue) }] : [],
                reason: audited[0].reason,
                impact: 'medio',
                classification: 'mecanico',
            });
        } catch { /* best-effort: la notificacion nunca revierte la auto-resolucion */ }
    }

    return { resueltos, mecanicos: audited, decisiones };
}

module.exports = {
    runParallelLane,
    classifyMotivos,
    toBlock,
    isSecuritySource,
};
