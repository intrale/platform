'use strict';

/** Trunca por el medio y conserva los dos extremos semánticos del head_ref. */
function middleEllipsis(value, maxLength = 120) {
    const text = String(value == null ? '' : value);
    const max = Number.isInteger(maxLength) && maxLength >= 5 ? maxLength : 120;
    if (text.length <= max) return text;
    const available = max - 1;
    const left = Math.ceil(available / 2);
    const right = Math.floor(available / 2);
    return text.slice(0, left) + '…' + text.slice(text.length - right);
}

function buildCeilingNotice({ issue, kind, pr, attempts }) {
    const cause = `${kind} sobre el PR #${pr}`;
    return {
        telegram: `🚨 Issue #${issue}: el auto-destrabe alcanzó el techo de ${attempts} intentos para ${cause}. El auto-destrabe queda deshabilitado para esta causa y el issue sigue en needs-human. Requiere intervención humana.`,
        comment: [
            '## 🚨 Auto-destrabe deshabilitado por intentos agotados',
            '',
            `El pipeline intentó reactivar este issue ${attempts} veces por la causa repetida \`${kind}\` sobre el PR #${pr}.`,
            '',
            '**El auto-destrabe queda deshabilitado para esta causa.** El issue sigue en `needs-human` hasta que una persona revise el bloqueo.',
        ].join('\n'),
    };
}

module.exports = { middleEllipsis, buildCeilingNotice };
