// =============================================================================
// recommendations-cut.js — corte transitorio de recomendaciones (#7673)
//
// Hasta que la Ola Propuestas (#7361 · modo ledger) reemplace el mecanismo, los
// agentes (guru, security, review, ux, po) NO crean issues de recomendación
// (`tipo:recomendacion` / `source:recommendation`). Las oportunidades van al
// comentario del issue origen bajo "Otras oportunidades observadas".
//
// Módulo chico y puro que comparten:
//   - `servicio-github.js` (defensa en profundidad sobre la cola `create-issue`);
//   - `.claude/hooks/recommendation-guard.js` (freno efectivo del `gh` directo).
//
// Reglas de seguridad (comentario de security en #7673):
//   SEC-1  la bandera falla CERRADA: sólo el booleano `true` literal reactiva la
//          creación. Ausente, `null`, `"true"`, `1`, YAML ilegible o excepción ⇒
//          `false` (corte activo).
//   SEC-3  `matchBashCommand` sólo COMPARA el string: nunca ejecuta ni interpola
//          el comando del agente.
//   SEC-6  lectura en caliente con caché de TTL ≤ 60 s: prender o apagar la
//          bandera se aplica sin reiniciar servicios.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TIPO_RECOMENDACION = 'tipo:recomendacion';
const SOURCE_RECOMMENDATION = 'source:recommendation';
const RECOMMENDATION_LABELS = Object.freeze([TIPO_RECOMENDACION, SOURCE_RECOMMENDATION]);

// SEC-6 — techo duro del TTL. Un TTL mayor haría que el corte o la
// reactivación se apliquen tarde sin que nadie lo note.
const CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_TTL_MS = 60 * 1000;

// Mensaje único para el agente bloqueado (hook) y para la auditoría. Pauta UX:
// qué pasó + qué hacer en su lugar; sin comando ni labels completos (SEC-4).
const BLOCK_MESSAGE =
    '⛔ Creación de recomendaciones pausada (#7673, `recomendaciones.crear_issues: false`). ' +
    'No crees el issue: agregá la oportunidad como una línea en "Otras oportunidades observadas" ' +
    'del comentario del issue origen.';

const MAX_TITLE_CHARS = 120;

// -----------------------------------------------------------------------------
// Bandera
// -----------------------------------------------------------------------------

const _cache = new Map(); // file -> { value, ts }

function defaultConfigPath() {
    // Misma precedencia de directorio que el resto del pipeline (D-1):
    // `PIPELINE_DIR_OVERRIDE` > `PIPELINE_STATE_DIR` > `PIPELINE_REPO_ROOT/.pipeline`
    // > el `.pipeline/` de este módulo. Require perezoso: el hook sólo llega acá
    // cuando el comando ya coincidió, así que Bash no paga el costo de `ajv`.
    return require('./config-resolver').resolveConfigPath().file;
}

/**
 * Lee `recomendaciones.crear_issues` del `config.yaml`. **Nunca tira.**
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] - path explícito (tests).
 * @param {number} [opts.now]        - reloj inyectable (tests del TTL).
 * @param {number} [opts.ttlMs]      - TTL de la caché (se capea a 60 s).
 * @param {object} [opts.fsImpl]     - fs inyectable.
 * @returns {boolean} `true` sólo si la bandera vale el booleano `true`.
 */
function isCreationEnabled(opts = {}) {
    try {
        const now = typeof opts.now === 'number' ? opts.now : Date.now();
        const ttl = Math.min(
            typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : CACHE_TTL_MS,
            MAX_CACHE_TTL_MS,
        );
        const file = opts.configPath ? path.resolve(opts.configPath) : defaultConfigPath();
        const hit = _cache.get(file);
        if (hit && now - hit.ts >= 0 && now - hit.ts < ttl) return hit.value;

        const value = readFlag(file, opts.fsImpl || fs);
        _cache.set(file, { value, ts: now });
        return value;
    } catch {
        return false; // SEC-1
    }
}

function readFlag(file, fsImpl) {
    try {
        const texto = fsImpl.readFileSync(file, 'utf8');
        // js-yaml v4: `load` es safe-by-default (mismo criterio que config-resolver, CA-17).
        const doc = require('js-yaml').load(texto);
        const sec = doc && typeof doc === 'object' ? doc.recomendaciones : null;
        return !!(sec && typeof sec === 'object' && sec.crear_issues === true);
    } catch {
        return false; // SEC-1 — YAML ilegible o archivo ausente ⇒ corte activo.
    }
}

function _resetCacheForTests() {
    _cache.clear();
}

// -----------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------

/** Acepta CSV o array; devuelve componentes trimeados en minúsculas. */
function normalizeLabels(labels) {
    const items = Array.isArray(labels) ? labels : [labels];
    const out = [];
    for (const it of items) {
        if (it == null) continue;
        for (const c of String(it).split(',')) {
            const n = c.trim().toLowerCase();
            if (n) out.push(n);
        }
    }
    return out;
}

/** ¿Hay `tipo:recomendacion` o `source:recommendation` (CSV o array, case-insensitive)? */
function hasRecommendationLabel(labels) {
    return normalizeLabels(labels).some((l) => RECOMMENDATION_LABELS.includes(l));
}

// -----------------------------------------------------------------------------
// Detección en comandos Bash (SEC-3) — sólo comparación de strings
// -----------------------------------------------------------------------------

/**
 * Tokenizador shell mínimo: respeta comillas simples/dobles y escapes, y corta
 * segmentos en `;`, `&`, `|` y saltos de línea fuera de comillas. Devuelve una
 * lista de segmentos, cada uno una lista de palabras.
 */
function tokenize(command) {
    const segments = [];
    let words = [];
    let cur = '';
    let has = false; // la palabra actual existe (aunque sea vacía por comillas)
    let quote = null;
    const s = String(command || '');
    const pushWord = () => {
        if (has) words.push(cur);
        cur = '';
        has = false;
    };
    const pushSegment = () => {
        pushWord();
        if (words.length) segments.push(words);
        words = [];
    };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote === "'") {
            if (ch === "'") quote = null;
            else cur += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
                cur += s[++i];
            } else if (ch === '"') {
                quote = null;
            } else {
                cur += ch;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            has = true;
            continue;
        }
        if (ch === '\\' && i + 1 < s.length) {
            const nx = s[++i];
            if (nx !== '\n') {
                cur += nx;
                has = true;
            }
            continue;
        }
        if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') {
            pushSegment();
            continue;
        }
        if (/\s/.test(ch)) {
            pushWord();
            continue;
        }
        cur += ch;
        has = true;
    }
    pushSegment();
    return segments;
}

// Palabras que pueden preceder a la palabra de comando sin cambiar qué se ejecuta.
const COMMAND_PREFIXES = new Set([
    'env', 'command', 'exec', 'time', 'nohup', 'sudo',
    'then', 'do', 'else', 'if', 'while', 'until', '{', '!',
]);

function isCommandPrefix(word) {
    return COMMAND_PREFIXES.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isGhBinary(word) {
    const base = String(word).replace(/\\/g, '/').split('/').pop().toLowerCase();
    return base === 'gh' || base === 'gh.exe';
}

/**
 * Lee el valor de un flag largo/corto en la posición `i`. Soporta
 * `--flag valor`, `--flag=valor`, `-f valor` y `-fvalor`.
 * Devuelve `{ value, next }` o `null` si el token no es ese flag.
 */
function flagValue(tokens, i, longNames, shortNames) {
    const t = tokens[i];
    for (const ln of longNames) {
        if (t === ln) return { value: tokens[i + 1], next: i + 2 };
        if (t.startsWith(ln + '=')) return { value: t.slice(ln.length + 1), next: i + 1 };
    }
    for (const sn of shortNames) {
        if (t === sn) return { value: tokens[i + 1], next: i + 2 };
        if (t.startsWith(sn) && t.length > sn.length && !t.startsWith('--')) {
            const rest = t.slice(sn.length);
            return { value: rest.startsWith('=') ? rest.slice(1) : rest, next: i + 1 };
        }
    }
    return null;
}

function analyzeGhInvocation(args) {
    // Subcomando: las primeras palabras que no son flags.
    const positional = args.filter((a) => !a.startsWith('-'));
    let kind = null;
    const iIssue = args.indexOf('issue');
    if (iIssue !== -1 && (args[iIssue + 1] === 'create' || args[iIssue + 1] === 'new')) kind = 'create';
    else if (iIssue !== -1 && args[iIssue + 1] === 'edit') kind = 'edit';
    else if (positional[0] === 'api' && positional.slice(1).some((p) => /(^|\/)issues(\/|$|\?)/i.test(p))) kind = 'api';
    if (!kind) return null;

    const labels = [];
    let title = null;
    for (let i = 0; i < args.length; ) {
        let r = null;
        if (kind === 'create') {
            r = flagValue(args, i, ['--label'], ['-l']);
        } else if (kind === 'edit') {
            r = flagValue(args, i, ['--add-label'], []);
        } else {
            r = flagValue(args, i, ['--field', '--raw-field'], ['-f', '-F']);
            if (r) {
                const v = String(r.value == null ? '' : r.value);
                const m = v.match(/^labels(\[\])?=(.*)$/i);
                if (m) labels.push(m[2]);
                i = r.next;
                continue;
            }
        }
        if (r) {
            if (r.value != null) labels.push(r.value);
            i = r.next;
            continue;
        }
        const t = flagValue(args, i, ['--title'], ['-t']);
        if (t) {
            if (title == null && t.value != null) title = String(t.value);
            i = t.next;
            continue;
        }
        i++;
    }
    return { kind, labels: normalizeLabels(labels), title };
}

/**
 * ¿El comando Bash intenta crear (o etiquetar) un issue de recomendación?
 *
 * Cubre `gh issue create` (`--label X`, `--label=X`, `-l X`, varios flags,
 * comillas, cualquier orden), `gh issue edit … --add-label` y
 * `gh api …/issues … -f/-F labels[]=`. Case-insensitive en los labels.
 *
 * @param {string} command
 * @returns {null | {kind: 'create'|'edit'|'api', labels: string[], title: (string|null)}}
 *          `labels` son SOLO los de recomendación encontrados.
 */
function matchBashCommand(command) {
    try {
        if (!command || typeof command !== 'string') return null;
        // Atajo barato: sin el texto de los labels no hay nada que mirar.
        const low = command.toLowerCase();
        if (!low.includes(TIPO_RECOMENDACION) && !low.includes(SOURCE_RECOMMENDATION)) return null;
        for (const words of tokenize(command)) {
            for (let i = 0; i < words.length; i++) {
                // `gh` tiene que ser la PALABRA DE COMANDO del segmento: un
                // `echo gh issue create …` o un `git commit -m "gh … -l …"` no crean nada.
                if (!words.slice(0, i).every(isCommandPrefix)) break;
                if (!isGhBinary(words[i])) continue;
                const res = analyzeGhInvocation(words.slice(i + 1));
                if (!res) continue;
                const reco = res.labels.filter((l) => RECOMMENDATION_LABELS.includes(l));
                if (reco.length) {
                    return {
                        kind: res.kind,
                        labels: Array.from(new Set(reco)),
                        title: res.title == null ? null : truncateTitle(res.title),
                    };
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

function truncateTitle(title) {
    const t = String(title == null ? '' : title);
    return t.length > MAX_TITLE_CHARS ? t.slice(0, MAX_TITLE_CHARS) : t;
}

module.exports = {
    TIPO_RECOMENDACION,
    SOURCE_RECOMMENDATION,
    RECOMMENDATION_LABELS,
    CACHE_TTL_MS,
    MAX_CACHE_TTL_MS,
    MAX_TITLE_CHARS,
    BLOCK_MESSAGE,
    isCreationEnabled,
    hasRecommendationLabel,
    normalizeLabels,
    matchBashCommand,
    truncateTitle,
    // helpers expuestos para tests
    tokenize,
    _resetCacheForTests,
};
