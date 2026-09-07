'use strict';
const { patch } = require('./patch');

patch('.pipeline/lib/commander/inflight-fallback.js', [
  [
`// ACA SOLO SE DEFINE. El emisor real -el que decide si una entrega quedo
// huerfana- es #6459. Este bloque no detecta huerfanos ni notifica a nadie.
// -----------------------------------------------------------------------------
function noteFallbackDeliveryResolved(opts = {}) {
    const {
        pipelineDir,
        primaryProvider,
        secondaryProvider,
        deliveryState,
        resolvedBy,
        chatId,
        requestId,
        commanderReqId,
        skill,
        auditLog,
        fsImpl,
        now,
    } = opts;`,
`// #6459 - PRIMER CONSUMIDOR EN RUNTIME: \`lib/commander/orphan-sweep.js\`.
//
// R-1 (verificado por guru en fase validacion): el entry NO tenia \`success\` ni
// \`error_code\`, y los literales \`'delivered'\`/\`'not_delivered'\` que proponia el
// body de #6459 NO existen en \`DELIVERY_STATES\` -_normalizeDeliveryState los
// colapsa a \`null\` EN SILENCIO-. Sin esta extension, CA-2 y CA-3 de #6459 son
// inverificables: un cierre fallido y uno exitoso quedan indistinguibles en el
// audit. Los dos campos nuevos van ADITIVOS ESTRICTAMENTE AL FINAL (mismo patron
// que #4413/#4438/#6458) para preservar el shape canonico y la hash-chain de
// las entradas viejas que no los traen.
//
// El mapeo correcto es: entrega confirmada -> \`delivery_observed\` + success
// true; entrega no confirmada -> \`delivery_failed\` + success false +
// \`error_code: 'delivered=false'\` (distinguible de \`empty_output\`).
// -----------------------------------------------------------------------------
function noteFallbackDeliveryResolved(opts = {}) {
    const {
        pipelineDir,
        primaryProvider,
        secondaryProvider,
        deliveryState,
        resolvedBy,
        chatId,
        requestId,
        commanderReqId,
        skill,
        // #6459 - aditivos. Ausentes => \`null\` (no observado), que es distinto
        // de \`false\` (observado como fallo): el tri-estado se preserva.
        success,
        errorCode,
        auditLog,
        fsImpl,
        now,
    } = opts;`],

  [
`            resolved_by: typeof resolvedBy === 'string' ? resolvedBy.slice(0, 64) : null,
            commander_req_id: commanderReqId || null,
            delivery_state: _normalizeDeliveryState(deliveryState),
        },
    });
}`,
`            resolved_by: typeof resolvedBy === 'string' ? resolvedBy.slice(0, 64) : null,
            commander_req_id: commanderReqId || null,
            delivery_state: _normalizeDeliveryState(deliveryState),
            // #6459 - ADITIVOS AL FINAL. \`success\` es tri-estado (true/false/null)
            // por la misma razon que en \`noteInflightCompleted\`: "no observado" y
            // "observado como fallo" son cosas distintas. \`error_code\` es texto
            // acotado a 64 chars (anti log-forging).
            success: success === true ? true : (success === false ? false : null),
            error_code: typeof errorCode === 'string' && errorCode ? errorCode.slice(0, 64) : null,
        },
    });
}`],
]);
