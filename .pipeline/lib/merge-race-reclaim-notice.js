'use strict';

// #6432 CA-23 / CA-24 — Copy del desenlace del barrido de rescate de merges
// varados por la carrera con los checks.
//
// POR QUÉ ESTE MÓDULO EXISTE (rebote de `ux` del 2026-08-25): la degradación a
// `human_judgment` ocurría EN SILENCIO. El marker se reescribía, el ledger se
// marcaba `degraded` y nadie se enteraba: el operador quedaba con un
// `needs-human` sin saber qué pasó ni cómo resolverlo — exactamente el problema
// que este issue venía a cerrar.
//
// CONTRATO (CA-23): el aviso de degradación dice QUÉ HACER, no sólo qué pasó.
// Los seis campos son obligatorios y el test los verifica uno por uno:
//   1. issue          2. PR
//   3. intentos agotados N/N                4. gate del último intento
//   5. reason del último intento            6. el comando `/unblock <issue> …`
//
// CONTRATO (CA-24): a Telegram salen SÓLO los dos desenlaces (merge confirmado /
// degradación). Los intentos intermedios fallidos NO notifican — su traza va a
// log + `.jsonl`. Este módulo no manda nada: sólo redacta. Quién notifica y
// cuándo lo decide `reapMergeChecksRaceBlocks`.
//
// Sin datos crudos del PR (CA-32 / SEC-8): acá sólo entran escalares ya
// clasificados, nunca el JSON de `gh pr view` (arrastra `allowed_actors` /
// `required_reviewers`).

const UNKNOWN = 'desconocido';

/** Escalar seguro para el copy: string corto, de una línea, sin objetos crudos. */
function scalar(value, maxLength = 200) {
    if (value == null) return UNKNOWN;
    if (typeof value === 'object') return UNKNOWN; // nunca volcamos objetos al operador
    const text = String(value).replace(/[\r\n]+/g, ' ').trim();
    if (!text) return UNKNOWN;
    return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Aviso ACCIONABLE de degradación a juicio humano (CA-23).
 *
 * @param {object} p
 * @param {number|string} p.issue        issue que queda en `needs-human`.
 * @param {number|string} p.pr           PR que no se pudo reclamar.
 * @param {number} p.attempts            intentos consumidos.
 * @param {number} p.maxAttempts         tope configurado.
 * @param {string} [p.gate]              gate donde frenó el último intento.
 * @param {string} [p.reason]            motivo del último intento.
 * @returns {{telegram: string, comment: string, log: string, unblockCommand: string}}
 */
function buildDegradationNotice({ issue, pr, attempts, maxAttempts, gate, reason } = {}) {
    const issueNum = scalar(issue);
    const prNum = scalar(pr);
    const max = positiveInt(maxAttempts, 3);
    const used = positiveInt(attempts, max);
    const counter = `${used}/${max}`;
    const gateText = scalar(gate);
    const reasonText = scalar(reason);

    // La orientación va DENTRO del comando: el operador copia y pega una línea
    // que ya dice qué mirar, no un `/unblock` pelado que lo deja en la misma.
    const unblockCommand = `/unblock ${issueNum} revisar el gate ${gateText} del PR #${prNum} y mergear a mano si corresponde`;

    const telegram = [
        `🚨 Issue #${issueNum}: el rescate automático del PR #${prNum} agotó sus intentos (${counter}) y pasa a destrabe manual.`,
        `Último intento: frenó en el gate \`${gateText}\` — ${reasonText}.`,
        `Qué hacer: ${unblockCommand}`,
    ].join('\n');

    const comment = [
        '## 🚨 Rescate automático agotado — pasa a destrabe manual',
        '',
        `El pipeline intentó reclamar el PR #${prNum} **${counter}** veces pasando por los gates completos de \`delivery\`. No lo logró, así que el bloqueo vuelve a ser de **juicio humano**: de acá en adelante nadie lo reintenta solo.`,
        '',
        '| Dato | Valor |',
        '|---|---|',
        `| Issue | #${issueNum} |`,
        `| PR | #${prNum} |`,
        `| Intentos agotados | ${counter} |`,
        `| Gate del último intento | \`${gateText}\` |`,
        `| Motivo del último intento | ${reasonText} |`,
        '',
        '**Qué hacer:**',
        '',
        '```',
        unblockCommand,
        '```',
        '',
        '_La degradación es pegajosa: aunque vuelva a escalarse con un hint válido, el barrido no lo toma hasta que un humano lo destrabe (#6432, D11)._',
    ].join('\n');

    const log = `[merge-race] #${issueNum} degradado a juicio humano — PR #${prNum}, intentos agotados ${counter}, gate=${gateText}, reason=${reasonText} → ${unblockCommand}`;

    return { telegram, comment, log, unblockCommand };
}

/**
 * Aviso del OTRO desenlace: merge confirmado (CA-22 / CA-25). Nunca dice
 * "mergeado" antes de que lo esté — sólo lo construye el camino que ya vio
 * `confirmMergeResponse.ok === true && merged === true`.
 */
function buildConfirmationNotice({ issue, pr, sha } = {}) {
    const issueNum = scalar(issue);
    const prNum = scalar(pr);
    const shaShort = scalar(sha).slice(0, 7);
    return {
        telegram: `✅ Issue #${issueNum}: el PR #${prNum} estaba trabado por una carrera con los checks y se rescató solo — se re-verificó con los mismos gates y el merge quedó confirmado (${shaShort}). No hace falta que hagas nada.`,
        comment: [
            '## ✅ Rescate automático confirmado',
            '',
            `Este issue había quedado en \`needs-human\` por una **carrera con los checks**: el check requerido todavía no había reportado cuando \`delivery\` pidió el merge.`,
            '',
            `El pipeline lo volvió a evaluar **con los mismos gates de \`delivery\`** — QA sobre snapshot fresco, CODEOWNERS desde \`origin/main\`, verificación de origen y SHA pinneado. **No fue un merge directo ni se saltó ningún gate.**`,
            '',
            `El merge quedó confirmado en \`${shaShort}\` y el label \`needs-human\` se retiró.`,
        ].join('\n'),
    };
}

module.exports = { buildDegradationNotice, buildConfirmationNotice, _internal: { scalar } };
