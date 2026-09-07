'use strict';

function resolveNotice(decision) {
    if (decision.alert === 'expiry') return decision.threshold === 't10' ? 'A2_urgente' : 'A1_por_vencer';
    if (decision.alert === 'health_unavailable') return 'A3_chequeo_sin_datos';
    if (decision.alert === 'health_recovered') return 'A4_chequeo_recuperado';
    return 'A5_renovada';
}

function runOAuthExpiryTick({ evaluate, notify, render, recordEmitted, statePath }) {
    const decision = evaluate({ statePath });
    if (!decision.shouldEmit) return { emitted: false, decision };
    const notification = notify(render(resolveNotice(decision), {
        minutesLeft: decision.minutesLeft,
        ageMinutes: decision.ageMinutes,
    }));
    if (!notification || notification.ok !== true) return { emitted: false, decision, notification };
    recordEmitted({ statePath, alert: decision.alert, threshold: decision.threshold });
    return { emitted: true, decision, notification };
}

module.exports = { runOAuthExpiryTick };
