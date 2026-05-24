// =============================================================================
// text-to-speech-adapter.js — Adaptador de texto a guion auditivo
// Issue #2958
//
// Transforma texto pensado para chat en un guion para TTS (Edge / fallback).
// El objetivo es que el audio suene a "una persona hablandole a otra", no a
// "screen reader leyendo el chat".
//
// Pipeline (orden importa):
//   1. Cap de input (MAX_TTS_INPUT_CHARS) — anti-ReDoS.
//   2. Redaccion de secretos (JWT, AWS keys, Telegram bot tokens, query
//      strings password=/token=/api_key=, Authorization headers). PRIMERO,
//      antes de tocar markdown / emojis, sino el secret puede quedar
//      residual legible en el audio.
//   3. Enmascaramiento de emails (lib/redact.js).
//   4. Reemplazo de modelos IA (Sonnet/Opus/Haiku/GPT-4o/claude-*) SOLO si
//      opts.preserveModelNames=false. Por default los nombres se preservan
//      tal cual (issue #3505: el reemplazo agresivo unificaba todo en "el
//      agente" y Whisper lo transcribia como "gente", perdiendo trazabilidad
//      de proveedor/modelo en operaciones).
//   5. Sustitucion de URLs de GitHub por "link al issue NNNN" / "link al PR
//      NNNN", resto por "link adjunto".
//   6. Sustitucion de paths Windows / Unix por "archivo del pipeline" /
//      "archivo del proyecto".
//   7. Sustitucion de hashes de commit (7-40 hex aislados) por
//      "commit reciente".
//   8. Limpieza visual de markdown (headers, listas, code blocks, tablas
//      a frase natural, emojis decorativos).
//   9. Resumen heuristico si supera maxChars (default 1500).
//
// API publica:
//   textToSpeechScript(text, opts) -> { script, droppedCategories, summarized }
//   sanitizeForTts(text)          -> string (compat con multimedia.js)
//
// Garantiza idempotencia: adapter(adapter(x).script).script === adapter(x).script.
// =============================================================================
'use strict';

const {
    redactEmailsInText,
    redactUrlLike,
    REDACTION_MARKER,
} = require('./redact');

// Cap defensivo contra inputs adversariales (ReDoS).
const MAX_TTS_INPUT_CHARS = 50000;

// Cap de salida antes de aplicar resumen (CA-8).
const DEFAULT_MAX_OUTPUT_CHARS = 1500;

// -----------------------------------------------------------------------------
// 1. SECRETOS — patrones que se redactan ANTES de cualquier limpieza visual.
//    Cada patron tiene una etiqueta para que el [REDACTED:<tipo>] sea legible
//    en logs sin re-exfiltrar el contenido.
// -----------------------------------------------------------------------------
const SECRET_PATTERNS = [
    // JWT — eyJ...payload.signature (3 segmentos base64url separados por punto)
    { tag: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    // AWS Access Key — AKIA + 16 mayusculas/digitos
    { tag: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
    // Telegram bot token — 8-10 digitos : 35 chars opacos
    { tag: 'telegram-bot-token', regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
    // Authorization header con Bearer / Basic
    { tag: 'auth-header', regex: /Authorization:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]+/gi },
    // Query param sensible: password=xxx, token=xxx, api_key=xxx, secret=xxx
    { tag: 'query-secret', regex: /\b(?:password|passwd|pwd|token|api[_-]?key|apikey|secret|access[_-]?key|auth)=([^&\s"']+)/gi },
    // AWS Secret Access Key — 40 chars base64-ish, sufijo aislado.
    // OJO: este patron es agresivo. Solo dispara cuando va precedido de
    // "secret" o "aws_secret_access_key" para evitar falsos positivos.
    {
        tag: 'aws-secret-key',
        regex: /(aws[_-]?secret[_-]?access[_-]?key|secretAccessKey|aws_secret)["':\s=]+([A-Za-z0-9/+=]{40})/gi,
    },
];

/**
 * Redacta secretos en texto plano. Devuelve { text, count } donde count es
 * la cantidad total de matches reemplazados (para telemetria, sin contenido).
 */
function redactSecretsInText(text) {
    if (typeof text !== 'string') return { text, count: 0 };
    let out = text;
    let count = 0;
    for (const { tag, regex } of SECRET_PATTERNS) {
        // Reset lastIndex porque las regex son /g.
        regex.lastIndex = 0;
        const before = out;
        out = out.replace(regex, () => `[REDACTED:${tag}]`);
        if (out !== before) {
            // Contar matches del before contra la regex original.
            const matches = before.match(new RegExp(regex.source, regex.flags));
            if (matches) count += matches.length;
        }
    }
    return { text: out, count };
}

// -----------------------------------------------------------------------------
// 2. MODELOS IA — patrones a omitir / reemplazar (opt-in via preserveModelNames=false).
// -----------------------------------------------------------------------------
// Por default los nombres se preservan tal cual (issue #3505). Esta funcion
// solo se ejecuta cuando el caller pide explicitamente audio generico.
// Match conservador: nombres conocidos + version opcional.
const MODEL_NAME_REGEX = /\b(?:Sonnet|Opus|Haiku|Claude(?:-?(?:Opus|Sonnet|Haiku))?|GPT-?\d+(?:\.\d+)?(?:o|-turbo)?|claude-(?:opus|sonnet|haiku)-?\d*(?:\.\d+)*|gemini-?\d*(?:\.\d+)*(?:-pro|-flash)?|cerebras|codex)(?:\s+\d+(?:\.\d+)*)?/gi;

function stripModelNames(text) {
    let count = 0;
    const out = text.replace(MODEL_NAME_REGEX, () => {
        count++;
        return 'el agente';
    });
    // Limpieza: "el agente el agente" → "el agente"
    return { text: out.replace(/\bel agente(?:\s+el agente)+/gi, 'el agente'), count };
}

// -----------------------------------------------------------------------------
// 3. URLs — reformular en lugar de leerlas literal.
// -----------------------------------------------------------------------------
const GH_ISSUE_URL = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)(?:#[\w-]+)?/gi;
const GH_PR_URL = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:pull|pulls)\/(\d+)(?:#[\w-]+)?/gi;
const ANY_URL = /https?:\/\/\S+/gi;

function reformulateUrls(text) {
    let count = 0;
    let out = text;
    out = out.replace(GH_ISSUE_URL, (_m, n) => {
        count++;
        return `link al issue ${n}`;
    });
    out = out.replace(GH_PR_URL, (_m, n) => {
        count++;
        return `link al PR ${n}`;
    });
    out = out.replace(ANY_URL, () => {
        count++;
        return 'link adjunto';
    });
    return { text: out, count };
}

// -----------------------------------------------------------------------------
// 4. PATHS — Windows (C:\...) y Unix (.pipeline/foo/bar.js, /c/Workspaces/...)
// -----------------------------------------------------------------------------
// Match bounded para evitar catastrophic backtracking.
const WIN_PATH = /\b[A-Za-z]:[\\/](?:[^\s\\/<>"']+[\\/]){0,12}[^\s\\/<>"']+\.[A-Za-z0-9]{1,6}/g;
const UNIX_PATH = /(?:^|[\s(])(\.{0,2}\/(?:[A-Za-z0-9_.-]+\/){0,12}[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6})/g;
const BARE_DOT_PATH = /\B\.(?:pipeline|claude|github)\/[A-Za-z0-9_./-]+/g;

function stripPaths(text) {
    let count = 0;
    let out = text;
    out = out.replace(WIN_PATH, () => {
        count++;
        return 'archivo del pipeline';
    });
    out = out.replace(UNIX_PATH, (_m, p) => {
        count++;
        const lead = _m.startsWith(p) ? '' : _m[0];
        return `${lead}archivo del pipeline`;
    });
    out = out.replace(BARE_DOT_PATH, () => {
        count++;
        return 'archivo del pipeline';
    });
    return { text: out, count };
}

// -----------------------------------------------------------------------------
// 5. HASHES de commit — 7 a 40 hex aislados.
// -----------------------------------------------------------------------------
const HASH_REGEX = /\b[0-9a-f]{7,40}\b/g;

function stripHashes(text) {
    let count = 0;
    const out = text.replace(HASH_REGEX, () => {
        count++;
        return 'commit reciente';
    });
    return { text: out, count };
}

// -----------------------------------------------------------------------------
// 6. MARKDOWN VISUAL — emojis, listas, tablas, code blocks, etc.
// -----------------------------------------------------------------------------
// Devuelve contadores granulares (CA-12 / telemetria sin leak).
function stripMarkdownAndEmojis(text) {
    const dropped = { markdown: 0, emoji: 0, table: 0 };
    let s = text;

    // Code blocks triple-backtick — descartar contenido.
    s = s.replace(/```[\s\S]*?```/g, () => {
        dropped.markdown++;
        return ' ';
    });
    // Inline code `xxx` → xxx (preservar texto).
    s = s.replace(/`([^`]+)`/g, (_m, inner) => {
        dropped.markdown++;
        return inner;
    });
    // Negrita **xxx**, __xxx__
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, i) => { dropped.markdown++; return i; });
    s = s.replace(/__([^_]+)__/g, (_m, i) => { dropped.markdown++; return i; });
    // Italicas *xxx* / _xxx_ (sin partir identificadores con _).
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*([\s).,:;!?]|$)/g, (_m, a, b, c) => { dropped.markdown++; return `${a}${b}${c}`; });
    s = s.replace(/(^|[\s(])_([^_\n]+)_([\s).,:;!?]|$)/g, (_m, a, b, c) => { dropped.markdown++; return `${a}${b}${c}`; });
    // Links markdown [texto](url) → texto
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t) => { dropped.markdown++; return t; });
    // Headers (# / ## / ### al inicio de linea).
    s = s.replace(/^#{1,6}\s+/gm, () => { dropped.markdown++; return ''; });
    // Refs "#1234" → "numero 1234".
    s = s.replace(/#(\d+)/g, 'numero $1');
    // Emojis y simbolos visuales — incluye pictographs, symbols, dingbats,
    // arrows, geometric shapes, variation selectors, ZWJ.
    s = s.replace(
        /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2460}-\u{24FF}\u{2B00}-\u{2BFF}\u{20D0}-\u{20FF}\u{FE0E}\u{FE0F}\u{200D}]/gu,
        () => { dropped.emoji++; return ''; }
    );
    // Blockquotes "> ".
    s = s.replace(/^\s*>\s?/gm, () => { dropped.markdown++; return ''; });
    // Tablas: detectar bloque (>= 2 filas con pipe) y reformular a frase.
    // Patron tabla: linea con "|", linea separador, mas filas con "|".
    s = reformulateTables(s, dropped);
    // Separadores / pipes sueltos remanentes.
    s = s.replace(/^[ \t|:\-]+$/gm, () => { dropped.markdown++; return ''; });
    s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, inner) => {
        dropped.markdown++;
        return inner.split('|').map((c) => c.trim()).filter(Boolean).join(', ');
    });
    // Bullets / numeradas al inicio de linea.
    s = s.replace(/^\s*[-*+]\s+/gm, () => { dropped.markdown++; return ''; });
    s = s.replace(/^\s*\d+\.\s+/gm, () => { dropped.markdown++; return ''; });
    // Asteriscos sueltos.
    s = s.replace(/\*+/g, '');
    // Backticks remanentes.
    s = s.replace(/`+/g, '');
    // Tachado ~~xxx~~.
    s = s.replace(/~~/g, '');
    // Saltos triples → dobles.
    s = s.replace(/\n{3,}/g, '\n\n');
    // Espacios multiples.
    s = s.replace(/[ \t]+/g, ' ');

    return { text: s.trim(), dropped };
}

/**
 * Detecta tablas markdown contiguas (header | sep | rows) y las reformula
 * a frase natural para tablas cortas (<= 4 filas x <= 4 columnas).
 * Tablas mas grandes caen al fallback CSV del wrapper.
 */
function reformulateTables(text, dropped) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const isPipeRow = /^\s*\|.+\|\s*$/.test(line);
        const next = lines[i + 1] || '';
        const isSeparator = /^\s*\|?[\s|:\-]+\|?\s*$/.test(next) && /[-:]{3,}/.test(next);
        if (isPipeRow && isSeparator) {
            // Capturar el bloque entero.
            const header = parseRow(line);
            let j = i + 2;
            const rows = [];
            while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
                rows.push(parseRow(lines[j]));
                j++;
            }
            if (header.length <= 4 && rows.length > 0 && rows.length <= 4) {
                // Frase natural — tomar la primera columna como "items".
                const items = rows.map((r) => r[0]).filter(Boolean);
                if (items.length > 0) {
                    const phrase = items.length === 1
                        ? `${header[0] || 'item'}: ${items[0]}`
                        : `${items.length} ${pluralizeHeader(header[0] || 'items')}: ${joinList(items)}`;
                    out.push(phrase + '.');
                    dropped.table++;
                    i = j;
                    continue;
                }
            }
            // Fallback: dejar como esta (limpieza posterior lo hara CSV).
        }
        out.push(line);
        i++;
    }
    return out.join('\n');
}

function parseRow(line) {
    return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter((c, idx, arr) => !(idx === arr.length - 1 && c === ''));
}

function pluralizeHeader(h) {
    // Heuristica simple: si ya termina en s, dejarlo. Sino agregar s.
    const lower = h.toLowerCase();
    if (lower.endsWith('s')) return lower;
    return `${lower}s`;
}

function joinList(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return `${items[0]} y ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

// -----------------------------------------------------------------------------
// 7. RESUMEN HEURISTICO — cuando supera maxChars.
// -----------------------------------------------------------------------------
/**
 * Heuristica determinista: tomar el primer parrafo + las 2 primeras "bullets"
 * que parezcan claves (frases cortas <120 chars). Sin LLM por default.
 * Conserva el "que" (primera oracion) + "por que" (siguiente oracion si la hay)
 * + datos concretos (numeros / #refs).
 */
function summarizeHeuristic(text, maxChars) {
    if (text.length <= maxChars) return { text, summarized: false };

    // Partir en parrafos.
    const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return { text: text.slice(0, maxChars), summarized: true };

    // Primer parrafo siempre.
    let summary = paragraphs[0];

    // Si quedo corto, agregar oraciones de los proximos parrafos hasta llegar.
    if (summary.length < maxChars / 2 && paragraphs.length > 1) {
        for (let i = 1; i < paragraphs.length && summary.length < maxChars * 0.8; i++) {
            const next = paragraphs[i];
            // Tomar solo la primera oracion del parrafo siguiente.
            const firstSentence = next.split(/(?<=[.!?])\s+/)[0];
            if (firstSentence && summary.length + firstSentence.length + 2 <= maxChars) {
                summary += '. ' + firstSentence;
            }
        }
    }

    if (summary.length > maxChars) {
        // Corte por ultima oracion completa antes del cap.
        const cut = summary.slice(0, maxChars);
        const lastPunct = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        summary = lastPunct > maxChars / 2 ? cut.slice(0, lastPunct + 1) : cut;
    }

    return { text: summary.trim(), summarized: true };
}

// -----------------------------------------------------------------------------
// API PRINCIPAL
// -----------------------------------------------------------------------------

/**
 * Transforma texto chat en guion auditivo.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars=1500]
 * @param {boolean} [opts.preserveModelNames=true] - por default preserva
 *   nombres de modelos/proveedores tal cual. Pasar false solo si se necesita
 *   un audio totalmente genérico (uso histórico pre-#3505).
 * @param {boolean} [opts.summarize=true] - si false, no aplica heuristica.
 * @returns {{ script: string, droppedCategories: object, summarized: boolean, truncated: boolean }}
 */
function textToSpeechScript(text, opts = {}) {
    const maxChars = typeof opts.maxChars === 'number' && opts.maxChars > 0
        ? opts.maxChars
        : DEFAULT_MAX_OUTPUT_CHARS;
    const preserveModelNames = opts.preserveModelNames !== false;
    const enableSummary = opts.summarize !== false;

    const dropped = {
        markdown: 0,
        emoji: 0,
        path: 0,
        url: 0,
        secret: 0,
        model: 0,
        hash: 0,
        email: 0,
        table: 0,
    };

    if (text == null) {
        return { script: '', droppedCategories: dropped, summarized: false, truncated: false };
    }
    let s = String(text);

    // 1. Cap defensivo.
    let truncated = false;
    if (s.length > MAX_TTS_INPUT_CHARS) {
        s = s.slice(0, MAX_TTS_INPUT_CHARS);
        truncated = true;
    }

    // 2. Secretos — PRIMERO.
    const secretsRes = redactSecretsInText(s);
    s = secretsRes.text;
    dropped.secret += secretsRes.count;

    // 3. Emails — antes de paths/URLs porque comparten caracteres.
    const beforeEmail = s;
    s = redactEmailsInText(s);
    if (s !== beforeEmail) {
        // Contar emails redactados aproximadamente.
        dropped.email += (beforeEmail.match(/[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]{2,}\.[A-Za-z]{2,}/g) || []).length;
    }

    // 4. Modelos IA.
    if (!preserveModelNames) {
        const modelsRes = stripModelNames(s);
        s = modelsRes.text;
        dropped.model += modelsRes.count;
    }

    // 5. URLs — antes de paths porque las URLs contienen "/".
    const urlsRes = reformulateUrls(s);
    s = urlsRes.text;
    dropped.url += urlsRes.count;

    // 6. Paths.
    const pathsRes = stripPaths(s);
    s = pathsRes.text;
    dropped.path += pathsRes.count;

    // 7. Hashes de commit.
    const hashesRes = stripHashes(s);
    s = hashesRes.text;
    dropped.hash += hashesRes.count;

    // 8. Markdown + emojis + tablas a frase.
    const mdRes = stripMarkdownAndEmojis(s);
    s = mdRes.text;
    dropped.markdown += mdRes.dropped.markdown;
    dropped.emoji += mdRes.dropped.emoji;
    dropped.table += mdRes.dropped.table;

    // 9. Resumen si supera maxChars.
    let summarized = false;
    if (enableSummary && s.length > maxChars) {
        const sumRes = summarizeHeuristic(s, maxChars);
        s = sumRes.text;
        summarized = sumRes.summarized;
    }

    return {
        script: s,
        droppedCategories: dropped,
        summarized,
        truncated,
    };
}

/**
 * Compat con multimedia.js — devuelve solo el script.
 * @param {string} text
 * @param {object} [opts]
 * @returns {string}
 */
function sanitizeForTts(text, opts = {}) {
    if (text == null) return text;
    return textToSpeechScript(text, opts).script;
}

module.exports = {
    textToSpeechScript,
    sanitizeForTts,
    // Exportados para tests / extensibilidad.
    redactSecretsInText,
    MAX_TTS_INPUT_CHARS,
    DEFAULT_MAX_OUTPUT_CHARS,
};
