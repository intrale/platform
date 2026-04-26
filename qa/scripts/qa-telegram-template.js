// =============================================================================
// qa-telegram-template.js — Template del mensaje Telegram que anuncia cierre QA
//
// Issue #2519. Antes el template vivía inline en `qa-video-share.js` con
// verdicto hardcoded ("EVIDENCIA") y contadores en cero. Ahora es un módulo
// puro que recibe el payload completo y devuelve el string Markdown listo para
// enviar a Telegram.
//
// Responsabilidades:
//   1) Render de los 6 paths visuales (3 modos × 2 veredictos) + path legacy.
//   2) Hardening de seguridad — escape Markdown, strip control chars, redacción
//      de secretos, validación de enums, truncado multibyte-safe.
//   3) Pureza total: sin I/O, sin fetch, sin env. Facilita unit tests.
//
// CRÍTICO: este módulo corre en producción. Si crashea, el QA no anuncia su
// veredicto y el operador queda ciego. Todos los inputs son tratados como
// no confiables; nada acá debe arrojar salvo condiciones imposibles de
// ignorar (issue no numérico → el caller no construye el mensaje).
// =============================================================================

'use strict';

// ─── Escape Markdown (CA-S1) ─────────────────────────────────────────────────
// Telegram legacy Markdown interpreta `_*[]`` y paréntesis de hyperlink.
// Cualquier texto libre (title, motivo, criterio, narrador) debe pasar por
// esta función ANTES de inyectarse al template. No confiamos en que los
// autores aguas arriba sanitizaron.

const MD_SPECIAL = /([_*\[\]`()])/g;

function escapeMarkdown(text) {
    if (typeof text !== 'string') return '';
    return text.replace(MD_SPECIAL, '\\$1');
}

// ─── Strip de caracteres de control (CA-S5) ──────────────────────────────────
// Null bytes, secuencias ANSI, CRLF múltiples. Preservamos un \n suelto porque
// separa criterios o párrafos cortos de motivo; más de uno se colapsa.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripControl(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(ANSI_RE, '')
        .replace(CTRL_RE, '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Truncado multibyte-safe (CA-S6, CA-A3) ──────────────────────────────────
// Array.from respeta code points (emojis/tildes cuentan como 1). Split naive
// de substring() podría partir un surrogate pair.

function truncate(text, max, ellipsis) {
    if (typeof text !== 'string') return '';
    if (typeof max !== 'number' || max <= 0) return text;
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    const tail = typeof ellipsis === 'string' ? ellipsis : '…';
    return chars.slice(0, max).join('') + tail;
}

// ─── Redacción de secretos (CA-S7) ───────────────────────────────────────────
// Motivo es texto libre que escribe el QA. Puede incluir accidentalmente
// JWT, AWS keys, tokens en URLs, connection strings con password. Antes de
// enviar a Telegram (canal menos auditado, reenviable/exportable) → reemplazar
// por `[REDACTED]`.

const SECRET_PATTERNS = [
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,  // JWT
    /(?:AKIA|ASIA)[0-9A-Z]{16}/g,                           // AWS access key
    /gh[pousr]_[A-Za-z0-9]{30,}/g,                          // GitHub token
    /github_pat_[A-Za-z0-9_]{80,}/g,                        // GitHub fine-grained
    /AIza[0-9A-Za-z_-]{35}/g,                               // Google API key
    /1\/\/[0-9A-Za-z_-]{43,}/g,                             // Google OAuth refresh
    /\d{6,}:[A-Za-z0-9_-]{35,}/g,                           // Telegram bot token
    /[?&](?:token|access_token|api_key|apikey)=[A-Za-z0-9_\-.]{16,}/gi, // query token
    /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{4,}/gi,  // password=xxx
];

function redactSecrets(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, '[REDACTED]');
    }
    return out;
}

// ─── Pipeline texto libre ────────────────────────────────────────────────────
// Orden: strip control → redact secretos → truncate → escape Markdown (lo hace
// el caller justo antes de insertarlo, para permitir truncado sin cortar
// escapes).

function sanitizeFreeText(text, maxChars) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let t = stripControl(text);
    t = redactSecrets(t);
    if (typeof maxChars === 'number' && maxChars > 0) {
        t = truncate(t, maxChars);
    }
    return t;
}

// ─── Validación de enums (CA-S3) ─────────────────────────────────────────────

const VERDICT_MAP = {
    aprobado: { icon: '✅', label: 'QA APROBADO', approved: true },
    rechazado: { icon: '❌', label: 'QA RECHAZADO', approved: false },
};

function resolveVerdict(verdict) {
    if (typeof verdict !== 'string') return null;
    const norm = verdict.trim().toLowerCase();
    return VERDICT_MAP[norm] || null;
}

const MODE_MAP = {
    android:    { key: 'android',    icon: '🤖', label: 'android (emulador + video)' },
    api:        { key: 'api',        icon: '🔌', label: 'api (sin video)' },
    structural: { key: 'structural', icon: '📦', label: 'structural (audit rápido)' },
};

function resolveMode(mode) {
    if (typeof mode !== 'string') return null;
    const norm = mode.trim().toLowerCase();
    return MODE_MAP[norm] || null;
}

// provider → character_name (del profile qa de tts-config.json)
const PROVIDER_TO_NARRATOR = {
    edge:   'Nacho',
    openai: 'Rulo',
};

function resolveNarrator(provider) {
    if (typeof provider !== 'string') return null;
    const norm = provider.trim().toLowerCase();
    return PROVIDER_TO_NARRATOR[norm] || null;
}

// ─── Validación numérica ─────────────────────────────────────────────────────

function parseCount(val, fallback) {
    const fb = typeof fallback === 'number' ? fallback : 0;
    if (val === null || val === undefined) return fb;
    const n = parseInt(String(val), 10);
    if (isNaN(n) || n < 0) return fb;
    return n;
}

// ─── Timestamp HH:MM local (CA-A9) ───────────────────────────────────────────

function formatTimestamp(date) {
    const d = date instanceof Date ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ─── Validación de issue (CA-S4) ─────────────────────────────────────────────

function isValidIssue(issue) {
    return /^\d+$/.test(String(issue || ''));
}

// ─── Validación de path de rejection PDF ─────────────────────────────────────
// Solo permitimos paths relativos sin `..` para evitar que un payload
// malicioso haga que el mensaje apunte a paths que sugieren /etc/passwd.

function isSafeRelPath(p) {
    if (typeof p !== 'string') return false;
    if (!p.trim()) return false;
    if (p.includes('..')) return false;
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
    // path inocuo: alfanumérico + separadores + extensión
    return /^[A-Za-z0-9_./\- ]+$/.test(p);
}

// ─── Builder principal ───────────────────────────────────────────────────────
/**
 * Construye el mensaje Telegram según el rediseño del issue #2519.
 *
 * @param {object} data Payload estructurado. Campos:
 *   - issue:                 (required, string|number, debe matchear /^\d+$/)
 *   - title:                 string, título humano del issue
 *   - verdict:               string, 'aprobado' | 'rechazado' (case-insensitive)
 *   - passed, total:         number|string, contadores
 *   - mode:                  string, 'android' | 'api' | 'structural'
 *   - motivo:                string, solo aplica cuando rechazado
 *   - criteriosFallidos:     string[], solo cuando rechazado
 *   - narratorProvider:      string, 'edge' | 'openai' — mapea a Nacho/Rulo
 *   - rejectionPdf:          string (relpath al PDF de rejection-report)
 *   - driveLink:             string (URL completa al video en Drive)
 *   - reportPath:            string (relpath al JSON del report QA)
 *   - audioTag:              string, sufijo opcional para info de narración
 *   - timestamp:             string (HH:MM) o Date — default: now
 *   - legacy:                boolean, true cuando viene sin campos nuevos (CA-B1)
 *
 * @returns {string} Mensaje Markdown listo para parse_mode=Markdown.
 *
 * Precondición: `data.issue` matchea /^\d+$/. El caller debe validar o fallback.
 */
function buildTelegramMessage(data) {
    const d = data || {};
    const issueRaw = String(d.issue == null ? '' : d.issue);
    if (!isValidIssue(issueRaw)) {
        // Devolvemos mensaje genérico sin datos comprometidos — log queda del
        // lado del caller que debería haber validado antes. No crasheamos.
        return '📹 *QA* — issue inválido, ver log del pipeline';
    }
    const issue = issueRaw;
    const titleSan = sanitizeFreeText(d.title || '', 80);
    const verdictInfo = resolveVerdict(d.verdict);
    const modeInfo = resolveMode(d.mode);
    const narrator = resolveNarrator(d.narratorProvider);
    const ts = typeof d.timestamp === 'string'
        ? d.timestamp
        : formatTimestamp(d.timestamp);
    const audioTag = typeof d.audioTag === 'string' ? d.audioTag : '';

    // ── Path legacy (CA-B1) ─────────────────────────────────────────────────
    // Payload sin verdict reconocido → mensaje neutro, sin afirmar estado.
    // Mantiene backward compat con jobs encolados antes del deploy.
    if (d.legacy || !verdictInfo) {
        const lines = [];
        lines.push('📹 *QA* — #' + issue);
        if (titleSan) lines.push('_' + escapeMarkdown(titleSan) + '_');
        lines.push('');
        if (d.driveLink)    lines.push('🎬 [Ver video en Drive](' + d.driveLink + ')' + audioTag);
        if (d.reportPath)   lines.push('📋 Reporte: `' + d.reportPath + '`');
        lines.push('');
        if (narrator)       lines.push('_Narrado por ' + escapeMarkdown(narrator) + ' · ' + ts + '_');
        else                lines.push('_' + ts + '_');
        return lines.join('\n');
    }

    // ── Template nuevo ──────────────────────────────────────────────────────
    const lines = [];
    lines.push(verdictInfo.icon + ' *' + verdictInfo.label + '* — #' + issue);
    if (titleSan) lines.push('_' + escapeMarkdown(titleSan) + '_');
    lines.push('');

    // Línea de tests
    const total = parseCount(d.total);
    const passedRaw = parseCount(d.passed);
    const passed = Math.min(passedRaw, total); // clamp passed ≤ total (CA-S3)
    const isApi = modeInfo && modeInfo.key === 'api';

    if (total === 0) {
        // Edge UX (sugerencia UX): cuando no hay tests cuantificados.
        if (verdictInfo.approved) {
            lines.push('Tests: sin criterios cuantificados');
        } else {
            lines.push('Tests: rechazado sin tests ejecutados');
        }
    } else {
        const label = isApi ? 'Test cases' : 'Tests';
        const suffix = isApi ? 'pasaron' : 'criterios verificados';
        lines.push(label + ': ' + passed + '/' + total + ' ' + suffix + audioTag);
    }

    // Línea de modo (con fallback explícito CA-A6 para evitar línea vacía)
    if (modeInfo) {
        lines.push('Modo: ' + modeInfo.icon + ' ' + modeInfo.label);
    } else {
        lines.push('Modo: ❓ indeterminado');
    }

    // Si rechazado: motivo + criterios fallidos (CA-A4)
    if (!verdictInfo.approved) {
        const motivo = sanitizeFreeText(d.motivo || '', 500);
        if (motivo) {
            lines.push('');
            lines.push('*Motivo:* ' + escapeMarkdown(motivo));
        }
        if (Array.isArray(d.criteriosFallidos) && d.criteriosFallidos.length > 0) {
            const items = d.criteriosFallidos
                .filter((x) => typeof x === 'string' && x.trim())
                .map((x) => sanitizeFreeText(x, 120))
                .filter((x) => x.length > 0)
                .map((x) => escapeMarkdown(x));
            if (items.length > 0) {
                const shown = items.slice(0, 10);
                const extra = items.length - shown.length;
                lines.push('*Criterios fallidos:* ' + shown.join(', ') + (extra > 0 ? ' +' + extra + ' más' : ''));
            }
        }
    }

    // Enlaces
    lines.push('');
    if (d.driveLink)  lines.push('🎬 [Ver video en Drive](' + d.driveLink + ')');
    if (d.reportPath) lines.push('📋 Reporte: `' + d.reportPath + '`');

    // Rejection PDF solo en rechazos, y solo si el path es seguro (CA-A7 + CA-S4)
    if (!verdictInfo.approved && isSafeRelPath(d.rejectionPdf)) {
        lines.push('📄 Rejection report: `' + d.rejectionPdf + '`');
    }

    // Pie con narrador + timestamp (CA-A5, CA-A9)
    lines.push('');
    if (narrator) {
        lines.push('_Narrado por ' + escapeMarkdown(narrator) + ' · ' + ts + '_');
    } else {
        lines.push('_' + ts + '_');
    }

    return lines.join('\n');
}

module.exports = {
    buildTelegramMessage,
    // Helpers puros expuestos para tests y para consumidores avanzados:
    escapeMarkdown,
    stripControl,
    truncate,
    redactSecrets,
    sanitizeFreeText,
    resolveVerdict,
    resolveMode,
    resolveNarrator,
    parseCount,
    formatTimestamp,
    isValidIssue,
    isSafeRelPath,
    // Constantes (solo lectura):
    VERDICT_MAP,
    MODE_MAP,
    PROVIDER_TO_NARRATOR,
};
