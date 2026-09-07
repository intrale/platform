#!/usr/bin/env node
'use strict';

// Guardrail de secretos, compartido por el pre-commit local y CI. Tiene DOS
// capas independientes; el merge de #5244 con #6111 las junta acá y ninguna
// reemplaza a la otra:
//
//   Capa 1 (#5551 / #6111) — PATHS. Un archivo del inventario
//     (`sensitive-paths.js`) que debe permanecer ignorado no puede aparecer en
//     el índice ni en el rango de un PR, aunque esté vacío. Para los que sí
//     están legítimamente trackeados, pasa el contenido por `sanitize()`
//     completo (modo REDACCIÓN).
//
//   Capa 2 (#5244) — CONTENIDO. Escanea las líneas AGREGADAS de TODO path del
//     cambio, agrupadas por hunk para conservar secretos multilínea.
//
// #5244 rev-2 — el criterio de bloqueo de la capa 2 NO es `sanitize()` completo.
// `sanitize()` es modo REDACCIÓN (sobre-redactar cuesta cero); la capa 2 es modo
// LINT (sobre-redactar frena al dev). `secret-scan-lint.js` separa los dos
// conjuntos de patrones y agrega el escape por línea `secret-scan:ignore`.
// Ver su cabecera.
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { isControlPath, loadAllowlist, whichAllowlistEntry } = require('./secret-allowlist');
const { IGNORE_MARKER, createLintSanitizer, markedLines, stripIgnoredLines } = require('./secret-scan-lint');
const { SENSITIVE_PATHS, clasificarPath } = require('./sensitive-paths');

const DEFAULT_ALLOWLIST = path.join(__dirname, '..', 'secret-scan-allowlist.json');
const DEFAULT_SANITIZER = path.join(__dirname, '..', 'sanitizer.js');
// Protocolo declarado por `--capabilities`. CI lo usa para decidir si el
// scanner del árbol base entiende `--mode=range`: un scanner viejo ignora los
// flags y termina en 0 sin mirar nada, así que "el archivo existe" no alcanza.
// Bumpear sólo si cambia el contrato de flags de forma incompatible.
const SCAN_PROTOCOL = 'range-v1';
const CAPABILITIES_LINE = `secret-scan-protocol=${SCAN_PROTOCOL}`;

// El inventario NO se duplica acá: sale del módulo compartido (#5551). Una
// lista paralela en este archivo se desincroniza en silencio y deja paths
// sensibles sin mirar — `credential-path-guards.test.js` lo verifica.
const SENSITIVE_PATTERNS = SENSITIVE_PATHS
  .filter((entry) => entry.escaneaContenido)
  .map((entry) => ({ name: entry.id, test: entry.test }));

// Devuelve el id de la entrada del inventario que cubre el path, o `null`.
// El `null` es parte del contrato: distingue "path del inventario" de
// "cualquier otro archivo", que la capa 2 escanea igual pero sin atribuirle
// una regla del inventario.
function isSensitive(filePath) {
  for (const pattern of SENSITIVE_PATTERNS) if (pattern.test(filePath)) return pattern.name;
  return null;
}

// ===========================================================================
// CAPA 1 — Paths sensibles del inventario (#5551 / #6111)
//
// Bloquea por PATH, sin mirar el contenido: si un archivo del inventario que
// debe permanecer ignorado aparece en el índice (o en el rango de un PR), el
// cambio se frena aunque hoy esté vacío. Es un control DISTINTO del de la capa
// 2 y no lo reemplaza: un `.pipeline/state/*.json` sin credenciales adentro
// igual no puede entrar al repo.
//
// Las dos capas corren SIEMPRE y de forma independiente: la capa 1 no corta la
// 2. Un `.env` staged con una AWS key adentro tiene que salir reportado por
// las dos vías — la del path y la del contenido — porque son dos defectos
// distintos y arreglar uno no arregla el otro.
// ===========================================================================

class GitOperationError extends Error {
  constructor(operation, status, detail) {
    super(`Git falló durante ${operation} (código ${status == null ? 'sin estado' : status})${detail ? `: ${detail}` : ''}`);
    this.name = 'GitOperationError';
    this.operation = operation;
    this.status = status;
  }
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? null : options.encoding,
    maxBuffer: 50 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || '').trim();
    throw new GitOperationError(options.operation || args.join(' '), result.status, detail);
  }
  return result.stdout;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseNameStatusZ(output) {
  const fields = (Buffer.isBuffer(output) ? output.toString('utf8') : String(output)).split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    // #5244 rev-9 — `T` (typechange) se acepta por la misma razón por la que la
    // capa 2 pasó a `--diff-filter=d`: pisar un gitlink/symlink tracked con un
    // archivo regular no es un alta, es un `T`, y la lista blanca `ACMR` lo
    // dejaba fuera del inventario de paths sensibles. Todo lo demás (`U`, `X`,
    // `B`) sigue tirando: "no entiendo el estado" bloquea, no se saltea.
    if (!/^[ACMRT][0-9]*$/.test(status)) {
      throw new GitOperationError('interpretar git diff --name-status -z', null, `estado inesperado ${JSON.stringify(status)}`);
    }
    const count = /^[CR]/.test(status) ? 2 : 1;
    if (index + count > fields.length) {
      throw new GitOperationError('interpretar git diff --name-status -z', null, 'salida truncada');
    }
    changes.push({ status, paths: fields.slice(index, index + count).map(normalizePath) });
    index += count;
  }
  return changes;
}

// #5244 rev-9 — mismo criterio que `gitDiff` de la capa 2: se excluye SÓLO `D`
// (por lista negra, no por lista blanca). La asimetría previa —capa 1 con
// `ACMR`, capa 2 con `d`— dejaba el agujero de typechange abierto en el
// inventario de paths sensibles: un `.env` que entra pisando un gitlink tracked
// sale con estado `T` y desaparecía de la capa 1 sin que nada lo declarara.
// Un borrado no agrega contenido y su path deja de estar trackeado, así que
// excluirlo es correcto en las dos capas.
function listChanges(options = {}) {
  const args = options.mode === 'range'
    ? ['diff', '--name-status', '-z', '--diff-filter=d', '-M', '-C', '--find-copies-harder', options.base, options.head, '--']
    : ['diff', '--cached', '--name-status', '-z', '--diff-filter=d', '-M', '-C', '--'];
  if (options.mode === 'range' && (!options.base || !options.head)) throw new Error('El modo --range requiere BASE y HEAD');
  const runner = options.git || runGit;
  return parseNameStatusZ(runner(args, { cwd: options.cwd, operation: 'enumerar paths del diff' }));
}

function readStagedContent(stagedPath, options = {}) {
  const runner = options.git || runGit;
  return runner(['show', `:0:${stagedPath}`], {
    cwd: options.cwd,
    encoding: 'utf8',
    operation: `leer contenido staged de ${JSON.stringify(stagedPath)}`,
  });
}

// El sanitizer de la capa 1 es el modo REDACCIÓN completo, no el lint. Se
// resuelve perezosamente: en modo range no hace falta, y el árbol reducido con
// el que corren los tests de CI no siempre lo tiene a mano.
function fullSanitizer(options = {}) {
  if (options.sanitize) return options.sanitize;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(options.sanitizer || DEFAULT_SANITIZER).sanitize;
}

function collectFindings(options = {}) {
  const paths = [...new Set(listChanges(options).flatMap((change) => change.paths))];
  const findings = [];
  for (const rel of paths) {
    const classification = clasificarPath(rel);
    if (classification && classification.requiereIgnore) {
      findings.push({ path: rel, ...classification, stagedSensitive: true });
      continue;
    }
    if (options.mode === 'range') continue;
    const kind = isSensitive(rel);
    if (!kind) continue;
    const content = readStagedContent(rel, options);
    const normalized = content.replace(/\r\n/g, '\n');
    let sanitized;
    try {
      sanitized = fullSanitizer(options)(normalized);
    } catch (error) {
      findings.push({ path: rel, id: kind, error: error.message || 'desconocido' });
      continue;
    }
    if (sanitized !== normalized) findings.push({ path: rel, id: kind, redactions: countRedactions(sanitized) });
  }
  return findings;
}

// El bloqueo nombra el path y la regla, nunca el valor: volcar el contenido del
// archivo sensible en el log sería filtrarlo por otra vía (CA-5 de #5551).
function formatInventoryFindings(findings, format = 'text') {
  const causa = (finding) => {
    if (finding.stagedSensitive) return 'causa=path del inventario que debe permanecer ignorado';
    if (finding.error) return `causa=falló el sanitizer (${finding.error})`;
    return `patrones=${Object.keys(finding.redactions || {}).join(',')}`;
  };
  const REMEDIO = 'Remediación: quite cada path del índice y verifique la regla en '
    + '.pipeline/lib/sensitive-paths.js y .gitignore.';
  if (format === 'github') {
    return `${findings.map((finding) => `::error file=${finding.path},line=1::Guardrail bloqueado: `
      + `path=${JSON.stringify(finding.path)} regla=${finding.id} `
      + `clase=${finding.clase || 'credencial'} ${causa(finding)} — ${REMEDIO}`).join('\n')}\n`;
  }
  const lines = ['Guardrail bloqueado: paths sensibles en el cambio.'];
  for (const finding of findings) {
    lines.push(`- path=${JSON.stringify(finding.path)} regla=${finding.id} clase=${finding.clase || 'credencial'}`);
    lines.push(`  ${causa(finding)}`);
  }
  lines.push(REMEDIO);
  return `${lines.join('\n')}\n`;
}

// ===========================================================================
// CAPA 2 — Secretos en el CONTENIDO agregado (#5244)
//
// Escanea líneas agregadas, agrupadas por hunk para conservar secretos
// multilínea, sobre TODO path del cambio (no sólo los del inventario).
// ===========================================================================

function countRedactions(text) {
  const tally = {};
  for (const hit of String(text).match(/\[REDACTED:[A-Z_]+\]/g) || []) {
    tally[hit] = (tally[hit] || 0) + 1;
  }
  return tally;
}

function unquoteDiffPath(raw) {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try { return JSON.parse(value); } catch { throw new Error(`diff: path C-quoted inválido: ${raw}`); }
}

// `@@ -viejo[,borradas] +nuevo[,agregadas] @@`. Los conteos delimitan el cuerpo.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// #5244 — el contenido NO se clasifica por su prefijo de texto, se consume por
// el conteo que declara el encabezado @@. Con -U0 una línea agregada cuyo
// contenido empieza con "++ " se emite como "+++ ...": si se la lee como
// encabezado de archivo, el hunk se descarta y el resto del contenido nunca se
// escanea. El cuerpo del hunk es una región cerrada: mientras queden líneas por
// consumir, ninguna línea puede reinterpretarse como encabezado.
function parseHunks(diff) {
  const hunks = [];
  let filePath = null;
  let current = null;
  let pendingAdds = 0;
  let pendingDeletions = 0;
  const flush = () => {
    if (current && current.lines.length) {
      hunks.push({ path: current.path, startLine: current.startLine, text: current.lines.join('\n') });
    }
    current = null;
  };
  for (const line of String(diff).split(/\r?\n/)) {
    if (pendingAdds > 0 || pendingDeletions > 0) {
      const marker = line.charAt(0);
      if (marker === '+') {
        if (current) current.lines.push(line.slice(1));
        pendingAdds -= 1;
      } else if (marker === '-') {
        pendingDeletions -= 1;
      } else if (marker === '\\' || marker === ' ') {
        // `\ No newline at end of file` y contexto: no consumen cuota del hunk.
      } else {
        // Un diff bien formado no llega acá. Si llega, el conteo se
        // desincronizó y no sabemos qué quedó sin mirar: fail-closed.
        throw new Error(`diff: cuerpo de hunk inesperado en ${filePath || '<sin path>'}`);
      }
      continue;
    }
    const header = line.match(HUNK_HEADER);
    if (header) {
      flush();
      pendingDeletions = header[2] === undefined ? 1 : Number(header[2]);
      pendingAdds = header[4] === undefined ? 1 : Number(header[4]);
      if (filePath && pendingAdds > 0) current = { path: filePath, startLine: Number(header[3]), lines: [] };
    } else if (line.startsWith('+++ ')) {
      flush();
      const raw = line.slice(4);
      if (raw === '/dev/null') filePath = null;
      else {
        const decoded = unquoteDiffPath(raw);
        filePath = decoded.startsWith('b/') ? decoded.slice(2) : decoded;
      }
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      // El marcador no trae el path en forma parseable sin ambigüedad (renames,
      // espacios). El path binario lo aporta `--numstat -z` y lo resuelve
      // `resolveBinaryEntries`: acá sólo se cierra el archivo en curso. Este
      // `flush()` NO es un descarte silencioso — ver rev-4 más abajo.
      flush();
      filePath = null;
    }
  }
  flush();
  return hunks;
}

const GIT_BUFFER = 256 * 1024 * 1024;

// #5244 rev-7 — el filtro es por EXCLUSIÓN (`d` minúscula = "todo menos
// borrados"), no por lista blanca. La lista blanca `ACMR` dejaba afuera la letra
// `T` (typechange: symlink<->regular, gitlink<->regular) y ese path desaparecía
// de las DOS salidas de git a la vez —del `-U0` y del `--numstat`—, así que el
// fail-closed de `unexplained` tampoco lo veía: daba VERDE. El vector era real
// hoy: el repo tiene entradas tracked en modo 160000 y pisar una con un archivo
// regular es un `T`, no un alta. Afectaba los dos modos (pre-commit y CI).
// Se invierte el criterio para que el gate no dependa de mantener al día una
// lista de tipos (quedaban afuera también `U`, `X`, `B`). Sólo se excluye `D`:
// un borrado no agrega contenido y, si es binario, `resolveBinaryEntries` no
// podría releer su blob en el head y bloquearía todo PR que borre un binario.
// La mitad de borrado de un typechange sale con `+++ /dev/null` y la descarta
// `parseHunks` sola; la mitad de alta sale con su `@@` y se escanea.
function gitDiff({ mode, base, head = 'HEAD', cwd = process.cwd() }, extraArgs) {
  const range = mode === 'range' ? [`${base}..${head}`] : ['--cached'];
  // #5244 rev-9 — el fallo de git se tipa como GitOperationError igual que en la
  // capa 1. Antes salía como Error pelado de child_process, el catch de `main()`
  // lo trataba como hallazgo y devolvía 1: "no pude correr git" quedaba
  // indistinguible de "encontré un secreto", contra el contrato documentado de
  // exit codes (0/1/2). Sigue bloqueando; lo que cambia es que ahora se puede
  // saber por qué.
  try {
    return execFileSync('git', [
      '-c', 'core.quotePath=false', 'diff', ...range, ...extraArgs, '--diff-filter=d',
      '--no-color', '--no-ext-diff', '--no-textconv',
    ], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_BUFFER,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new GitOperationError(`obtener el diff (${extraArgs.join(' ') || '-U0'})`, error?.status ?? null, detail);
  }
}

// `added\tdeleted\tpath`; en binarios los conteos son `-`.
const NUMSTAT_RECORD = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

// #5244 rev-4 — `--numstat -z` es la fuente confiable de "qué considera binario
// git": separa los campos con NUL, así que no hay C-quoting ni ambigüedad con
// paths que tienen espacios. En renames/copias el path del registro viene vacío
// y los DOS campos siguientes son origen y destino.
function parseNumstat(output) {
  const fields = String(output).split('\0');
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = field.match(NUMSTAT_RECORD);
    if (!match) throw new Error(`numstat: registro inesperado ${JSON.stringify(field)}`);
    let filePath = match[3];
    if (filePath === '') {
      filePath = fields[index + 2];
      index += 2;
      if (filePath === undefined) throw new Error('numstat: rename sin path destino');
    }
    const binary = match[1] === '-';
    records.push({ path: filePath, binary, added: binary ? 0 : Number(match[1]) });
  }
  return records;
}

function readBlob({ mode, head = 'HEAD', cwd = process.cwd() }, filePath) {
  // `<rev>:<path>` y `:0:<path>` resuelven contra la raíz del árbol mientras el
  // path no empiece con `./`, así que no depende del cwd del proceso.
  const spec = mode === 'range' ? `${head}:${filePath}` : `:0:${filePath}`;
  return execFileSync('git', ['show', spec], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_BUFFER,
  });
}

// #5244 rev-4 — un path que git reporta como binario NO se descarta más.
// "Binario" no es un hecho del contenido: git lo decide leyendo el atributo
// `diff` del `.gitattributes` del ÁRBOL DE TRABAJO, y en CI ese árbol es el
// checkout del head, o sea el MISMO commit que trae el secreto. Una línea
// `* -diff` agregada al `.gitattributes` de la raíz apagaba el gate entero, en
// silencio y en los dos modos.
//
// Se decide por CONTENIDO REAL: se relee el blob y, si no tiene NUL, se escanea
// igual (es texto disfrazado). Si tiene NUL es un binario de verdad: se saltea
// —expandirlo con `git diff -a` sólo lo haría chocar contra la guarda NUL de
// `findingFor` y trabaría todo PR con un binario legítimo— pero se ANUNCIA. Un
// salteo nunca puede quedar indistinguible de un PR limpio.
function resolveBinaryEntries(options, records) {
  const entries = [];
  for (const record of records) {
    if (!record.binary) continue;
    let blob;
    try {
      blob = readBlob(options, record.path);
    } catch (error) {
      entries.push({
        path: record.path,
        startLine: 1,
        error: `declarado binario y no se pudo releer el blob: ${error?.message || error}`,
      });
      continue;
    }
    if (blob.includes(0)) {
      entries.push({ path: record.path, skippedBinary: true, bytes: blob.length });
      continue;
    }
    entries.push({
      path: record.path, startLine: 1, text: blob.toString('utf8'), fromBinary: true,
    });
  }
  return entries;
}

function collectAddedHunks({ mode = 'staged', base, head = 'HEAD', cwd = process.cwd() } = {}) {
  if (mode === 'range' && !base) throw new Error('secret-scan: falta --base en modo range');
  const options = { mode, base, head, cwd };
  const hunks = parseHunks(gitDiff(options, ['-U0']));
  const records = parseNumstat(gitDiff(options, ['--numstat', '-z']));
  // Invariante "ningún path queda sin mirar en silencio": si numstat declara
  // líneas agregadas y el parser no produjo un solo hunk para ese path, el diff
  // no se entendió. Fail-closed en vez de verde silencioso.
  const scanned = new Set(hunks.map((hunk) => hunk.path));
  const unexplained = records
    .filter((record) => !record.binary && record.added > 0 && !scanned.has(record.path))
    .map((record) => ({
      path: record.path,
      startLine: 1,
      error: `git declara ${record.added} linea(s) agregada(s) y el diff no produjo hunks: no escaneable (fail-closed)`,
    }));
  return [...hunks, ...resolveBinaryEntries(options, records), ...unexplained];
}

function defaultLintSanitizer(sanitizerPath = DEFAULT_SANITIZER) {
  return createLintSanitizer(require(sanitizerPath));
}

function findingFor(hunk, sanitizer = defaultLintSanitizer()) {
  // #5244 — git detecta binarios mirando los primeros ~8000 bytes: un \0 más
  // allá de ese umbral llega acá como texto. Descartar el hunk dejaba el
  // archivo entero sin escanear (con -U0 un alta es un solo hunk), así que un
  // \0 tardío alcanzaba para colar un secreto. Un hunk no escaneable BLOQUEA;
  // los binarios reales ya salen antes por el marcador `Binary files`.
  if (String(hunk.text).includes('\0')) {
    return { path: hunk.path, line: hunk.startLine, error: 'NUL en el contenido agregado: no es escaneable (fail-closed)' };
  }
  // #5244 rev-2 — escape por línea. Se aplica antes de sanitizar para que el
  // delta de redacciones no vea lo que el dev marcó explícitamente.
  // rev-3 — sobre un path de control la marca NO se honra: el hunk se escanea
  // entero. Las supresiones que sí se honran las anuncia `suppressionsFor`.
  const scannable = isControlPath(hunk.path)
    ? hunk.text
    : stripIgnoredLines(hunk.text, { startLine: hunk.startLine }).text;
  let sanitized;
  try { sanitized = sanitizer(scannable, hunk.path); } catch (error) {
    return { path: hunk.path, line: hunk.startLine, error: error?.message || 'sanitize falló' };
  }
  if (typeof sanitized !== 'string') {
    return { path: hunk.path, line: hunk.startLine, error: 'sanitize devolvió un valor inválido' };
  }
  if (sanitized.startsWith('[SANITIZER_ERROR:')) {
    return { path: hunk.path, line: hunk.startLine, error: 'SANITIZER_ERROR' };
  }
  const before = countRedactions(scannable);
  const after = countRedactions(sanitized);
  const redactions = {};
  for (const [placeholder, count] of Object.entries(after)) {
    const delta = count - (before[placeholder] || 0);
    if (delta > 0) redactions[placeholder] = delta;
  }
  return Object.keys(redactions).length ? { path: hunk.path, line: hunk.startLine, redactions } : null;
}

// #5244 rev-3 — supresiones del hunk, con `honored` según si la marca aplica.
// Existe para que el escape deje de ser invisible: un PR que suprime líneas y
// uno limpio ya no son indistinguibles en el log del job bloqueante de CI.
function suppressionsFor(hunk) {
  const honored = !isControlPath(hunk.path);
  return markedLines(hunk.text, hunk.startLine || 1)
    .map((line) => ({ path: hunk.path, line, honored }));
}

function formatSuppressions(suppressions, format) {
  // CA-UX-4: sin supresiones no se emite un solo byte.
  if (!suppressions.length) return '';
  const detail = ({ honored }) => (honored
    ? `secret-scan: linea suprimida con ${IGNORE_MARKER}`
    : `secret-scan: marca ${IGNORE_MARKER} IGNORADA en path de control; la linea se escanea igual`);
  if (format === 'github') {
    return `${suppressions
      .map((s) => `::warning file=${s.path},line=${s.line}::${detail(s)}`)
      .join('\n')}\n`;
  }
  return `${suppressions.map((s) => `${s.path}:${s.line} — ${detail(s)}`).join('\n')}\n`;
}

// #5244 rev-4 — un binario legítimo se saltea, pero queda anunciado por la
// misma vía que las supresiones. CA-UX-4: sin binarios no se emite un byte.
function formatSkippedBinaries(skipped, format) {
  if (!skipped.length) return '';
  const detail = ({ bytes }) => `secret-scan: binario real (NUL en el contenido, ${bytes} bytes), no escaneado`;
  if (format === 'github') {
    return `${skipped
      .map((s) => `::warning file=${s.path},line=1::${detail(s)}`)
      .join('\n')}\n`;
  }
  return `${skipped.map((s) => `${s.path} — ${detail(s)}`).join('\n')}\n`;
}

// Dos formas de invocación conviven a propósito, porque las escribieron dos
// controles distintos y las dos siguen cableadas en producción:
//   · posicional  `--staged` | `--range BASE HEAD`   → `.husky/pre-commit` y
//     `.github/workflows/runtime-state-guard.yml` (#6111).
//   · con flags   `--mode=range --base=… --head=…`   → el job bloqueante de
//     `security-sast.yml` (#5244), que además pasa `--cwd/--allowlist/
//     --sanitizer/--format`.
// Un argumento desconocido sigue siendo un error: el gate no puede quedarse
// callado porque alguien tipeó mal un flag.
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'staged', cwd: process.cwd(), allowlist: DEFAULT_ALLOWLIST,
    sanitizer: DEFAULT_SANITIZER, format: 'text', head: 'HEAD',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--staged' && rest.length === 0) options.mode = 'staged';
    else if (flag === '--range' && rest.length === 0) {
      options.mode = 'range';
      options.base = argv[index + 1];
      options.head = argv[index + 2];
      if (!options.base || !options.head) throw new Error('secret-scan: --range requiere BASE y HEAD');
      index += 2;
    } else if (flag === '--mode') options.mode = value;
    else if (flag === '--base') options.base = value;
    else if (flag === '--head') options.head = value;
    else if (flag === '--cwd') options.cwd = path.resolve(value);
    else if (flag === '--allowlist') options.allowlist = path.resolve(value);
    else if (flag === '--sanitizer') options.sanitizer = path.resolve(value);
    else if (flag === '--format') options.format = value;
    else throw new Error(`secret-scan: argumento desconocido ${arg}`);
  }
  if (!['staged', 'range'].includes(options.mode)) throw new Error(`secret-scan: modo inválido ${options.mode}`);
  if (!['text', 'github'].includes(options.format)) throw new Error(`secret-scan: formato inválido ${options.format}`);
  return options;
}

function formatFindings(findings, format) {
  if (format === 'github') {
    return `${findings.map((finding) => {
      const detail = finding.error || Object.entries(finding.redactions)
        .map(([placeholder, count]) => `${placeholder} x${count}`).join(', ');
      return `::error file=${finding.path},line=${finding.line || 1}::BLOQUEADO: secreto detectado (${detail})`;
    }).join('\n')}\n`;
  }
  const lines = findings.map((finding) => {
    const detail = finding.error || Object.entries(finding.redactions)
      .map(([placeholder, count]) => `${placeholder} x${count}`).join(', ');
    return `${finding.path}:${finding.line || 1} — BLOQUEADO: ${detail} (${isSensitive(finding.path) || 'contenido staged'})`;
  });
  lines.push('',
    `Revisá el contenido agregado. Si esa línea es un falso positivo, marcala`,
    `con "${IGNORE_MARKER}" en la misma línea. Si es un archivo entero`,
    'sin secretos, agregá ese path o un glob específico a',
    '.pipeline/secret-scan-allowlist.json.',
    'El mismo control corre de forma bloqueante en CI; --no-verify no lo evita.');
  return `${lines.join('\n')}\n`;
}

function run(options, dependencies = {}) {
  const collect = dependencies.collectAddedHunks || collectAddedHunks;
  const sanitizer = dependencies.sanitize || defaultLintSanitizer(options.sanitizer || DEFAULT_SANITIZER);
  const allowlist = loadAllowlist(options.allowlist, { strict: true });
  const findings = [];
  const suppressions = [];
  const skippedBinaries = [];
  for (const hunk of collect(options)) {
    if (whichAllowlistEntry(hunk.path, allowlist)) continue;
    if (hunk.skippedBinary) { skippedBinaries.push(hunk); continue; }
    if (hunk.error) {
      findings.push({ path: hunk.path, line: hunk.startLine || 1, error: hunk.error });
      continue;
    }
    suppressions.push(...suppressionsFor(hunk));
    const finding = findingFor(hunk, sanitizer);
    if (finding) findings.push(finding);
  }
  // Ni las supresiones ni los binarios salteados cambian el exit code (CA-8d: un
  // lint que frena por un escape legítimo se desactiva). Sí cambian la salida:
  // quedan anunciados.
  const warnings = `${formatSuppressions(suppressions, options.format)}${formatSkippedBinaries(skippedBinaries, options.format)}`;
  const common = { findings: [], suppressions, skippedBinaries, warnings };
  return findings.length
    ? {
      ...common, exitCode: 1, output: formatFindings(findings, options.format), findings,
    }
    : { ...common, exitCode: 0, output: '' };
}

// Las dos capas corren siempre y cada una escribe su propio reporte. Ninguna
// puede saltear a la otra: si la capa 1 cortara ante un path del inventario, un
// `.env` con una AWS key adentro se reportaría sólo como "path que no puede
// estar trackeado" y el secreto quedaría sin nombrar.
//
// Exit codes:
//   0 → limpio.
//   1 → hallazgo de cualquiera de las dos capas, o entrada no escaneable
//       (fail-closed: preferimos frenar antes que dar verde sin haber mirado).
//   2 → fallo TÉCNICO de git, en CUALQUIERA de las dos capas (#5244 rev-9: la
//       capa 2 lo devolvía como 1 por su catch genérico, y el contrato quedaba
//       escrito pero no cumplido). Se distingue de 1 a propósito: "no pude
//       correr" no es lo mismo que "encontré algo". Los dos bloquean —
//       `.husky/pre-commit` y el job de CI cortan con cualquier exit != 0 —;
//       lo que cambia es qué tiene que ir a mirar el operador.
function main(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--capabilities')) {
    process.stdout.write(`${CAPABILITIES_LINE}\n`);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`secret-scan BLOQUEADO: ${error?.message || error}\n`);
    return 1;
  }

  // Capa 1 — paths sensibles del inventario.
  let inventoryFindings;
  try {
    inventoryFindings = collectFindings({ ...parsed, ...options });
  } catch (error) {
    const operation = error instanceof GitOperationError ? ` operación=${error.operation}` : '';
    process.stderr.write(`Guardrail bloqueado por fallo técnico de Git:${operation} detalle=${error.message}\n`);
    return 2;
  }
  if (inventoryFindings.length) {
    process.stderr.write(formatInventoryFindings(inventoryFindings, parsed.format));
  }

  // Capa 2 — secretos en el contenido agregado.
  let result;
  try {
    result = run(parsed, options);
  } catch (error) {
    // #5244 rev-9 — un fallo TÉCNICO de git en la capa 2 sale 2, igual que en la
    // capa 1. Las dos bloquean; el código es lo que le dice al operador si tiene
    // que buscar un secreto o arreglar su checkout.
    if (error instanceof GitOperationError) {
      process.stderr.write(`Guardrail bloqueado por fallo técnico de Git: operación=${error.operation} detalle=${error.message}\n`);
      return 2;
    }
    process.stderr.write(`secret-scan BLOQUEADO: ${error?.message || error}\n`);
    return 1;
  }
  if (result.warnings) process.stderr.write(result.warnings);
  if (result.output) process.stderr.write(result.output);
  return inventoryFindings.length ? 1 : result.exitCode;
}

if (require.main === module) process.exit(main());
module.exports = {
  CAPABILITIES_LINE, DEFAULT_ALLOWLIST, DEFAULT_SANITIZER, GitOperationError, IGNORE_MARKER,
  SCAN_PROTOCOL, SENSITIVE_PATTERNS, collectAddedHunks, collectFindings, countRedactions,
  defaultLintSanitizer, findingFor, formatFindings, formatInventoryFindings,
  formatSkippedBinaries, formatSuppressions, isSensitive, main, parseArgs, parseHunks,
  parseNumstat, readBlob, resolveBinaryEntries, run, suppressionsFor, unquoteDiffPath,
  __forTestsOnly__: {
    runGit, parseNameStatusZ, listChanges, readStagedContent, parseArgs,
  },
};
