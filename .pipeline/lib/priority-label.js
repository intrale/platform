// =============================================================================
// priority-label.js — Punto único de mutación del label `priority:*` de un
// issue, con emisión de audit trail (issue #4371, Ola 8.3, CA-3).
//
// La prioridad de un issue NO vive en `waves.json`: es un label de GitHub
// (`priority:high|medium|low`) mutado desde varios puntos del pipeline. Para que
// "quién cambió la prioridad" quede auditado de forma completa —y no dependa de
// que cada call-site futuro se acuerde de emitir— centralizamos la mutación acá:
// cualquier punto que cambie la prioridad debe pasar por `setPriorityLabel`, que
// (a) encola la mutación del label y (b) emite `priority_changed` a `wave-audit`.
//
// La emisión del audit es best-effort (ver `wave-audit`): si falla, se loguea
// pero NO rompe la mutación del label (CA-12). La mutación del label se hace vía
// una función `enqueue` inyectada por el caller (fire-and-forget sobre el
// filesystem — nunca invoca `gh` en proceso: regla "el pipeline no puede morir").
// =============================================================================
'use strict';

// Labels de prioridad válidos (enum cerrado). Un valor fuera de acá es un bug
// del caller → throw.
const PRIORITY_LABELS = Object.freeze(['priority:high', 'priority:medium', 'priority:low']);

function isPriorityLabel(v) {
    return typeof v === 'string' && PRIORITY_LABELS.includes(v);
}

/**
 * Cambia el label de prioridad de un issue y audita el cambio.
 *
 * @param {object} params
 * @param {number} params.issue — número del issue.
 * @param {string} params.priority — nuevo label (`priority:high|medium|low`).
 * @param {function} params.enqueue — `(action, payload) => any` que encola la
 *   mutación de label en la cola de github (inyectado por el caller para evitar
 *   ciclos de require y facilitar tests).
 * @param {string} [params.actor='desconocido'] — actor autenticado (no self-report).
 * @param {string|null} [params.previousPriority=null] — prioridad previa si se
 *   conoce (para `prioridad_previa`). Si no se conoce, queda null.
 * @param {boolean} [params.removePrevious=true] — si además de agregar el nuevo
 *   label, encola el remove del previo (cuando difiere y es un priority:* válido).
 * @param {string} [params.note] — nota libre para el audit.
 * @param {object} [params.deps] — overrides para tests ({ audit }).
 * @returns {{ ok: boolean, issue: number, priority: string }}
 * @throws si `issue` no es entero > 0, `priority` no es un priority:* válido, o
 *   `enqueue` no es función.
 */
function setPriorityLabel({
    issue,
    priority,
    enqueue,
    actor = 'desconocido',
    previousPriority = null,
    removePrevious = true,
    note,
    deps = {},
} = {}) {
    const i = Number(issue);
    if (!Number.isInteger(i) || i <= 0) {
        throw new Error(`setPriorityLabel: issue inválido (${issue})`);
    }
    if (!isPriorityLabel(priority)) {
        throw new Error(`setPriorityLabel: priority inválido "${priority}" (válidos: ${PRIORITY_LABELS.join(', ')})`);
    }
    if (typeof enqueue !== 'function') {
        throw new Error('setPriorityLabel: se requiere una función enqueue(action, payload).');
    }

    // 1. Mutación del label (autoritativa). Agregar el nuevo y, si aplica, sacar
    //    el previo para que el issue no quede con dos priority:* a la vez.
    enqueue('label', { issue: i, label: priority });
    if (removePrevious && isPriorityLabel(previousPriority) && previousPriority !== priority) {
        enqueue('remove-label', { issue: i, label: previousPriority });
    }

    // 2. Audit trail (CA-3), aditivo y best-effort.
    try {
        // eslint-disable-next-line global-require
        const audit = deps.audit || require('./wave-audit');
        audit.recordWaveEvent({
            event: 'priority_changed',
            issue: i,
            actor,
            prioridad_previa: isPriorityLabel(previousPriority) ? previousPriority : null,
            prioridad_nueva: priority,
            note,
        });
    } catch (e) {
        // No romper la mutación del label si el audit falla.
        // eslint-disable-next-line no-console
        console.warn(`[priority-label] audit priority_changed falló (no bloqueante): ${e.message}`);
    }

    return { ok: true, issue: i, priority };
}

module.exports = {
    setPriorityLabel,
    isPriorityLabel,
    PRIORITY_LABELS,
};
