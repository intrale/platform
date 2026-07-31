#!/usr/bin/env node
'use strict';

// Escanea líneas agregadas, agrupadas por hunk para conservar secretos
// multilínea. El mismo entrypoint sirve al pre-commit y a CI.
//
// #5244 rev-2 — el criterio de bloqueo NO es `sanitize()` completo. `sanitize()`
// es modo REDACCIÓN (sobre-redactar cuesta cero); acá es modo LINT (sobre-redactar
// frena al dev). `secret-scan-lint.js` separa los dos conjuntos de patrones y
// agrega el escape por línea `secret-scan:ignore`. Ver su cabecera.
const path = require('path');
const { execFileSync } = require('child_process');
const { isControlPath, loadAllowlist, whichAllowlistEntry } = require('./secret-allowlist');
const { IGNORE_MARKER, createLintSanitizer, markedLines, stripIgnoredLines } = require('./secret-scan-lint');

const DEFAULT_ALLOWLIST = path.join(__dirname, '..', 'secret-scan-allowlist.json');
const DEFAULT_SANITIZER = path.join(__dirname, '..', 'sanitizer.js');
// Protocolo declarado por `--capabilities`. CI lo usa para decidir si el
// scanner del árbol base entiende `--mode=range`: un scanner viejo ignora los
// flags y termina en 0 sin mirar nada, así que "el archivo existe" no alcanza.
// Bumpear sólo si cambia el contrato de flags de forma incompatible.
const SCAN_PROTOCOL = 'range-v1';
const CAPABILITIES_LINE = `secret-scan-protocol=${SCAN_PROTOCOL}`;
const SENSITIVE_PATTERNS = [
  { name: 'commander-session', test: (p) => p === '.pipeline/commander-session.json' },
  { name: 'commander-history', test: (p) => p === '.pipeline/commander-history.jsonl' },
  { name: 'servicios-state', test: (p) => p.startsWith('.pipeline/servicios/') && p.endsWith('.json') },
];

function isSensitive(filePath) {
  return SENSITIVE_PATTERNS.find(({ test }) => test(filePath))?.name || 'contenido staged';
}

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
      flush();
      filePath = null;
    }
  }
  flush();
  return hunks;
}

function collectAddedHunks({ mode = 'staged', base, head = 'HEAD', cwd = process.cwd() } = {}) {
  if (mode === 'range' && !base) throw new Error('secret-scan: falta --base en modo range');
  const diffArgs = mode === 'range' ? ['diff', `${base}..${head}`] : ['diff', '--cached'];
  const output = execFileSync('git', [
    '-c', 'core.quotePath=false', ...diffArgs, '-U0', '--diff-filter=ACMR',
    '--no-color', '--no-ext-diff', '--no-textconv',
  ], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseHunks(output);
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

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'staged', cwd: process.cwd(), allowlist: DEFAULT_ALLOWLIST,
    sanitizer: DEFAULT_SANITIZER, format: 'text', head: 'HEAD',
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--mode') options.mode = value;
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
    return `${finding.path}:${finding.line || 1} — BLOQUEADO: ${detail} (${isSensitive(finding.path)})`;
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
  for (const hunk of collect(options)) {
    if (whichAllowlistEntry(hunk.path, allowlist)) continue;
    suppressions.push(...suppressionsFor(hunk));
    const finding = findingFor(hunk, sanitizer);
    if (finding) findings.push(finding);
  }
  // Las supresiones NO cambian el exit code (CA-8d: un lint que frena por un
  // escape legítimo se desactiva). Sí cambian la salida: quedan anunciadas.
  const warnings = formatSuppressions(suppressions, options.format);
  return findings.length
    ? { exitCode: 1, output: formatFindings(findings, options.format), findings, suppressions, warnings }
    : { exitCode: 0, output: '', findings: [], suppressions, warnings };
}

function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes('--capabilities')) {
      process.stdout.write(`${CAPABILITIES_LINE}\n`);
      return 0;
    }
    const result = run(parseArgs(argv));
    if (result.warnings) process.stderr.write(result.warnings);
    if (result.output) process.stderr.write(result.output);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`secret-scan BLOQUEADO: ${error?.message || error}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = {
  CAPABILITIES_LINE, DEFAULT_ALLOWLIST, DEFAULT_SANITIZER, IGNORE_MARKER, SCAN_PROTOCOL,
  SENSITIVE_PATTERNS, collectAddedHunks, countRedactions, defaultLintSanitizer, findingFor,
  formatFindings, formatSuppressions, isSensitive, main, parseArgs, parseHunks, run,
  suppressionsFor, unquoteDiffPath,
};
