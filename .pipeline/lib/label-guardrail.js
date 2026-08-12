// =============================================================================
// label-guardrail.js — Guardrail fail-closed contra la mezcla de labels de
// bloqueo real (`needs-human`) y de recomendación (`tipo:recomendacion`).
//
// Issue: #5690 (parte 2 de 3 del split de #5678).
//
// ---------------------------------------------------------------------------
// POR QUÉ VIVE ACÁ Y NO EN EL INTAKE DEL PULPO
// ---------------------------------------------------------------------------
// El issue madre proponía ubicarlo en el intake (`pulpo.js`). Eso es una **ruta
// de lectura**: detecta la mezcla después de ocurrida. Hay 6+ productores que
// escriben la orden de label directo a la cola sin pasar por ningún helper
// común (`pulpo.js:1538/3821/4404/5120`, `lib/human-block.js`,
// `servicio-reconciler.js`, `rejection-report.js`, `lib/rebote-classifier.js`).
// Todos convergen en el `switch` de `servicio-github.js`, que es el único
// choke point real de **mutación**. El guardrail va ahí.
//
// ---------------------------------------------------------------------------
// MODELO DE AMENAZA (explícito y honesto)
// ---------------------------------------------------------------------------
// La cola `.pipeline/servicios/github/pendiente/` es un **directorio del
// filesystem sin autenticación**, escribible por cualquier agente, hook o
// script del repo. Todo lo que caiga ahí se ejecuta con el token de `gh` del
// operador. Un JSON de 80 bytes puede pedir cualquier mutación de label.
//
// Este módulo NO es una frontera criptográfica: el par
// `guardrail_authorized` + `authorized_by` es una **declaración de
// procedencia**, no una firma. Un productor malicioso que ya puede escribir en
// la cola puede setearlo. Lo que sí garantiza:
//
//   1. Un productor que NO declara procedencia **no puede** disparar las
//      mutaciones sensibles (es el caso del JSON de 80 bytes y el del
//      productor nuevo que no conoce la regla — el modo de falla real).
//   2. La declaración obliga a **nombrarse** (`authorized_by`), y TODO uso
//      —permitido o rechazado— queda auditado en un JSONL con hash chain
//      (tamper-evident, `lib/audit-log.js`). El abuso no es prevenible pero
//      sí detectable, y el log dice quién dijo ser quién.
//
// Esa garantía (1) depende de una premisa que la primera versión de este módulo
// daba por sentada y NO se cumplía: que el campo `label` de la orden sea UN
// label. Es una **lista CSV**, y comparar el string entero contra la lista de
// sensibles dejaba pasar `"needs-human,priority:high"` como "no sensible". Ver
// SEC-F más abajo: toda decisión se toma sobre los componentes parseados.
//
// Se llama `guardrail_authorized` y no `human_authorized` a propósito: de los
// tres productores legítimos, uno (`servicio-reconciler`, oráculo de épicas
// con todos los hijos cerrados) NO es humano. Nombrar el campo "human" sería
// mentir en el audit log.
//
// Es el mismo mecanismo que el codebase ya usa para los labels QA
// (`gate_reconciler: true` en `gate-label-reconciler`), y es el que la fase de
// análisis de seguridad sancionó explícitamente para este issue.
//
// ---------------------------------------------------------------------------
// SEC-4 / R4 — INVARIANTE MÁS IMPORTANTE DEL MÓDULO
// ---------------------------------------------------------------------------
// **El guardrail NUNCA remueve `needs-human`, ni ordena removerlo.** Su única
// salida es un veredicto `{allowed:boolean}`. No devuelve acciones, no muta,
// no "corrige". Un guardrail que auto-corrige desarmaría el gate humano, que
// es exactamente el riesgo que este issue viene a cerrar.
//
// ---------------------------------------------------------------------------
// RUTA HUMANA EXENTA POR DISEÑO (no "endurecer")
// ---------------------------------------------------------------------------
// `lib/recommendations.js` (`approve()` / `reject()`, invocados desde el panel
// del dashboard) llama a `gh` **directo**, sin pasar por la cola ni por este
// guardrail. Eso es **deliberado**: el dashboard es acción humana con identidad
// detrás; la cola es un directorio anónimo. Enrutar `recommendations.js` por la
// cola rompería el único mecanismo de destrabe legítimo y dejaría el gate sin
// forma de abrirse. NO enrutarlo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const auditLog = require('./audit-log');

const NEEDS_HUMAN = 'needs-human';
const TIPO_RECOMENDACION = 'tipo:recomendacion';
const SOURCE_RECOMMENDATION = 'source:recommendation';
const RECOMMENDATION_APPROVED = 'recommendation:approved';

// SEC-D — conjunto sensible. La consulta de labels actuales (un `gh issue view`
// extra por orden) se dispara **sólo** para estos labels. Con la migración de
// ~924 issues de la parte 3 corriendo en paralelo, hacerlo para cualquier label
// agotaría el rate limit de la API y degradaría el servicio entero, incluidas
// las órdenes legítimas de bloqueo (DoS auto-infligido).
const SENSITIVE_LABELS = Object.freeze([
    NEEDS_HUMAN,
    TIPO_RECOMENDACION,
    SOURCE_RECOMMENDATION,
    RECOMMENDATION_APPROVED,
]);

// Sólo `needs-human` y `tipo:recomendacion` requieren leer el estado actual del
// issue para decidir (son los dos lados de la regla de mezcla). Los otros dos
// sensibles se resuelven sin consulta — ver `evaluateLabelOrder`, que lo decide
// con los flags `pideNeedsHuman` / `pideRecomendacion` sobre los componentes.

const MOTIVOS = Object.freeze({
    MEZCLA_BLOQUEO_SOBRE_RECO: 'mezcla-needs-human-sobre-recomendacion',
    MEZCLA_RECO_SOBRE_BLOQUEO: 'mezcla-recomendacion-sobre-needs-human',
    MEZCLA_EN_LA_MISMA_ORDEN: 'mezcla-needs-human-y-recomendacion-en-la-misma-orden',
    APPROVED_SIN_ORIGEN_HUMANO: 'approved-sin-origen-autorizado',
    REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO: 'remove-needs-human-sin-origen-autorizado',
    INDETERMINADO: 'guardrail-indeterminado',
});

// -----------------------------------------------------------------------------
// SEC-F — NORMALIZACIÓN CSV (bypass encontrado en la verificación de #5690)
//
// El campo `label` de una orden NO es un label: es una **lista CSV**. `gh issue
// edit --add-label "a,b"` aplica DOS labels, y el propio repo ya emite ese
// formato (`servicio-github.js` → `labelsStr.split(',')`,
// `migrate-recomendaciones-legacy.js` → `toAdd.join(',')`).
//
// Comparar el string entero por igualdad exacta contra `SENSITIVE_LABELS` hacía
// que UNA COMA desarmara el guardrail entero: `"needs-human,priority:high"` no
// matchea ningún elemento → veredicto `label-no-sensible` → pasa directo a
// `editIssue` → `gh` separa por la coma y remueve `needs-human` igual. El gate
// humano se destrababa desde la cola anónima, y en silencio: el camino
// permitido no escribe en `.pipeline/audit/`.
//
// La defensa es normalizar ANTES de decidir y aplicar las reglas si CUALQUIER
// componente es sensible. Se trimea cada componente a propósito: `" needs-human"`
// no es un label válido para `gh`, pero tratarlo como sensible es la dirección
// conservadora (peor rechazar de más que dejar pasar una remoción del gate).
// -----------------------------------------------------------------------------

/** Descompone el campo `label` en sus componentes reales (CSV, trimeados). */
function parseLabelList(label) {
    return String(label == null ? '' : label)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Componentes sensibles presentes en el campo `label` (puede ser CSV). */
function sensitiveComponents(label) {
    return parseLabelList(label).filter((c) => SENSITIVE_LABELS.includes(c));
}

/**
 * ¿La orden toca algún label sensible? CSV-aware: `"needs-human,area:infra"`
 * es sensible aunque el string completo no matchee ningún elemento de la lista.
 */
function isSensitiveLabel(label) {
    return sensitiveComponents(label).length > 0;
}

/**
 * Declaración de procedencia. Exige AMBOS campos: el booleano y un
 * `authorized_by` no vacío. Obligar a nombrarse convierte el bypass en una
 * línea de audit atribuible, en vez de un flag anónimo.
 */
function declaredAuthorization(order) {
    if (!order || order.guardrail_authorized !== true) return null;
    const by = typeof order.authorized_by === 'string' ? order.authorized_by.trim() : '';
    if (!by) return null;
    return by;
}

/**
 * Evalúa una orden de la cola de GitHub. **No muta nada.**
 *
 * @param {object} params
 * @param {string} params.action        - 'label' | 'remove-label' (otras → permitidas).
 * @param {string} params.label         - label solicitado. Puede ser una LISTA
 *        CSV (`"a,b"`), que es como `gh` la interpreta: se evalúa componente
 *        por componente (SEC-F), nunca como string entero.
 * @param {object} [params.order]       - la orden completa (procedencia declarada).
 * @param {function} [params.getCurrentLabels] - () => string[]. Puede tirar.
 * @returns {{allowed:boolean, motivo:string, consulted:boolean, currentLabels:(string[]|null), authorizedBy?:string, error?:string}}
 */
function evaluateLabelOrder({ action, label, order = {}, getCurrentLabels } = {}) {
    const lbl = String(label || '');
    const act = String(action || '');

    if (act !== 'label' && act !== 'remove-label') {
        return { allowed: true, motivo: 'accion-fuera-del-dominio', consulted: false, currentLabels: null };
    }
    // SEC-F — el campo `label` es una LISTA CSV. Se decide sobre los componentes,
    // nunca sobre el string entero (ver bloque SEC-F arriba).
    const componentes = parseLabelList(lbl);

    // SEC-D — cortar acá evita el `gh issue view` extra en el 99% de las órdenes.
    if (!componentes.some((c) => SENSITIVE_LABELS.includes(c))) {
        return { allowed: true, motivo: 'label-no-sensible', consulted: false, currentLabels: null };
    }

    const authorizedBy = declaredAuthorization(order);

    // -------------------------------------------------------------------------
    // SEC-B — `remove-label`. El `case 'remove-label'` de `servicio-github.js`
    // no tiene guardia de staleness ni pasa por el reconciliador (ni
    // `needs-human` ni `recommendation:approved` son gate labels QA), así que
    // hoy `{"action":"remove-label","issue":N,"label":"needs-human"}` destraba
    // cualquier issue bloqueado por un humano, sin log y sin auditoría.
    //
    // No se consulta el estado actual: la decisión depende sólo de la
    // procedencia. Remover un label ausente es un no-op benigno.
    // -------------------------------------------------------------------------
    if (act === 'remove-label') {
        // SEC-F — `needs-human` en CUALQUIER posición del CSV, no sólo solo.
        if (!componentes.includes(NEEDS_HUMAN)) {
            return { allowed: true, motivo: 'remove-label-no-restringido', consulted: false, currentLabels: null };
        }
        if (!authorizedBy) {
            return {
                allowed: false,
                motivo: MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO,
                consulted: false,
                currentLabels: null,
            };
        }
        return {
            allowed: true,
            motivo: 'remove-needs-human-con-origen-autorizado',
            consulted: false,
            currentLabels: null,
            authorizedBy,
        };
    }

    // -------------------------------------------------------------------------
    // SEC-A — el gate nuevo es **aditivo**: el humano aprueba agregando
    // `recommendation:approved` (`pulpo.js:16535`). Sin esta guardia, un JSON
    // de 80 bytes en la cola auto-aprueba una recomendación y la mete en la
    // ola sin que nadie la haya mirado. Es R4 mudado de la remoción a la
    // adición: cerrar la puerta y dejar la ventana.
    //
    // La ruta legítima es `lib/recommendations.js` (dashboard), que no pasa
    // por acá.
    // -------------------------------------------------------------------------
    const pideNeedsHuman = componentes.includes(NEEDS_HUMAN);
    const pideRecomendacion = componentes.includes(TIPO_RECOMENDACION);
    const pideApproved = componentes.includes(RECOMMENDATION_APPROVED);

    // SEC-F — mezcla dentro de UNA SOLA orden: `label: "needs-human,tipo:recomendacion"`
    // aplica los dos labels de una. No hace falta consultar el estado actual, la
    // orden ya es la mezcla. Va ANTES del chequeo de procedencia a propósito: el
    // CA pide que volver a mezclarlos sea imposible **por construcción**, así que
    // la declaración de procedencia no habilita esta combinación (mismo criterio
    // que las dos reglas de mezcla contra el estado actual).
    if (pideNeedsHuman && pideRecomendacion) {
        return { allowed: false, motivo: MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN, consulted: false, currentLabels: null };
    }

    if (pideApproved && !authorizedBy) {
        return { allowed: false, motivo: MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO, consulted: false, currentLabels: null };
    }

    // Ningún componente tiene regla de mezcla contra el estado actual
    // (`source:recommendation`, o `recommendation:approved` ya autorizado):
    // se resuelve sin gastar el `gh issue view`.
    if (!pideNeedsHuman && !pideRecomendacion) {
        return {
            allowed: true,
            motivo: pideApproved ? 'approved-con-origen-autorizado' : 'label-sensible-sin-regla-de-mezcla',
            consulted: false,
            currentLabels: null,
            ...(pideApproved ? { authorizedBy } : {}),
        };
    }

    // -------------------------------------------------------------------------
    // SEC-C — fail-closed ante consulta indeterminada.
    //
    // `getIssueLabels` es un `execFileSync` de `gh issue view` con timeout y
    // sin try/catch. Si falla (rate limit, red caída, token vencido, timeout)
    // la tentación es devolver `[]`. Con `[]` el guardrail no ve conflicto y
    // deja pasar TODO → se vuelve bypasseable a voluntad induciendo rate limit.
    // Acá: si no podemos determinar los labels actuales, **se rechaza**.
    // Nunca "ante la duda, aplicar".
    // -------------------------------------------------------------------------
    let currentLabels;
    try {
        currentLabels = typeof getCurrentLabels === 'function' ? getCurrentLabels() : null;
    } catch (e) {
        return {
            allowed: false,
            motivo: MOTIVOS.INDETERMINADO,
            consulted: true,
            currentLabels: null,
            error: (e && e.message) || String(e),
        };
    }
    if (!Array.isArray(currentLabels)) {
        return {
            allowed: false,
            motivo: MOTIVOS.INDETERMINADO,
            consulted: true,
            currentLabels: null,
            error: 'getCurrentLabels no devolvió un array',
        };
    }
    const actuales = currentLabels.map(String);

    // SEC-F — se evalúa el COMPONENTE pedido, no el string entero.
    if (pideNeedsHuman && actuales.includes(TIPO_RECOMENDACION)) {
        return { allowed: false, motivo: MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO, consulted: true, currentLabels: actuales };
    }
    if (pideRecomendacion && actuales.includes(NEEDS_HUMAN)) {
        return { allowed: false, motivo: MOTIVOS.MEZCLA_RECO_SOBRE_BLOQUEO, consulted: true, currentLabels: actuales };
    }
    return {
        allowed: true,
        motivo: 'sin-conflicto',
        consulted: true,
        currentLabels: actuales,
        ...(pideApproved ? { authorizedBy } : {}),
    };
}

// -----------------------------------------------------------------------------
// AUDITORÍA
//
// SEC-E — rotación. `.pipeline/audit/` no tenía rotación y este proyecto ya
// tuvo incidentes de disco lleno. Un productor en bucle que reintenta una orden
// rechazada escribiría una línea por intento, sin techo. Dos defensas:
//   - archivo por día (`label-guardrail-YYYY-MM-DD.jsonl`) + corte por tamaño;
//   - dedupe de conflictos idénticos consecutivos dentro del proceso.
//
// UX-4c — no se vuelca el payload completo: issue, label pedido, labels
// actuales, acción, motivo y origen alcanzan para el forense.
// -----------------------------------------------------------------------------

const AUDIT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB por archivo antes de rotar

function defaultAuditDir() {
    const pipelineDir = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname, '..');
    return path.join(pipelineDir, 'audit');
}

function auditFileFor(dir, ts) {
    const dia = String(ts || new Date().toISOString()).slice(0, 10); // YYYY-MM-DD
    return path.join(dir, `label-guardrail-${dia}.jsonl`);
}

/**
 * Corte por tamaño. El hash chain de `audit-log` arranca en GENESIS por
 * archivo, así que rotar no rompe la verificabilidad: cada archivo es una
 * cadena completa e independiente.
 */
function rotateIfNeeded(file, maxBytes = AUDIT_MAX_BYTES, fsImpl = fs) {
    try {
        if (!fsImpl.existsSync(file)) return false;
        const st = fsImpl.statSync(file);
        if (Number(st.size || 0) < maxBytes) return false;
        // Un solo archivo rotado: el `.1` previo se descarta. Es un log de
        // señal, no de contabilidad — retener 5 MB del histórico alcanza y
        // acota el crecimiento a 10 MB duros.
        const rotated = file + '.1';
        try { fsImpl.rmSync(rotated, { force: true }); } catch { /* best-effort */ }
        fsImpl.renameSync(file, rotated);
        return true;
    } catch {
        return false;
    }
}

// Dedupe de conflictos idénticos **consecutivos**, por proceso. Acota el caso
// del productor en bucle sin perder el primer registro del conflicto.
let _lastConflictKey = null;

function _resetDedupeForTests() {
    _lastConflictKey = null;
}

/**
 * Registra un conflicto rechazado. Nunca tira: un fallo de auditoría no debe
 * matar al worker de la cola. Y como el rechazo ya ocurrió antes de llegar acá,
 * un fallo de escritura nunca puede convertirse en una mutación.
 *
 * @returns {{written:boolean, deduped?:boolean, rotated?:boolean, file?:string, error?:string}}
 */
function auditConflict({
    issue,
    label_solicitado,
    labels_actuales,
    origen,
    accion,
    motivo,
    event = 'label_guardrail_conflict',
    authorized_by,
    ts,
    dir,
    maxBytes,
    fsImpl,
} = {}) {
    const cuando = ts || new Date().toISOString();
    const key = [event, accion, issue, label_solicitado, motivo].join('|');
    if (key === _lastConflictKey) {
        return { written: false, deduped: true };
    }
    _lastConflictKey = key;

    const auditDir = dir || defaultAuditDir();
    const file = auditFileFor(auditDir, cuando);
    let rotated = false;
    try {
        const _fs = fsImpl || fs;
        if (!_fs.existsSync(auditDir)) _fs.mkdirSync(auditDir, { recursive: true });
        rotated = rotateIfNeeded(file, maxBytes || AUDIT_MAX_BYTES, _fs);
        auditLog.appendChained({
            file,
            entry: {
                ts: cuando,
                event,
                issue: Number(issue) || null,
                accion: accion || null,
                label_solicitado: label_solicitado || null,
                labels_actuales: Array.isArray(labels_actuales) ? labels_actuales : null,
                origen: origen || null,
                motivo: motivo || null,
                authorized_by: authorized_by || null,
            },
            fsImpl,
        });
        return { written: true, rotated, file };
    } catch (e) {
        return { written: false, rotated, file, error: (e && e.message) || String(e) };
    }
}

/**
 * Registra el uso del bypass de procedencia sobre una mutación sensible. La
 * declaración no es criptográfica: lo que la hace útil es que queda escrita,
 * atribuida y encadenada. Sin este registro, el escape hatch sería invisible.
 */
function auditAuthorizedBypass(ctx = {}) {
    return auditConflict({ ...ctx, event: 'label_guardrail_bypass_autorizado' });
}

/**
 * UX-4a — línea legible en español para el log normal del servicio, para que el
 * operador entienda qué pasó sin abrir `.pipeline/audit/`.
 * UX-4b — deliberadamente NO notifica por Telegram: es señal de auditoría, no
 * de bloqueo. Notificar cada rechazo reintroduciría exactamente el ruido que
 * este issue viene a eliminar.
 * UX-4c — no incluye el payload completo ni secretos.
 */
function describeRejection({ issue, label_solicitado, labels_actuales, motivo, accion, origen }) {
    const explicaciones = {
        [MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO]:
            `el issue ya es una recomendación (${TIPO_RECOMENDACION}) y ${NEEDS_HUMAN} es para bloqueos reales`,
        [MOTIVOS.MEZCLA_RECO_SOBRE_BLOQUEO]:
            `el issue está bloqueado por un humano (${NEEDS_HUMAN}) y no puede marcarse como recomendación`,
        [MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN]:
            `la orden pide aplicar ${NEEDS_HUMAN} y ${TIPO_RECOMENDACION} juntos, que es exactamente la mezcla que este guardrail existe para impedir`,
        [MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO]:
            'aprobar una recomendación es una acción humana: va por el panel del dashboard, no por la cola',
        [MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO]:
            'destrabar un bloqueo humano es una acción humana: va por el panel o la alerta de Telegram, no por la cola',
        [MOTIVOS.INDETERMINADO]:
            'no se pudieron determinar los labels actuales del issue y el guardrail falla cerrado',
    };
    const porque = explicaciones[motivo] || motivo;
    const actuales = Array.isArray(labels_actuales) && labels_actuales.length
        ? ` Labels actuales: ${labels_actuales.join(', ')}.`
        : '';
    const verbo = accion === 'remove-label' ? 'remover' : 'agregar';
    return (
        `Guardrail de labels: rechazada la orden de ${verbo} "${label_solicitado}" en #${issue} — ${porque}.` +
        `${actuales} Origen: ${origen || 'desconocido'}. El issue NO fue modificado.`
    );
}

module.exports = {
    // constantes
    NEEDS_HUMAN,
    TIPO_RECOMENDACION,
    SOURCE_RECOMMENDATION,
    RECOMMENDATION_APPROVED,
    SENSITIVE_LABELS,
    MOTIVOS,
    AUDIT_MAX_BYTES,
    // API
    isSensitiveLabel,
    parseLabelList,
    sensitiveComponents,
    declaredAuthorization,
    evaluateLabelOrder,
    auditConflict,
    auditAuthorizedBypass,
    describeRejection,
    // helpers expuestos para tests
    auditFileFor,
    defaultAuditDir,
    rotateIfNeeded,
    _resetDedupeForTests,
};
