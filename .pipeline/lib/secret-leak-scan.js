// =============================================================================
// secret-leak-scan.js — Barrido de credenciales replicadas en copias de
// `.claude/` fuera del repo principal (issue #5220, épico #5215).
//
// CONTRATO CENTRAL (CA-3 · control ESTRUCTURAL, no cosmético):
//   El tipo `Finding` NO tiene campo `value`. El valor de la credencial muere
//   dentro de `classifyValue()` y jamás sale de esta función, ni completo ni
//   truncado. Es imposible que una línea de reporte lo filtre porque el dato
//   no existe aguas abajo. Redactar al final NO es un control: está verificado
//   que `redactSecretValue()` (redact.js:355-358) exige `!/\s/.test(trimmed)`,
//   o sea que NUNCA se aplica sobre una línea de reporte (toda línea tiene
//   espacios), y que el `client_secret` de Google mide 35 chars, por debajo de
//   `HIGH_ENTROPY_MIN_LEN = 40`.
//
// Cada hallazgo se identifica por: path + nombre de clave + `sha256[0:8]` + longitud.
//
// Remediación bifurcada en TRES categorías (CA-1), nunca en dos:
//   - `purgable`       → archivo untracked: se borra EL ARCHIVO (jamás el directorio).
//   - `historial`      → archivo TRACKEADO: borrarlo NO remedia (un checkout lo
//                        re-materializa) y ensucia `git status` con `D`, lo que
//                        vuelve inmortal un worktree hoy reciclable (#3943, R4).
//                        Se REPORTA con su estado de rotación; no se toca.
//   - `no-verificable` → no se pudo leer/parsear/consultar git. Fail-closed:
//                        NUNCA cuenta como limpio (CA-5).
//
// Núcleo puro y testeable: `fsImpl` / `spawnImpl` inyectables, sin efectos de
// consola. Sigue el patrón de extracción de #3943 (`lib/ghostbusters-worktrees.js`).
// =============================================================================

'use strict';

const crypto = require('crypto');
const fsDefault = require('fs');
const path = require('path');
const { spawnSync: spawnSyncDefault } = require('child_process');

const { shannonEntropy } = require('./redact');
const { isPlaceholderOrEmpty } = require('./credentials');
// A2 — `isLikelyToken` / `looksLikePlaceholder` eran privados en telegram-secrets.js;
// esta historia los agrega al `module.exports` (cambio aditivo) para reusarlos acá.
const { isLikelyToken, looksLikePlaceholder } = require('./telegram-secrets');
const { isForbiddenTarget } = require('./ghostbusters-worktrees');

// -----------------------------------------------------------------------------
// Constantes de superficie
// -----------------------------------------------------------------------------

// Umbrales de la heurística de entropía. Alineados con redact.js para que un
// valor opaco sin formato conocido se clasifique igual en ambos lados.
const HIGH_ENTROPY_MIN_LEN = 40;
const HIGH_ENTROPY_THRESHOLD = 4.5;

// Tamaño máximo de archivo a parsear. Un JSON mayor no es un archivo de config
// de credenciales; leerlo sólo encarece el barrido (CA-8).
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Profundidad máxima de recursión dentro de una copia de `.claude/`.
const MAX_DEPTH = 6;

// Corte de recursión + estado de runtime. `worktrees/` es obligatorio: sin él el
// barrido recursa en copias de copias. El resto son directorios de estado
// (sesiones, logs, tmp) sin credenciales estructuradas.
const DENY_DIRS = Object.freeze(new Set([
  'node_modules', '.git', 'worktrees', 'sessions', 'sessions-archive', 'tmp',
  'shell-snapshots', 'statsig', 'projects', 'todos', 'plugins', 'build', '.gradle',
]));

// EJE 1 del clasificador — el NOMBRE de la clave sugiere secreto.
// Los dos ejes son OBLIGATORIOS: `guru` midió 198 descartes sobre 226 ocurrencias
// (88 %) con un matcher sólo-por-nombre. `_secrets_note` es prosa y
// `google_credentials_path` es un path: ambos matchean acá y los mata el eje 2.
const SECRET_KEY_RE =
  /(token|secret|password|passwd|pwd|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|refresh)/i;

// EJE 2 del clasificador — el VALOR tiene forma de secreto real.
// Verificado que `redact.js` hoy sólo cubre una de las cuatro formas en juego.
const VALUE_SHAPES = Object.freeze([
  { kind: 'telegram_bot_token', re: /^\d{6,}:[A-Za-z0-9_-]{35,}$/ },
  { kind: 'anthropic_api_key', re: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  // Medido en el disco real: las keys actuales de OpenAI llevan `-`/`_`
  // (`sk-proj-…`), así que el patrón de `redact.js` (`sk-[A-Za-z0-9]{20,}`) no
  // las matchea y caían en `high-entropy`. Acá se clasifican con su nombre real.
  { kind: 'openai_api_key', re: /^sk-[A-Za-z0-9_-]{20,}$/ },
  { kind: 'google_client_secret', re: /^GOCSPX-[A-Za-z0-9_-]{20,}$/ },
  { kind: 'google_refresh_token', re: /^1\/\/[A-Za-z0-9_-]{20,}$/ },
  { kind: 'aws_access_key', re: /^AKIA[0-9A-Z]{16}$/ },
  { kind: 'groq_api_key', re: /^gsk_[A-Za-z0-9]{20,}$/ },
  { kind: 'jwt', re: /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
]);

const toPosix = (p) => String(p).replace(/\\/g, '/');

/** sha256 truncado a 8 hex. Identifica una credencial sin revelarla. */
function hash8(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/**
 * Devuelve el `kind` de la forma del valor, o `null` si no tiene forma de secreto.
 * @param {string} value
 * @returns {string|null}
 */
function matchShape(value) {
  for (const { kind, re } of VALUE_SHAPES) {
    if (re.test(value)) return kind;
  }
  // Secreto opaco sin formato conocido: entropía alta y sin espacios.
  if (
    value.length > HIGH_ENTROPY_MIN_LEN &&
    shannonEntropy(value) >= HIGH_ENTROPY_THRESHOLD
  ) {
    return 'high-entropy';
  }
  return null;
}

/**
 * Clasifica un par clave/valor. NUNCA devuelve el valor ni una subcadena suya.
 *
 * @param {string} key   nombre de la clave (o su dot-path dentro del JSON)
 * @param {*}      value valor crudo
 * @returns {{verdict:'real'|'placeholder'|'not-secret', kind?:string, hash8?:string, len?:number}}
 */
function classifyValue(key, value) {
  if (typeof value !== 'string' || !value.trim()) return { verdict: 'not-secret' };

  // Eje 1 — el nombre de la clave tiene que sugerir secreto.
  const leaf = String(key || '').split('.').pop();
  if (!SECRET_KEY_RE.test(leaf) && !SECRET_KEY_RE.test(String(key || ''))) {
    return { verdict: 'not-secret' };
  }

  // Placeholder explícito (`MOVED_TO_HOME_DOT_CLAUDE_SECRETS`, `REVOKED`, …).
  // Va antes que la forma: un placeholder no es un hallazgo.
  if (looksLikePlaceholder(value) || isPlaceholderOrEmpty(value)) {
    return { verdict: 'placeholder' };
  }

  // Eje 2 — descartes baratos antes de medir forma.
  if (/\s/.test(value)) return { verdict: 'not-secret' };                          // prosa / nota
  if (/^[A-Za-z]:[\\/]|^[.~]?[\\/]/.test(value)) return { verdict: 'not-secret' };  // path

  const kind = isLikelyToken(value) && /^\d{6,}:[A-Za-z0-9_-]{35,}$/.test(value)
    ? 'telegram_bot_token'
    : matchShape(value);
  if (!kind) return { verdict: 'not-secret' };

  // ⛔ EL VALOR MUERE ACÁ. No se devuelve, ni completo ni truncado (CA-3).
  return { verdict: 'real', kind, hash8: hash8(value), len: value.length };
}

// -----------------------------------------------------------------------------
// Enumerado de superficie (R6 / CA-8)
// -----------------------------------------------------------------------------

/**
 * Enumera los directorios a barrer POR EXISTENCIA de `.claude`, no por glob de
 * nombre: verificado que `.pipeline/_tmp/` tiene 16 directorios y sólo 4 con
 * `.claude` propio, y que un glob `*-worktree` deja fuera a `ux-2761-rebounce`.
 *
 * @returns {string[]} paths absolutos de las raíces con `.claude` propio
 */
function enumerateScanRoots({ mainRepo, workspaces, fsImpl = fsDefault } = {}) {
  const main = mainRepo || process.cwd();
  const ws = workspaces || path.resolve(main, '..');
  const roots = [];
  const seen = new Set();

  const consider = (dir) => {
    const key = toPosix(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (fsImpl.statSync(path.join(dir, '.claude')).isDirectory()) roots.push(dir);
    } catch { /* sin .claude propio: fuera de la superficie */ }
  };

  const listDir = (dir) => {
    try { return fsImpl.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
  };

  const baseName = path.basename(main);
  // Worktrees hermanos `<repo>.session-*` y `<repo>.agent-*`.
  for (const e of listDir(ws)) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(`${baseName}.session-`) || e.name.startsWith(`${baseName}.agent-`)) {
      consider(path.join(ws, e.name));
    }
  }
  // Worktrees internos y temporales del pipeline.
  for (const sub of [path.join(main, '.claude', 'worktrees'), path.join(main, '.pipeline', '_tmp')]) {
    for (const e of listDir(sub)) {
      if (e.isDirectory()) consider(path.join(sub, e.name));
    }
  }
  return roots;
}

// -----------------------------------------------------------------------------
// Barrido
// -----------------------------------------------------------------------------

/**
 * Recorre un objeto JSON acumulando hallazgos con valor real.
 * `out` recibe `{ key, kind, hash8, len }` — nunca el valor.
 */
function walkJson(node, prefix, out) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJson(v, `${prefix}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') { walkJson(v, dotted, out); continue; }
    const verdict = classifyValue(dotted, v);
    if (verdict.verdict === 'real') {
      out.push({ key: dotted, kind: verdict.kind, hash8: verdict.hash8, len: verdict.len });
    }
  }
}

/**
 * Barre las copias de `.claude/` bajo las raíces indicadas.
 *
 * Fail-closed (CA-5 / R7): todo archivo que no se pudo leer o parsear se
 * contabiliza en `filesUnparseable` y se emite un hallazgo `no-verificable`.
 * Un error NUNCA se traga en silencio ni se reporta como limpio.
 *
 * @returns {{findings:Array, errors:Array, dirsScanned:number, filesScanned:number, filesUnparseable:number}}
 */
function scanLeakedSecrets({ roots = [], fsImpl = fsDefault } = {}) {
  const findings = [];
  const errors = [];
  let dirsScanned = 0;
  let filesScanned = 0;
  let filesUnparseable = 0;

  for (const root of roots) {
    const claudeDir = path.join(root, '.claude');
    const stack = [{ dir: claudeDir, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > MAX_DEPTH) {
        filesUnparseable++;
        const reason = `directorio no verificable: profundidad ${depth} supera el límite ${MAX_DEPTH}`;
        errors.push({ root, file: toPosix(dir), reason });
        findings.push(mkFinding(
          root, dir, { key: '(directorio)', kind: 'limite-profundidad' },
          'no-verificable', reason));
        continue;
      }
      let entries;
      try {
        entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        dirsScanned++;
      } catch (e) {
        errors.push({ root, file: toPosix(dir), reason: `readdir: ${String(e.message).slice(0, 120)}` });
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (DENY_DIRS.has(e.name)) continue;   // corte de recursión
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!e.isFile() || !e.name.endsWith('.json')) continue;

        let raw;
        try {
          const st = fsImpl.statSync(full);
          if (st.size > MAX_FILE_BYTES) {
            filesUnparseable++;
            const reason =
              `archivo no verificable: tamaño ${st.size} supera el límite ${MAX_FILE_BYTES} bytes`;
            errors.push({ root, file: toPosix(full), reason });
            findings.push(mkFinding(
              root, full, { key: '(archivo)', kind: 'limite-tamano' },
              'no-verificable', reason));
            continue;
          }
          raw = fsImpl.readFileSync(full, 'utf8');
          filesScanned++;
        } catch (err) {
          filesUnparseable++;
          const reason = `lectura: ${String(err.message).slice(0, 120)}`;
          errors.push({ root, file: toPosix(full), reason });
          findings.push(mkFinding(root, full, { key: '(archivo)', kind: 'ilegible' }, 'no-verificable', reason));
          continue;
        }

        const docs = parseJsonOrJsonl(raw);
        if (docs === null) {
          // CA-5 (letra explícita: «JSON corrupto») — fail-closed: NUNCA cuenta
          // como limpio, aunque el barrido de texto crudo no encuentre nada.
          filesUnparseable++;
          const reason = /^<{7}|\n<{7}/.test(raw)
            ? 'JSON roto por marcadores de conflicto de git sin resolver'
            : 'contenido no parseable como JSON ni como JSONL';
          findings.push(mkFinding(root, full, { key: '(archivo)', kind: 'no-parseable' }, 'no-verificable', reason));
          // …y aun así lo miramos en crudo, para no quedar ciegos ante un
          // secreto que esté adentro (sólo agrega, nunca resta).
          for (const h of scanRawFallback(raw)) findings.push(mkFinding(root, full, h, null, null));
          continue;
        }

        const hits = [];
        for (const doc of docs) walkJson(doc, '', hits);
        for (const h of hits) findings.push(mkFinding(root, full, h, null, null));
      }
    }
  }

  return { findings, errors, dirsScanned, filesScanned, filesUnparseable };
}

/**
 * Parsea el contenido como JSON o, si falla, como JSONL (un documento por línea).
 *
 * Medido en el disco real: 419 de los 419 "no parseables" de la primera corrida
 * eran 6 archivos de estado del pipeline (`agent-metrics.json`,
 * `tg-session-store.json`, `auto-review-state.json`, `scrum-monitor-state.json`,
 * `agent-registry.json`) que guardan JSONL con extensión `.json`. Marcarlos como
 * `no-verificable` no era fail-closed: era ruido que sepultaba los 13 hallazgos
 * reales a rotar. Parsearlos de verdad ES verificarlos; el que sigue sin parsear
 * queda `no-verificable` igual.
 *
 * @returns {Array<*>|null} documentos parseados, o `null` si no se pudo verificar.
 */
function parseJsonOrJsonl(raw) {
  try { return [JSON.parse(raw)]; } catch { /* probamos JSONL */ }
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return null;
  const docs = [];
  for (const line of lines) {
    try { docs.push(JSON.parse(line)); }
    catch { return null; }     // ni JSON ni JSONL ⇒ no verificable
  }
  return docs;
}

// Variantes globales (sin anclas) de las formas explícitas, para buscarlas
// dentro de texto crudo. Se excluye `high-entropy`: sin la clave al lado, la
// heurística de entropía sobre texto libre es puro ruido.
const RAW_SHAPES = Object.freeze([
  { kind: 'telegram_bot_token', re: /\b\d{6,}:[A-Za-z0-9_-]{35,}/g },
  { kind: 'anthropic_api_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_api_key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'google_client_secret', re: /GOCSPX-[A-Za-z0-9_-]{20,}/g },
  { kind: 'google_refresh_token', re: /1\/\/[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'groq_api_key', re: /gsk_[A-Za-z0-9]{20,}/g },
]);

/**
 * Barrido de TEXTO CRUDO para archivos que no parsean.
 *
 * Un archivo con marcadores de conflicto de git (`<<<<<<<`) es JSON inválido,
 * y CA-5 manda contarlo como `no-verificable`. Pero quedarse ahí dejaría al
 * barrido CIEGO ante un secreto que sí está adentro: el operador vería «no pude
 * verificar» y seguiría de largo. Esta pasada extra sólo AGREGA hallazgos
 * reales; no reduce el conteo de no-verificables ni relaja el fail-closed.
 *
 * Mantiene el contrato de CA-3: devuelve `{key, kind, hash8, len}`, nunca el valor.
 */
function scanRawFallback(raw) {
  const hits = [];
  const seen = new Set();
  const push = (key, kind, value) => {
    const h = hash8(value);
    const dedup = `${kind}|${h}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    // ⛔ El valor no se propaga: sólo su hash y su longitud.
    hits.push({ key, kind, hash8: h, len: value.length });
  };

  const text = String(raw);

  // 1) Formas explícitas sueltas, sin clave al lado. Son inequívocas.
  //    Se corren sobre el texto ENTERO de una vez (7 regex), no línea por línea:
  //    medido, hacerlo por línea sobre 419 archivos costaba ~9 s del barrido.
  for (const { kind, re } of RAW_SHAPES) {
    re.lastIndex = 0;
    let s;
    while ((s = re.exec(text)) !== null) {
      if (!looksLikePlaceholder(s[0])) push('(texto crudo)', kind, s[0]);
    }
  }

  // 2) Pares "clave": "valor" con nombre de clave sospechoso — mismo criterio
  //    de dos ejes que el JSON. Pre-filtro barato: si el archivo entero no
  //    menciona ninguna clave con pinta de secreto, no hay nada que extraer.
  if (SECRET_KEY_RE.test(text)) {
    const pairRe = /"([^"\\]{1,80})"\s*:\s*"([^"\\]{1,4096})"/g;
    for (const line of text.split(/\r?\n/)) {
      if (!SECRET_KEY_RE.test(line)) continue;
      pairRe.lastIndex = 0;
      let m;
      while ((m = pairRe.exec(line)) !== null) {
        const v = classifyValue(m[1], m[2]);
        if (v.verdict === 'real') push(m[1], v.kind, m[2]);
      }
    }
  }
  return hits;
}

/** Construye un Finding. Por contrato NO existe el campo `value`. */
function mkFinding(root, file, hit, category, reason) {
  const f = {
    root: toPosix(root),
    file: toPosix(file),
    rel: toPosix(path.relative(root, file)),
    key: hit.key,
    kind: hit.kind,
    hash8: hit.hash8 || null,
    len: typeof hit.len === 'number' ? hit.len : null,
  };
  if (category) f.category = category;
  if (reason) f.reason = reason;
  return f;
}

// -----------------------------------------------------------------------------
// Clasificación de remediación (CA-1)
// -----------------------------------------------------------------------------

/**
 * Resuelve el toplevel git SIN spawnear `git rev-parse`, subiendo por el fs
 * hasta encontrar un `.git` (archivo en worktrees, directorio en el repo).
 *
 * Medido: `rev-parse` costaba un spawn por raíz y el barrido completo tardaba
 * 11,5 s, de los cuales sólo 1,8 s eran lectura de archivos — el resto, git.
 * Resolverlo por fs elimina la mitad de los spawns sin perder exactitud: el
 * mismo barrido (68 raíces, 3261 archivos) quedó en ~1 s medido sobre el disco
 * real. Ése es el número vigente; el 11,5 s es el estado PREVIO a este cambio.
 *
 * @returns {string|null} toplevel en formato posix, o `null` si no es árbol git.
 */
function gitTopLevel(root, fsImpl = fsDefault) {
  let dir = path.resolve(root);
  for (let i = 0; i <= 12; i++) {
    try {
      fsImpl.statSync(path.join(dir, '.git'));
      return toPosix(dir);
    } catch { /* seguimos subiendo */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitTrackedSet(root, spawnImpl, cache, fsImpl = fsDefault) {
  const top = gitTopLevel(root, fsImpl);
  // No es un árbol git: nada puede estar trackeado, por lo tanto la copia es
  // untracked y purgable. No es un "no verificable".
  if (top === null) return { top: null, tracked: new Set() };

  const relRoot = toPosix(path.relative(top, root));
  const pathspec = relRoot ? `${relRoot}/.claude` : '.claude';
  const key = `${top}::${pathspec}`;
  if (cache && cache.has(key)) return cache.get(key);

  let entry;
  try {
    const r = spawnImpl('git', ['ls-files', '-z', '--cached', '--', pathspec],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      entry = { top, tracked: null };     // no se pudo consultar → fail-closed
    } else {
      const rels = String(r.stdout || '').split('\0').filter(Boolean);
      entry = { top, tracked: new Set(rels.map(toPosix)) };
    }
  } catch {
    entry = { top, tracked: null };
  }
  if (cache) cache.set(key, entry);
  return entry;
}

/**
 * Clasifica la remediación de un hallazgo en exactamente UNA de tres categorías.
 * @returns {'purgable'|'historial'|'no-verificable'}
 */
function classifyRemediation(finding, { spawnImpl = spawnSyncDefault, cache, fsImpl = fsDefault } = {}) {
  // Un hallazgo que ya nació no-verificable (ilegible / JSON roto) lo sigue siendo.
  if (finding.category === 'no-verificable') return 'no-verificable';

  const { top, tracked } = gitTrackedSet(finding.root, spawnImpl, cache, fsImpl);
  if (tracked === null) return 'no-verificable';
  if (top === null) return 'purgable';

  const relFromTop = toPosix(path.relative(top, finding.file));
  return tracked.has(relFromTop) ? 'historial' : 'purgable';
}

/** Aplica `classifyRemediation` a todos los hallazgos, devolviendo copias con `category`. */
function classifyAll(findings, { spawnImpl = spawnSyncDefault, fsImpl = fsDefault } = {}) {
  const cache = new Map();
  return findings.map((f) => ({ ...f, category: classifyRemediation(f, { spawnImpl, cache, fsImpl }) }));
}

/**
 * Chequeo BARATO para la corrida default de `/ghostbusters` (CA-8 / R1).
 *
 * El barrido completo tarda más de 5 s (medido), así que la categoría `secrets`
 * queda detrás del flag `--secrets` y la corrida sin flags hace sólo esto:
 * contar copias ANIDADAS de `.claude/.claude`, que es la firma exacta de la fuga
 * (`cp -r` de `.claude` sin `rm -rf` previo del destino). Sin parsear ni git:
 * un `stat` por raíz.
 *
 * @returns {{nestedClaudeCopies:number, roots:string[]}}
 */
function quickNestedClaudeCheck({ roots = [], fsImpl = fsDefault } = {}) {
  const hits = [];
  for (const root of roots) {
    try {
      if (fsImpl.statSync(path.join(root, '.claude', '.claude')).isDirectory()) hits.push(toPosix(root));
    } catch { /* sin anidamiento */ }
  }
  return { nestedClaudeCopies: hits.length, roots: hits };
}

// -----------------------------------------------------------------------------
// Purga (CA-9 / R4 / R5)
// -----------------------------------------------------------------------------

/**
 * Elimina ARCHIVOS individuales untracked. Jamás directorios, jamás worktrees.
 *
 * Guardas, en orden:
 *   1. Sólo categoría `purgable` (untracked). Tocar un trackeado agrega `M`/`D`
 *      y vuelve inmortal un worktree hoy reciclable (#3943 / R4).
 *   2. `isForbiddenTarget` sobre la raíz (repo principal, ancestros, junctions).
 *   3. El path tiene que estar dentro de un `.claude/` de esa raíz.
 *   4. `lstat` tiene que decir que es un archivo regular (ni dir ni symlink).
 *
 * NUNCA invoca `removeWorktree` ni `rmSync` recursivo: 17 de 33 worktrees tienen
 * cambios sin commitear (R5).
 */
function purgeFindings(findings, { dryRun = true, fsImpl = fsDefault, mainRepo } = {}) {
  const purged = [];
  const skipped = [];
  const rootChecks = new Map();

  // Un hallazgo es UNA CREDENCIAL, pero `unlinkSync` borra EL ARCHIVO ENTERO.
  // Los 13 archivos purgables del disco real tienen 4 credenciales cada uno:
  // sin esta memo el 1er hallazgo borra el archivo y los 3 restantes fallan el
  // `lstat` con ENOENT y caen en `skipped` con `removed` en false — o sea que
  // tras una purga que limpió el 100% del disco el reporte decía «0/13
  // eliminados» y `computeExitCode` devolvía 2 (PURGABLE_PENDING) en vez de 0.
  // La decisión de borrado se toma UNA vez por archivo y su resultado se
  // propaga a TODOS los hallazgos de ese archivo.
  const fileOutcome = new Map();

  for (const f of findings) {
    if (f.category !== 'purgable') {
      skipped.push({ ...f, skipReason: `categoría ${f.category}: no se purga` });
      continue;
    }

    if (!rootChecks.has(f.root)) {
      const opts = mainRepo ? { mainRepo, fsImpl } : { fsImpl };
      let check;
      try { check = isForbiddenTarget(f.root, opts); }
      catch (e) { check = { forbidden: true, reason: `guard falló: ${String(e.message).slice(0, 80)}` }; }
      rootChecks.set(f.root, check);
    }
    const guard = rootChecks.get(f.root);
    if (guard.forbidden) {
      skipped.push({ ...f, skipReason: `path protegido: ${guard.reason}` });
      continue;
    }

    const rel = toPosix(path.relative(f.root, f.file));
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.startsWith('.claude/')) {
      skipped.push({ ...f, skipReason: 'fuera del .claude/ de la raíz barrida' });
      continue;
    }

    // Decisión POR ARCHIVO, tomada una sola vez. El ENOENT del 2º hallazgo de
    // un archivo ya borrado en esta misma corrida no es un skip: es el mismo
    // borrado exitoso visto de nuevo.
    if (!fileOutcome.has(f.file)) {
      fileOutcome.set(f.file, decidePurge(f.file, { dryRun, fsImpl }));
    }
    const outcome = fileOutcome.get(f.file);

    if (!outcome.ok) { skipped.push({ ...f, skipReason: outcome.skipReason }); continue; }
    purged.push({ ...f, removed: outcome.removed, dryRun });
  }
  return { purged, skipped };
}

/**
 * Resuelve el borrado de UN archivo. Se llama una vez por archivo (memoizado
 * por `purgeFindings`), no una vez por credencial.
 * @returns {{ok:true, removed:boolean}|{ok:false, skipReason:string}}
 */
function decidePurge(file, { dryRun, fsImpl }) {
  let st;
  try { st = fsImpl.lstatSync(file); }
  catch (e) { return { ok: false, skipReason: `lstat: ${String(e.message).slice(0, 80)}` }; }
  if (!st.isFile()) return { ok: false, skipReason: 'no es un archivo regular' };

  if (dryRun) return { ok: true, removed: false };

  try {
    fsImpl.unlinkSync(file);                  // ← unlink de UN archivo. Nunca rmSync recursivo.
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, skipReason: `unlink: ${String(e.message).slice(0, 80)}` };
  }
}

// -----------------------------------------------------------------------------
// Estado de rotación (CA-7) — la credencial que persiste por historial sólo
// cuenta como remediada si consta su rotación Y su revocación verificada.
// -----------------------------------------------------------------------------

const ROTATIONS_FILE = 'secret-rotations.json';

/**
 * Lee el registro de rotaciones. Formato:
 *   { "rotations": [ { "hash8": "ab12cd34", "kind": "...", "rotated_at": "2026-07-30",
 *                      "revoked": true, "verified_at": "2026-07-30", "note": "..." } ] }
 * Ausente o ilegible ⇒ registro vacío ⇒ todo hallazgo de historial queda PENDIENTE.
 * Es el default fail-closed que CA-7 exige.
 */
function loadRotationRegistry({ file, fsImpl = fsDefault } = {}) {
  const byHash = new Map();
  if (!file) return byHash;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    for (const r of (parsed.rotations || [])) {
      if (r && r.hash8) byHash.set(String(r.hash8), r);
    }
  } catch { /* sin registro: todo PENDIENTE */ }
  return byHash;
}

/**
 * Estado de rotación de un hallazgo, listo para imprimir (UX-4).
 * @returns {{rotated:boolean, label:string}}
 */
function rotationStatusOf(finding, registry) {
  const rec = registry && finding.hash8 ? registry.get(finding.hash8) : null;
  if (!rec || !rec.rotated_at) return { rotated: false, label: 'rotación PENDIENTE' };
  if (!rec.revoked) return { rotated: false, label: `rotada ${rec.rotated_at} · revocación PENDIENTE` };
  if (!rec.verified_at) return { rotated: false, label: `rotada ${rec.rotated_at} · revocación SIN VERIFICAR` };
  return { rotated: true, label: `rotada ${rec.rotated_at} · revocación VERIFICADA ${rec.verified_at}` };
}

// -----------------------------------------------------------------------------
// Agrupado para el reporte (UX-1) — agrupar, jamás truncar.
// -----------------------------------------------------------------------------

/**
 * Agrupa por credencial distinta (`hash8` + `kind`) dentro de cada categoría.
 * Comprime 33 hallazgos del mismo token en 1 línea `xN worktrees` SIN perder
 * ninguna unidad de acción, que es lo que sí perdería un truncado a 10.
 */
function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.category}|${f.kind}|${f.hash8 || f.file}`;
    if (!groups.has(key)) {
      groups.set(key, {
        category: f.category, kind: f.kind, hash8: f.hash8, len: f.len,
        keys: new Set(), roots: new Set(), files: [], reasons: new Set(),
      });
    }
    const g = groups.get(key);
    g.keys.add(f.key);
    g.roots.add(f.root);
    g.files.push(f.file);
    if (f.reason) g.reasons.add(f.reason);
  }
  return [...groups.values()].map((g) => ({
    category: g.category, kind: g.kind, hash8: g.hash8, len: g.len,
    keys: [...g.keys], roots: [...g.roots], files: g.files,
    count: g.files.length, reasons: [...g.reasons],
  }));
}

// -----------------------------------------------------------------------------
// Exit codes semánticos (CA-5 / UX-6). Gana el número más alto.
// -----------------------------------------------------------------------------

const EXIT_CODES = Object.freeze({
  CLEAN: 0,            // sin hallazgos de secretos
  COMMAND_ERROR: 1,    // error del propio comando (reservado)
  PURGABLE_PENDING: 2, // dry-run con hallazgos untracked pendientes
  UNVERIFIABLE: 3,     // no-verificables presentes → fail-closed
  UNROTATED: 4,        // credencial persistente por historial sin rotación registrada
});

/**
 * @param {{leakedSecrets:Array, secretsScanErrors:Array, secretsUnparseable:number}} r
 * @returns {number}
 */
function computeExitCode(r) {
  const findings = (r && r.leakedSecrets) || [];
  const errors = (r && r.secretsScanErrors) || [];
  let code = EXIT_CODES.CLEAN;

  if (findings.some((f) => f.category === 'purgable' && !f.removed)) {
    code = Math.max(code, EXIT_CODES.PURGABLE_PENDING);
  }
  if (errors.length > 0 || (r && r.secretsUnparseable > 0) ||
      findings.some((f) => f.category === 'no-verificable')) {
    code = Math.max(code, EXIT_CODES.UNVERIFIABLE);
  }
  if (findings.some((f) => f.category === 'historial' && !f.rotated)) {
    code = Math.max(code, EXIT_CODES.UNROTATED);
  }
  return code;
}

module.exports = {
  classifyValue,
  matchShape,
  hash8,
  enumerateScanRoots,
  scanLeakedSecrets,
  classifyRemediation,
  classifyAll,
  quickNestedClaudeCheck,
  scanRawFallback,
  parseJsonOrJsonl,
  gitTopLevel,
  purgeFindings,
  loadRotationRegistry,
  rotationStatusOf,
  groupFindings,
  computeExitCode,
  EXIT_CODES,
  ROTATIONS_FILE,
  SECRET_KEY_RE,
  VALUE_SHAPES,
  DENY_DIRS,
};
