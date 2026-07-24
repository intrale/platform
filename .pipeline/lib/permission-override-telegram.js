// =============================================================================
// permission-override-telegram.js — Helper para notificar overrides al chat.
//
// Issue: #3082 (S4 multi-provider) — CA-17 + G2 (UX).
//
// El bot debe respetar `feedback_telegram-messages-natural.md` (memoria global):
// mensajes naturales, variados, contextuales — NO templates robóticos.
//
// Por qué un módulo separado: el CLI de override (scripts/override-permission.js)
// no debe acoplarse a la implementación de `sendTelegram` del pulpo. Usamos
// el mismo patrón filesystem-based del pulpo (encolar en `servicios/telegram/`)
// para que el envío sea fire-and-forget y resiliente a restart del servicio.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPENING_VERBS = [
    'Override de permisos creado',
    'Acabo de registrar un override',
    'Override autorizado por',
    'Se concedió un override',
    'Registrado un override temporal',
];

/**
 * Formatea una entry de override en un mensaje Telegram natural.
 * Devuelve un objeto con `text` y opcionalmente `reply_markup` (no usado acá).
 *
 * Estructura cumplida de G2:
 *   - Variar el verbo de apertura (sin plantilla repetida).
 *   - Incluir autor, skill, provider, mode, TTL, primeras 80 chars de justific.
 *   - Capabilities adicionales otorgadas.
 *   - Hash autoverificable.
 *   - Comando para revocar antes del TTL.
 */
function formatOverrideMessage(entry, { now } = {}) {
    if (!entry || typeof entry !== 'object') {
        throw new Error('[permission-override-telegram] entry inválida.');
    }
    const nowMs = typeof now === 'number' ? now : Date.now();
    const created = Number(entry.created_at) || nowMs;
    const ttlMs = (Number(entry.ttl_horas) || 0) * 3600 * 1000;
    const expiresAt = created + ttlMs;
    const expiresInMs = expiresAt - nowMs;
    const expiresInHours = Math.floor(expiresInMs / 3600000);
    const expiresInMinutes = Math.max(0, Math.floor((expiresInMs % 3600000) / 60000));

    // G3: tiempos human-readable duales (fecha absoluta + relativa).
    const expiresDate = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const remainingHuman = `vence en ${expiresInHours}h ${expiresInMinutes}m`;

    // Verb de apertura rotativo (basado en hash_self para que sea determinístico
    // pero parezca natural si se mira en agregado).
    const verbIdx = Number.parseInt(String(entry.hash_self || '').slice(0, 4), 16) % OPENING_VERBS.length;
    const opener = OPENING_VERBS[verbIdx] || OPENING_VERBS[0];

    const just = String(entry.justificacion || '').slice(0, 80);
    const capDiff = Array.isArray(entry.capabilities_diff) ? entry.capabilities_diff.join(', ') : '<sin diff>';
    const hashShort = String(entry.hash_self || '').slice(0, 16);
    const ttlH = Number(entry.ttl_horas) || 0;

    const lines = [
        `🛂 *${opener}* — \`${entry.autor}\` autorizó \`${entry.skill}\` corriendo bajo \`${entry.provider}/${entry.mode_otorgado || '?'}\` por las próximas \`${ttlH}h\` (${expiresDate}, ${remainingHuman}).`,
        `Justificación: "${just}${entry.justificacion && entry.justificacion.length > 80 ? '…' : ''}"`,
        `Capabilities adicionales concedidas: \`${capDiff}\`.`,
        `Hash: \`${hashShort}\``,
        `Para revocar antes del TTL: \`node .pipeline/scripts/revoke-permission.js --hash ${hashShort} --motivo '<razón>'\``,
    ];
    return { text: lines.join('\n'), parse_mode: 'Markdown' };
}

/**
 * Encola un mensaje Telegram en `servicios/telegram/pendiente/`.
 * Devuelve el path del archivo encolado para que el caller pueda loggear.
 *
 * Si la cola no existe, se crea. Si el write falla, propaga el error.
 * (El caller decide si abortar el override o seguir.)
 */
function enqueueTelegramNotification({ payload, pipelineRoot, fsImpl } = {}) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('[permission-override-telegram] payload requerido.');
    }
    const _fs = fsImpl || fs;
    const root = pipelineRoot || path.join(process.env.PIPELINE_REPO_ROOT || process.cwd(), '.pipeline');
    const svcDir = path.join(root, 'servicios', 'telegram', 'pendiente');
    if (!_fs.existsSync(svcDir)) {
        _fs.mkdirSync(svcDir, { recursive: true });
    }
    const filename = `${Date.now()}-permission-override.json`;
    const fullPath = path.join(svcDir, filename);
    _fs.writeFileSync(fullPath, JSON.stringify(payload), 'utf8');
    return fullPath;
}

/**
 * API de alto nivel: format + enqueue en una sola llamada atómica.
 * El CLI de override la usa después de escribir el JSONL con hash chain.
 */
function notifyOverrideCreated(entry, { pipelineRoot, now, fsImpl } = {}) {
    const payload = formatOverrideMessage(entry, { now });
    return enqueueTelegramNotification({ payload, pipelineRoot, fsImpl });
}

module.exports = {
    formatOverrideMessage,
    enqueueTelegramNotification,
    notifyOverrideCreated,
    OPENING_VERBS,
};
