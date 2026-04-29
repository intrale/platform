// =============================================================================
// telegram-health.js — escribe/lee el estado del bot Telegram.
//
// El listener actualiza este archivo en cada poll: ok cuando Telegram responde
// 200, error con descripcion cuando hay 401/403/etc. El dashboard lee este
// archivo y muestra el fallo en /ops para que un token revocado o secrets
// faltantes sean visibles inmediatamente, no silenciosos.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

function healthFile(pipelineDir) {
    return path.join(pipelineDir, 'telegram-health.json');
}

function writeHealth(pipelineDir, payload) {
    try {
        const file = healthFile(pipelineDir);
        const data = { ...payload, updatedAt: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {}
}

function readHealth(pipelineDir) {
    try {
        return JSON.parse(fs.readFileSync(healthFile(pipelineDir), 'utf8'));
    } catch { return null; }
}

function markOk(pipelineDir, extras = {}) {
    writeHealth(pipelineDir, { ok: true, lastError: null, ...extras });
}

function markError(pipelineDir, { code, description, source }) {
    writeHealth(pipelineDir, {
        ok: false,
        lastError: { code: code || null, description: description || 'unknown', source: source || null },
    });
}

module.exports = { writeHealth, readHealth, markOk, markError, healthFile };
