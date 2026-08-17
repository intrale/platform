// =============================================================================
// desync-block-notifier.js — Lifecycle de aviso del dispatch suspendido por
// desync (#5724 CA-3).
//
// Por qué existe
// --------------
// El detector de desync (`desync-detector.js`) manda UNA alerta al crear el
// flag. Pero el pulpo dedupea: mientras `.desync-detected.flag` siga puesto,
// cada evaluación posterior es un no-op silencioso. Resultado del incidente
// 2026-08-09: el dispatch estuvo suspendido ~10 horas con cuota disponible en
// 4 providers y la única traza fue una línea en `pulpo.log`. Nadie se enteró.
//
// Un bloqueo de dispatch NO es un evento puntual: es un estado que se agrava
// con el tiempo. Diez minutos frenado es ruido; diez horas es un incidente. La
// diferencia sólo la comunica un recordatorio que diga cuánto lleva.
//
// Diseño (mismo patrón que `quota-notifier.js`: inicial + recordatorios
// escalonados + cierre):
//
//   - `onBlocked()` se llama en CADA evaluación mientras el bloqueo siga vivo.
//     El módulo decide solo si toca recordar, según los escalones de backoff.
//     El pulpo evalúa cada ~5 min: sin backoff serían ~120 mensajes en 10 h.
//   - Escalones desde la detección: 15 min, 1 h, 3 h, 6 h y después cada 6 h.
//     Creciente a propósito — la urgencia inicial no debe volverse ruido de
//     fondo que el operador aprenda a ignorar.
//   - `onResolved()` cierra el ciclo: avisa que el dispatch volvió SÓLO si
//     antes se avisó del bloqueo (nunca un cierre huérfano).
//
// El estado vive en `.pipeline/.desync-block-notify.json` (filesystem = fuente
// de verdad: un restart del pulpo no debe reiniciar la escalera de avisos ni
// duplicar el aviso inicial). Si la divergencia CAMBIA (otros issues), la
// firma cambia y el ciclo se reinicia: es un bloqueo nuevo.
//
// Reglas inquebrantables
// ----------------------
//   - Cero side effects en require.
//   - Fail-soft total: un error de FS o de Telegram NUNCA rompe al caller
//     (el pulpo llama a esto dentro de su loop de dispatch).
//   - Copy de operador, no volcado de estado interno: tiempo transcurrido +
//     issues concretos + qué hacer. Nada de `waves_allowlist`/`partial_allowlist`
//     crudos (eso ya está en el `diag` del detector).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_BASENAME = '.desync-block-notify.json';

// Escalones de recordatorio en minutos desde `detected_at`. Después del último,
// se repite cada `RECURRENCIA_FINAL_MIN`.
const ESCALONES_MIN = Object.freeze([15, 60, 180, 360]);
const RECURRENCIA_FINAL_MIN = 360;

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function statePath() {
    return path.join(pipelineDir(), STATE_BASENAME);
}

function readState() {
    try {
        const p = statePath();
        if (!fs.existsSync(p)) return null;
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

function writeState(state) {
    try {
        fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
        return true;
    } catch {
        return false;
    }
}

function clearState() {
    try {
        const p = statePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* fail-soft */ }
}

function normalizarIssues(arr) {
    return (Array.isArray(arr) ? arr : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
}

/**
 * Firma del bloqueo: identifica "el mismo bloqueo" entre evaluaciones. Cambia
 * si cambia la divergencia o si el flag se recreó (otro `detected_at`).
 */
function firmaDe({ detectedAt, added, removed }) {
    return [
        detectedAt || 'sin-fecha',
        'extras:' + normalizarIssues(added).join(','),
        'faltantes:' + normalizarIssues(removed).join(','),
    ].join('|');
}

/**
 * "hace 2 h 15 min" / "hace 45 min" / "recién". Copy de operador, no ISO crudo.
 */
function formatearAntiguedad(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'hace un rato';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return 'recién';
    if (totalMin < 60) return `hace ${totalMin} min`;
    const horas = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (horas >= 24) {
        const dias = Math.floor(horas / 24);
        const restoH = horas % 24;
        return restoH > 0 ? `hace ${dias} d ${restoH} h` : `hace ${dias} d`;
    }
    return min > 0 ? `hace ${horas} h ${min} min` : `hace ${horas} h`;
}

function listarIssues(arr, tope = 8) {
    const issues = normalizarIssues(arr);
    if (issues.length === 0) return 'ninguno';
    const visibles = issues.slice(0, tope).map((n) => `#${n}`).join(', ');
    return issues.length > tope ? `${visibles} y ${issues.length - tope} más` : visibles;
}

/**
 * ¿Cuántos recordatorios corresponden haber emitido a los `minutos` de bloqueo?
 * Devuelve el índice del último escalón alcanzado (1-based); 0 = ninguno.
 */
function escalonAlcanzado(minutos) {
    if (!Number.isFinite(minutos) || minutos < ESCALONES_MIN[0]) return 0;
    let idx = 0;
    for (let i = 0; i < ESCALONES_MIN.length; i++) {
        if (minutos >= ESCALONES_MIN[i]) idx = i + 1;
    }
    if (minutos >= ESCALONES_MIN[ESCALONES_MIN.length - 1] + RECURRENCIA_FINAL_MIN) {
        const extra = Math.floor(
            (minutos - ESCALONES_MIN[ESCALONES_MIN.length - 1]) / RECURRENCIA_FINAL_MIN);
        idx = ESCALONES_MIN.length + extra;
    }
    return idx;
}

function defaultSend(payload) {
    require('./notify-telegram').notifyTelegram(payload);
}

/**
 * Registra que el dispatch sigue suspendido por desync y emite el recordatorio
 * si toca según el backoff. Idempotente por escalón: llamarlo cada 5 minutos
 * NO produce un mensaje cada 5 minutos.
 *
 * @param {object} params
 * @param {string} [params.detectedAt] — ISO del `detected_at` del flag.
 * @param {number[]} [params.added] — extras en la allowlist (fuera de la ola).
 * @param {number[]} [params.removed] — issues de la ola ausentes de la allowlist.
 * @param {number} [params.nowMs] — fake clock para tests.
 * @param {(payload:object)=>void} [params.send] — seam de envío (default Telegram).
 * @returns {{ notificado: boolean, motivo: string, escalon?: number, antiguedadMin?: number }}
 */
function onBlocked({ detectedAt, added, removed, nowMs, send } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const enviar = typeof send === 'function' ? send : defaultSend;
    const firma = firmaDe({ detectedAt, added, removed });
    const detectedMs = Date.parse(detectedAt);
    const inicioMs = Number.isFinite(detectedMs) ? detectedMs : now;
    const antiguedadMin = Math.max(0, Math.floor((now - inicioMs) / 60000));

    let state = readState();
    if (!state || state.firma !== firma) {
        // Bloqueo nuevo (o divergencia distinta): arranca la escalera. La alerta
        // inicial la emite el detector al crear el flag, así que acá NO se manda
        // nada todavía — sólo se registra el arranque para contar desde acá.
        state = {
            firma,
            detected_at: detectedAt || new Date(inicioMs).toISOString(),
            escalon_emitido: 0,
            ultimo_aviso_at: null,
        };
        writeState(state);
        return { notificado: false, motivo: 'ciclo_iniciado', escalon: 0, antiguedadMin };
    }

    const escalon = escalonAlcanzado(antiguedadMin);
    if (escalon <= (Number.isInteger(state.escalon_emitido) ? state.escalon_emitido : 0)) {
        return { notificado: false, motivo: 'sin_escalon_nuevo', escalon, antiguedadMin };
    }

    const faltantes = normalizarIssues(removed);
    const extras = normalizarIssues(added);
    const antiguedad = formatearAntiguedad(now - inicioMs);

    // Copy de operador: consecuencia primero, issues concretos después.
    let resumen = `El dispatch sigue suspendido — ${antiguedad} que no se lanza ningún agente`;
    const detalles = [];
    if (faltantes.length > 0) {
        detalles.push(`${faltantes.length === 1 ? 'Está' : 'Están'} en la ola activa pero fuera de la allowlist: ${listarIssues(faltantes)}.`);
    }
    if (extras.length > 0) {
        detalles.push(`${extras.length === 1 ? 'Está' : 'Están'} en la allowlist pero fuera de la ola: ${listarIssues(extras)}.`);
    }
    if (detalles.length === 0) detalles.push('La allowlist y la ola activa siguen divergiendo.');

    let notificado = false;
    try {
        enviar({
            level: 'error',
            component: 'dispatch-suspendido',
            message: resumen,
            context: {
                bloqueado_desde: state.detected_at,
                antiguedad_minutos: antiguedadMin,
                recordatorio_numero: escalon,
            },
            action: `${detalles.join(' ')} Mientras siga la divergencia no arranca ningún agente, ` +
                `aunque haya cuota disponible. Revisá cuál de los dos refleja la verdad y destrabá ` +
                `(o sumá los issues faltantes a la allowlist).`,
            diag: 'diff <(jq \'.active_wave.issues\' .pipeline/waves.json) <(jq \'.allowed_issues\' .pipeline/.partial-pause.json)',
        });
        notificado = true;
    } catch {
        // Fail-soft: una alerta perdida no rompe el loop del pulpo. NO marcamos
        // el escalón como emitido para reintentar en la próxima evaluación.
        return { notificado: false, motivo: 'envio_fallido', escalon, antiguedadMin };
    }

    state.escalon_emitido = escalon;
    state.ultimo_aviso_at = new Date(now).toISOString();
    writeState(state);
    return { notificado, motivo: 'recordatorio_emitido', escalon, antiguedadMin };
}

/**
 * Cierra el ciclo: el dispatch volvió. Avisa SÓLO si hubo recordatorios (si el
 * bloqueo se resolvió antes del primer escalón, el operador nunca se enteró y
 * no hace falta contarle que terminó algo que no vio).
 *
 * @param {object} [params]
 * @param {string} [params.resolucion] — cómo se resolvió (para el copy).
 * @param {number[]} [params.issues] — issues involucrados en la resolución.
 * @param {number} [params.nowMs] — fake clock para tests.
 * @param {(payload:object)=>void} [params.send] — seam de envío.
 * @returns {{ notificado: boolean, motivo: string }}
 */
function onResolved({ resolucion, issues, nowMs, send } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const enviar = typeof send === 'function' ? send : defaultSend;
    const state = readState();
    if (!state) return { notificado: false, motivo: 'sin_ciclo_abierto' };

    const huboAvisos = Number.isInteger(state.escalon_emitido) && state.escalon_emitido > 0;
    clearState();
    if (!huboAvisos) return { notificado: false, motivo: 'sin_avisos_previos' };

    const desdeMs = Date.parse(state.detected_at);
    const duracion = Number.isFinite(desdeMs) ? formatearAntiguedad(now - desdeMs) : 'un rato';
    const lista = normalizarIssues(issues);
    const detalle = lista.length > 0
        ? `Se resolvió sumando a la allowlist ${listarIssues(lista)}.`
        : 'La allowlist y la ola activa volvieron a coincidir.';

    try {
        enviar({
            level: 'info',
            component: 'dispatch-suspendido',
            message: `El dispatch volvió a arrancar — estuvo frenado ${duracion.replace(/^hace /, '')}`,
            context: {
                bloqueado_desde: state.detected_at,
                resolucion: resolucion || 'convergencia_automatica',
                recordatorios_emitidos: state.escalon_emitido,
            },
            action: `${detalle} No hace falta que hagas nada.`,
        });
        return { notificado: true, motivo: 'cierre_emitido' };
    } catch {
        return { notificado: false, motivo: 'envio_fallido' };
    }
}

module.exports = {
    onBlocked,
    onResolved,
    STATE_BASENAME,
    ESCALONES_MIN,
    RECURRENCIA_FINAL_MIN,
    _internal: {
        statePath,
        readState,
        writeState,
        clearState,
        firmaDe,
        formatearAntiguedad,
        escalonAlcanzado,
        listarIssues,
    },
};
