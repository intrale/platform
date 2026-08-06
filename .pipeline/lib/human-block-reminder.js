// =============================================================================
// human-block-reminder.js — Recordatorio escalado de bloqueos humanos sin
// responder (#5337, CA-5). FAIL-CLOSED: el silencio NUNCA aprueba.
//
// El aviso inicial de `needs-human` vive dentro del gate `if (!yaBloqueado)` de
// `pulpo.js` — por diseño (SEC-5 de #4067): dispara SOLO en la transición, para
// no spamear una alerta idéntica en cada tick del barrido. Correcto, pero deja
// un hueco: si el operador no vio ese único mensaje, el bloqueo queda mudo para
// siempre. Este módulo es la ruta NUEVA que cubre el hueco; no relaja aquel
// gate (quitarlo convertiría el aviso en spam por tick).
//
// -----------------------------------------------------------------------------
// LA REGLA QUE NO SE NEGOCIA
// -----------------------------------------------------------------------------
// Este módulo NO tiene forma de resolver un bloqueo. No importa `unblockIssue`,
// no importa `dismissBlockedIssue`, no escribe en `bloqueado-humano/` y no
// encola nada en el servicio-github. Su único efecto observable es MANDAR UN
// MENSAJE y anotar cuándo lo mandó. La imposibilidad de auto-aprobar por
// vencimiento de plazo es estructural, no una promesa del comentario: si algún
// día alguien intenta agregar acá un auto-destrabe, tiene que importar módulos
// que hoy este archivo deliberadamente no conoce.
// Coherente con `docs/pipeline/gates-firma-operador.md`.
//
// -----------------------------------------------------------------------------
// ESCALADO
// -----------------------------------------------------------------------------
// Espaciado creciente para no quemar la señal: 2h → 6h → 24h → después cada 72h,
// indefinidamente. El piso nunca es "cero recordatorios para siempre": un
// bloqueo de una semana sigue avisando, sólo que cada 3 días.
//
// -----------------------------------------------------------------------------
// PERSISTENCIA
// -----------------------------------------------------------------------------
// El estado va en `.pipeline/human-block-reminder-state.json`, GITIGNOREADO
// junto a sus pares (`blocked-issues.json`, `cooldowns.json`). El repo
// principal hace `reset --hard` en cada respawn: un archivo de estado versionado
// se pisaría con el template vacío y los recordatorios se reiniciarían solos
// (es exactamente lo que ya mordió a `waves.json`).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Escalones de recordatorio, en horas desde el bloqueo. Después del último se
// repite cada `RECURRING_EVERY_HOURS`.
const REMINDER_STEPS_HOURS = Object.freeze([2, 6, 24]);
const RECURRING_EVERY_HOURS = 72;

const STATE_FILENAME = 'human-block-reminder-state.json';

function defaultStateFilePath(pipelineDir) {
    return path.join(pipelineDir, STATE_FILENAME);
}

/**
 * Lee el estado. Cualquier problema (no existe, JSON corrupto, permisos) → estado
 * vacío. Nunca lanza: el recordatorio es accesorio y no puede matar al pulpo.
 */
function readState(stateFile) {
    try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.issues && typeof parsed.issues === 'object') {
            return parsed;
        }
        return { issues: {} };
    } catch {
        return { issues: {} };
    }
}

/**
 * Escribe el estado de forma atómica (tmp + rename) para que un corte a mitad
 * de escritura no deje un JSON truncado que después se lea como estado vacío
 * (lo que reiniciaría el escalado de todos los bloqueos).
 */
function writeState(stateFile, state) {
    try {
        const tmp = `${stateFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, stateFile);
        return true;
    } catch {
        return false;
    }
}

/**
 * ¿Cuántos recordatorios corresponden haber mandado a las `ageHours` de bloqueo?
 * Determinística y pura: es el corazón del escalado y la parte que testea CA-5.
 */
function dueCount(ageHours) {
    if (!Number.isFinite(ageHours) || ageHours <= 0) return 0;
    let n = 0;
    for (const step of REMINDER_STEPS_HOURS) {
        if (ageHours >= step) n++;
    }
    if (n < REMINDER_STEPS_HOURS.length) return n;
    const last = REMINDER_STEPS_HOURS[REMINDER_STEPS_HOURS.length - 1];
    const extra = Math.floor((ageHours - last) / RECURRING_EVERY_HOURS);
    return n + Math.max(0, extra);
}

/**
 * Evalúa qué bloqueos merecen recordatorio AHORA.
 *
 * Función pura: no toca disco ni red. Recibe la lista de bloqueos y el estado
 * previo, devuelve los vencidos y el estado siguiente.
 *
 * @param {object} args
 * @param {Date|number} args.now
 * @param {Array} args.blocked  — salida de `listBlockedIssues()`.
 * @param {object} [args.state]
 * @returns {{due: Array, nextState: object, pruned: number[]}}
 */
function evaluateReminders({ now, blocked, state } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const prev = (state && state.issues && typeof state.issues === 'object') ? state.issues : {};
    const list = Array.isArray(blocked) ? blocked : [];

    const nextIssues = {};
    const due = [];

    for (const b of list) {
        if (!b) continue;
        const issue = Number(b.issue);
        if (!Number.isFinite(issue)) continue;
        const key = String(issue);

        // Antigüedad: preferimos `blocked_at` (dato del marker) sobre `age_hours`
        // (derivado del mtime, que se mueve si alguien toca el archivo).
        let ageHours = Number(b.age_hours);
        const blockedAtMs = Date.parse(b.blocked_at || '');
        if (Number.isFinite(blockedAtMs) && Number.isFinite(nowMs)) {
            ageHours = (nowMs - blockedAtMs) / 3600000;
        }
        if (!Number.isFinite(ageHours)) ageHours = 0;

        const target = dueCount(ageHours);
        const previo = prev[key] && Number.isFinite(Number(prev[key].sent)) ? Number(prev[key].sent) : 0;

        // Si el marker es MÁS NUEVO que el que vimos la última vez, es un bloqueo
        // distinto sobre el mismo issue (se destrabó y se volvió a trabar): el
        // escalado arranca de cero en vez de heredar los recordatorios viejos.
        const previoBlockedAt = prev[key] ? prev[key].blocked_at : null;
        const reinicio = previoBlockedAt && b.blocked_at && previoBlockedAt !== b.blocked_at;
        const sent = reinicio ? 0 : previo;

        if (target > sent) {
            due.push({
                issue,
                skill: b.skill || '—',
                phase: b.phase || '—',
                pipeline: b.pipeline || null,
                reason: b.reason || '',
                question: b.question || '',
                age_hours: Math.round(ageHours * 10) / 10,
                reminder_number: target,
            });
            nextIssues[key] = {
                sent: target,
                blocked_at: b.blocked_at || null,
                last_reminder_at: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
            };
        } else {
            nextIssues[key] = {
                sent,
                blocked_at: b.blocked_at || null,
                last_reminder_at: (prev[key] && prev[key].last_reminder_at) || null,
            };
        }
    }

    // Poda: los issues que ya no están bloqueados salen del estado. Que
    // desaparezcan de acá NO los destraba — es al revés: el estado sigue a la
    // lista de bloqueos, que es la fuente de verdad (filesystem).
    const pruned = Object.keys(prev)
        .filter((k) => !(k in nextIssues))
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n));

    return { due, nextState: { issues: nextIssues }, pruned };
}

function formatAge(ageHours) {
    if (!Number.isFinite(ageHours) || ageHours < 1) {
        return `${Math.max(1, Math.round((ageHours || 0) * 60))}min`;
    }
    if (ageHours < 48) return `${Math.round(ageHours)}h`;
    return `${Math.round(ageHours / 24)}d`;
}

/**
 * CA-4/CA-5 — UN SOLO mensaje con todos los bloqueos vencidos (agrupado, para
 * no spamear un mensaje por issue).
 *
 * Guideline UX: el recordatorio tiene que distinguirse a simple vista del aviso
 * inicial. Si son idénticos, el operador no sabe si está viendo un bloqueo
 * nuevo o el mismo de hace 6 horas. Por eso el encabezado es `🔁 Recordatorio`
 * (el aviso inicial usa `🚧`) y cada ítem lleva su antigüedad y el número de
 * recordatorio.
 *
 * @param {Array} due — salida de `evaluateReminders().due`.
 * @returns {string} texto Markdown, o '' si no hay nada que recordar.
 */
function buildReminderMessage(due) {
    const list = Array.isArray(due) ? due : [];
    if (!list.length) return '';

    const ordenados = list.slice().sort((a, b) => (b.age_hours || 0) - (a.age_hours || 0));
    const plural = ordenados.length === 1 ? '' : 's';
    const lines = [];
    lines.push(`🔁 *Recordatorio: ${ordenados.length} bloqueo${plural} esperando tu respuesta*`);
    lines.push('');

    for (const d of ordenados) {
        const nro = d.reminder_number > 1 ? ` · aviso #${d.reminder_number}` : '';
        lines.push(`• *#${d.issue}* — ${d.skill} en ${d.phase} _(hace ${formatAge(d.age_hours)}${nro})_`);
        const detalle = String(d.question || d.reason || '').trim();
        if (detalle) lines.push(`   ↳ ${detalle.slice(0, 160)}`);
    }

    lines.push('');
    lines.push('_Siguen bloqueados: nada se aprueba solo por dejar pasar el tiempo._');
    lines.push('_Usá_ `/unblock <issue> <orientación>` _para destrabar._');
    return lines.join('\n');
}

/**
 * Tick del recordatorio. Lee estado, evalúa, manda UN mensaje agrupado, persiste.
 *
 * NUNCA lanza y NUNCA modifica el estado de bloqueo de ningún issue.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {Function} opts.listBlocked    — () => Array (inyectable en tests).
 * @param {Function} opts.sendTelegram   — (texto, markup?) => any.
 * @param {Date}   [opts.now]
 * @param {Function} [opts.log]
 * @param {Function} [opts.buildMarkup]  — (issue) => reply_markup | undefined.
 * @returns {{sent:boolean, due:number, error?:string}}
 */
function runReminderTick(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    try {
        const pipelineDir = opts.pipelineDir;
        if (!pipelineDir) return { sent: false, due: 0, error: 'sin pipelineDir' };
        const stateFile = opts.stateFile || defaultStateFilePath(pipelineDir);
        const now = opts.now instanceof Date ? opts.now : new Date();

        let blocked = [];
        try {
            blocked = typeof opts.listBlocked === 'function' ? (opts.listBlocked() || []) : [];
        } catch (e) {
            return { sent: false, due: 0, error: `listBlocked falló: ${e.message}` };
        }

        const state = readState(stateFile);
        const { due, nextState, pruned } = evaluateReminders({ now, blocked, state });

        if (due.length === 0) {
            // Igual persistimos: la poda de issues destrabados tiene que quedar.
            if (pruned.length) writeState(stateFile, nextState);
            return { sent: false, due: 0 };
        }

        const texto = buildReminderMessage(due);

        // Botonera: sólo tiene sentido cuando el recordatorio es de UN bloqueo
        // (los botones actúan sobre un issue puntual). Con varios, el texto
        // alcanza y el operador entra por `/unblock`. Degradación con gracia: si
        // el markup no se puede armar, el texto sale igual — un bloqueo nunca
        // puede quedar invisible porque falló un canal.
        let markup;
        if (due.length === 1 && typeof opts.buildMarkup === 'function') {
            try { markup = opts.buildMarkup(due[0].issue); } catch { markup = undefined; }
        }

        try {
            opts.sendTelegram(texto, markup || null);
        } catch (e) {
            // No persistimos el avance del contador si el envío falló: así el
            // próximo tick reintenta en vez de dar por avisado algo que nunca salió.
            return { sent: false, due: due.length, error: `envío falló: ${e.message}` };
        }

        writeState(stateFile, nextState);
        log(`Recordatorio enviado: ${due.length} bloqueo(s) — ${due.map((d) => `#${d.issue}`).join(', ')}`);
        return { sent: true, due: due.length };
    } catch (e) {
        return { sent: false, due: 0, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    REMINDER_STEPS_HOURS,
    RECURRING_EVERY_HOURS,
    STATE_FILENAME,
    defaultStateFilePath,
    readState,
    writeState,
    dueCount,
    evaluateReminders,
    buildReminderMessage,
    runReminderTick,
};
