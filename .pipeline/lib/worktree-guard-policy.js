// =============================================================================
// worktree-guard-policy.js — Política pura del guard de worktree (#5421).
//
// Split de #5401 — parte 3 de 3 (Bloques C y D).
//
// **Qué resuelve**: el guard de `pulpo.js` decidía si un aborto de resolución
// de worktree escalaba a `needs-human` con una regex por PREFIJO sobre el
// motivo (`/^(remote-branch-missing|branch-origin-unverified|...)/`). Eso
// tenía dos problemas:
//   1. Un motivo futuro `branch-origin-unverified-foo` matcheaba por prefijo
//      sin que nadie lo hubiera revisado.
//   2. La ausencia de la copia LOCAL de la rama (el directorio de trabajo
//      quedó huérfano) escalaba igual que una falla de CONFIANZA (procedencia
//      de la rama no verificada), cuando son problemas de naturaleza distinta.
//
// **Qué NO hace (D2, innegociable)**: `guardExceptionEligible` decide *una
// sola cosa* — si el aborto escala o no a `needs-human`. NUNCA autoriza
// adoptar, leer ni ejecutar un directorio preexistente. La única vía para
// obtener un worktree usable sigue siendo la creación fresca desde el remoto
// verificado (`attemptAutoRecovery` en `worktree-resolver.js`, D1).
//
// **Módulo puro (D5)**: sin I/O, sin `spawnSync`, sin `fs`. Su única
// dependencia es `../redact` (D4 — redactor canónico del pipeline; NO se usa
// `redactInline` de `skills-deterministicos/lib/git-ops.js`, que invertiría
// las capas: `pulpo.js` no depende de `skills-deterministicos/`).
// =============================================================================
'use strict';

const { redact } = require('../redact');

/**
 * Motivos elegibles SIEMPRE para la excepción del guard.
 *
 * Ambos describen lo mismo: la rama remota está verificada, lo que falta es la
 * copia de trabajo local. Es ausencia de una copia, no una falla de confianza.
 */
const ALWAYS_ELIGIBLE = new Set([
    'worktree-path-exists',
    'worktree-path-exists-without-git-entry',
]);

/**
 * Motivos transitorios: elegibles SÓLO si la procedencia de la rama ya fue
 * verificada (`branchOriginVerified === true`). Con `false` o `null` no lo son
 * — no sabemos si la rama es de un agente del pipeline.
 */
const ELIGIBLE_IF_VERIFIED = new Set([
    'ls-remote-failed',
    'fetch-failed',
]);

/**
 * Motivos que NUNCA son elegibles. Se listan explícitos (aunque el default ya
 * es cerrado) para que quede documentado que la exclusión es deliberada y para
 * poder darles una `causa` en lenguaje de operador.
 */
const NEVER_ELIGIBLE = new Set([
    'branch-origin-unverified',
    'invalid-input',
    'remote-branch-missing',
]);

/** Enum cerrado de operaciones (D3). Sólo metadato de log, nunca decisión. */
const OPERATIONS = Object.freeze({
    SPAWN_AGENTE: 'spawn-agente',
    COMMIT_PUSH: 'commit-push',
    MERGE_SERVER_SIDE: 'merge-server-side',
});

/** Etiqueta de la operación en lenguaje de operador (CA-6). */
const OPERATION_LABEL = Object.freeze({
    'spawn-agente': 'spawn de agente en worktree dedicado',
    'commit-push': 'commit/push sobre la rama del dev',
    'merge-server-side': 'merge server-side de la entrega',
});

/**
 * Causa en lenguaje de operador por motivo normalizado (CA-6).
 * Cualquier motivo no listado cae en el genérico de "motivo no reconocido".
 */
const CAUSA_POR_MOTIVO = Object.freeze({
    'worktree-path-exists':
        'la rama remota está verificada pero falta la copia de trabajo local (quedó un directorio huérfano que git no reconoce)',
    'worktree-path-exists-without-git-entry':
        'la rama remota está verificada pero falta la copia de trabajo local (quedó un directorio huérfano que git no reconoce)',
    'ls-remote-failed': 'no se pudo consultar el remoto (falla transitoria de red o de git)',
    'fetch-failed': 'no se pudo traer la rama desde el remoto (falla transitoria de red o de git)',
    'branch-origin-unverified':
        'no se pudo verificar la procedencia de la rama remota (el committer no está en la allowlist, o la rama no tiene commits)',
    'remote-branch-missing': 'no existe ninguna rama remota con el patrón esperado para el issue',
    'invalid-input': 'el issue o el skill del ciclo están malformados',
});

/**
 * Acción concreta que destraba, por motivo normalizado (CA-6).
 * El texto se completa con el issue para que sea copiable sin pensar.
 */
function accionQueDestraba(motivo, issue) {
    const ref = `#${issue}`;
    switch (motivo) {
        case 'worktree-path-exists':
        case 'worktree-path-exists-without-git-entry':
            return (
                'revisá el directorio huérfano indicado y borralo si no tiene trabajo pendiente; ' +
                'el pipeline NO lo toca a propósito y ya intenta recrear la copia en un path nuevo con sufijo -rN'
            );
        case 'ls-remote-failed':
        case 'fetch-failed':
            return 'verificá conectividad con GitHub (git ls-remote origin); el pipeline reintenta solo cuando la infra se recupera';
        case 'branch-origin-unverified':
            return (
                'si el committer es un agente legítimo, agregalo a la allowlist worktree_provenance.committers ' +
                'de .pipeline/config.yaml; si no lo reconocés, NO re-encoles: inspeccioná el autor de la rama'
            );
        case 'remote-branch-missing':
            return `confirmá que el dev de ${ref} pusheó su rama agent/${issue}-<slug>; si nunca existió, re-encolá ${ref} al inicio del pipeline`;
        case 'invalid-input':
            return `revisá el YAML del ciclo de ${ref} (issue/skill malformados) — no se arregla reintentando`;
        default:
            return `motivo no contemplado por la política del guard: escalá ${ref} a un humano y agregá el motivo a worktree-guard-policy.js`;
    }
}

/**
 * Normaliza un `reason` quedándose con el token ANTERIOR al primer `:`.
 *
 * Los reasons del resolver llevan sufijo `:<detalle>`, y ese detalle suele ser
 * un path del filesystem (que en Windows trae su propio `:`), un email o un
 * mensaje de error. Por eso se corta en el PRIMER `:`.
 */
function normalizarMotivo(reasonStr) {
    const raw = String(reasonStr == null ? '' : reasonStr).trim();
    if (!raw) return '';
    const idx = raw.indexOf(':');
    const head = idx === -1 ? raw : raw.slice(0, idx);
    return head.trim().toLowerCase();
}

/**
 * ¿El aborto es elegible para la excepción del guard (= NO escala a
 * `needs-human` por motivo)?
 *
 * Decide con **igualdad exacta** contra una allowlist de motivos normalizados,
 * nunca por prefijo, y con **default cerrado**: motivo desconocido ⇒ el guard
 * aplica (`eligible:false`).
 *
 * D3 — `operation` viaja para el log, NO entra en la decisión: el veredicto se
 * calcula sólo con `reasonStr` normalizado + `branchOriginVerified`.
 *
 * @param {string} reasonStr Motivo crudo del resolver (con o sin sufijo).
 * @param {object} [opts]
 * @param {string} [opts.operation] Enum de OPERATIONS — sólo metadato.
 * @param {boolean|null} [opts.branchOriginVerified] Procedencia de la rama.
 * @returns {{eligible: boolean, motivoNormalizado: string, causa: string}}
 */
function guardExceptionEligible(reasonStr, opts = {}) {
    const { branchOriginVerified = null } = opts || {};
    const motivoNormalizado = normalizarMotivo(reasonStr);

    let eligible;
    if (NEVER_ELIGIBLE.has(motivoNormalizado)) {
        eligible = false;
    } else if (ALWAYS_ELIGIBLE.has(motivoNormalizado)) {
        eligible = true;
    } else if (ELIGIBLE_IF_VERIFIED.has(motivoNormalizado)) {
        // Estricto: sólo el booleano `true`. `false`, `null` y `undefined` no.
        eligible = branchOriginVerified === true;
    } else {
        // Default cerrado (CA-4).
        eligible = false;
    }

    const causa = CAUSA_POR_MOTIVO[motivoNormalizado]
        || 'motivo no reconocido por la política del guard (default cerrado: el guard aplica)';

    return { eligible, motivoNormalizado, causa };
}

/**
 * Deriva la operación que el pulpo estaba intentando (D3, enum cerrado).
 *
 * La fase de entrega no spawnea un agente para commitear: hace el merge del PR
 * server-side. Distinguirlo importa porque la acción del operador es distinta.
 */
function resolveOperation({ fase, skill } = {}) {
    const f = String(fase == null ? '' : fase).trim().toLowerCase();
    const s = String(skill == null ? '' : skill).trim().toLowerCase();
    if (f === 'entrega' || s === 'delivery') return OPERATIONS.MERGE_SERVER_SIDE;
    return OPERATIONS.SPAWN_AGENTE;
}

/**
 * Línea de log accionable del aborto (CA-6 + CA-7).
 *
 * Nombra: la operación intentada, la causa en lenguaje de operador y la acción
 * concreta que destraba. Todo el string sale por `redact()` (D4), así que
 * cualquier `stderr` de `gh`/`git` con paths absolutos o tokens queda tapado
 * antes de llegar al log.
 */
function buildAbortLogLine({
    issue,
    fase,
    skill,
    reasonStr,
    operation,
    intentos,
    cap,
    eligible,
    escalar,
    stderr,
} = {}) {
    const motivo = normalizarMotivo(reasonStr);
    // Enum cerrado: una operación fuera del enum cae al default en vez de
    // viajar cruda al log del operador.
    const op = Object.values(OPERATIONS).includes(operation) ? operation : OPERATIONS.SPAWN_AGENTE;
    const opLabel = OPERATION_LABEL[op];
    const causa = (CAUSA_POR_MOTIVO[motivo]
        || 'motivo no reconocido por la política del guard (default cerrado: el guard aplica)');

    const partes = [
        `⛔ #${issue}: aborté la operación "${opLabel}" en fase ${fase} (skill ${skill}).`,
        `Causa: ${causa}.`,
        `Acción que destraba: ${accionQueDestraba(motivo, issue)}.`,
        `Detalle técnico: ${String(reasonStr == null ? 'desconocido' : reasonStr)} | operacion=${op} ` +
        `motivo=${motivo || 'desconocido'} excepcion_guard=${eligible ? 'si' : 'no'} ` +
        `intentos=${intentos}/${cap} escala_humano=${escalar ? 'si' : 'no'}`,
    ];
    if (stderr) {
        // Una sola línea, acotada: el stderr de gh/git puede ser enorme.
        const flat = String(stderr).replace(/\s+/g, ' ').trim().slice(0, 400);
        if (flat) partes.push(`stderr: ${flat}`);
    }

    return redact(partes.join(' '));
}

/**
 * Texto de la pregunta al operador, separado por CAUSA REAL (CA-8).
 *
 * Tabla de wording:
 *   - procedencia no verificada + hay committers no reconocidos ⇒ problema de
 *     CONFIGURACIÓN. Nombra el email y la allowlist a actualizar. NO usa
 *     lenguaje de "rama ajena".
 *   - procedencia no verificada + sin committers (la rama no tiene commits de
 *     nadie reconocible) ⇒ se conserva el lenguaje de procedencia sospechosa.
 *   - procedencia verificada o desconocida ⇒ texto genérico.
 */
function buildOperatorQuestion({ issue, reasonStr, branchOriginVerified, unverifiedAuthors } = {}) {
    const autores = Array.isArray(unverifiedAuthors)
        ? unverifiedAuthors.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim())
        : [];

    if (branchOriginVerified === false && autores.length > 0) {
        const lista = autores.join(', ');
        const plural = autores.length > 1;
        return redact(
            `El pipeline no reconoce ${plural ? 'a los committers' : 'al committer'} \`${lista}\` ` +
            `de la rama \`agent/${issue}-*\`. ` +
            `Si ${plural ? 'son agentes legítimos' : 'es un agente legítimo'}, falta ` +
            `${plural ? 'agregarlos' : 'agregarlo'} a la allowlist \`worktree_provenance.committers\` ` +
            'de `.pipeline/config.yaml`. ' +
            `¿Podés confirmarlo y actualizar la allowlist? Después re-encolá #${issue}.`
        );
    }

    if (branchOriginVerified === false) {
        return redact(
            `¿Podés inspeccionar el autor de la rama remota origin/agent/${issue}-* de #${issue}? ` +
            'La verificación de procedencia falló y la rama no corresponde a ningún agente conocido ' +
            '(posible rama ajena). Re-encolá o cerrá según corresponda.'
        );
    }

    const detalle = reasonStr ? ` Motivo del aborto: ${reasonStr}.` : '';
    return redact(
        `¿Podés verificar la rama del dev de #${issue} (patrón agent/${issue}-<slug>) y re-encolar ` +
        `el issue al inicio del pipeline, o cerrarlo si ya no aplica?${detalle}`
    );
}

/**
 * Línea que lista los skills afectados por escaladas del mismo (issue, fase)
 * (CA-9). El dedup de Telegram ya colapsa las alertas a una sola; esta línea
 * es lo que evita que el operador pierda la información de las otras.
 *
 * Devuelve `''` si no hay skills — el caller decide si la agrega o no.
 */
function buildAffectedSkillsLine(skills) {
    const lista = Array.isArray(skills)
        ? [...new Set(skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
        : [];
    if (lista.length === 0) return '';
    return `Skills afectados: ${lista.join(', ')}`;
}

module.exports = {
    guardExceptionEligible,
    resolveOperation,
    buildAbortLogLine,
    buildOperatorQuestion,
    buildAffectedSkillsLine,
    normalizarMotivo,
    OPERATIONS,
    ALWAYS_ELIGIBLE,
    ELIGIBLE_IF_VERIFIED,
    NEVER_ELIGIBLE,
};
