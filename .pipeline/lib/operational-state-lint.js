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
// ESTADO DEL WIRING: en `--check` (ENFORCE) desde #5179, la parte 3 del split.
// El inventario de accesos directos en producción está en CERO, así que a partir
// de acá un acceso directo NUEVO al estado operativo rompe el build (CI) y el
// commit (hook).
//
// El binario nació con los tres modos y el wiring arrancó en `--report-only`
// (partes 1 y 2) porque un guardrail en `enforce` no puede mergearse antes que
// la migración: fallaría contra su propio repo (R5). Los tres modos siguen
// existiendo — `--report` / `--report-only` son útiles para auditar sin
// bloquear.
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
//      `{file, anchor, reason}` no puede tener MENOS justificación. La
//      allowlist nace con `files: []`, así que hoy no afecta a nadie.
//
// Anclaje de las excepciones POR CONTENIDO (#6106)
// ------------------------------------------------
// Una entry de `rules` es `{ file, anchor, reason }`, donde `anchor` es la
// LÍNEA DE CÓDIGO exenta, en claro. NO es `{ file, line, reason }`: el shape
// viejo, anclado por número de línea, se rechaza con exit 2.
//
// El matcher posicional fallaba de dos formas y ninguna era buena:
//
//   - falso POSITIVO — insertar líneas arriba del acceso excusado corría la
//     coordenada y el guardrail rompía el build de un cambio inocente. No es
//     teórico: la entry de `pulpo.js` tuvo que re-apuntarse A MANO en #6238,
//     #6144, #6226, #5110, #6179, #6296 y en el merge de main de #6118 —
//     commits sin ninguna relación con el guardrail, obligados a tocar una
//     excepción de seguridad revisada por CODEOWNERS.
//
//   - falso NEGATIVO (peor) — la línea excusada pasaba a apuntar a OTRO acceso
//     directo, que quedaba exento sin que nadie lo revisara. La autorización de
//     CODEOWNERS es sobre ESE acceso, no sobre ESA coordenada, y con anclaje
//     posicional se transfería en silencio.
//
// Reglas del ancla:
//   - se normaliza con `normalizeAnchor`: CRLF/CR → LF y whitespace horizontal
//     colapsado, para que la firma sea IDÉNTICA en el checkout Windows
//     (`core.autocrlf=true`) y en el runner Linux de Actions.
//   - 0 matches   ⇒ excepción OBSOLETA. Nunca queda muda, que es el estado que
//     hoy no se distinguía de "excepción viva".
//   - >1 matches  ⇒ ancla AMBIGUA y NADIE queda exento: una autorización para
//     un call site no se extiende sola a N. Se desambigua con `occurrence`
//     EXPLÍCITO, nunca implícito.
//   - `line` sobrevive como campo OPCIONAL e INDICATIVO (para el mensaje y para
//     el review humano). NO participa del match: puede quedar desactualizado
//     sin ninguna consecuencia, que es justamente el punto.
//
// Comportamiento por modo ante un diagnóstico de ancla (CA-5 pide que esté
// documentado): `--check` ⇒ **exit 2** — es un error de CONFIGURACIÓN del
// control (una autorización que ya no autoriza lo que dice), no una violation
// del código auditado, que sería exit 1. `--report-only` ⇒ `AVISO:` y exit 0,
// igual que con las violations. `--report` ⇒ exit 0 y el detalle viaja en la
// tabla "Estado de las excepciones": ese modo es la salida de diagnóstico que
// el workflow publica con `if: always()` y su contrato es exit 0 SIEMPRE.
//
// Con `--only` (el hook pasa los staged) los diagnósticos se filtran por
// archivo igual que las violations: nadie queda bloqueado por una entry rota en
// un archivo que no tocó (UX-5). CI corre SIN `--only`, así que la foto
// completa no se pierde nunca.
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
//   node .pipeline/lib/operational-state-lint.js --anchor=<archivo>:<linea>
//       Imprime la entry de `rules` LISTA PARA PEGAR, con el ancla ya
//       normalizada (#6106 / UX-2). Nadie produce un ancla a mano y bien; si
//       generarla tiene fricción el dev cae en la exención de ARCHIVO ENTERO,
//       que es justo lo que el `_shape_doc` pide evitar. exit 0 / exit 2.
//
//       Es la ÚNICA salida que imprime una línea del código auditado, y por eso
//       es un modo aparte, local y bajo demanda: el desvío 1 (violation sin
//       `snippet`) sigue intacto en los tres modos que corren en CI y en el
//       hook. `--anchor` no evalúa ni exenta nada, sólo formatea.
//
// Exit codes (contrato del template)
//   0 → clean (o modo report/report-only, que nunca fallan por violations)
//   1 → violations encontradas (sólo `--check`)
//   2 → error interno / de configuración / uso inválido — incluye una entry de
//       la allowlist cuya ancla no resuelve contra el archivo real (#6106)
//
// El exit 2 NO está subordinado al modo: una allowlist corrupta o un argumento
// inválido son errores del control, no violations del código auditado. La única
// excepción es `--report`, cuyo contrato es exit 0 SIEMPRE una vez que la
// allowlist CARGÓ: los diagnósticos de ancla viajan ahí en la tabla, porque ese
// modo es la salida con la que se diagnostica el fallo.
//
// API
// ---
//   const { lint } = require('./operational-state-lint');
//   const { violations, scanned, anchorIssues, anchorResolutions } =
//       lint({ pipelineRoot, allowlist });
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
// #6190 — Copia LOCAL del predicado canonico de `lib/scratch-dirs.js`.
//
// Por que inline y no `require('./scratch-dirs')`: este binario se copia SOLO
// (sin sus vecinos) a un tmpdir en los tests del CLI (`installBin`), y ademas
// corre en el hook de pre-commit. Una dependencia local nueva le agrega un
// modo de falla —"falta el vecino, el pre-commit no corre"— a un guardrail que
// tiene que ser el ultimo en romperse. Se mantiene self-contained a proposito.
//
// La copia NO puede desincronizarse en silencio: `lib/__tests__/scratch-dirs.test.js`
// compara este predicado contra el canonico nombre por nombre.
function isScratchDirName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (name === '_tmp') return true;
    return name.startsWith('tmp');
}

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
// #5110 — `lib/project-context.js` es el dueño de la RESOLUCIÓN del namespace
// (`.pipeline/projects/<projectId>/`) y `scripts/migrate-operational-state-namespace.js`
// es el migrador que mueve el layout plano a ese namespace: ambos manipulan los
// literales de estado por definición, igual que el resto del sustrato. NO se
// usa `operational-state-lint.allowlist.json` para esto — esa allowlist es por
// LÍNEA y su propósito es documentar excepciones de consumidores, no declarar
// scope del control.
const SELF_EXEMPT = new Set([
    'lib/operational-state.js',
    'lib/waves.js',
    'lib/partial-pause.js',
    'lib/operational-state-lint.js',
    'lib/project-context.js',
    'scripts/migrate-operational-state-namespace.js',
]);

// ─── Regla 1 · path-level ───────────────────────────────────────────────────

// Literal de estado. `g` — se resetea `lastIndex` por archivo.
//
// El prefijo de path opcional (`(?:[^'"`\n]*[\/\\])?`) NO es cosmético: sin él
// la comilla tiene que estar PEGADA al nombre del archivo y cualquier literal
// que sea FRAGMENTO DE PATH evade el matcher entero — ni siquiera entra al
// bucket BRUTO, así que el falso negativo es invisible incluso para la
// auditoría del delta. Caso real que motivó la corrección:
//
//     views/dashboard/mizpa-frame.js:42
//     const WAVES_PATH = path.join(__dirname, '../../waves.json');
//
// Es un lector vivo de `waves.json` (lo consume `views/dashboard/logs.js`) que
// quedaba fuera del inventario y por lo tanto fuera del checklist de migración
// de las partes 2 y 3 de #5109: tras el flip a `--check` el guardrail habría
// quedado VERDE con el bypass intacto.
//
// La clase de caracteres del prefijo excluye comillas y saltos de línea, así
// que el match no puede cruzar el borde del literal.
//
// LÍMITES CONOCIDOS (declarados a propósito, no descubiertos por accidente):
//   - concatenación partida: `'waves' + '.json'` → NO se detecta.
//   - indirección por constante: `path.join(dir, WAVES_FILE)` sólo se detecta
//     si la declaración de `WAVES_FILE` cae dentro del radio de confirmación
//     de contexto (±3 líneas de un `path.*`/`fs.*Sync`).
// Ambos están cubiertos por tests que fijan el comportamiento actual: si algún
// día se cierran, el test avisa en vez de que el cambio pase inadvertido.
const STATE_LITERAL_RE = /['"`](?:[^'"`\n]*[\/\\])?(?:waves\.json|\.partial-pause\.json|\.paused)['"`]/g;

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

/**
 * Indica si `offset` cae dentro de un comentario de bloque real.
 *
 * No alcanza contar `/*` y `*/` sobre texto crudo: ambos delimitadores pueden
 * aparecer legítimamente dentro de strings, templates o regex. Este scanner
 * léxico mínimo ignora esos contextos y es conservador ante sintaxis incompleta
 * (strings/regex se cierran al fin de línea; un bloque sólo se abre con `/*`
 * observado en estado de código).
 */
function isInsideBlockComment(src, offset) {
    let state = 'code';
    let escaped = false;
    let regexCharClass = false;
    let previousSignificant = '';

    for (let i = 0; i < offset; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (state === 'block-comment') {
            if (ch === '*' && next === '/') { state = 'code'; i++; }
            continue;
        }
        if (state === 'line-comment') {
            if (ch === '\n' || ch === '\r') state = 'code';
            continue;
        }
        if (state === 'single' || state === 'double' || state === 'template') {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if ((state === 'single' && ch === "'")
                || (state === 'double' && ch === '"')
                || (state === 'template' && ch === '`')) state = 'code';
            continue;
        }
        if (state === 'regex') {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '[') { regexCharClass = true; continue; }
            if (ch === ']' && regexCharClass) { regexCharClass = false; continue; }
            if (ch === '/' && !regexCharClass) state = 'code';
            if (ch === '\n' || ch === '\r') state = 'code';
            continue;
        }

        if (ch === '/' && next === '*') { state = 'block-comment'; i++; continue; }
        if (ch === '/' && next === '/') { state = 'line-comment'; i++; continue; }
        if (ch === "'") { state = 'single'; escaped = false; previousSignificant = 'v'; continue; }
        if (ch === '"') { state = 'double'; escaped = false; previousSignificant = 'v'; continue; }
        if (ch === '`') { state = 'template'; escaped = false; previousSignificant = 'v'; continue; }
        // Un regex que contiene `/*` debe ser tan inocuo como un string. Para
        // esta decisión sólo importa no interpretar sus caracteres internos;
        // tratar `/` no-comentario como regex hasta su cierre (o EOL) es
        // conservador y no puede abrir falsamente un bloque.
        if (ch === '/' && (!previousSignificant || /[([{:,;=!?&|+\-*%^~<>]/.test(previousSignificant))) {
            state = 'regex';
            escaped = false;
            regexCharClass = false;
            previousSignificant = 'v';
            continue;
        }
        if (!/\s/.test(ch)) previousSignificant = ch;
    }
    return state === 'block-comment';
}

function isCommentOnlyLine(src, srcLines, line) {
    const text = srcLines[line - 1] || '';
    if (COMMENT_LINE_RE.test(text)) return true;
    if (!/^\s*\*/.test(text)) return false;

    const lineStart = srcLines.slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0);
    return isInsideBlockComment(src, lineStart);
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

// ─── Sanitizacion de salida (rebote rev-1 / SEC-3) ──────────────────────────

/**
 * Control chars + DEL. Un `\n` acá adentro es todo lo que hace falta para que
 * texto del repo se convierta en una LINEA PROPIA del log de Actions, y una
 * linea propia que arranque con `::` es un workflow command: el atacante
 * escribe anotaciones en la UI del PR firmadas con el nombre del guardrail.
 */
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

/**
 * Aplana texto NO CONFIABLE a una sola linea imprimible, para interpolarlo
 * dentro de un mensaje propio (rev-1: la sanitizacion estaba en la capa del
 * CAMPO `reason` y no en la de la CLASE de amenaza "texto del repo → stdout").
 */
function sanitizeForLog(raw) {
    return String(raw).replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Segunda puerta, en la capa del SINK: envuelve un `console.*` garantizando
 * que UNA llamada emita EXACTAMENTE UNA linea. Neutraliza control chars sin
 * colapsar espacios ni recortar, para no destruir la indentacion del texto
 * propio (bloque de remediacion).
 *
 * Invariante que sostiene: como toda linea emitida arranca con `LOG_PREFIX`,
 * `ERROR:`, `AVISO:` o espacios, NINGUNA linea de la salida puede empezar con
 * `::`. El invariante vive acá, no en cada `throw`: cada mensaje nuevo que
 * agreguen las partes 2 y 3 de #5109 nace cubierto.
 */
function oneLineSink(fn) {
    return (line) => fn(String(line).replace(CONTROL_CHARS_RE, ' '));
}

// ─── Helpers (reusados tal cual del template) ───────────────────────────────

function defaultLogger() {
    const log = oneLineSink(console.log);
    const warn = oneLineSink(console.warn);
    const error = oneLineSink(console.error);
    return {
        info: (m) => log(`${LOG_PREFIX} ${m}`),
        warn: (m) => warn(`${LOG_PREFIX} ${m}`),
        error: (m) => error(`${LOG_PREFIX} ${m}`),
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
                // #6190 — `SKIP_DIRS` traia `tmp` pero no `_tmp` ni las formas
                // `tmp-review-<issue>`/`tmp<issue>`. Como esos scratchpads
                // contienen COPIAS ENTERAS del repo, el lint reportaba
                // violations sobre archivos que no son codigo de este arbol y
                // bloqueaba el pre-commit de issues ajenos. Fuente unica del
                // criterio: `lib/scratch-dirs.js`.
                if (SKIP_DIRS.has(e.name) || isScratchDirName(e.name)) continue;
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
 * sanitizar son la misma función.
 *
 * OJO (rebote rev-1): esta función cubre el CAMPO `reason`, NO la clase de
 * amenaza "texto del repo → log de Actions". Esa la cubren los sinks
 * (`oneLineSink` en `defaultLogger` y en el camino de violations). No agregar
 * sanitización caso por caso en cada `throw`: el bug nació exactamente de eso.
 */
function sanitizeReason(raw, where) {
    if (typeof raw !== 'string') {
        throw new LintConfigError(`${where}: "reason" es obligatoria y debe ser string (recibido: ${raw === undefined ? 'ausente' : typeof raw})`);
    }
    // Control chars + ANSI: rompen el formato del log y habilitan spoofing.
    // Misma puerta que usan los sinks (`sanitizeForLog`) — un solo tratamiento.
    const clean = sanitizeForLog(raw);
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

// ─── Anclas por contenido (#6106) ───────────────────────────────────────────

/**
 * Claves válidas de una entry de `rules`. Cualquier otra ⇒ exit 2: un `ancla`
 * o un `linea` mal tipeado se comería la excepción en silencio — exactamente la
 * clase de falla muda que este anclaje viene a cerrar.
 */
const RULE_KEYS = new Set(['file', 'anchor', 'line', 'occurrence', 'reason']);

/** Estados de la resolución de un ancla contra el contenido real del archivo. */
const ANCHOR_OK = 'resuelta';
const ANCHOR_STALE = 'obsoleta';
const ANCHOR_AMBIGUOUS = 'ambigua';
const ANCHOR_ORDINAL = 'ordinal-fuera-de-rango';
const ANCHOR_UNSCANNED = 'archivo-no-escaneado';

/**
 * `reason` que emite `--anchor` para que el dev la complete.
 *
 * NO puede ser uno de los placeholders que `sanitizeReason` rechaza (UX-2): si
 * el copy-paste de la remediación sale por exit 2, el dev aprende a no usarla.
 * Que se pueda pegar sin completar es deliberado — lo que atrapa una `reason`
 * sin contenido real es el review humano de CODEOWNERS, no un regex.
 */
const ANCHOR_REASON_PLACEHOLDER = 'COMPLETAR: por que este acceso directo es legitimo, que alternativa del envoltorio se descarto, y cual es la version estructural (issue).';

/**
 * Normaliza UNA línea de código a su forma canónica para comparar anclas.
 *
 * CA-4 — la normalización DEBE incluir los line endings. El repo está en
 * `core.autocrlf=true` y los fuentes viven en CRLF en el checkout Windows pero
 * en LF en el runner Linux de Actions. `lintFile` lee con
 * `readFileSync(..., 'utf8')` sin normalizar y `src.split('\n')` deja el `\r`
 * colgando al final de cada línea: comparar crudo daría distinto entre las dos
 * plataformas y el guardrail pasaría local y rompería en CI (o al revés).
 *
 * Además colapsa whitespace HORIZONTAL (espacios, tabs, NBSP) y recorta los
 * bordes: mover el acceso dentro de un `if` lo reindenta sin cambiarlo, y eso
 * no debería invalidar una autorización que ya pasó por CODEOWNERS.
 *
 * Lo que NO normaliza, a propósito: comillas, nombres de variables y el
 * contenido de los strings. Cambiar cualquiera de esos SÍ cambia el acceso y
 * tiene que forzar re-anclaje + re-aprobación.
 */
function normalizeAnchor(raw) {
    return String(raw)
        .replace(/\r\n?/g, '\n')        // CRLF y CR sueltos → LF (CA-4)
        .replace(/[^\S\n]+/g, ' ')      // whitespace horizontal colapsado
        .replace(/ ?\n ?/g, '\n')
        .trim();
}

/**
 * Resuelve, contra el contenido REAL de `rel`, qué líneas quedan exentas.
 *
 * Devuelve `{ exemptLines, issues, resolutions }`:
 *   - `exemptLines` — líneas exentas (1-indexadas).
 *   - `issues`      — diagnósticos que el CLI reporta (obsoleta / ambigua /
 *                     ordinal fuera de rango). Una entry con diagnóstico NO
 *                     exenta nada: ante la duda el guardrail aprieta, no afloja.
 *   - `resolutions` — una fila por entry para la tabla del inventario.
 */
function resolveAnchors(rel, srcLines, rules) {
    const exemptLines = new Set();
    const issues = [];
    const resolutions = [];

    for (const r of rules) {
        if (r.file !== rel) continue;

        const matches = [];
        for (let i = 0; i < srcLines.length; i++) {
            if (normalizeAnchor(srcLines[i]) === r.anchorNormalized) matches.push(i + 1);
        }

        const fail = (status) => {
            issues.push({ status, entry: r, matches });
            resolutions.push({ entry: r, status, line: null, matches, covered: false });
        };

        if (matches.length === 0) { fail(ANCHOR_STALE); continue; }
        // CA-3 — la ambigüedad NUNCA se desempata sola. Una exención aprobada
        // para UN call site extendida en silencio a N es el mismo pecado que
        // #6106 viene a cerrar, entrando por otra puerta.
        if (matches.length > 1 && r.occurrence === undefined) { fail(ANCHOR_AMBIGUOUS); continue; }
        if (r.occurrence !== undefined && r.occurrence > matches.length) { fail(ANCHOR_ORDINAL); continue; }

        const line = matches[(r.occurrence || 1) - 1];
        exemptLines.add(line);
        resolutions.push({ entry: r, status: ANCHOR_OK, line, matches, covered: false });
    }

    return { exemptLines, issues, resolutions };
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
        // El mensaje de `JSON.parse` hace eco de un fragmento del archivo: se
        // aplana y se acota para no volcar contenido al log (CA-3b). La
        // garantia de que no rompe linea la da el sink, esto solo limita el eco.
        throw new LintConfigError(`${ALLOWLIST_REL}: JSON inválido (${sanitizeForLog(e.message).slice(0, 160)}). NO se asume allowlist vacía: una allowlist corrupta y una allowlist vacía a propósito no pueden ser indistinguibles (SEC-4).`);
    }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
        throw new LintConfigError(`${ALLOWLIST_REL}: shape inválido, se esperaba un objeto { files: [], rules: [] }`);
    }
    for (const key of Object.keys(j)) {
        if (key === 'files' || key === 'rules' || key.startsWith('_')) continue;
        throw new LintConfigError(`${ALLOWLIST_REL}: clave desconocida "${sanitizeForLog(key).slice(0, 80)}". Claves válidas: "files", "rules" y documentación con prefijo "_".`);
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
            throw new LintConfigError(`${where}: se esperaba { file, reason }, no un string. Una exención de archivo entero es MÁS amplia que { file, anchor, reason } y no puede tener MENOS justificación (CA-5).`);
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
            throw new LintConfigError(`${where}: se esperaba un objeto { file, anchor, reason }`);
        }
        for (const key of Object.keys(entry)) {
            if (RULE_KEYS.has(key) || key.startsWith('_')) continue;
            throw new LintConfigError(`${where}: clave desconocida "${sanitizeForLog(key).slice(0, 80)}". Claves válidas: ${[...RULE_KEYS].map(k => `"${k}"`).join(', ')} y documentación con prefijo "_".`);
        }
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
            throw new LintConfigError(`${where}: "file" es obligatorio y debe ser un path relativo a .pipeline/`);
        }
        // #6106 — el ancla es el CONTENIDO de la línea exenta, no su coordenada.
        // El shape viejo se rechaza DE UNA, no se acepta en transición: aceptarlo
        // mantendría vivo el falso negativo (la exención migrando sola a otro call
        // site) que es la razón de ser del cambio, y son 2 entries migradas en el
        // MISMO commit — no hay ventana que cubrir.
        if (typeof entry.anchor !== 'string' || !entry.anchor.trim()) {
            throw new LintConfigError(`${where}: "anchor" es obligatorio y debe ser la LÍNEA DE CÓDIGO exenta, en claro. El shape viejo { file, line, reason } (anclaje por número de línea) ya NO se acepta: #6106. Generá la entry lista para pegar con \`node .pipeline/lib/operational-state-lint.js --anchor=<archivo>:<linea>\`.`);
        }
        const anchorNormalized = normalizeAnchor(entry.anchor);
        if (!anchorNormalized) {
            throw new LintConfigError(`${where}: "anchor" queda vacía al normalizar — no identifica ningún acceso.`);
        }
        if (anchorNormalized.includes('\n')) {
            throw new LintConfigError(`${where}: "anchor" debe ser UNA sola línea de código. Toda violation se reporta en una línea única, así que un ancla multilínea no puede identificar ninguna.`);
        }
        // `line` sobrevive INDICATIVA (UX-3: el reviewer tiene que poder ubicar
        // el acceso sin salir del diff). No participa del match: que quede
        // desactualizada no rompe nada, y eso es exactamente el punto de #6106.
        if (entry.line !== undefined && (!Number.isInteger(entry.line) || entry.line < 1)) {
            throw new LintConfigError(`${where}: "line" es OPCIONAL e INDICATIVA desde #6106 (sólo para el mensaje y el review), pero si está debe ser un entero >= 1 (recibido: ${JSON.stringify(entry.line)})`);
        }
        if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || entry.occurrence < 1)) {
            throw new LintConfigError(`${where}: "occurrence" es opcional (desambigua un ancla que matchea varias líneas) pero si está debe ser un entero >= 1 (recibido: ${JSON.stringify(entry.occurrence)})`);
        }
        const reason = sanitizeReason(entry.reason, where);
        return {
            where,
            index: i,
            file: normalizeRel(entry.file),
            anchor: entry.anchor,
            anchorNormalized,
            line: entry.line,
            occurrence: entry.occurrence,
            reason,
        };
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
 * `rawLiteralHits` = todas las ocurrencias del literal ENTRECOMILLADO (con
 * prefijo de path opcional). NO es equivalente a un `git grep` del nombre del
 * archivo: `git grep` también cuenta menciones sin comillas (prosa, mensajes,
 * concatenación partida). El bruto es un PISO auditable, no un censo.
 * Se descompone en tres buckets que particionan exacto:
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

    // #6106 — la exención se resuelve por CONTENIDO antes de escanear. Un
    // ancla obsoleta o ambigua NO aporta líneas exentas: el acceso vuelve a
    // reportarse como violation y además sale un diagnóstico explícito.
    const anchors = resolveAnchors(rel, srcLines, allowlist.rules || []);
    const coveredLines = new Set();

    const seen = new Set();
    const push = (line, rule) => {
        const key = `${line}:${rule}`;
        if (seen.has(key)) return;            // determinismo: 1 violation por (file,line,rule)
        if (anchors.exemptLines.has(line)) { coveredLines.add(line); return; }
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

    // Una entry resuelta que NO suprimió ninguna violation es una exención que
    // no protege nada. Es informativo (viaja en la tabla de `--report`) y NO
    // rompe el build a propósito: si el matcher deja de marcar un acceso por un
    // refactor inocente, reventar CI reintroduce exactamente la fricción que
    // #6106 elimina. Es el gancho que habilita el vencimiento de #5167.
    for (const r of anchors.resolutions) {
        if (r.status === ANCHOR_OK) r.covered = coveredLines.has(r.line);
    }

    return {
        violations: out,
        rawLiteralHits,
        commentHits,
        noCtxHits,
        confirmedHits,
        anchorIssues: anchors.issues,
        anchorResolutions: anchors.resolutions,
    };
}

/**
 * Factory, no constante compartida: `anchorIssues` / `anchorResolutions` son
 * arrays y un `{ ...EMPTY_SCAN }` los copiaría POR REFERENCIA — un push desde
 * un archivo contaminaría a todos los demás.
 */
function emptyScan() {
    return {
        violations: [],
        rawLiteralHits: 0,
        commentHits: 0,
        noCtxHits: 0,
        confirmedHits: 0,
        anchorIssues: [],
        anchorResolutions: [],
    };
}

function lintFile(absolute, pipelineRoot, allowlist) {
    const rel = pathPosixRel(pipelineRoot, absolute);
    if (allowlist.files.has(rel)) return emptyScan();
    if (SELF_EXEMPT.has(rel)) return emptyScan();
    let src;
    try { src = fs.readFileSync(absolute, 'utf8'); }
    catch { return emptyScan(); }
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
    let anchorIssues = [];
    let anchorResolutions = [];
    const anchoredFiles = new Set();
    for (const f of files) {
        const rel = pathPosixRel(pipelineRoot, f);
        const r = lintFile(f, pipelineRoot, allowlist);
        if (r.rawLiteralHits > 0) rawByFile.set(rel, r.rawLiteralHits);
        for (const k of Object.keys(tally)) tally[k] += r[k];
        for (const v of r.violations) violations.push(v);
        for (const it of r.anchorIssues) anchorIssues.push(it);
        for (const res of r.anchorResolutions) {
            anchorResolutions.push(res);
            anchoredFiles.add(res.entry.file);
        }
    }

    // CA-5 — una entry cuyo archivo nunca llegó a escanearse tampoco puede
    // quedar muda: hoy simplemente no exenta a nadie y nadie se entera.
    for (const r of (allowlist.rules || [])) {
        if (anchoredFiles.has(r.file)) continue;
        const cause = allowlist.files.has(r.file)
            ? 'el archivo ya esta exento entero por `files[]`, la entry puntual sobra'
            : SELF_EXEMPT.has(r.file)
                ? 'el archivo ya esta exento por SELF_EXEMPT (scope del control), la entry puntual sobra'
                : 'el archivo no existe o quedo fuera del scope de walkJs';
        anchorIssues.push({ status: ANCHOR_UNSCANNED, entry: r, matches: [], cause });
        anchorResolutions.push({ entry: r, status: ANCHOR_UNSCANNED, line: null, matches: [], covered: false, cause });
    }

    if (Array.isArray(opts.only)) {
        const wanted = new Set(opts.only.map(normalizeRel));
        violations = violations.filter(v => wanted.has(v.file));
        // UX-5 — el hook pasa los staged. Una entry rota en un archivo que el
        // dev no tocó no puede frenarle el commit; CI corre SIN `--only`, así
        // que la foto completa nunca se pierde.
        anchorIssues = anchorIssues.filter(it => wanted.has(it.entry.file));
        anchorResolutions = anchorResolutions.filter(res => wanted.has(res.entry.file));
    }

    // Orden por índice de la entry: es como el humano la encuentra en el JSON.
    anchorIssues.sort((a, b) => a.entry.index - b.entry.index);
    anchorResolutions.sort((a, b) => a.entry.index - b.entry.index);

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
        anchorIssues,
        anchorResolutions,
        ...tally,
    };
}

// ─── Formateo ───────────────────────────────────────────────────────────────

/**
 * Una línea por violation. SIN snippet (CA-3b / SEC-2).
 *
 * `v.file` sale de `walkJs`, o sea del NOMBRE DE ARCHIVO del repo, y el job
 * corre en `ubuntu-latest` donde un `\n` en un nombre de archivo es legal
 * (rebote rev-1, ruta C). Se aplana acá porque este camino NO pasa por
 * `defaultLogger`.
 */
function formatViolation(v, prefix) {
    const what = v.rule === 'path-level'
        ? 'literal de estado en construccion de path'
        : 'uso de `_internal` (superficie de tests, no API)';
    return `${prefix} ${sanitizeForLog(v.file)}:${sanitizeForLog(v.line)} - regla ${sanitizeForLog(v.rule)} (${what})`;
}

/**
 * Diagnóstico de ancla, UNA línea (UX-4).
 *
 * Cita la entry por su ÍNDICE en el archivo, que es como el humano la encuentra
 * —igual que `loadAllowlist` con su `where`—, nunca por su contenido.
 *
 * NO imprime el ancla: el violation es estructural y sin `snippet` a propósito
 * (desvío 1 / CA-3b / SEC-2) y este camino tampoco puede volcar código del repo
 * al log de Actions. Para ver o regenerar el ancla está `--anchor`, que corre
 * local y bajo demanda.
 *
 * Para el stale se distinguen las DOS causas plausibles porque la acción del dev
 * es distinta: si el acceso se borró la entry sobra; si el acceso cambió hay que
 * re-anclarla Y volver a pasar por CODEOWNERS.
 */
function formatAnchorIssue(it) {
    // `where` lo pone `loadAllowlist`; el fallback cubre a un caller de la API
    // que arme las rules a mano, para que el mensaje siga ubicando la entry.
    const where = sanitizeForLog(it.entry.where || `${ALLOWLIST_REL} rules[${it.entry.index}]`);
    const file = sanitizeForLog(it.entry.file);
    const hint = it.entry.line === undefined ? '' : ` (linea indicativa de la entry: ${sanitizeForLog(it.entry.line)})`;
    if (it.status === ANCHOR_STALE) {
        return `${where}: excepcion obsoleta - el ancla no matchea ninguna linea de \`${file}\`${hint}. Dos causas, dos acciones: si el acceso SE BORRO (migrado al envoltorio), borra la entry; si el acceso CAMBIO, re-anclala con \`--anchor=${file}:<linea>\` y volve a pasar por el review de @leitolarreta - un ancla nueva es una autorizacion nueva.`;
    }
    if (it.status === ANCHOR_AMBIGUOUS) {
        return `${where}: ancla ambigua - matchea ${it.matches.length} lineas de \`${file}\` (${it.matches.join(', ')}) y NINGUNA queda exenta. Una exencion aprobada para un call site no se extiende sola a ${it.matches.length}: desambigua con \`"occurrence": <1..${it.matches.length}>\` explicito, o usa un ancla mas especifica.`;
    }
    if (it.status === ANCHOR_ORDINAL) {
        return `${where}: \`"occurrence": ${sanitizeForLog(it.entry.occurrence)}\` fuera de rango - el ancla matchea ${it.matches.length} linea(s) de \`${file}\`${it.matches.length ? ` (${it.matches.join(', ')})` : ''} y ninguna queda exenta.`;
    }
    return `${where}: excepcion obsoleta - \`${file}\` no se escaneo: ${sanitizeForLog(it.cause || 'causa desconocida')}. La entry no exenta nada.`;
}

/**
 * Remediación de los diagnósticos de ancla. Se emite UNA vez al final, mismo
 * criterio que `remediationLines` (UX-4).
 */
function anchorRemediationLines() {
    return [
        '',
        'Remediacion - excepciones de la allowlist (ancladas por CONTENIDO desde #6106):',
        '  Una entry de `rules` se ancla al TEXTO de la linea exenta, no a su numero.',
        '  Insertar o borrar lineas arriba ya NO invalida la excepcion, y la excepcion',
        '  tampoco se transfiere sola al acceso que caiga en esa coordenada. Un',
        '  diagnostico aca significa que el ancla dejo de identificar UN acceso concreto.',
        '  Para regenerar la entry con el ancla ya normalizada:',
        '    node .pipeline/lib/operational-state-lint.js --anchor=<archivo>:<linea>',
        '  El review humano de @leitolarreta (CODEOWNERS) es sobre el ACCESO, no sobre la',
        `  coordenada: re-anclar a un acceso distinto es una autorizacion nueva. Ver ${CONTRACT_DOC} §7.`,
    ];
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
        out.push('  Si la excepcion es legitima: entry { file, anchor, reason } en');
        out.push(`  \`.pipeline/${ALLOWLIST_REL}\`.`);
        out.push('  El `anchor` es la LINEA DE CODIGO exenta, en claro: desde #6106 la exencion');
        out.push('  viaja con el acceso y no se transfiere a otro call site si el archivo deriva.');
        out.push('  NO la escribas a mano — genera la entry lista para pegar con:');
        out.push('    node .pipeline/lib/operational-state-lint.js --anchor=<archivo>:<linea>');
        out.push('  `.github/CODEOWNERS` declara la responsabilidad sobre este archivo,');
        out.push('  pero la politica vigente (#5986, Opcion A) es declarativa y no activa');
        out.push('  un gate de ownership. El cambio se valida mediante los controles');
        out.push('  automaticos requeridos del PR, incluido operational-state-lint.');
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
    L.push('Los tres buckets particionan exacto el numero BRUTO. El bruto cuenta el literal');
    L.push('ENTRECOMILLADO (con prefijo de path opcional): NO es equivalente a un `git grep`');
    L.push('del nombre del archivo, que ademas cuenta menciones sin comillas. Este inventario');
    L.push('es un PISO auditable, no un censo — ver LIMITES CONOCIDOS del matcher.');
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
        // El path va aplanado por la misma puerta: `--report` alimenta
        // GITHUB_STEP_SUMMARY (markdown), donde un `\n` rompe la tabla.
        L.push(`| \`${sanitizeForLog(r.file)}\` | ${r.scope} | ${r['path-level']} | ${r['internal-bypass']} | ${r.total} |`);
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
        for (const v of result.violations) L.push(`- \`${sanitizeForLog(v.file)}:${sanitizeForLog(v.line)}\` — ${sanitizeForLog(v.rule)}`);
    }
    L.push('');
    L.push('## Estado de las excepciones de la allowlist');
    L.push('');
    L.push('Las entries de `rules` se anclan por CONTENIDO desde #6106: `line` es INDICATIVA,');
    L.push('no autoritativa. `linea resuelta` es donde vive HOY el acceso autorizado, y que no');
    L.push('coincida con la indicativa es normal (el archivo derivo) y no rompe nada.');
    L.push('');
    const anchorRows = Array.isArray(result.anchorResolutions) ? result.anchorResolutions : [];
    if (anchorRows.length === 0) {
        L.push('- (la allowlist no declara entries de `rules`)');
    } else {
        L.push('| entry | archivo | estado | linea resuelta | linea indicativa | suprime violation |');
        L.push('|---|---|---|---:|---:|---|');
        for (const r of anchorRows) {
            L.push([
                `| \`rules[${sanitizeForLog(r.entry.index)}]\``,
                `\`${sanitizeForLog(r.entry.file)}\``,
                sanitizeForLog(r.status),
                r.line === null ? '-' : sanitizeForLog(r.line),
                r.entry.line === undefined ? '-' : sanitizeForLog(r.entry.line),
                `${r.covered ? 'si' : 'NO'} |`,
            ].join(' | '));
        }
        L.push('');
        L.push('Una entry `resuelta` con `suprime violation` en **NO** no esta protegiendo nada:');
        L.push('el acceso dejo de ser directo (o el matcher dejo de marcarlo) y la entry sobra.');
        L.push('Es informativo a proposito y NO rompe el build — reventar CI por eso reintroduce');
        L.push('la friccion que #6106 elimina. Es el gancho que habilita el vencimiento de #5167.');
        L.push('');
        L.push('Un estado distinto de `resuelta` SI es error de configuracion: `--check` sale con');
        L.push('exit 2 (no exit 1: es el control el que esta mal, no el codigo auditado).');
    }
    L.push('');
    L.push('## Limites conocidos del matcher');
    L.push('');
    L.push('Este inventario es un **piso auditable**, no un censo. Formas de acceso que el');
    L.push('matcher NO detecta hoy, declaradas explicitamente para que la migracion de las');
    L.push('partes 2 y 3 no las de por cubiertas (cada una tiene test que fija la conducta):');
    L.push('');
    L.push('- concatenacion partida del nombre: `\'waves\' + \'.json\'`.');
    L.push('- indireccion por constante (`path.join(dir, WAVES_FILE)`) cuando la declaracion');
    L.push('  de la constante cae fuera del radio de +-3 lineas de confirmacion de contexto.');
    L.push('- accesos desde archivos que no son `.js` (por ejemplo shell scripts): `walkJs`');
    L.push('  solo recolecta `.js` — cubrirlos es otro issue (#5184).');
    L.push('');
    L.push('El prefijo de path SI esta cubierto (`path.join(__dirname, \'../../waves.json\')`).');
    return L.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

/**
 * Modo `--anchor` (#6106 / UX-2) — arma la entry de `rules` lista para pegar.
 *
 * Existe porque con anclaje por contenido la entry deja de ser autoescribible:
 * el dev ya no puede leer `pulpo.js:17860` del error y tipearla. Si producir el
 * ancla tiene fricción, la salida fácil pasa a ser la exención de ARCHIVO
 * ENTERO — la más ancha, la que el `_shape_doc` pide evitar. La UX del ancla
 * decide si el guardrail se usa fino o grueso.
 *
 * NO evalúa, NO exenta, NO consulta la allowlist: sólo formatea.
 */
function anchorEntryFor(pipelineRoot, spec) {
    const m = /^(.+):(\d+)$/.exec(String(spec));
    if (!m) {
        throw new LintUsageError(`--anchor espera <archivo>:<linea> (recibido: "${sanitizeForLog(spec).slice(0, 120)}")`);
    }
    const rel = normalizeRel(m[1]);
    const line = Number(m[2]);
    if (!Number.isInteger(line) || line < 1) {
        throw new LintUsageError('--anchor: la linea debe ser un entero >= 1');
    }
    let src;
    try { src = fs.readFileSync(path.join(pipelineRoot, rel), 'utf8'); }
    catch { throw new LintConfigError(`--anchor: no se pudo leer \`${sanitizeForLog(rel)}\` (el path es relativo a .pipeline/)`); }

    const srcLines = src.split('\n');
    if (line > srcLines.length) {
        throw new LintConfigError(`--anchor: \`${sanitizeForLog(rel)}\` tiene ${srcLines.length} lineas, se pidio la ${line}`);
    }
    const anchor = normalizeAnchor(srcLines[line - 1]);
    if (!anchor) {
        throw new LintConfigError(`--anchor: \`${sanitizeForLog(rel)}:${line}\` esta vacia o es solo whitespace — no sirve como ancla`);
    }

    const matches = [];
    for (let i = 0; i < srcLines.length; i++) {
        if (normalizeAnchor(srcLines[i]) === anchor) matches.push(i + 1);
    }
    // Orden de claves deliberado: lo primero que lee el reviewer es QUÉ acceso
    // se autoriza (`anchor`), no dónde estaba (`line`, indicativa).
    const entry = { file: rel, anchor, line };
    // El ordinal se emite EXPLÍCITO, ya calculado: implícito sería el pecado que
    // CA-3 prohíbe, y a mano el dev lo cuenta mal.
    if (matches.length > 1) entry.occurrence = matches.indexOf(line) + 1;
    entry.reason = ANCHOR_REASON_PLACEHOLDER;
    return { entry, matches };
}

function parseArgv(argv) {
    const opts = { mode: null, json: false, only: null, anchor: null };
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
        } else if (a.startsWith('--anchor=')) {
            if (opts.mode && opts.mode !== 'anchor') {
                throw new LintUsageError(`modos mutuamente excluyentes: --${opts.mode} y --anchor`);
            }
            opts.mode = 'anchor';
            opts.anchor = a.slice('--anchor='.length).trim();
            if (!opts.anchor) throw new LintUsageError('--anchor espera <archivo>:<linea>');
        } else {
            throw new LintUsageError(`argumento desconocido: ${a}`);
        }
    }
    if (!opts.mode) throw new LintUsageError('falta el modo');
    if (opts.json && opts.mode !== 'report') {
        throw new LintUsageError('--json solo es valido con --report');
    }
    if (opts.only && opts.mode === 'anchor') {
        throw new LintUsageError('--only no aplica a --anchor (ese modo no escanea el repo, solo formatea una entry)');
    }
    return opts;
}

const USAGE = [
    'uso: node .pipeline/lib/operational-state-lint.js <modo> [opciones]',
    '',
    'modos (exactamente uno, obligatorio):',
    '  --report         inventario markdown reproducible, exit 0 siempre',
    '  --report-only    avisos con prefijo AVISO:, exit 0 siempre (auditar sin bloquear)',
    '  --check          prefijo ERROR:, exit 1 si hay violations (modo del wiring)',
    '  --anchor=<archivo>:<linea>',
    '                   imprime la entry de `rules` lista para pegar, con el ancla ya',
    '                   normalizada (#6106). No escanea, no exenta: solo formatea.',
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

    // `--anchor` no escanea nada: se resuelve antes de cargar la allowlist, para
    // que el dev pueda generar la entry AUNQUE la allowlist este rota — que es
    // justo cuando la necesita.
    if (opts.mode === 'anchor') {
        let built;
        try {
            built = anchorEntryFor(DEFAULT_PIPELINE_ROOT, opts.anchor);
        } catch (e) {
            if (e instanceof LintUsageError) {
                logger.error(e.message);
                console.error(USAGE);
                process.exit(2);
            }
            logger.error(e instanceof LintConfigError ? `configuracion: ${e.message}` : `fatal: ${e.message}`);
            process.exit(2);
        }
        // Mismo sink que el resto: una llamada = una linea. `JSON.stringify` ya
        // escapa los control chars del codigo fuente, y toda linea del objeto
        // arranca con `{`, `}` o indentacion — nunca con `::`.
        const emit = oneLineSink(console.log);
        for (const l of JSON.stringify(built.entry, null, 2).split('\n')) emit(l);
        logger.info(`pegala en \`.pipeline/${ALLOWLIST_REL}\` > "rules" y COMPLETA la "reason" (el review es sobre ESE texto).`);
        logger.info('requiere review humano de @leitolarreta (CODEOWNERS): lo que se autoriza es el ACCESO, no la coordenada.');
        if (built.matches.length > 1) {
            logger.warn(`ojo: el ancla matchea ${built.matches.length} lineas (${built.matches.join(', ')}), por eso la entry lleva "occurrence". Si podes, usa un acceso mas especifico.`);
        }
        process.exit(0);
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
                // #6106 — estado de cada excepcion. Sin `anchor`: el JSON del
                // inventario se publica y el desvio 1 (no volcar codigo) sigue
                // valiendo. La entry se identifica por indice, como en el resto.
                anchors: (result.anchorResolutions || []).map(r => ({
                    entry: `rules[${r.entry.index}]`,
                    file: r.entry.file,
                    status: r.status,
                    line: r.line,
                    indicativeLine: r.entry.line === undefined ? null : r.entry.line,
                    matches: r.matches.length,
                    covered: r.covered,
                })),
            }, null, 2));
        } else {
            console.log(formatReport(result));
        }
        process.exit(0);
    }

    const enforce = opts.mode === 'check';
    const prefix = enforce ? 'ERROR:' : 'AVISO:';

    // Segunda puerta: las lineas de violation NO pasan por `defaultLogger`
    // (rebote rev-1, ruta C). El sink garantiza una llamada = una linea.
    const out = oneLineSink(enforce ? console.error : console.warn);

    // #6106 · CA-3 / CA-5 — diagnosticos de ancla ANTES de las violations.
    //
    // Con un ancla sin resolver la exencion no se aplica, asi que el acceso
    // autorizado reaparece como violation: listar las dos cosas juntas mezcla la
    // causa con su consecuencia. En `--check` se corta aca con exit 2 (error de
    // CONFIGURACION del control, no violation del codigo auditado). En
    // `--report-only` se avisa y se sigue, fiel al contrato del modo.
    const anchorIssues = result.anchorIssues || [];
    if (anchorIssues.length) {
        for (const it of anchorIssues) out(`${prefix} ${formatAnchorIssue(it)}`);
        out(`${prefix} total: ${anchorIssues.length} excepcion(es) de la allowlist sin resolver contra el contenido del archivo`);
        for (const line of anchorRemediationLines()) out(line);
        if (enforce) process.exit(2);
    }

    if (result.violations.length === 0) {
        // Si hubo diagnosticos de ancla, decirlo: un "OK" pelado despues de
        // avisar que una excepcion quedo sin resolver entrena a ignorar el aviso.
        const nota = anchorIssues.length
            ? ` (pero ${anchorIssues.length} excepcion(es) de la allowlist sin resolver — ver arriba)`
            : '';
        logger.info(`OK — ${result.scanned} archivos JS escaneados, 0 violations${nota}`);
        process.exit(0);
    }

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
        out('AVISO: modo report-only — NO bloquea el commit ni el build. El wiring real');
        out('       (CI + hook pre-commit) corre en `--check` desde #5179: alla estas');
        out('       violations SI bloquean. Usa este modo para auditar, no para saltear.');
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
        sanitizeForLog, oneLineSink, defaultLogger,
        resolveWrapperBindings, classifyScope, aggregateByFile,
        formatViolation, formatReport, remediationLines, parseArgv, main,
        // #6106 — anclaje por contenido
        normalizeAnchor, resolveAnchors, formatAnchorIssue, anchorRemediationLines,
        anchorEntryFor, emptyScan,
        RULE_KEYS, ANCHOR_REASON_PLACEHOLDER,
        ANCHOR_OK, ANCHOR_STALE, ANCHOR_AMBIGUOUS, ANCHOR_ORDINAL, ANCHOR_UNSCANNED,
        LintConfigError, LintUsageError,
        STATE_LITERAL_RE, PATH_CTX_RE, COMMENT_LINE_RE, isCommentOnlyLine, isInsideBlockComment,
        ID_RE, SELF_EXEMPT, SKIP_DIRS, RULES, isScratchDirName,
        ALLOWLIST_REL, USAGE,
    },
};
