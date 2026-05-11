// =============================================================================
// agent-models-change-alert.js — Alerta Telegram + audio narrado para cambios
// en `.pipeline/agent-models.json` (#3087, U2 multi-provider · épico #3065).
//
// Trigger:
//   - Cron interno del pulpo (fuente autoritativa, idempotente post-reinicio).
//   - Opcional: `.husky/post-commit` como fast-path local. El cron detecta
//     `last_notified_sha == HEAD` y no re-emite (idempotencia).
//
// Flujo:
//   1. detectChanges(prevSha, headSha) lee `git log -p` entre los dos SHAs y
//      extrae los commits que tocan agent-models.json.
//   2. Para cada commit, computa diff con `allowlistedFieldsForDiff()` —
//      proyección segura: solo provider/model/model_override/launcher.
//   3. consolidateWindow agrupa cambios dentro de 5 min en un solo aviso.
//   4. formatTelegramMessage arma el MarkdownV2 sanitizado (template fijo).
//   5. generateNarrationScript devuelve el texto del audio (template fijo).
//   6. sendAlert encola en .pipeline/servicios/telegram/pendiente/, opcional-
//      mente dispara TTS, y escribe audit log append-only.
//   7. persistLastNotifiedSha actualiza el cursor.
//
// Reglas inquebrantables:
//   - Allowlist de campos (CA-S1): NUNCA emitir credentials_env, spawn_args_template,
//     permissions_mode, etc. La allowlist canónica vive en `lib/agent-models.js`.
//   - Sanitizer canónico aplicado al output final (CA-S2): redactSensitive + sanitize.
//   - Template fijo para TTS (CA-S4): SIN variables libres del repo (commit message,
//     autor) — solo skill/provider/model/cost/co_commit_sensitive.
//   - Co-commit con archivos sensibles (CA-S8): se menciona como flag de auditoría,
//     NUNCA se pega contenido del archivo.
//   - last_notified_sha persistido con permisos 0o600 (CA-S6).
//   - Audit log append-only con permisos 0o600 (CA-S7).
//
// TODO migración: cuando #3112 (escapeMdV2 centralizado) cierre, eliminar el
// helper local `escapeMdV2` y reemplazar por `require('./escape-mdv2')`. Este
// módulo y `cost-cross-provider-alert.js` y `notifier-infra-recovered.js` se
// migran juntos para no introducir un cuarto escape divergente.
//
// Tests: lib/__tests__/agent-models-change-alert.test.js (H-1..H-10 del PO).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redactSensitive } = require('./redact');
const { sanitize } = require('../sanitizer');
const { MODEL_PRICING } = require('./traceability');
const agentModels = require('./agent-models');

// ─── Constantes ──────────────────────────────────────────────────────────────

// Ventana de consolidación temporal (CA-S5 / CA-E-1). Múltiples commits sobre
// agent-models.json dentro de esta ventana consolidan en un único aviso.
const CONSOLIDATION_WINDOW_MS = 5 * 60 * 1000;

// Umbral relativo a partir del cual el delta de costo se marca con `⚠`
// (CA-C-5). Por debajo del umbral, el cambio pasa neutro o con `✓` si es ahorro.
const DELTA_HIGHLIGHT_THRESHOLD = 0.50;

// Umbral mínimo de sesiones para considerar la baseline "confiable" (CA-S3 /
// CA-C-3). Por debajo, el mensaje agrega `_baseline corta — N=N, dato indicativo_`.
const BASELINE_MIN_SESSIONS = 5;

// Patrones de archivos sensibles para detección de co-commit (CA-S8 / CA-G-1).
// Si el commit que tocó agent-models.json también tocó alguno de estos, se
// agrega el flag `🚨 *Atención*: este commit también modificó archivos con
// credenciales.` al cuerpo del mensaje. NUNCA se pega contenido del archivo.
const SENSITIVE_PATH_PATTERNS = [
    /(^|\/)\.env(\..*)?$/i,                 // .env, .env.local, .env.production, etc.
    /(^|\/)credentials(\.|$)/i,             // credentials.json, .aws/credentials, etc.
    /\.aws\/credentials$/i,
    /application\.conf$/i,                  // backend secrets file (Ktor)
    /(^|\/)secrets?\.(json|yaml|yml|conf)$/i,
];

// Skill names "limpios" del pipeline. Si entra basura (skill: "C:\\foo"), se
// sustituye por `[skill_invalid]`. Defensa redundante con sanitize().
const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

// Caracteres especiales de MarkdownV2 que Telegram obliga a escapar.
// Mantener idéntico a notifier-infra-recovered.js (cuando #3112 cierre, los 3
// se reemplazan por un solo import).
const MD_V2_SPECIAL_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

// Patrones extra para secrets que el sanitizer canónico no cubre todavía
// (gap documentado en CA-S2 — "Sanitizer extendido S2 cuando esté"). Se aplica
// localmente como defensa en profundidad y se elimina cuando S2 cierre.
//
// Cobertura mínima:
//   - sk- prefijos típicos de OpenAI / Anthropic / Replicate / etc.
//   - xoxb- / xoxp- prefijos de Slack bot/user tokens.
//   - ghp_ / gho_ / ghs_ / ghu_ prefijos de GitHub PATs.
const LOCAL_EXTRA_SECRET_PATTERNS = [
    { name: 'OPENAI_LIKE_SK', re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, repl: '[REDACTED:SK_TOKEN]' },
    { name: 'SLACK_TOKEN', re: /\bxox[bpaors]-[A-Za-z0-9-]{10,}\b/g, repl: '[REDACTED:SLACK_TOKEN]' },
    { name: 'GITHUB_PAT', re: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, repl: '[REDACTED:GITHUB_PAT]' },
];

function applyLocalExtraSanitization(text) {
    if (typeof text !== 'string' || text.length === 0) return text || '';
    let out = text;
    for (const p of LOCAL_EXTRA_SECRET_PATTERNS) {
        out = out.replace(p.re, p.repl);
    }
    return out;
}

// ─── Helpers de formateo ─────────────────────────────────────────────────────

/**
 * Escapa caracteres especiales de MarkdownV2. Tolera null/undefined/no-string.
 * TODO: reemplazar por import de `lib/escape-mdv2.js` cuando #3112 cierre.
 */
function escapeMdV2(input) {
    if (input == null) return '';
    const s = typeof input === 'string' ? input : String(input);
    return s.replace(MD_V2_SPECIAL_RE, (ch) => '\\' + ch);
}

function safeSkillName(name) {
    if (typeof name !== 'string') return '[skill_invalid]';
    if (!SAFE_SKILL_NAME_RE.test(name)) return '[skill_invalid]';
    return name;
}

/**
 * Formatea USD a 4 decimales (CA-C-2). NaN/null → "—". Negativos coercen a "—".
 */
function usd4(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    return `$${n.toFixed(4)}`;
}

/**
 * Devuelve el delta porcentual entre `from` y `to`. Si from == 0 o NaN, devuelve
 * null para que el caller imprima "no disponible".
 */
function deltaPct(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
    return (to - from) / from;
}

function formatPctSigned(p) {
    if (p == null || !Number.isFinite(p)) return '—';
    const sign = p >= 0 ? '+' : '';
    return `${sign}${Math.round(p * 100)}%`;
}

// ─── Detección de cambios desde git history ──────────────────────────────────

/**
 * Devuelve la lista de commits (más viejo → más nuevo) entre `prevSha` (exclusive)
 * y `headSha` (inclusive) que tocaron `.pipeline/agent-models.json`.
 *
 * Usa git plumbing porque queremos información estable, no UX:
 *   - Cada commit incluye sha, ts (ISO), parents, files (lista de archivos tocados),
 *     y el blob completo de agent-models.json en ese sha (para poder normalizar y
 *     hacer diff pieza a pieza).
 *
 * Si `prevSha` es null/undefined, se usa `headSha~1` (un solo commit).
 *
 * No lanza si git falla — devuelve `[]` y registra el error en stderr.
 *
 * @param {string|null} prevSha
 * @param {string} headSha
 * @param {object} [opts]
 * @param {string} [opts.cwd] — repo root (default: process.cwd())
 * @param {function} [opts.execFile] — override para tests (firma de execFileSync)
 * @returns {Array<{sha: string, ts: string, parents: string[], files: string[]}>}
 */
function detectChanges(prevSha, headSha, opts) {
    const _opts = opts || {};
    const cwd = _opts.cwd || process.cwd();
    const exec = _opts.execFile || execFileSync;

    // Rango: si prevSha existe, usar prevSha..headSha (excl..incl).
    // Si no, --max-count=1 sobre headSha (un solo commit).
    let range;
    if (prevSha && typeof prevSha === 'string' && prevSha.trim()) {
        range = `${prevSha.trim()}..${headSha.trim()}`;
    } else {
        range = headSha.trim();
    }

    let raw;
    try {
        // --name-only para listar archivos modificados; --pretty con format
        // estable y separadores únicos para parsing seguro.
        const args = [
            'log',
            '--name-only',
            // Separador único entre commits: "%x1f" = byte 0x1f (unit separator)
            // que NO aparece naturalmente en filenames ni en commit messages tipados.
            '--pretty=format:%x1f%H%x1e%cI%x1e%P',
            '--reverse',
            '--',
            '.pipeline/agent-models.json',
        ];
        if (prevSha && typeof prevSha === 'string' && prevSha.trim()) {
            args.splice(1, 0, range);
        } else {
            args.splice(1, 0, '--max-count=1', range);
        }
        raw = exec('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    } catch (e) {
        try { process.stderr.write(`[agent-models-change-alert] git log falló: ${e.message}\n`); } catch (_) {}
        return [];
    }

    return parseGitLogOutput(raw);
}

/**
 * Parsea la salida de `git log --name-only --pretty=format:%x1f%H%x1e%cI%x1e%P`.
 * Cada commit empieza con `\x1f` y luego `<sha>\x1e<iso>\x1e<parents>` seguido
 * de líneas con files. Función pura — exportada para tests.
 */
function parseGitLogOutput(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const out = [];
    // Separar por unit separator (0x1f). El primer split es '' por el leading separator.
    const blocks = raw.split('\x1f').filter((b) => b.trim().length > 0);
    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const header = lines.shift() || '';
        const headerParts = header.split('\x1e');
        if (headerParts.length < 2) continue;
        const sha = headerParts[0].trim();
        const ts = headerParts[1].trim();
        const parents = (headerParts[2] || '').trim().split(/\s+/).filter(Boolean);
        const files = lines.map((l) => l.trim()).filter((l) => l.length > 0);
        if (!sha) continue;
        out.push({ sha, ts, parents, files });
    }
    return out;
}

/**
 * Devuelve el contenido de agent-models.json en un sha específico, parseado.
 * Si no existe en ese sha (commit primero) o no parsea, devuelve null.
 */
function getAgentModelsAtSha(sha, opts) {
    const _opts = opts || {};
    const cwd = _opts.cwd || process.cwd();
    const exec = _opts.execFile || execFileSync;
    try {
        const out = exec('git', ['show', `${sha}:.pipeline/agent-models.json`], {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            // Silenciar stderr — un sha que no contiene el archivo es un caso
            // esperado (commit inicial, branch viejo) y NO queremos polución
            // en el output del CLI ni del cron.
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(out);
    } catch (_e) {
        return null;
    }
}

// ─── Computación de diffs por skill ──────────────────────────────────────────

/**
 * Compara dos vistas allowlistadas (output de `agentModels.allowlistedFieldsForDiff`)
 * y devuelve un array de cambios por skill. Cada cambio incluye:
 *   - skill: nombre
 *   - changes: { provider?: {from, to}, model?: {from, to}, ... }
 *
 * Solo se reportan campos que efectivamente cambiaron — no se generan filas
 * "sin cambios" (CA-B-3).
 *
 * Skills que aparecen solo en `to` (agregados) o solo en `from` (eliminados)
 * también se reportan, con `from`/`to` en undefined según corresponda.
 */
function diffSkills(fromView, toView) {
    const fromSkills = (fromView && fromView.skills) || {};
    const toSkills = (toView && toView.skills) || {};
    const allSkillNames = new Set([
        ...Object.keys(fromSkills),
        ...Object.keys(toSkills),
    ]);
    const out = [];
    for (const skill of allSkillNames) {
        const fromState = fromSkills[skill];
        const toState = toSkills[skill];
        // Si el skill estaba antes y ya no está, lo reportamos como "removed".
        // Si es nuevo, "added". Si los dos lados existen, computamos campo a campo.
        if (!fromState && toState) {
            out.push({
                skill,
                kind: 'added',
                changes: pickAll(toState),
            });
            continue;
        }
        if (fromState && !toState) {
            out.push({
                skill,
                kind: 'removed',
                changes: pickAll(fromState),
            });
            continue;
        }
        const changes = {};
        for (const key of agentModels.ALLOWLISTED_FIELDS_FOR_NOTIFICATION) {
            const a = fromState[key];
            const b = toState[key];
            if (!shallowEqual(a, b)) {
                changes[key] = { from: a == null ? null : a, to: b == null ? null : b };
            }
        }
        if (Object.keys(changes).length > 0) {
            out.push({ skill, kind: 'modified', changes });
        }
    }
    return out;
}

function shallowEqual(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    return false;
}

function pickAll(state) {
    const out = {};
    for (const key of agentModels.ALLOWLISTED_FIELDS_FOR_NOTIFICATION) {
        out[key] = state[key] == null ? null : state[key];
    }
    return out;
}

// ─── Costo estimado por sesión ───────────────────────────────────────────────

/**
 * Lee `.claude/activity-log.jsonl` y devuelve `{ sessions, avg_tokens_per_session }`
 * para un skill dado, con cutoff de los últimos `lookbackDays` (default 30).
 * Si el archivo no existe o no hay sesiones del skill, devuelve `{ sessions: 0,
 * avg_tokens_per_session: 0 }`.
 *
 * Función liviana (no usa metrics/aggregator.js entero) — el aggregator es
 * async, hace muchas pasadas y trae más payload del necesario para una alerta.
 */
function readBaselineForSkill(skill, opts) {
    const _opts = opts || {};
    const logFile = _opts.logFile || path.resolve(__dirname, '..', '..', '.claude', 'activity-log.jsonl');
    const lookbackDays = Number.isFinite(_opts.lookbackDays) ? _opts.lookbackDays : 30;
    const now = Number.isFinite(_opts.nowMs) ? _opts.nowMs : Date.now();
    const cutoff = now - lookbackDays * 86400 * 1000;

    let raw;
    try {
        raw = fs.readFileSync(logFile, 'utf8');
    } catch (_e) {
        return { sessions: 0, avg_tokens_per_session: 0 };
    }

    let totalTokens = 0;
    let sessions = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch (_) { continue; }
        if (!evt || evt.event !== 'session:end') continue;
        if (evt.skill !== skill) continue;
        if (evt.ts) {
            const ms = Date.parse(evt.ts);
            if (Number.isFinite(ms) && ms < cutoff) continue;
        }
        sessions += 1;
        totalTokens += Number(evt.tokens_in || 0)
            + Number(evt.tokens_out || 0)
            + Number(evt.cache_read || 0)
            + Number(evt.cache_write || 0);
    }
    if (sessions === 0) return { sessions: 0, avg_tokens_per_session: 0 };
    return {
        sessions,
        avg_tokens_per_session: Math.round(totalTokens / sessions),
    };
}

/**
 * Estima el costo USD por sesión para un skill+modelo dados.
 * Devuelve null si:
 *   - El modelo no está en MODEL_PRICING (CA-C-4 — gap OpenAI/Codex documentado en #3133).
 *   - No hay baseline empírica (CA-C-3 sub-caso "sin baseline").
 *
 * Devuelve { usd, sessions, baselineShort } cuando hay datos. `baselineShort`
 * es true si sessions < BASELINE_MIN_SESSIONS (CA-C-3 disclaimer).
 *
 * @returns {null|{usd: number, sessions: number, baselineShort: boolean}}
 */
function estimateCostPerSession(skill, model, opts) {
    if (!model) return null;
    const key = String(model).toLowerCase().replace(/-\d{8}$/, '').trim();
    const pricing = MODEL_PRICING[key];
    if (!pricing) return null;

    const baseline = readBaselineForSkill(skill, opts);
    if (baseline.sessions === 0 || baseline.avg_tokens_per_session === 0) return null;

    // Aproximación: tratamos avg_tokens_per_session como tokens "totales" repartidos
    // 50/50 input/output. Es una estimación intencionalmente conservadora — el delta
    // entre dos modelos es lo que importa, no el valor absoluto perfecto.
    // El refinamiento con breakdown real (in/out/cache) es trabajo del aggregator
    // y se conecta cuando la baseline cross-provider de #3090 esté en main.
    const half = baseline.avg_tokens_per_session / 2;
    const usdRaw = (half * pricing.in + half * pricing.out) / 1e6;
    return {
        usd: Math.round(usdRaw * 10000) / 10000,
        sessions: baseline.sessions,
        baselineShort: baseline.sessions < BASELINE_MIN_SESSIONS,
    };
}

/**
 * Devuelve el "render" del costo para un skill que cambia de modelo:
 *   - Si AMBOS modelos están en pricing y hay baseline → "$0.0234 → $0.0089 (-62%)"
 *     (con disclaimer si baselineShort).
 *   - Si el modelo nuevo NO está en pricing → "no disponible (modelo no en pricing table)".
 *   - Si la baseline es 0 → "no disponible (sin baseline)".
 *
 * Devuelve `{ line, secondLine, severity }` donde:
 *   - line: la línea principal a mostrar (sin escape MdV2 — el caller lo aplica).
 *   - secondLine: disclaimer de baseline corta o null.
 *   - severity: 'savings' | 'increase' | 'neutral' | 'unknown' — para emoji.
 */
function renderCostLine(skill, fromModel, toModel, opts) {
    const fromCost = estimateCostPerSession(skill, fromModel, opts);
    const toCost = estimateCostPerSession(skill, toModel, opts);
    if (!toCost) {
        // El costo del NUEVO modelo es lo que importa; si no se puede calcular,
        // el delta pierde sentido. Pero distinguimos los dos motivos para que el
        // operador entienda por qué.
        if (!toModel) return { line: 'costo estimado: no disponible (sin modelo destino)', secondLine: null, severity: 'unknown' };
        const key = String(toModel).toLowerCase().replace(/-\d{8}$/, '').trim();
        if (!MODEL_PRICING[key]) {
            return { line: 'costo estimado: no disponible (modelo no en pricing table)', secondLine: null, severity: 'unknown' };
        }
        return { line: 'costo estimado: no disponible (sin baseline)', secondLine: null, severity: 'unknown' };
    }

    if (!fromCost) {
        // Tenemos costo del nuevo pero no del viejo — mostramos el nuevo solo,
        // sin delta. Mejor que inventar un "+∞%".
        const sessions = toCost.sessions;
        const second = toCost.baselineShort ? `_baseline corta — N=${sessions}, dato indicativo_` : null;
        return {
            line: `costo estimado por sesión: ${usd4(toCost.usd)} (basado en ${sessions} sesiones, últimos 30 días)`,
            secondLine: second,
            severity: 'neutral',
        };
    }

    const delta = deltaPct(fromCost.usd, toCost.usd);
    const fromUsd = usd4(fromCost.usd);
    const toUsd = usd4(toCost.usd);
    const deltaText = formatPctSigned(delta);

    let severity = 'neutral';
    if (delta != null) {
        if (delta > 0 && Math.abs(delta) >= DELTA_HIGHLIGHT_THRESHOLD) severity = 'increase';
        else if (delta < 0 && Math.abs(delta) >= DELTA_HIGHLIGHT_THRESHOLD) severity = 'savings';
    }

    const sessions = Math.min(fromCost.sessions, toCost.sessions);
    const baselineShort = fromCost.baselineShort || toCost.baselineShort;
    const second = baselineShort ? `_baseline corta — N=${sessions}, dato indicativo_` : null;

    return {
        line: `costo estimado por sesión: ${fromUsd} → ${toUsd} (${deltaText}) basado en ${sessions} sesiones (últimos 30 días)`,
        secondLine: second,
        severity,
    };
}

// ─── Co-commit con archivos sensibles (CA-S8) ───────────────────────────────

/**
 * Devuelve true si el commit tocó algún archivo que matchee SENSITIVE_PATH_PATTERNS.
 * No-eco: no leemos contenido, solo nombres de archivo.
 *
 * @param {string[]} files — lista de paths del commit (output de detectChanges)
 */
function detectSensitiveCoCommit(files) {
    if (!Array.isArray(files)) return false;
    for (const file of files) {
        if (typeof file !== 'string') continue;
        for (const re of SENSITIVE_PATH_PATTERNS) {
            if (re.test(file)) return true;
        }
    }
    return false;
}

// ─── Consolidación temporal (CA-S5 / CA-E-1) ────────────────────────────────

/**
 * Toma una lista de commits ordenada (más viejo → más nuevo) y los agrupa en
 * "ventanas" donde commits con timestamp dentro de `windowMs` quedan juntos.
 * El commit base de cada ventana es el primero (más viejo).
 *
 * @param {Array<{sha:string, ts:string}>} commits
 * @param {number} [windowMs=CONSOLIDATION_WINDOW_MS]
 * @returns {Array<Array<{sha:string, ts:string}>>}
 */
function consolidateWindow(commits, windowMs) {
    const _ms = windowMs == null ? CONSOLIDATION_WINDOW_MS : windowMs;
    const out = [];
    let bucket = null;
    for (const c of commits || []) {
        const t = Date.parse(c.ts);
        if (!Number.isFinite(t)) continue;
        if (!bucket) {
            bucket = [c];
            continue;
        }
        const firstT = Date.parse(bucket[0].ts);
        if (t - firstT <= _ms) {
            bucket.push(c);
        } else {
            out.push(bucket);
            bucket = [c];
        }
    }
    if (bucket) out.push(bucket);
    return out;
}

// ─── Formateo del mensaje Telegram (CA-B / CA-E-2) ──────────────────────────

/**
 * Toma una lista consolidada de "skill changes" + costos y arma el texto
 * Markdown V2 listo para Telegram. SIEMPRE pasa por sanitize + redactSensitive.
 *
 * Formato base (single change):
 *
 *   🔄 Cambio de provider/model commiteado
 *
 *   *skill*: `backend-dev`
 *   `claude-opus-4-7` → `claude-sonnet-4-6`
 *
 *   ```
 *   campo            antes              después
 *   provider         anthropic          anthropic
 *   model            claude-opus-4-7    claude-sonnet-4-6
 *   ```
 *
 *   costo estimado por sesión: $0.0234 → $0.0089 (-62%) basado en 12 sesiones (últimos 30 días)
 *
 * Formato consolidado (>1 skill change en ventana):
 *
 *   🔄 Cambios de provider/model consolidados (últimos 5 min)
 *
 *   ```
 *   ux:           sonnet-4-6 → gpt-5-codex   (+18%)
 *   backend-dev:  opus-4-7   → opus-4-7      (model_override actualizado)
 *   qa:           haiku-4-5  → sonnet-4-6    (+340%, ⚠ revisar)
 *   ```
 *
 * @param {object} bucket — output de buildBucket(commits, fromCfg, toCfg, opts)
 * @returns {string} texto sanitizado, MarkdownV2-escaped
 */
function formatTelegramMessage(bucket) {
    if (!bucket || !Array.isArray(bucket.changes) || bucket.changes.length === 0) {
        return '';
    }

    // Sanitizador de valores escalares ANTES de pasar por escapeMdV2 (review #2 / CA-B-2).
    // Si fromM/toM contienen un secret (ej. sk-token mal puesto en model_override),
    // hay que redactarlo antes de escapar MdV2 — sino los regex aguas abajo dejan
    // pasar `sk\-test\-...` (Telegram colapsa los `\-` al renderizar).
    const sanitizeScalar = (v) => {
        if (v == null) return v;
        const s = typeof v === 'string' ? v : String(v);
        return redactSensitive(sanitize(applyLocalExtraSanitization(s)));
    };

    const isConsolidated = bucket.commitCount > 1 || bucket.changes.length > 1;
    const lines = [];

    if (isConsolidated) {
        lines.push(`🔄 ${escapeMdV2('Cambios de provider/model consolidados (últimos 5 min)')}`);
    } else {
        lines.push(`🔄 ${escapeMdV2('Cambio de provider/model commiteado')}`);
    }
    lines.push('');

    if (bucket.coCommitSensitive) {
        lines.push(`🚨 *${escapeMdV2('Atención')}*: ${escapeMdV2('este commit también modificó archivos con credenciales.')}`);
        lines.push('');
    }

    if (!isConsolidated) {
        // Render single-change.
        const change = bucket.changes[0];
        const skill = safeSkillName(change.skill);
        const modelChange = change.changes.model || change.changes.model_override;
        // Sanitizar ANTES de escapar MdV2 — review #2 / CA-B-2 / CA-S2.
        const fromM = modelChange ? sanitizeScalar(modelChange.from) : null;
        const toM = modelChange ? sanitizeScalar(modelChange.to) : null;

        lines.push(`*skill*: \`${escapeMdV2(skill)}\``);
        if (fromM != null && toM != null && fromM !== toM) {
            // Flecha unicode (no `->`) — safe en MarkdownV2.
            lines.push(`\`${escapeMdV2(String(fromM))}\` → \`${escapeMdV2(String(toM))}\``);
        }
        lines.push('');

        // Tabla compacta de cambios reales.
        const tableLines = [];
        const fields = agentModels.ALLOWLISTED_FIELDS_FOR_NOTIFICATION;
        const widths = {
            field: Math.max(...fields.map((f) => f.length), 'campo'.length),
            from: 0,
            to: 0,
        };
        const rows = [];
        for (const f of fields) {
            const c = change.changes[f];
            if (!c) continue;
            // Sanitizar los valores del bloque code-fenced — defensa en profundidad.
            // Dentro de ``` MdV2 no escapa, pero el regex de redacción canónico
            // sí matchea — aplicamos antes de imprimir.
            const a = c.from == null ? '—' : sanitizeScalar(String(c.from));
            const b = c.to == null ? '—' : sanitizeScalar(String(c.to));
            rows.push({ field: f, from: a, to: b });
            widths.from = Math.max(widths.from, a.length);
            widths.to = Math.max(widths.to, b.length);
        }
        widths.from = Math.max(widths.from, 'antes'.length);
        widths.to = Math.max(widths.to, 'después'.length);

        if (rows.length > 0) {
            tableLines.push(['campo'.padEnd(widths.field), 'antes'.padEnd(widths.from), 'después'.padEnd(widths.to)].join('  '));
            for (const r of rows) {
                tableLines.push([r.field.padEnd(widths.field), r.from.padEnd(widths.from), r.to.padEnd(widths.to)].join('  '));
            }
            // Bloque code fenced — el contenido NO se escapa MdV2 dentro de ```.
            lines.push('```');
            for (const tl of tableLines) lines.push(tl);
            lines.push('```');
            lines.push('');
        }

        // Costo estimado.
        const cost = change.costRender;
        if (cost) {
            const emoji = cost.severity === 'savings' ? '✓ '
                       : cost.severity === 'increase' ? '⚠ '
                       : '';
            lines.push(`${emoji}${escapeMdV2(cost.line)}`);
            if (cost.secondLine) lines.push(escapeMdV2(cost.secondLine));
        }
    } else {
        // Render consolidado.
        const tableLines = [];
        const trimmed = bucket.changes.slice(0, 5);
        for (const change of trimmed) {
            const skill = safeSkillName(change.skill);
            const mc = change.changes.model || change.changes.model_override;
            // Sanitizar ANTES de meter al bloque code-fenced — defensa en profundidad.
            const fromM = mc ? (mc.from == null ? '—' : sanitizeScalar(String(mc.from))) : '—';
            const toM = mc ? (mc.to == null ? '—' : sanitizeScalar(String(mc.to))) : '—';
            const c = change.costRender;
            const deltaText = c && c.line.includes('(')
                ? c.line.match(/\(([^)]+)\)/)?.[1] || ''
                : '';
            const flag = c && c.severity === 'increase' ? ', ⚠ revisar' : '';
            tableLines.push(`${skill}: ${fromM} → ${toM} (${deltaText}${flag})`);
        }
        lines.push('```');
        for (const tl of tableLines) lines.push(tl);
        if (bucket.changes.length > 5) {
            lines.push(`… y ${bucket.changes.length - 5} más (ver audit log)`);
        }
        lines.push('```');
    }

    const raw = lines.join('\n');

    // Pipeline canónico de sanitización al final como red de seguridad (CA-S2).
    // Los escalares user-controlled (fromM/toM, valores de tabla) YA fueron
    // saneados arriba — esto es defensa en profundidad por si algún literal
    // futuro se cuela sin pasar por sanitizeScalar.
    //   1) applyLocalExtraSanitization → cubre sk-/xoxb-/ghp_ mientras S2 no esté.
    //   2) sanitizer.js::sanitize  → reemplaza tokens (AIza, AKIA*, JWT, telegram, ...)
    //   3) lib/redact.js::redactSensitive → emails, URLs con userinfo, etc.
    const localExtra = applyLocalExtraSanitization(raw);
    const sanitized = sanitize(localExtra);
    return redactSensitive(sanitized);
}

// ─── Narración para audio (CA-S4 / CA-D) ─────────────────────────────────────

/**
 * Genera el texto narrativo para TTS — TEMPLATE FIJO.
 *
 * NUNCA toma commit message ni autor crudo del repo (vector de prompt injection).
 * Solo recibe variables saneadas: skill, modelos, costo formateado, flag de co-commit.
 *
 * Apertura natural (rioplatense), cierre con acción esperada cuando aumenta costo.
 *
 * @param {object} bucket
 * @returns {string} texto narrativo (limpio, sin markdown), apto para TTS
 */
function generateNarrationScript(bucket) {
    if (!bucket || !Array.isArray(bucket.changes) || bucket.changes.length === 0) {
        return '';
    }

    const parts = [];

    // CA-D-4: si hay co-commit sensible, advertir PRIMERO.
    if (bucket.coCommitSensitive) {
        parts.push('Ojo Leito, este cambio vino con un commit que también tocó archivos de credenciales.');
    }

    const isConsolidated = bucket.changes.length > 1;
    if (isConsolidated) {
        parts.push(`Mirá, cambiaron ${bucket.changes.length} skills, te paso el desglose en el mensaje.`);
        // CA-D-3: NO leer cada cambio en el audio cuando es consolidado.
    } else {
        const change = bucket.changes[0];
        const skill = safeSkillName(change.skill);
        const mc = change.changes.model || change.changes.model_override;
        const provC = change.changes.provider;

        if (provC) {
            parts.push(`Loco, cambió el provider del skill ${skill}.`);
            const fromP = provC.from || 'el anterior';
            const toP = provC.to || 'el nuevo';
            parts.push(`Pasó de ${fromP} a ${toP}.`);
        } else if (mc) {
            parts.push(`Mirá, te cambié el modelo de ${skill}.`);
            const fromM = mc.from || 'el anterior';
            const toM = mc.to || 'el nuevo';
            parts.push(`Pasó de ${fromM} a ${toM}.`);
        } else {
            parts.push(`Hubo un cambio en la config de ${skill}.`);
        }

        // Dirección del costo en los primeros segundos.
        const c = change.costRender;
        if (c && c.severity === 'increase') {
            parts.push('El costo estimado por sesión sube respecto del anterior.');
            parts.push('Si querés revertirlo te aviso cómo.');
        } else if (c && c.severity === 'savings') {
            parts.push('El costo estimado por sesión baja respecto del anterior.');
        } else if (c && c.severity === 'unknown') {
            parts.push('No tengo baseline para estimar el costo, mirá el detalle en el mensaje.');
        }
    }

    // El audio nunca lleva tokens, paths ni nombres de archivo. Sanitizamos por
    // las dudas (defensa redundante con el formatter Telegram).
    const raw = parts.join(' ');
    return redactSensitive(sanitize(applyLocalExtraSanitization(raw)));
}

// ─── Construcción del bucket completo (commits → bucket renderizable) ───────

/**
 * Toma una ventana consolidada de commits y produce un "bucket" listo para
 * formatear/narrar/auditar. El bucket combina:
 *   - commitCount: cantidad de commits en la ventana
 *   - firstSha, lastSha
 *   - coCommitSensitive: union de las flags de cada commit
 *   - changes: lista de skill changes únicos (último estado por skill gana)
 *
 * Para el cálculo de costo, usamos el `to` del bucket completo (estado final
 * después del último commit) vs el `from` del primer commit de la ventana.
 *
 * @param {Array<{sha:string, ts:string, parents:string[], files:string[]}>} commits
 * @param {object} [opts]
 * @param {function} [opts.execFile]
 * @param {string} [opts.cwd]
 * @param {string} [opts.logFile]
 * @returns {object|null} bucket o null si no hay cambios efectivos
 */
function buildBucket(commits, opts) {
    const _opts = opts || {};
    if (!commits || commits.length === 0) return null;

    const first = commits[0];
    const last = commits[commits.length - 1];

    // Estado anterior: el de antes del primer commit (parent del primero).
    // Si no hay parent (commit inicial), usamos null y diffeamos vs vacío.
    let fromParent = null;
    if (first.parents && first.parents.length > 0) {
        fromParent = first.parents[0];
    }
    const fromCfg = fromParent
        ? getAgentModelsAtSha(fromParent, _opts) || { skills: {} }
        : { skills: {} };
    const toCfg = getAgentModelsAtSha(last.sha, _opts) || { skills: {} };

    const fromView = agentModels.allowlistedFieldsForDiff(fromCfg);
    const toView = agentModels.allowlistedFieldsForDiff(toCfg);
    const skillChanges = diffSkills(fromView, toView);
    if (skillChanges.length === 0) return null;

    // Para cada skill cambiado, calcular costRender con `from`/`to` resolvido.
    for (const ch of skillChanges) {
        const fromState = (fromView.skills && fromView.skills[ch.skill]) || null;
        const toState = (toView.skills && toView.skills[ch.skill]) || null;
        const fromModel = fromState ? fromState.model : null;
        const toModel = toState ? toState.model : null;
        ch.costRender = renderCostLine(ch.skill, fromModel, toModel, _opts);
    }

    // Co-commit sensible: si CUALQUIER commit del bucket tocó archivos sensibles.
    let coCommitSensitive = false;
    for (const c of commits) {
        if (detectSensitiveCoCommit(c.files)) {
            coCommitSensitive = true;
            break;
        }
    }

    return {
        firstSha: first.sha,
        lastSha: last.sha,
        firstTs: first.ts,
        lastTs: last.ts,
        commitCount: commits.length,
        coCommitSensitive,
        changes: skillChanges,
    };
}

// ─── Persistencia de cursor + audit log (CA-S6 / CA-S7) ─────────────────────

const LAST_NOTIFIED_FILENAME = 'agent-models-last-notified.json';
const AUDIT_DIR = 'audit';
const AUDIT_FILENAME = 'agent-models-notifications.jsonl';

function lastNotifiedPath(pipelineDir) {
    return path.join(pipelineDir, LAST_NOTIFIED_FILENAME);
}

function auditFilePath(pipelineDir) {
    return path.join(pipelineDir, AUDIT_DIR, AUDIT_FILENAME);
}

/**
 * Lee el cursor `last_notified_sha` desde disco. Si no existe, devuelve null.
 * No lanza — devuelve null en caso de I/O error (idempotencia: mejor reemitir
 * que perder una notificación).
 */
function readLastNotifiedSha(pipelineDir) {
    try {
        const file = lastNotifiedPath(pipelineDir);
        const raw = fs.readFileSync(file, 'utf8');
        const obj = JSON.parse(raw);
        return obj && typeof obj.sha === 'string' ? obj.sha : null;
    } catch (_e) {
        return null;
    }
}

/**
 * Persiste el cursor `last_notified_sha` con permisos 0o600.
 * Atómico: write a temp + rename.
 */
function persistLastNotifiedSha(pipelineDir, sha) {
    const file = lastNotifiedPath(pipelineDir);
    const tmp = file + '.tmp';
    const payload = JSON.stringify({ sha, ts: new Date().toISOString() }, null, 2);
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    // En Windows, fs.chmod efectivamente no aplica los bits de POSIX, pero la
    // intención queda documentada. En Unix sí aplica.
    try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/**
 * Append-only en `.pipeline/audit/agent-models-notifications.jsonl`.
 * Crea el directorio si no existe. Permisos 0o600 sobre el archivo.
 */
function auditAppend(pipelineDir, event) {
    const file = auditFilePath(pipelineDir);
    const dir = path.dirname(file);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        try { process.stderr.write(`[agent-models-change-alert] no pude crear ${dir}: ${e.message}\n`); } catch (_) {}
        return false;
    }
    try {
        fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch (_) {}
        return true;
    } catch (e) {
        try { process.stderr.write(`[agent-models-change-alert] no pude escribir audit: ${e.message}\n`); } catch (_) {}
        return false;
    }
}

// Hash determinístico simple (FNV-1a 32-bit) para from_state_hash / to_state_hash.
// No es crypto-grade — solo identifica visualmente estados distintos en audit log.
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function stateHash(view) {
    try {
        return fnv1a(JSON.stringify(view));
    } catch (_) {
        return '00000000';
    }
}

// ─── sendAlert ───────────────────────────────────────────────────────────────

/**
 * Punto de entrada para emitir una alerta.
 *   - prevSha: cursor previo (o null para "primer arranque" — se compara solo
 *     contra HEAD~1 ya que no hay rango).
 *   - headSha: HEAD actual de la rama protegida (usualmente origin/main).
 *   - opts.pipelineDir: override de `.pipeline/` (tests).
 *   - opts.dryRun: true para NO escribir queue ni audit (smoke tests).
 *   - opts.now: Date.now overridable.
 *
 * Devuelve `{ ok, alerts: [...] }` con la lista de alertas emitidas (una por
 * ventana consolidada). Si no hay cambios, devuelve `{ ok: true, alerts: [] }`.
 */
function sendAlert(prevSha, headSha, opts) {
    const _opts = opts || {};
    const pipelineDir = _opts.pipelineDir || path.resolve(__dirname, '..');
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const dryRun = !!_opts.dryRun;

    const commits = detectChanges(prevSha, headSha, _opts);
    if (commits.length === 0) {
        return { ok: true, alerts: [], reason: 'no_commits_touching_agent_models' };
    }
    const windows = consolidateWindow(commits, _opts.windowMs);
    const alerts = [];

    for (const window of windows) {
        const bucket = buildBucket(window, _opts);
        if (!bucket) continue; // sin cambios efectivos en la allowlist

        const text = formatTelegramMessage(bucket);
        const narration = generateNarrationScript(bucket);

        // Detector de "input sensible": si el sanitize cambió el texto vs raw,
        // la flag se levanta para auditoría. Comparamos longitudes y substrings
        // canónicos del sanitizer (la función no expone una API sin redactar).
        const sensitiveInputDetected = text.includes('[REDACTED:')
            || /\[REDACTED\]/.test(text)
            || /\*\*\*/.test(text);

        const queueDir = path.join(pipelineDir, 'servicios', 'telegram', 'pendiente');
        let alertResult = {
            ok: false,
            text,
            narration,
            firstSha: bucket.firstSha,
            lastSha: bucket.lastSha,
            commitCount: bucket.commitCount,
            coCommitSensitive: bucket.coCommitSensitive,
            sensitiveInputDetected,
            // Contrato sendAlert↔caller (review #3): exponemos la lista de skills
            // afectados para que el caller pueda loggear/auditar sin reinspeccionar
            // el bucket. Mismo dato que va al audit log (línea de skills_affected).
            skills_affected: bucket.changes.map((c) => c.skill),
        };

        if (!dryRun) {
            try {
                if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
                const filename = `${now}-agent-models-change.json`;
                const file = path.join(queueDir, filename);
                fs.writeFileSync(file, JSON.stringify({
                    text,
                    parse_mode: 'MarkdownV2',
                    narration_text: narration,  // para que un drainer futuro arme el TTS
                }), 'utf8');
                alertResult.ok = true;
                alertResult.queueFile = file;
            } catch (e) {
                alertResult.reason = `cannot_write_queue: ${e.message}`;
            }

            // Audit log siempre, incluso si la queue falló — es la fuente de
            // verdad forense.
            const fromCfg = bucket.firstSha && window[0].parents[0]
                ? getAgentModelsAtSha(window[0].parents[0], _opts) || { skills: {} }
                : { skills: {} };
            const toCfg = getAgentModelsAtSha(bucket.lastSha, _opts) || { skills: {} };
            const fromView = agentModels.allowlistedFieldsForDiff(fromCfg);
            const toView = agentModels.allowlistedFieldsForDiff(toCfg);
            auditAppend(pipelineDir, {
                ts: new Date(now).toISOString(),
                first_sha: bucket.firstSha,
                last_sha: bucket.lastSha,
                commit_count: bucket.commitCount,
                from_state_hash: stateHash(fromView),
                to_state_hash: stateHash(toView),
                skills_affected: bucket.changes.map((c) => c.skill),
                co_commit_sensitive: bucket.coCommitSensitive,
                sensitive_input_detected: sensitiveInputDetected,
                queue_file: alertResult.queueFile || null,
            });
        }

        alerts.push(alertResult);
    }

    if (!dryRun && alerts.some((a) => a.ok) && headSha) {
        try { persistLastNotifiedSha(pipelineDir, headSha); } catch (_) {}
    }

    return { ok: true, alerts };
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

function cliMain(argv) {
    const args = argv.slice(2);
    let prevSha = null;
    let headSha = null;
    let dryRun = false;
    let pipelineDir = path.resolve(__dirname, '..');
    let cwd = process.cwd();

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--prev' && args[i + 1]) prevSha = args[++i];
        else if (a === '--head' && args[i + 1]) headSha = args[++i];
        else if (a === '--commit' && args[i + 1]) headSha = args[++i];
        else if (a === '--pipeline-dir' && args[i + 1]) pipelineDir = path.resolve(args[++i]);
        else if (a === '--cwd' && args[i + 1]) cwd = path.resolve(args[++i]);
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--help' || a === '-h') {
            process.stdout.write([
                'agent-models-change-alert — alerta Telegram para cambios en agent-models.json',
                '',
                'Uso: node .pipeline/lib/agent-models-change-alert.js [--prev SHA] [--head SHA] [--dry-run]',
                '',
                'Si --prev no se pasa, se lee el cursor desde .pipeline/agent-models-last-notified.json.',
                'Si --head no se pasa, se usa HEAD del cwd.',
                '',
                'Exit codes:',
                '  0 = ejecución OK (haya o no haya alertas)',
                '  1 = error de I/O o git',
                '',
            ].join('\n'));
            process.exit(0);
        }
    }

    if (!headSha) {
        try {
            headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
        } catch (e) {
            process.stderr.write(`[agent-models-change-alert] no pude resolver HEAD: ${e.message}\n`);
            process.exit(1);
        }
    }

    if (!prevSha) {
        prevSha = readLastNotifiedSha(pipelineDir);
    }

    if (prevSha === headSha) {
        // Idempotencia post-reinicio (CA-S6): mismo SHA, no re-emitir.
        process.stdout.write(`[agent-models-change-alert] OK ${headSha} ya notificado, skip\n`);
        process.exit(0);
    }

    const result = sendAlert(prevSha, headSha, { pipelineDir, cwd, dryRun });
    if (!result.ok) {
        process.stderr.write(`[agent-models-change-alert] FAIL: ${JSON.stringify(result)}\n`);
        process.exit(1);
    }
    process.stdout.write(`[agent-models-change-alert] OK ${result.alerts.length} alerta(s) ${dryRun ? '(dry-run)' : 'emitida(s)'}\n`);
    process.exit(0);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Constantes de tuning expuestas para tests.
    CONSOLIDATION_WINDOW_MS,
    DELTA_HIGHLIGHT_THRESHOLD,
    BASELINE_MIN_SESSIONS,
    SENSITIVE_PATH_PATTERNS,
    LAST_NOTIFIED_FILENAME,
    AUDIT_DIR,
    AUDIT_FILENAME,

    // Detección y diff.
    detectChanges,
    parseGitLogOutput,
    getAgentModelsAtSha,
    diffSkills,

    // Costo.
    readBaselineForSkill,
    estimateCostPerSession,
    renderCostLine,

    // Co-commit + consolidación.
    detectSensitiveCoCommit,
    consolidateWindow,
    buildBucket,

    // Render.
    formatTelegramMessage,
    generateNarrationScript,
    escapeMdV2,
    safeSkillName,
    applyLocalExtraSanitization,

    // Persistencia.
    readLastNotifiedSha,
    persistLastNotifiedSha,
    auditAppend,
    auditFilePath,
    lastNotifiedPath,
    stateHash,

    // API principal.
    sendAlert,
};

if (require.main === module) {
    try {
        cliMain(process.argv);
    } catch (e) {
        process.stderr.write(`[agent-models-change-alert] FATAL: ${e.stack || e.message}\n`);
        process.exit(1);
    }
}
