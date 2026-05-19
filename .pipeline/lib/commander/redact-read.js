// =============================================================================
// redact-read.js — Sanitizador read-path para handlers determinísticos
// Issue #3257 · CA-9
//
// Cubre la salida que devuelven los handlers ANTES de pasar por la plantilla
// y por el sender Telegram. El sender ya redacta payloads HTTP (issue #2307),
// pero la lectura de FS necesita su propia capa porque puede traer:
//
//   - AWS access keys (`AKIA[0-9A-Z]{16}` o `ASIA...`)
//   - JWT (`eyJ` prefix con base64url payload)
//   - API keys (`sk-...`, `gsk_...`, `xoxb-...`, etc.)
//   - Telegram bot tokens (`\d+:[A-Za-z0-9_-]{20,}`)
//   - Passwords/secrets en variables `password=...`, `secret=...`, `token=...`
//   - Emails que no sean del operador
//
// Diseño:
//   - El módulo expone un solo punto de entrada `redactReadOutput(text)` que
//     aplica todas las regex en cascada y cuenta cuántas redacciones hizo
//     (útil para mostrar "se redactaron N valores" en la plantilla).
//   - Reutiliza `lib/redact.js` (#2307) para emails y JSON sensibles.
//   - Es idempotente: pasar dos veces no acumula marcadores.
// =============================================================================
'use strict';

const baseRedact = require('../redact');

const MARKER = '[REDACTED]';

// Cada entrada: { name, regex, captureIdx } — captureIdx es opcional para
// preservar un fragmento contextual (default: reemplazo total).
const PATTERNS = [
    // AWS access keys (4 letras de tipo + 16 alfanum mayúsculas)
    { name: 'aws_key', regex: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
    // AWS secret access keys (40 caracteres base64-ish)
    { name: 'aws_secret', regex: /\baws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi, captureIdx: 1 },
    // JWT — 3 segmentos base64url separados por punto (header eyJ...)
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    // OpenAI / Anthropic / similares
    { name: 'openai_key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
    { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    // Groq API key (`gsk_`) — MANTENIDO post-#3353 como defense-in-depth.
    // Groq descontinuado como provider (mayo 2026), pero las keys legacy
    // pueden seguir apareciendo en backups (`~/.claude/secrets/backups/`),
    // logs viejos y dumps de incidentes leídos por commander. El filtro
    // genérico `generic_secret_kv` NO cubre bare keys ni JSON quoted.
    { name: 'groq_key', regex: /\bgsk_[A-Za-z0-9]{40,}\b/g },
    // Google AI / Gemini API keys (AIza prefix + 35 chars)
    { name: 'gemini_key', regex: /\bAIza[A-Za-z0-9_-]{35}\b/g },
    // Slack tokens (xoxb-/xoxp-/xoxa-)
    { name: 'slack_token', regex: /\bxox[bpaors]-[A-Za-z0-9-]{10,}\b/g },
    // Telegram bot tokens — `<bot_id>:<token>` con bot_id ≥6 dígitos.
    { name: 'telegram_token', regex: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g },
    // GitHub PATs (ghp_ / gho_ / ghu_ / ghs_ / ghr_)
    { name: 'github_pat', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
    // Generic password/secret/token=... en variables o JSON
    { name: 'generic_secret_kv', regex: /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)["']?([^\s"',}]{4,})["']?/gi, captureIdx: 2 },
];

/**
 * Redacta secretos de un bloque de texto (tail de logs, snapshot, etc.).
 * Devuelve `{ text, redactedCount }`.
 *
 * @param {string} input
 */
function redactReadOutput(input) {
    if (typeof input !== 'string' || input.length === 0) {
        return { text: input || '', redactedCount: 0 };
    }
    let out = input;
    let redactedCount = 0;

    // Reusar emails y URL userinfo de la lib base (#2307).
    const beforeBase = out;
    try {
        const baseOut = baseRedact.redactEmailsInText(baseRedact.redactUrlLike(out));
        if (baseOut !== beforeBase) {
            // Aprox del count: cada `***` agregado por baseRedact representa una redacción.
            redactedCount += (baseOut.match(/\*\*\*/g) || []).length - (beforeBase.match(/\*\*\*/g) || []).length;
        }
        out = baseOut;
    } catch (_) { /* tolerar — la base es defensiva */ }

    for (const { regex, captureIdx } of PATTERNS) {
        regex.lastIndex = 0;
        out = out.replace(regex, (match, cap1, cap2) => {
            redactedCount += 1;
            if (captureIdx === 1 && cap1 !== undefined) {
                return match.replace(cap1, MARKER);
            }
            if (captureIdx === 2 && cap2 !== undefined) {
                return match.replace(cap2, MARKER);
            }
            return MARKER;
        });
    }

    return { text: out, redactedCount };
}

module.exports = { redactReadOutput, MARKER };
