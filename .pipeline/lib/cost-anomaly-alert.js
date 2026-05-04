// =============================================================================
// cost-anomaly-alert.js — Formateador + sender Telegram para alertas de
// consumo anómalo (#2892 PR-C, parte del épico #2882).
//
// Responsabilidad:
//   - formatTelegramMessage(evaluation, snapshot, opts) → string (Markdown)
//   - sendTelegramAlert(evaluation, snapshot, opts)     → encola para svc-telegram
//
// Reglas inquebrantables:
//   1. El payload pasa por `lib/redact.js` ANTES del envío (CA-Sec-A09).
//      Aunque svc-telegram también sanitiza al final, defendemos en origen.
//   2. NUNCA se filtran paths absolutos de Windows (`C:\…`), tokens o emails.
//   3. NUNCA se filtra el snapshot completo. Solo numéricos + skill names
//      whitelisted (alfanumérico + dash/underscore).
//   4. El encolado es fire-and-forget: si el directorio de servicio no
//      existe, se registra el error y se sigue (la alerta es accesoria,
//      no debe matar el detector ni el pulpo).
//
// Tests: lib/__tests__/cost-anomaly-alert.test.js (snapshot del payload
// sanitizado + cap de snooze + auto-clear).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { redactSensitive } = require('./redact');
const { sanitize } = require('../sanitizer');

// Cap absoluto del snooze (CA-2.8 / CA-Sec-A04b). El backend rechaza
// payloads con valor > MAX_SNOOZE_HOURS aunque la UI tenga el bug.
const MAX_SNOOZE_HOURS = 24;

// Whitelist de chars permitidos en skill names mostrados al usuario.
// Skills "limpios" del pipeline matchean siempre (android-dev, backend-dev,
// guru, etc.). Si entra basura (skill: "C:\\foo\\bar"), filtramos y
// reemplazamos por "[skill_invalid]".
const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

function safeSkillName(name) {
    if (typeof name !== 'string') return '[skill_invalid]';
    if (!SAFE_SKILL_NAME_RE.test(name)) return '[skill_invalid]';
    return name;
}

function pct(n) {
    if (!Number.isFinite(n)) return '—';
    return `${Math.round(n * 100)}%`;
}

function usd(n) {
    if (!Number.isFinite(n) || n < 0) return '$0.00';
    return `$${n.toFixed(2)}`;
}

function safeRatio(ratio) {
    if (!Number.isFinite(ratio)) return null;
    return Math.round(ratio * 1000) / 1000;
}

/**
 * Toma el evaluation del detector + snapshot.json + opts y construye el
 * mensaje Markdown que va a Telegram.
 *
 * Determinístico: con los mismos inputs devuelve siempre el mismo string,
 * lo que permite usar snapshot tests para fijar el formato sanitizado
 * (CA-5.5 / CA-Sec-A09).
 *
 * @param {object} evaluation — record del anomaly-detector
 * @param {object} snapshot   — snapshot.json del aggregator
 * @param {object} [opts]
 * @param {number} [opts.topN=3] — cantidad de skills a mostrar
 * @returns {string} mensaje markdown listo para Telegram (post-redact)
 */
function formatTelegramMessage(evaluation, snapshot, opts) {
    const _opts = opts || {};
    const topN = Math.max(1, Math.min(10, Number(_opts.topN || 3)));

    const ev = evaluation || {};
    const snap = snapshot || {};
    const HH = String(ev.hour || '').padStart(2, '0');
    const nextHH = String((Number(HH) + 1) % 24).padStart(2, '0');

    const ratio = safeRatio(ev.ratio);
    const ratioPct = (ratio == null) ? '—' : `+${pct(ratio - 1)}`;

    const actual = Number(ev.actual_usd || 0);
    const baseline = Number(ev.baseline_usd || 0);
    const lookbackDays = Number((snap.hourlyMeta && snap.hourlyMeta.lookbackDays) || 7);

    // Top N skills de la franja actual. Si el snapshot no tiene bySkill
    // (versión vieja), o si bySkill es vacío, mostramos solo el header.
    const bySkill = (snap.currentHour && Array.isArray(snap.currentHour.bySkill))
        ? snap.currentHour.bySkill : [];
    const top = bySkill.slice(0, topN).map((s, i) => {
        const name = safeSkillName(s && s.skill);
        const cost = Number((s && s.cost_usd) || 0);
        const sharePct = actual > 0 ? Math.round((cost / actual) * 100) : 0;
        return `${i + 1}. *${name}* — ${usd(cost)} (${sharePct}%)`;
    });

    // Render Markdown — formato exacto del mockup 06.
    const lines = [];
    lines.push('⚠ *Consumo anómalo detectado*');
    lines.push(`Franja ${HH}:00–${nextHH}:00 · ratio ${ratioPct}`);
    lines.push(`Actual: *${usd(actual)} USD/h*`);
    lines.push(`Esperado: *${usd(baseline)} USD/h* (rolling ${lookbackDays}d)`);
    if (top.length > 0) {
        lines.push('');
        lines.push('*TOP 3 SKILLS*');
        for (const line of top) lines.push(line);
    }
    lines.push('');
    lines.push('→ Ver detalle en el dashboard');

    const raw = lines.join('\n');

    // CA-Sec-A09: pipeline canónico de sanitización ANTES del envío.
    //   1) sanitizer.js::sanitize  → reemplaza tokens (sk-, ghp_, xoxb-,
    //      AKIA*, JWT, telegram bot, AWS, paths absolutos C:\, etc.) por
    //      placeholders [REDACTED:<TIPO>]. Maneja homoglifos y normaliza UTF-8.
    //   2) lib/redact.js::redactSensitive → enmascara emails leito@x.com →
    //      le***@x***.com y strippa userinfo de URLs.
    //
    // El doble paso es DEFENSA EN PROFUNDIDAD: si en una versión futura
    // alguien agrega un campo libre por error, ambos módulos lo van a
    // interceptar con criterios complementarios.
    //
    // No inventamos lógica nueva — reusamos los módulos del pipeline
    // (instrucción explícita de /guru en el comentario de validación).
    const sanitized = sanitize(raw);
    return redactSensitive(sanitized);
}

/**
 * Encola un mensaje de alerta en `.pipeline/servicios/telegram/pendiente/`.
 * El svc-telegram lo procesa fire-and-forget. Si el dir no existe,
 * loguea y devuelve { ok: false, reason }.
 *
 * @param {object} evaluation
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir] — override de `.pipeline/` (para tests)
 * @param {function} [opts.now]       — Date.now overridable (para tests)
 * @returns {{ok: boolean, file?: string, reason?: string, text?: string}}
 */
function sendTelegramAlert(evaluation, snapshot, opts) {
    const _opts = opts || {};
    const pipelineDir = _opts.pipelineDir || path.resolve(__dirname, '..');
    const queueDir = path.join(pipelineDir, 'servicios', 'telegram', 'pendiente');
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const text = formatTelegramMessage(evaluation, snapshot, _opts);

    try {
        if (!fs.existsSync(queueDir)) {
            fs.mkdirSync(queueDir, { recursive: true });
        }
    } catch (e) {
        return { ok: false, reason: `cannot_create_queue_dir: ${e.message}`, text };
    }

    const filename = `${now}-anomaly-alert.json`;
    const file = path.join(queueDir, filename);
    try {
        fs.writeFileSync(file, JSON.stringify({ text, parse_mode: 'Markdown' }), 'utf8');
        return { ok: true, file, text };
    } catch (e) {
        return { ok: false, reason: `cannot_write_file: ${e.message}`, text };
    }
}

module.exports = {
    formatTelegramMessage,
    sendTelegramAlert,
    safeSkillName,
    MAX_SNOOZE_HOURS,
};
