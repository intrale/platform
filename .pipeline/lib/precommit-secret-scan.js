#!/usr/bin/env node
'use strict';

// Escanea líneas agregadas, agrupadas por hunk para conservar secretos
// multilínea. El mismo entrypoint sirve al pre-commit y a CI.
const path = require('path');
const { execFileSync } = require('child_process');
const { loadAllowlist, whichAllowlistEntry } = require('./secret-allowlist');

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

function parseHunks(diff) {
  const hunks = [];
  let filePath = null;
  let current = null;
  const flush = () => {
    if (current && current.lines.length) {
      const text = current.lines.join('\n');
      if (!text.includes('\0')) hunks.push({ path: current.path, startLine: current.startLine, text });
    }
    current = null;
  };
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
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
    } else {
      const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) {
        flush();
        if (filePath) current = { path: filePath, startLine: Number(header[1]), lines: [] };
      } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
        current.lines.push(line.slice(1));
      }
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

function findingFor(hunk, sanitizer = require(DEFAULT_SANITIZER).sanitize) {
  let sanitized;
  try { sanitized = sanitizer(hunk.text); } catch (error) {
    return { path: hunk.path, line: hunk.startLine, error: error?.message || 'sanitize falló' };
  }
  if (typeof sanitized !== 'string') {
    return { path: hunk.path, line: hunk.startLine, error: 'sanitize devolvió un valor inválido' };
  }
  if (sanitized.startsWith('[SANITIZER_ERROR:')) {
    return { path: hunk.path, line: hunk.startLine, error: 'SANITIZER_ERROR' };
  }
  const before = countRedactions(hunk.text);
  const after = countRedactions(sanitized);
  const redactions = {};
  for (const [placeholder, count] of Object.entries(after)) {
    const delta = count - (before[placeholder] || 0);
    if (delta > 0) redactions[placeholder] = delta;
  }
  return Object.keys(redactions).length ? { path: hunk.path, line: hunk.startLine, redactions } : null;
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
  lines.push('', 'Revisá el contenido agregado. Si es un falso positivo, agregá sólo',
    'ese path o un glob específico a .pipeline/secret-scan-allowlist.json.',
    'El mismo control corre de forma bloqueante en CI; --no-verify no lo evita.');
  return `${lines.join('\n')}\n`;
}

function run(options, dependencies = {}) {
  const collect = dependencies.collectAddedHunks || collectAddedHunks;
  const sanitizer = dependencies.sanitize || require(options.sanitizer || DEFAULT_SANITIZER).sanitize;
  const allowlist = loadAllowlist(options.allowlist, { strict: true });
  const findings = [];
  for (const hunk of collect(options)) {
    if (whichAllowlistEntry(hunk.path, allowlist)) continue;
    const finding = findingFor(hunk, sanitizer);
    if (finding) findings.push(finding);
  }
  return findings.length
    ? { exitCode: 1, output: formatFindings(findings, options.format), findings }
    : { exitCode: 0, output: '', findings: [] };
}

function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes('--capabilities')) {
      process.stdout.write(`${CAPABILITIES_LINE}\n`);
      return 0;
    }
    const result = run(parseArgs(argv));
    if (result.output) process.stderr.write(result.output);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`secret-scan BLOQUEADO: ${error?.message || error}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = {
  CAPABILITIES_LINE, DEFAULT_ALLOWLIST, DEFAULT_SANITIZER, SCAN_PROTOCOL, SENSITIVE_PATTERNS,
  collectAddedHunks, countRedactions, findingFor, formatFindings, isSensitive, main, parseArgs,
  parseHunks, run, unquoteDiffPath,
};
