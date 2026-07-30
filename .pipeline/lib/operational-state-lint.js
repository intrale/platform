#!/usr/bin/env node
'use strict';

// =============================================================================
// operational-state-lint.js — Guardrail anti-regresión del envoltorio de acceso
// al estado operativo (`lib/operational-state.js`).
//
// Parte 1 de 3 del split de #5109 (issue #5175). Ola 9.4 · E2 (#5107).
//
// Objetivo
// --------
// Que ningún componente del pipeline vuelva a tocar el registro de olas
// (`waves.json`) ni la allowlist efectiva (`.partial-pause.json`, `.paused`)
// por fuera de la fachada `lib/operational-state.js`. El invariante está
// documentado en `docs/pipeline/contrato-estado-operativo.md` §2.
//
// ESTA PARTE NO MIGRA NADA. Es puramente aditiva: el binario nace con los tres
// modos, y el wiring (CI + hook) arranca en `--report-only`. El flip a
// `--check` va en la parte 3, cuando las violations estén en cero (R5 del
// issue). Un guardrail en `enforce` no puede mergearse antes que la migración
// porque fallaría contra su propio repo.
//
// Las dos reglas del matcher
// --------------------------
//   1. `path-level`      — literal de estado (`waves.json`, `.partial-pause.json`,
//                          `.paused`) DENTRO de una construcción de path. El
//                          literal solo NO alcanza: se exige confirmación por
//                          contexto local (±3 líneas) de `path.join/resolve`,
//                          `fs.*Sync` o `require('fs')`. Sin esa confirmación es
//                          copy del operador (`dashboard.js:7833`) o valor de
//                          dominio (`wave.source !== 'waves.json'`) — NO es
//                          acceso, y marcarlo inunda el inventario (CA-6c).
//
//   2. `internal-bypass` — uso de `_internal`, la superficie que la fachada
//                          expone SÓLO para tests. PROHIBIDO matchear
//                          `/\._internal/` a secas: `_internal` es convención
//                          transversal del pipeline y aparece en 78 archivos
//                          bajo `.pipeline/**/*.js` (R1). Se resuelve primero
//                          el binding local del `require(...operational-state)`
//                          y recién ahí se matchea `<binding>._internal`.
//                          Cubre las DOS formas del require: namespace
//                          (`const ops = require(...)`) y destructurada
//                          (`const { _internal } = require(...)`, con o sin
//                          alias) — un regex sobre `._internal` se evade con
//                          destructuring, comprobado en `dashboard-slices.js`.
//
// Cinco desvíos DELIBERADOS del template `ghost-artifact-lint.js`
// --------------------------------------------------------------
// No son omisiones. Ningún review posterior debería "corregirlos":
//
//   1. Shape del violation SIN `snippet` (CA-3b / SEC-2). El template hace
//      `snippet: m[0].slice(0,120)` y lo imprime. Acá no: el repo es público y
//      los logs de Actions también, y `--report --json` serializa el objeto
//      entero. El violation es estructural: `{file, line, rule}`. Nada más.
//
//   2. `loadAllowlist` fail-LOUD, no fail-silent (CA-5b / SEC-4). El template
//      hace `catch { return allowlist vacía }`. Acá eso borraría la señal: una
//      allowlist con BOM o truncada sería indistinguible de la allowlist vacía
//      a propósito, que es justo el estado deseado de este issue. JSON
//      inválido / shape inválido / entry incompleta ⇒ exit 2 citando archivo e
//      índice del entry ofensor. Archivo AUSENTE sí es allowlist vacía: la
//      ausencia no es ambigua, la corrupción sí.
//
//   3. Scope de `walkJs` ampliado al prefijo `test-` (CA-6d / R2), en vez de
//      entradas de allowlist. El template filtra `*.test.js` y `SKIP_DIRS`
//      pero no la convención `test-*.js` de la raíz de `.pipeline/` (20
//      archivos), y ya pagó ese costo con 2 entradas file-level que nadie va a
//      poder podar. Acá es una línea de scope.
//
//   4. Tres modos en vez de uno (CA-9a / UX-3). El template sólo tiene
//      `--check`. Ver tabla de modos abajo.
//
//   5. `files` (exención de archivo entero) exige `{file, reason}`, no un
//      string pelado. El template acepta strings y documenta la razón aparte,
//      en un `_files_doc` que puede desincronizarse. CA-5 pide `reason`
//      obligatoria y sin excepciones amplias: una exención MÁS amplia que
//      `{file, line, reason}` no puede tener MENOS justificación. La allowlist
//      nace con `files: []`, así que hoy no afecta a nadie.
//
// Modos (CA-9a / UX-3)
// --------------------
//   node .pipeline/lib/operational-state-lint.js --report [--json]
//       Inventario reproducible (CA-1a). Tabla markdown ordenada por (file,
//       line), sin timestamps ni rutas absolutas, byte-idéntica entre corridas.
//       exit 0 SIEMPRE.
//
//   node .pipeline/lib/operational-state-lint.js --report-only [--only=a,b]
//       Prefijo `AVISO:`. exit 0 SIEMPRE. Es el modo del wiring de la parte 1
//       (workflow + hook). `--only` filtra a una lista de archivos (el hook lo
//       usa con los staged files: sin filtro, escupe avisos de archivos que el
//       dev no tocó y entrena a ignorar el hook — UX-1).
//
//   node .pipeline/lib/operational-state-lint.js --check [--only=a,b]
//       Prefijo `ERROR:`. exit 1 si hay violations. RESERVADO PARA LA PARTE 3.
//
// Exit codes (contrato del template, igual en los tres modos)
//   0 → clean (o modo report/report-only, que nunca fallan por violations)
//   1 → violations encontradas (sólo `--check`)
//   2 → error interno / de configuración / uso inválido
//
// El exit 2 NO está subordinado al modo: un allowlist corrupta o un argumento
// inválido son errores del control, no violations del código auditado.
//
// API
// ---
//   const { lint } = require('./operational-state-lint');
//   const { violations, scanned } = lint({ pipelineRoot, allowlist });
// =============================================================================

const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[operational-state-lint]';

const DEFAULT_PIPELINE_ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_FILE = 'operational-state-lint.allowlist.json';
const ALLOWLIST_REL = `lib/${ALLOWLIST_FILE}`;

const CONTRACT_DOC = 'docs/pipeline/contrato-estado-operativo.md';

// Carpetas excluidas del scan por convención (mismo set que el template: no
// son código que acceda a estado operativo en runtime del pulpo).
const SKIP_DIRS = new Set([
    'node_modules', '__tests__', '_test-helpers', 'tests', 'archived',
    'archivado', 'audit', 'audio', 'logs', 'events', 'tmp', 'sessions',
    'metrics', 'definicion', 'desarrollo', 'servicios', 'quota-snapshots',
    'snapshots', 'fixtures', 'assets',
]);

// El sustrato del envoltorio y el propio guardrail quedan exentos por
// construcción (CA-10). `waves.js` y `partial-pause.js` SON los dueños del
// path físico; `operational-state.js` es la fachada que los envuelve; este
// archivo contiene los literales del matcher. Auditarlos sería tautológico.
// Esto NO son entradas de allowlist: es scope del control, revisado vía
// CODEOWNERS junto con el binario.
const SELF_EXEMPT = new Set([
    'lib/operational-state.js',
    'lib/waves.js',
    'lib/partial-pause.js',
    'lib/operational-state-lint.js',
]);

// ─── Regla 1 · path-level ───────────────────────────────────────────────────

// Literal de estado. `g` — se resetea `lastIndex` por archivo.
const STATE_LITERAL_RE = /['"`](?:waves\.json|\.partial-pause\.json|\.paused)['"`]/g;

// Confirmación por contexto local: sin esto el literal es copy o dominio.
const PATH_CTX_RE = /path\s*\.\s*(?:join|resolve)|fs\s*\.\s*[a-zA-Z]+Sync|require\(\s*['"]fs['"]\s*\)/;

const PATH_CTX_RADIUS = 3;

// Línea que ARRANCA con marcador de comentario (`//`, `/*`, o el `*` de
// continuación de un bloque JSDoc). Un literal ahí adentro es prosa, no acceso.
//
// Por qué hace falta y por qué así: el radio de ±3 líneas de la confirmación de
// contexto no distingue un comentario que MENCIONA `waves.json` de un acceso
// real cuando hay un `path.join` de otra cosa a 3 líneas de distancia (caso
// verificado: `lib/wizards/ola/index.js:49`, un comentario sobre `_setForTests`
// pegado a un `path.join(__dirname, ..., 'logs')`). Es el mismo fenómeno que
// domina el delta bruto-vs-confirmado: mayoritariamente comentario y doc.
//
// La regla mide si la LÍNEA arranca comentada, NO si el offset cae dentro de un
// comentario. `*` requiere además estar dentro de un bloque abierto: también
// puede iniciar un método generador ejecutable (`*load() { ... }`).
// El residuo conocido es el comentario al final de una línea de código
// (`const x = 1; // ver waves.json`), que se sigue reportando — conservador a
// propósito.
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*)/;

function isCommentOnlyLine(src, srcLines, line) {
    const text = srcLines[line - 1] || '';
    if (COMMENT_LINE_RE.test(text)) return true;
    if (!/^\s*\*/.test(text)) return false;

    const lineStart = srcLines.slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0);
    const prefix = src.slice(0, lineStart);
    return prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/');
}

// ─── Regla 2 · internal-bypass ──────────────────────────────────────────────

// Candidato de require del envoltorio, forma namespace. El binding se captura
// LAXO a propósito (`[^\s=;]+`) para que un require malformado sea un candidato
// DESCARTADO por `ID_RE` y no un match silenciosamente perdido ni una
// interpolación peligrosa en `new RegExp` (R4 / SEC-5).
const REQ_NS_RE = /(?:const|let|var)\s+([^\s=;{]+)\s*=\s*require\(\s*['"][^'"]*operational-state['"]\s*\)/g;

// Forma destructurada: `const { _internal } = require(...)` /
// `const { _internal: alias } = require(...)`. Capturamos el cuerpo del
// destructuring para inspeccionar si `_internal` está adentro.
const REQ_DEST_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*operational-state['"]\s*\)/g;

// `_internal` dentro del cuerpo del destructuring, con alias opcional.
const DEST_INTERNAL_RE = /\b_internal\b\s*(?::\s*([A-Za-z_$][\w$]*))?/;

// Misma guarda que `ghost-artifact-lint.js:164` — se aplica ANTES de
// interpolar el binding en `new RegExp` (R4).
const ID_RE = /^[A-Za-z_$][\w$]*$/;

const RULES = ['path-level', 'internal-bypass'];

// ─── Errores ────────────────────────────────────────────────────────────────

/** Error de configuración del propio control ⇒ exit 2, nunca exit 1. */
class LintConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LintConfigError';
    }
}

/** Error de uso del CLI ⇒ exit 2 con `uso: ...`. */
class LintUsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LintUsageError';
    }
}

// ─── Helpers (reusados tal cual del template) ───────────────────────────────

function defaultLogger() {
    return {
        info: (m) => console.log(`${LOG_PREFIX} ${m}`),
        warn: (m) => console.warn(`${LOG_PREFIX} ${m}`),
        error: (m) => console.error(`${LOG_PREFIX} ${m}`),
    };
}

function walkJs(root) {
    const out = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                if (e.name.startsWith('.')) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile()) {
                // R2 / CA-6d — la convención `test-*.js` de la raíz de
                // `.pipeline/` (20 archivos) queda fuera POR SCOPE, no por
                // entrada de allowlist.
                if (e.name.startsWith('test-')) continue;
                if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
                    out.push(path.join(dir, e.name));
                }
            }
        }
    }
    recurse(root);
    return out;
}

function pathPosixRel(pipelineRoot, absolute) {
    return path.relative(pipelineRoot, absolute).split(path.sep).join('/');
}

function lineOfOffset(source, offset) {
    let line = 1;
    for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
}

function lookupContext(source, line, radius = 25) {
    const lines = source.split('\n');
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line - 1 + radius + 1);
    return lines.slice(start, end).join('\n');
}

// ─── Allowlist ──────────────────────────────────────────────────────────────

/**
 * Valida y sanitiza `reason` (CA-5c / SEC-3).
 *
 * `reason` viene de un JSON del repo editable vía PR y termina en stdout de
 * Actions. Un `::stop-commands::<token>` ahí adentro usaría el mensaje de
 * error del guardrail para OCULTAR la salida del guardrail. Por eso validar y
 * sanitizar son la misma función: no hay camino donde una `reason` llegue a
 * stdout sin pasar por acá.
 */
function sanitizeReason(raw, where) {
    if (typeof raw !== 'string') {
        throw new LintConfigError(`${where}: "reason" es obligatoria y debe ser string (recibido: ${raw === undefined ? 'ausente' : typeof raw})`);
    }
    // Control chars + ANSI: rompen el formato del log y habilitan spoofing.
    const clean = raw.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) {
        throw new LintConfigError(`${where}: "reason" vacía. Cada excepción necesita una justificación real — el review humano de @leitolarreta es sobre ESE texto.`);
    }
    if (clean.startsWith('::')) {
        throw new LintConfigError(`${where}: "reason" no puede empezar con "::" (workflow command de GitHub Actions — SEC-3)`);
    }
    if (/^(?:TODO|FIXME|XXX|TBD|placeholder|wip|n\/a|none|-+|\.+|\?+)$/i.test(clean)) {
        throw new LintConfigError(`${where}: "reason" es un placeholder ("${clean}"). Escribí por qué esta excepción es legítima.`);
    }
    return clean.slice(0, 200);
}

function normalizeRel(p) {
    return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.pipeline\//, '');
}

/**
 * Fail-loud (desvío 2 / CA-5b / SEC-4).
 *   - archivo ausente  → allowlist vacía (la ausencia NO es ambigua)
 *   - JSON inválido    → LintConfigError ⇒ exit 2
 *   - shape inválido   → LintConfigError ⇒ exit 2
 *   - entry incompleta → LintConfigError ⇒ exit 2, citando índice
 */
function loadAllowlist(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', ALLOWLIST_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { files: new Set(), rules: [] };
        throw new LintConfigError(`${ALLOWLIST_REL}: no se pudo leer (${e && e.code ? e.code : 'error'})`);
    }

    let j;
    try {
        j = JSON.parse(raw);
    } catch (e) {
        throw new LintConfigError(`${ALLOWLIST_REL}: JSON inválido (${e.message}). NO se asume allowlist vacía: una allowlist corrupta y una allowlist vacía a propósito no pueden ser indistinguibles (SEC-4).`);
    }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
        throw new LintConfigError(`${ALLOWLIST_REL}: shape inválido, se esperaba un objeto { files: [], rules: [] }`);
    }
    for (const key of Object.keys(j)) {
        if (key === 'files' || key === 'rules' || key.startsWith('_')) continue;
        throw new LintConfigError(`${ALLOWLIST_REL}: clave desconocida "${key}". Claves válidas: "files", "rules" y documentación con prefijo "_".`);
    }

    const rawFiles = j.files === undefined ? [] : j.files;
    if (!Array.isArray(rawFiles)) {
        throw new LintConfigError(`${ALLOWLIST_REL}: "files" debe ser un array`);
    }
    const files = new Set();
    rawFiles.forEach((entry, i) => {
        const where = `${ALLOWLIST_REL} files[${i}]`;
        // Desvío 5 — exención de archivo entero exige `{file, reason}`.
        if (typeof entry === 'string') {
            throw new LintConfigError(`${where}: se esperaba { file, reason }, no un string. Una exención de archivo entero es MÁS amplia que { file, line, reason } y no puede tener MENOS justificación (CA-5).`);
        }
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new LintConfigError(`${where}: se esperaba un objeto { file, reason }`);
        }
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
            throw new LintConfigError(`${where}: "file" es obligatorio y debe ser un path relativo a .pipeline/`);
        }
        sanitizeReason(entry.reason, where);
        files.add(normalizeRel(entry.file));
    });

    const rawRules = j.rules === undefined ? [] : j.rules;
    if (!Array.isArray(rawRules)) {
        throw new LintConfigError(`${ALLOWLIST_REL}: "rules" debe ser un array`);
    }
    const rules = rawRules.map((entry, i) => {
        const where = `${ALLOWLIST_REL} rules[${i}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new LintConfigError(`${where}: se esperaba un objeto { file, line, reason }`);
        }
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
            throw new LintConfigError(`${where}: "file" es obligatorio y debe ser un path relativo a .pipeline/`);
        }
        if (!Number.isInteger(entry.line) || entry.line < 1) {
            throw new LintConfigError(`${where}: "line" es obligatorio y debe ser un entero >= 1 (recibido: ${JSON.stringify(entry.line)})`);
        }
        const reason = sanitizeReason(entry.reason, where);
        return { file: normalizeRel(entry.file), line: entry.line, reason };
    });

    return { files, rules };
}

// ─── Matcher ────────────────────────────────────────────────────────────────

/**
 * Regla 2 — bindings locales del `require(...operational-state)` que exponen
 * `_internal`. Devuelve:
 *   { namespaces: [ident], internalAliases: [ident], destructureLines: [n] }
 *
 * Los candidatos con binding no-identificador se DESCARTAN en silencio: no son
 * excepción (rompería el scan entero — R4) ni violation (no sabemos qué son).
 */
function resolveWrapperBindings(src) {
    const namespaces = [];
    const internalAliases = [];
    const destructureLines = [];

    REQ_NS_RE.lastIndex = 0;
    let m;
    while ((m = REQ_NS_RE.exec(src)) !== null) {
        const binding = m[1];
        if (!ID_RE.test(binding)) continue;   // descartar candidato, NO interpolar
        if (!namespaces.includes(binding)) namespaces.push(binding);
    }

    REQ_DEST_RE.lastIndex = 0;
    while ((m = REQ_DEST_RE.exec(src)) !== null) {
        const body = m[1];
        const hit = DEST_INTERNAL_RE.exec(body);
        if (!hit) continue;                   // destructura API pública, no `_internal`
        destructureLines.push(lineOfOffset(src, m.index));
        const alias = hit[1];
        if (alias && ID_RE.test(alias) && !internalAliases.includes(alias)) {
            internalAliases.push(alias);
        }
    }

    return { namespaces, internalAliases, destructureLines };
}

/**
 * Escanea un archivo. Devuelve `{ violations, rawLiteralHits, commentHits,
 * noCtxHits }`.
 *
 * `rawLiteralHits` = TODAS las ocurrencias del literal, comparable con un
 * `git grep`. Se descompone en tres buckets que particionan exacto:
 *
 *     rawLiteralHits = commentHits + noCtxHits + (violations path-level)
 *
 * El inventario publica los cuatro números para que el delta quede auditable:
 * que el confirmado dé mucho menos que el bruto es el guardrail funcionando
 * bien, no un matcher roto. PROHIBIDO relajar `PATH_CTX_RE` para "llegar" al
 * número bruto — eso reintroduce exactamente los falsos positivos de copy del
 * operador (UX-6 / CA-6c).
 */
function lintSource(rel, src, allowlist) {
    const out = [];
    let rawLiteralHits = 0;
    let commentHits = 0;
    let noCtxHits = 0;
    let confirmedHits = 0;
    const srcLines = src.split('\n');

    const seen = new Set();
    const push = (line, rule) => {
        const key = `${line}:${rule}`;
        if (seen.has(key)) return;            // determinismo: 1 violation por (file,line,rule)
        if (allowlist.rules.some(r => r.file === rel && r.line === line)) return;
        seen.add(key);
        // Shape EXACTO — sin `snippet` (CA-3b / SEC-2).
        out.push({ file: rel, line, rule });
    };

    // ── Regla 1 — path-level ────────────────────────────────────────────────
    STATE_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = STATE_LITERAL_RE.exec(src)) !== null) {
        rawLiteralHits++;
        const line = lineOfOffset(src, m.index);
        if (isCommentOnlyLine(src, srcLines, line)) { commentHits++; continue; }
        if (!PATH_CTX_RE.test(lookupContext(src, line, PATH_CTX_RADIUS))) { noCtxHits++; continue; }
        confirmedHits++;
        push(line, 'path-level');
    }

    // ── Regla 2 — internal-bypass ───────────────────────────────────────────
    const { namespaces, internalAliases, destructureLines } = resolveWrapperBindings(src);

    // La destructuración de `_internal` ES el bypass: se reporta en el require.
    for (const line of destructureLines) push(line, 'internal-bypass');

    for (const binding of namespaces) {
        const re = new RegExp(`\\b${binding}\\s*\\.\\s*_internal\\b`, 'g');
        let hit;
        while ((hit = re.exec(src)) !== null) {
            push(lineOfOffset(src, hit.index), 'internal-bypass');
        }
    }
    for (const alias of internalAliases) {
        const re = new RegExp(`\\b${alias}\\s*\\.`, 'g');
        let hit;
        while ((hit = re.exec(src)) !== null) {
            push(lineOfOffset(src, hit.index), 'internal-bypass');
        }
    }

    return { violations: out, rawLiteralHits, commentHits, noCtxHits, confirmedHits };
}

const EMPTY_SCAN = { violations: [], rawLiteralHits: 0, commentHits: 0, noCtxHits: 0, confirmedHits: 0 };

function lintFile(absolute, pipelineRoot, allowlist) {
    const rel = pathPosixRel(pipelineRoot, absolute);
    if (allowlist.files.has(rel)) return { ...EMPTY_SCAN };
    if (SELF_EXEMPT.has(rel)) return { ...EMPTY_SCAN };
    let src;
    try { src = fs.readFileSync(absolute, 'utf8'); }
    catch { return { ...EMPTY_SCAN }; }
    return lintSource(rel, src, allowlist);
}

/** `tests` vs `produccion` para el desglose del inventario (CA-1a). */
function classifyScope(rel) {
    const segs = rel.split('/');
    const base = segs[segs.length - 1];
    if (base.endsWith('.test.js') || base.startsWith('test-')) return 'tests';
    for (const s of segs.slice(0, -1)) {
        if (s === '__tests__' || s === 'tests' || s === '_test-helpers' || s === 'fixtures') return 'tests';
    }
    return 'produccion';
}

function lint(opts = {}) {
    const pipelineRoot = opts.pipelineRoot || DEFAULT_PIPELINE_ROOT;
    const allowlist = opts.allowlist || loadAllowlist(pipelineRoot);
    const files = walkJs(pipelineRoot);

    let violations = [];
    const rawByFile = new Map();
    const tally = { rawLiteralHits: 0, commentHits: 0, noCtxHits: 0, confirmedHits: 0 };
    for (const f of files) {
        const rel = pathPosixRel(pipelineRoot, f);
        const r = lintFile(f, pipelineRoot, allowlist);
        if (r.rawLiteralHits > 0) rawByFile.set(rel, r.rawLiteralHits);
        for (const k of Object.keys(tally)) tally[k] += r[k];
        for (const v of r.violations) violations.push(v);
    }

    if (Array.isArray(opts.only)) {
        const wanted = new Set(opts.only.map(normalizeRel));
        violations = violations.filter(v => wanted.has(v.file));
    }

    // UX-D / CA-1a — sort explícito: `readdirSync` no garantiza orden entre
    // máquinas ni filesystems. No confiar en el orden de recolección.
    violations.sort((a, b) => (
        a.file < b.file ? -1 : a.file > b.file ? 1
            : a.line - b.line
            || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    ));

    return {
        scanned: files.length,
        violations,
        rawLiteralFiles: rawByFile.size,
        ...tally,
    };
}

// ─── Formateo ───────────────────────────────────────────────────────────────

/** Una línea por violation. SIN snippet (CA-3b / SEC-2). */
function formatViolation(v, prefix) {
    const what = v.rule === 'path-level'
        ? 'literal de estado en construccion de path'
        : 'uso de `_internal` (superficie de tests, no API)';
    return `${prefix} ${v.file}:${v.line} - regla ${v.rule} (${what})`;
}

/**
 * Remediación DIFERENCIADA por regla (UX-A / UX-B / CA-3).
 *
 * Se emite UNA vez al final, no por violation: con ~24 violations el bloque
 * repetido sepulta la señal y entrena a ignorar el guardrail.
 *
 * Para `internal-bypass`, "usá el envoltorio" es NO accionable — el dev ya lo
 * importó. Y ante la ambigüedad semántica de "allowlist" está PROHIBIDO
 * sugerir una sola función: se listan las dos con su consecuencia.
 */
function remediationLines(rules) {
    const out = [];
    if (rules.has('path-level')) {
        out.push('');
        out.push('Remediacion - regla `path-level` (literal de estado en construccion de path):');
        out.push('  Importar `lib/operational-state.js` y usar la superficie publica en vez de');
        out.push(`  construir el path a mano. Superficie publica: ${CONTRACT_DOC} §6`);
        out.push('  Ojo: "allowlist" tiene dos significados en este contrato y NO son lo mismo:');
        out.push('    - Alcance de la ola   -> getWaveScopeIssues()                 derivado, NO gatea el dispatch');
        out.push('    - Allowlist efectiva  -> getDispatchState() / isIssueAllowed()  SI gatea el dispatch');
        out.push(`  Cual corresponde depende de tu caso: ${CONTRACT_DOC} §3`);
    }
    if (rules.has('internal-bypass')) {
        out.push('');
        out.push('Remediacion - regla `internal-bypass` (uso de `_internal`):');
        out.push('  `_internal` existe SOLO para que los tests monten fixtures y limpien cache.');
        out.push('  Es la unica superficie que revela rutas fisicas, y usarla desde produccion');
        out.push('  saltea el invariante entero.');
        out.push('  Si la superficie publica no cubre tu caso, PEDI EXTENDERLA en vez de');
        out.push(`  saltearla — lo que la fachada no expone y por que: ${CONTRACT_DOC} §7`);
    }
    if (out.length) {
        out.push('');
        out.push('  Si la excepcion es legitima: entry { file, line, reason } en');
        out.push(`  \`.pipeline/${ALLOWLIST_REL}\` — requiere review humano de @leitolarreta (CODEOWNERS).`);
    }
    return out;
}

function aggregateByFile(violations) {
    const byFile = new Map();
    for (const v of violations) {
        if (!byFile.has(v.file)) {
            byFile.set(v.file, { file: v.file, scope: classifyScope(v.file), 'path-level': 0, 'internal-bypass': 0, total: 0 });
        }
        const row = byFile.get(v.file);
        row[v.rule] += 1;
        row.total += 1;
    }
    // Orden alfabético por path (UX-4): estable e independiente del filesystem.
    return [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Inventario markdown (CA-1a / CA-1b). Se pega literal en un issue publico:
 * sin timestamps, sin rutas absolutas, byte-identico entre dos corridas.
 */
function formatReport(result) {
    const rows = aggregateByFile(result.violations);
    const L = [];
    L.push('# Inventario · accesos directos al estado operativo');
    L.push('');
    L.push('Generado por `node .pipeline/lib/operational-state-lint.js --report` (#5175, parte 1 de 3 de #5109).');
    L.push('Sin timestamps ni rutas absolutas: dos corridas seguidas dan salida byte-identica.');
    L.push('');
    L.push(`- Archivos JS en scope de \`walkJs\`: **${result.scanned}**`);
    L.push('');
    L.push('Descomposicion del literal de estado (`waves.json` / `.partial-pause.json` / `.paused`).');
    L.push('Los tres buckets particionan exacto el numero bruto, comparable con un `git grep`:');
    L.push('');
    L.push(`| bucket | ocurrencias | que es |`);
    L.push('|---|---:|---|');
    L.push(`| BRUTO (todas) | ${result.rawLiteralHits} | en ${result.rawLiteralFiles} archivos |`);
    L.push(`| descartado: linea comentada | ${result.commentHits} | prosa/doc que menciona el archivo, no acceso |`);
    L.push(`| descartado: sin contexto de path | ${result.noCtxHits} | copy del operador (\`confirm(...)\`) o valor de dominio (\`wave.source !== 'waves.json'\`) |`);
    L.push(`| CONFIRMADO path-level | ${result.confirmedHits} | literal dentro de una construccion de path |`);
    L.push('');
    L.push(`Violations reportadas: **${result.violations.length}** en **${rows.length}** archivos`);
    L.push('(deduplicadas por `(archivo, linea, regla)`, mas las de regla `internal-bypass`).');
    L.push('');
    L.push('Que el confirmado de mucho menos que el bruto es el guardrail funcionando bien, NO un');
    L.push('matcher roto. Relajar la confirmacion de contexto para "llegar" al numero bruto');
    L.push('reintroduce los falsos positivos de copy del operador (UX-6 / CA-6c).');
    L.push('');
    L.push('| archivo | scope | path-level | internal-bypass | total |');
    L.push('|---|---|---:|---:|---:|');
    for (const r of rows) {
        L.push(`| \`${r.file}\` | ${r.scope} | ${r['path-level']} | ${r['internal-bypass']} | ${r.total} |`);
    }

    const sub = (scope) => {
        const s = rows.filter(r => r.scope === scope);
        return {
            files: s.length,
            'path-level': s.reduce((a, r) => a + r['path-level'], 0),
            'internal-bypass': s.reduce((a, r) => a + r['internal-bypass'], 0),
            total: s.reduce((a, r) => a + r.total, 0),
        };
    };
    const prod = sub('produccion');
    const tst = sub('tests');
    L.push(`| **subtotal produccion** (${prod.files} archivos) | produccion | **${prod['path-level']}** | **${prod['internal-bypass']}** | **${prod.total}** |`);
    L.push(`| **subtotal tests** (${tst.files} archivos) | tests | **${tst['path-level']}** | **${tst['internal-bypass']}** | **${tst.total}** |`);
    L.push(`| **TOTAL** (${rows.length} archivos) | | **${prod['path-level'] + tst['path-level']}** | **${prod['internal-bypass'] + tst['internal-bypass']}** | **${result.violations.length}** |`);
    L.push('');
    L.push('> El subtotal `tests` es 0 por construccion, no por casualidad: `walkJs` excluye');
    L.push('> `*.test.js`, `__tests__/` y la convencion `test-*.js` de la raiz de `.pipeline/`');
    L.push('> (R2/R7). Si alguna vez aparece una fila `tests`, es bug del scope del control —');
    L.push('> NO caso de allowlist.');
    L.push('');
    L.push('Detalle `archivo:linea` (ordenado por archivo, luego linea):');
    L.push('');
    if (result.violations.length === 0) {
        L.push('- (ninguna)');
    } else {
        for (const v of result.violations) L.push(`- \`${v.file}:${v.line}\` — ${v.rule}`);
    }
    return L.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
    const opts = { mode: null, json: false, only: null };
    const MODES = { '--report': 'report', '--report-only': 'report-only', '--check': 'check' };
    for (const a of argv) {
        if (MODES[a]) {
            if (opts.mode && opts.mode !== MODES[a]) {
                throw new LintUsageError(`modos mutuamente excluyentes: --${opts.mode} y ${a}`);
            }
            opts.mode = MODES[a];
        } else if (a === '--json') {
            opts.json = true;
        } else if (a.startsWith('--only=')) {
            opts.only = a.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean);
        } else {
            throw new LintUsageError(`argumento desconocido: ${a}`);
        }
    }
    if (!opts.mode) throw new LintUsageError('falta el modo');
    if (opts.json && opts.mode !== 'report') {
        throw new LintUsageError('--json solo es valido con --report');
    }
    return opts;
}

const USAGE = [
    'uso: node .pipeline/lib/operational-state-lint.js <modo> [opciones]',
    '',
    'modos (exactamente uno, obligatorio):',
    '  --report         inventario markdown reproducible, exit 0 siempre',
    '  --report-only    avisos con prefijo AVISO:, exit 0 siempre (wiring parte 1)',
    '  --check          prefijo ERROR:, exit 1 si hay violations (parte 3)',
    '',
    'opciones:',
    '  --json           solo con --report: emite el inventario como JSON',
    '  --only=a,b       limita la salida a esos archivos (el hook pasa los staged)',
].join('\n');

function main(argv = process.argv.slice(2)) {
    const logger = defaultLogger();
    let opts;
    try {
        opts = parseArgv(argv);
    } catch (e) {
        if (e instanceof LintUsageError) {
            logger.error(e.message);
            console.error(USAGE);
            process.exit(2);
        }
        throw e;
    }

    let result;
    try {
        result = lint({ only: opts.only });
    } catch (e) {
        // Config o error interno ⇒ exit 2 en los TRES modos. Un control roto no
        // es un repo limpio.
        logger.error(e instanceof LintConfigError ? `configuracion: ${e.message}` : `fatal: ${e.message}`);
        process.exit(2);
    }

    if (opts.mode === 'report') {
        if (opts.json) {
            console.log(JSON.stringify({
                scanned: result.scanned,
                rawLiteralHits: result.rawLiteralHits,
                rawLiteralFiles: result.rawLiteralFiles,
                commentHits: result.commentHits,
                noCtxHits: result.noCtxHits,
                confirmedHits: result.confirmedHits,
                totals: {
                    violations: result.violations.length,
                    'path-level': result.violations.filter(v => v.rule === 'path-level').length,
                    'internal-bypass': result.violations.filter(v => v.rule === 'internal-bypass').length,
                },
                byFile: aggregateByFile(result.violations),
                violations: result.violations,
            }, null, 2));
        } else {
            console.log(formatReport(result));
        }
        process.exit(0);
    }

    const enforce = opts.mode === 'check';
    const prefix = enforce ? 'ERROR:' : 'AVISO:';

    if (result.violations.length === 0) {
        logger.info(`OK — ${result.scanned} archivos JS escaneados, 0 violations`);
        process.exit(0);
    }

    const out = enforce ? console.error : console.warn;
    const HOOK_CAP = 10;
    const shown = enforce ? result.violations : result.violations.slice(0, HOOK_CAP);
    for (const v of shown) out(formatViolation(v, prefix));
    if (shown.length < result.violations.length) {
        out(`${prefix} ... y ${result.violations.length - shown.length} mas (ver \`--report\` para el inventario completo)`);
    }
    out(`${prefix} total: ${result.violations.length} violation(s) en ${new Set(result.violations.map(v => v.file)).size} archivo(s) de ${result.scanned} escaneados`);
    for (const line of remediationLines(new Set(result.violations.map(v => v.rule)))) out(line);

    if (!enforce) {
        out('');
        out('AVISO: modo report-only — NO bloquea el commit ni el build. El flip a `--check`');
        out('       va en la parte 3 de #5109, con las violations en cero. No "corregir" esto');
        out('       a --check antes de esa migracion (R5).');
        process.exit(0);
    }
    process.exit(1);
}

if (require.main === module) main();

module.exports = {
    lint,
    // exposed for tests
    _internal: {
        walkJs, lintFile, lintSource, loadAllowlist, sanitizeReason,
        resolveWrapperBindings, classifyScope, aggregateByFile,
        formatViolation, formatReport, remediationLines, parseArgv, main,
        LintConfigError, LintUsageError,
        STATE_LITERAL_RE, PATH_CTX_RE, COMMENT_LINE_RE, isCommentOnlyLine,
        ID_RE, SELF_EXEMPT, SKIP_DIRS, RULES,
        ALLOWLIST_REL, USAGE,
    },
};
