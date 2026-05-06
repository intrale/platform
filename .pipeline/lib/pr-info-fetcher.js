// =============================================================================
// pr-info-fetcher.js — Helper para consultar el estado del PR vinculado a un
// issue invocando `gh pr list`. Extraído de pulpo.js (#3030) para tener
// pruebas determinísticas con un `runner` inyectable.
//
// Convenciones del proyecto:
//   - Las ramas de agentes son `agent/<issue>-<slug>`. Buscamos por
//     `head:agent/<issue>-` para evitar falsos positivos por número en título
//     (ej. "feat: limita 3030 productos" no debería matchear el issue 3030).
//   - El PR puede estar en cualquier estado (`open`/`merged`/`closed`).
//
// Seguridad (CA-11..CA-14):
//   - Validación de entrada: número entero positivo. Si no lo es → null sin
//     ejecutar `gh`.
//   - spawnSync con array de argumentos (no shell-string), elimina superficie
//     de inyección.
//   - Timeout 5s real (mata el proceso si cuelga). El default `timeout` de
//     spawnSync envía SIGTERM al hijo cuando expira → evita FDs colgados.
//   - JSON.parse en try/catch — JSON malformado o stdout vacío → fallback.
// =============================================================================
'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 5;
const FIELDS = [
  'number',
  'state',
  'mergedAt',
  'mergeCommit',
  'url',
  'statusCheckRollup',
  'reviewDecision',
  'updatedAt',
  'headRefName',
  'title',
].join(',');

/**
 * Consulta el estado del PR asociado al issue.
 *
 * @param {number|string} issue Número del issue.
 * @param {object} [options]
 * @param {string} [options.ghBin] Path al binario gh. Default: env GH_BIN o 'gh'.
 * @param {string} [options.cwd] Working directory. Default: process.cwd().
 * @param {number} [options.timeoutMs] Timeout en ms para `gh`. Default: 5000.
 * @param {Function} [options.runner] Inyectable para tests; firma idéntica a
 *   `child_process.spawnSync(cmd, args, opts)`. Devuelve `{ status, stdout, stderr, error? }`.
 * @returns {object|null} prInfo parseado, o `null` si no hay PR detectable, o
 *   `{ error: true }` si gh falló / timeout / JSON malformado.
 */
function fetchPrInfoForIssue(issue, options) {
  const opts = options || {};

  // CA-11 — validación de entrada antes de invocar gh.
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return null;

  const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runner = typeof opts.runner === 'function' ? opts.runner : spawnSync;

  // Buscamos por head branch prefix para usar la convención agent/<issue>-<slug>.
  // El guion final evita matchear agent/30300-... cuando issue=3030.
  const args = [
    'pr',
    'list',
    '--search',
    `head:agent/${n}-`,
    '--state',
    'all',
    '--limit',
    String(DEFAULT_LIMIT),
    '--json',
    FIELDS,
  ];

  let result;
  try {
    result = runner(ghBin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
    });
  } catch (e) {
    return { error: true, reason: 'spawn_failed', message: e && e.message };
  }

  if (!result) return { error: true, reason: 'no_result' };
  // CA-14 — timeout real. spawnSync setea result.error.code === 'ETIMEDOUT'
  // (o status null + signal 'SIGTERM') cuando excede el timeout.
  if (result.error) return { error: true, reason: 'spawn_error', message: result.error.message };
  if (result.status !== 0) {
    return { error: true, reason: 'non_zero_exit', exit: result.status, stderr: (result.stderr || '').slice(0, 200) };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (e) {
    return { error: true, reason: 'json_parse_failed', message: e.message };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  // Filtrar matches estrictos por convención de branch (defensa contra futuras
  // queries más laxas) y elegir el más reciente.
  const prefix = `agent/${n}-`;
  const strict = parsed.filter((p) => p && typeof p.headRefName === 'string' && p.headRefName.startsWith(prefix));
  const candidates = strict.length > 0 ? strict : parsed;
  candidates.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return candidates[0];
}

module.exports = {
  fetchPrInfoForIssue,
  DEFAULT_TIMEOUT_MS,
  __FIELDS: FIELDS,
};
