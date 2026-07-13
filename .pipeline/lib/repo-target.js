'use strict';

// =============================================================================
// repo-target.js — Fuente de verdad única del repo destino del pipeline (CA-0)
//
// Issue #4693 (P0-A del split de #4685 · Ola Puente — self-hosting del kernel).
//
// Helper PURO, sin efectos de I/O más allá de leer `pipeline.config.json` (config
// estática, NUNCA input de runtime — REQ-SEC-3). Reemplaza las fuentes de verdad
// divergentes previas (`config.yaml github:`, `DEFAULT_REPO`, ~12 literales
// `intrale/platform` en pulpo.js) por un único lector.
//
// La allowlist NO es cosmética: es la frontera de confianza. Sumar un repo a la
// allowlist = otorgarle confianza de ejecución de código con el token del
// pipeline. Por eso todo acá es fail-closed / default-deny (REQ-SEC-1).
//
// Contrato:
//   getIntakeRepos([configOverride])  → string[]  repos a consultar en el intake
//   getRepoForIssue(issue[, cfg])      → string    repo de origen propagado
//   isRepoAllowed(repo[, cfg])         → boolean   default-deny fail-closed
//   getPrimaryRepo([configOverride])   → string    repo primario (fallback)
//   getDefaultBaseRef([configOverride])→ string    ref base por default (merge/PR)
//
// Testeable con `node --test` sin infra: todas las funciones aceptan un
// `configOverride` opcional (objeto) para inyectar fixtures.
// =============================================================================

const fs = require('fs');
const path = require('path');

// pipeline.config.json vive en la raíz del repo (../../ desde .pipeline/lib/).
const CONFIG_PATH = path.join(__dirname, '..', '..', 'pipeline.config.json');

// REQ-SEC-2 — forma canónica `owner/repo` de GitHub. Owner ≤ 39 chars, repo ≤ 100.
// Sólo alfanumérico + `.`, `_`, `-`. Rechaza espacios, `;`, `--flag`, `/../`, etc.
const REPO_RE = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Fallback de último recurso si la config está ausente/rota (fail-closed a primary).
const FALLBACK_PRIMARY = 'intrale/platform';

// REQ-SEC-4 — normalizar SIEMPRE ambos lados de la comparación (owner GitHub es
// case-insensitive). Comparar sólo un lado abre falso-negativo Y bypass.
function norm(r) {
  return String(r == null ? '' : r).trim().toLowerCase();
}

// REQ-SEC-2 — validar la forma ANTES de interpolar en cualquier comando/path.
function isValidRepo(r) {
  return REPO_RE.test(String(r == null ? '' : r).trim());
}

// Lee y parsea pipeline.config.json. Devuelve null si falta o está corrupto
// (fail-closed en los callers, nunca crash-open).
function loadConfig(configOverride) {
  if (configOverride && typeof configOverride === 'object') return configOverride;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Núcleo: parsea y sanea el bloque `repos`. TODO es fail-closed:
//   - primary inválido/ausente          → FALLBACK_PRIMARY
//   - allowlist ausente/vacía/malformada → primary-only (nunca allow-all)
//   - intake ausente                     → = allowlist
//   - intake siempre ∩ allowlist         → intake no puede ampliar la confianza
//   - default_base_ref ausente/vacío     → 'main'
//
// Devuelve { primary, allowSet:Set<string>, intake:string[], defaultBaseRef }.
// Todos los repos vienen ya normalizados (lowercase) y validados.
function parseRepos(configOverride) {
  const cfg = loadConfig(configOverride);
  const repos = (cfg && typeof cfg.repos === 'object' && cfg.repos) ? cfg.repos : {};

  // primary
  let primary = norm(repos.primary);
  if (!isValidRepo(primary)) primary = FALLBACK_PRIMARY;

  // allowlist — sólo entradas con forma válida entran al set.
  const rawAllow = Array.isArray(repos.allowlist) ? repos.allowlist : [];
  const allowSet = new Set();
  for (const r of rawAllow) {
    if (isValidRepo(r)) allowSet.add(norm(r));
  }
  // Fail-closed: allowlist vacía/malformada ⇒ primary-only (nunca allow-all).
  if (allowSet.size === 0) allowSet.add(primary);
  // El primary siempre es confiable (invariante de consistencia).
  allowSet.add(primary);

  // intake (opcional). Default = allowlist completa. SIEMPRE se intersecta con
  // allowlist: intake jamás amplía la confianza más allá de lo allowlisted.
  let intake;
  if (Array.isArray(repos.intake) && repos.intake.length > 0) {
    intake = repos.intake
      .map(norm)
      .filter((r) => isValidRepo(r) && allowSet.has(r));
    // dedup preservando orden
    intake = [...new Set(intake)];
  } else {
    intake = [...allowSet];
  }
  // Fail-closed: si el filtrado dejó intake vacío ⇒ primary-only.
  if (intake.length === 0) intake = [primary];

  // default_base_ref
  const rawRef = typeof repos.default_base_ref === 'string' ? repos.default_base_ref.trim() : '';
  const defaultBaseRef = rawRef || 'main';

  return { primary, allowSet, intake, defaultBaseRef };
}

// CA-A1 — repos que el intake debe consultar (con `--repo <r>`). Siempre ⊆ allowlist.
function getIntakeRepos(configOverride) {
  return parseRepos(configOverride).intake;
}

// CA-A3 / REQ-SEC-1..4 — default-deny. Repo ausente/vacío/malformado/no-listado ⇒ false.
// Normaliza casing en ambos lados. Valida la forma antes de comparar.
function isRepoAllowed(repo, configOverride) {
  if (!isValidRepo(repo)) return false; // REQ-SEC-2: forma válida primero.
  return parseRepos(configOverride).allowSet.has(norm(repo));
}

// CA-A2 — resuelve el repo de origen propagado del issue. `issue` puede ser:
//   - objeto con `.origin_repo` / `.repo` / `.repository`
//   - string 'owner/repo'
// Fail-closed: si no hay repo propagado válido y allowlisted ⇒ primary.
function getRepoForIssue(issue, configOverride) {
  let candidate = null;
  if (issue && typeof issue === 'object') {
    candidate = issue.origin_repo || issue.repo || issue.repository || null;
  } else if (typeof issue === 'string') {
    candidate = issue;
  }
  if (candidate && isValidRepo(candidate) && isRepoAllowed(candidate, configOverride)) {
    return norm(candidate);
  }
  return parseRepos(configOverride).primary;
}

// Repo primario (fallback canónico). Reemplaza `DEFAULT_REPO`.
function getPrimaryRepo(configOverride) {
  return parseRepos(configOverride).primary;
}

// Ref base por default para merge/PR (default_base_ref). Reemplaza literales 'main'.
function getDefaultBaseRef(configOverride) {
  return parseRepos(configOverride).defaultBaseRef;
}

module.exports = {
  getIntakeRepos,
  getRepoForIssue,
  isRepoAllowed,
  getPrimaryRepo,
  getDefaultBaseRef,
  // Exportados para tests de frontera (no para consumo de producción):
  _internals: { REPO_RE, norm, isValidRepo, parseRepos },
};
