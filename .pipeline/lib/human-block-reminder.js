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
// #6190 — el recordatorio NO redacta copy propio: le pide la ficha al módulo
// compartido y la dibuja con el mismo renderer que el aviso inicial. Si armara
// su propia versión volveríamos al problema que #6190 cierra: dos textos que
// describen lo mismo y divergen sin que nadie se entere.
const decisionCard = require('./decision-card');
// Se importa el RENDERER, no `human-block`: este módulo no puede alcanzar
// `unblockIssue` ni `dismissBlockedIssue` ni por vía indirecta (ver la garantía
// estructural arriba, y su test en `human-block-notificacion.test.js`).
const cardRender = require('./decision-card-render');
// #6190 — `listBlockedIssues()` NO trae `titulo` ni `labels` (el marker es un
// archivo vacío con el número en el nombre): el `due` que llega acá viene con
// esa forma cruda. Sin enriquecer, TODAS las fichas del recordatorio salían con
// "(sin título)" mientras el aviso inicial —con el mismo dato y en el mismo
// instante— salía con el título real. Es un módulo de SÓLO LECTURA de cache:
// no le da a este módulo ninguna capacidad de destrabe, así que no viola la
// garantía estructural de arriba.
const issueTitleCache = require('./issue-title-cache');

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
 * #6190 — Migrado a la ficha de decisión. Antes emitía **Markdown vivo** (`*`,
 * `_`, backticks) y `pulpo.js` lo enviaba SIN `plain:true`: era el séptimo
 * camino, el único que seguía expuesto a #5421 (markup desbalanceado → HTTP 400
 * de Telegram → recordatorio perdido sin rastro, porque el saliente es
 * fire-and-forget vía dropfile y nadie ve el 400). Ahora sale en texto plano y
 * el copy lo produce `lib/decision-card.js`, igual que el aviso inicial: el
 * recordatorio NO tiene copy propio, que es exactamente CA-1. Lo único suyo son
 * el encabezado y el cierre.
 *
 * El encabezado dice el NÚMERO DE AVISO, no "recordatorio" (H-UX-8): el
 * operador que ya vio dos de estos lee "recordatorio" y archiva sin abrir. La
 * información que cambia el comportamiento es cuántas veces ya se avisó, y
 * hasta ahora vivía escondida en un paréntesis en cursiva de cada línea.
 *
 * El destacado —la única ficha completa— es el MÁS ANTIGUO: el recordatorio es
 * un barrido sin disparador, así que no hay "el que motivó el mensaje", y el
 * más viejo es el que más caro sale seguir ignorando.
 *
 * FAIL-CLOSED: si armar las fichas lanza, el recordatorio SALE IGUAL en texto
 * plano, redactado y sin volcar el motivo crudo. Un bloqueo no puede dejar de
 * recordarse porque falló el formateador. Nunca `catch {}` vacío.
 *
 * TÍTULO (CA-1/CA-2): el `due` llega con la forma cruda de
 * `listBlockedIssues()`, que no trae `titulo` ni `labels`. Se enriquece con el
 * MISMO módulo que usa el aviso inicial antes de armar las fichas — si no, el
 * recordatorio emite "(sin título)" para todos los issues y deja de ser "el
 * mismo cuerpo que el mensaje agrupado", que es literalmente lo que el mockup
 * 6190-01 panel B declara.
 *
 * @param {Array}  due     — salida de `evaluateReminders().due`.
 * @param {number} [nowMs] — "ahora" inyectable (CA-A6).
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir] — dir de `.pipeline` para el cache de
 *   títulos (inyectable en tests; en producción lo pasa `runReminderTick`).
 * @returns {string} texto PLANO, o '' si no hay nada que recordar.
 */
function buildReminderMessage(due, nowMs, opts) {
    const list = Array.isArray(due) ? due : [];
    if (!list.length) return '';

    // Antigüedad descendente: el más viejo primero, y por lo tanto destacado.
    const ordenados = list.slice().sort((a, b) => (b.age_hours || 0) - (a.age_hours || 0));

    // El número de aviso del encabezado es el más alto del grupo: es el que
    // mide hace cuánto que el operador viene sin responder.
    const avisos = ordenados
        .map((d) => Number(d.reminder_number))
        .filter((n) => Number.isInteger(n) && n > 0);
    const avisoMax = avisos.length ? Math.max(...avisos) : 1;
    const encabezado = `🔁 ${decisionCard.encabezadoRecordatorio(avisoMax, ordenados.length)}`;
    const cierre = decisionCard.CIERRE_RECORDATORIO;

    // Mapa issue → número de aviso, para que cada línea compacta lleve el suyo.
    // Es contexto de urgencia, no un contador crudo de máquina: por eso se dice
    // "2º aviso" y no `reminder_number=2`.
    const porIssue = {};
    for (const d of ordenados) {
        const n = Number(d.reminder_number);
        if (Number.isInteger(n) && n > 1) porIssue[Number(d.issue)] = n;
    }

    let cuerpo;
    try {
        const enriquecidos = issueTitleCache.enriquecerConTitulo(
            ordenados,
            { pipelineDir: opts && opts.pipelineDir },
        );
        const cards = decisionCard.buildDecisionCards(enriquecidos, nowMs);
        // El presupuesto del bloque de fichas descuenta lo que ocupan el
        // encabezado y el cierre: si no, el recordatorio entra justo y el
        // transporte lo trunca en silencio — la falla que este issue cierra.
        const reservado = encabezado.length + cierre.length + 8;
        cuerpo = cardRender.renderDecisionCardsPlain(
            cards,
            cardRender.FICHA_BUDGET - reservado,
            { encabezado: false, avisos: porIssue },
        );
    } catch (e) {
        try {
            process.stderr.write(`[hb-reminder] ficha falló, se recuerda en forma degradada: ${e && e.message}\n`);
        } catch (_) { /* stderr cerrado */ }
        // Degradado: título y antigüedad, nada más. Volcar el motivo crudo
        // "porque total es el fallback" es la forma exacta en que este camino
        // filtra un stack o un volcado de config (SEC-1).
        cuerpo = ordenados.map((d) => {
            const issue = Number(d.issue);
            const num = Number.isInteger(issue) && issue > 0 ? `#${issue}` : 'Un trabajo sin número';
            const aviso = decisionCard.sufijoAviso(d.reminder_number);
            return `${num} — frenado hace ${formatAge(d.age_hours)}${aviso ? `, ${aviso}` : ''}.`;
        }).join('\n');
    }

    return [encabezado, '', cuerpo, '', cierre].join('\n').replace(/\n{3,}/g, '\n\n');
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

        const texto = buildReminderMessage(due, now.getTime(), { pipelineDir });

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
