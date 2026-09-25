// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// exceptions-diff.js — Aprobación humana de excepciones nuevas (#7592, D1)
//
// Si un PR agrega o modifica una excepción de config/licenses/policy.json
// respecto de la rama base, el gate falla salvo que el PR tenga el label
// `licencias:excepcion-aprobada`. Ese label lo aplica SÓLO un humano: ningún
// agente ni skill del pipeline lo pone (lo verifica un test estático).
//
// Los labels se leen EN RUNTIME por API (no del payload del evento), así el
// workflow no necesita el trigger `labeled`: aplicado el label, se re-corre el
// job fallido (`gh run rerun --failed`). Ver docs/legal/licencias-terceros.md.
//
// Fail-closed: si hay excepciones cambiadas y no se pueden leer los labels, o
// la rama base no está disponible, el gate falla.
// =============================================================================
'use strict';

const nodeFs = require('fs');

const APPROVAL_LABEL = 'licencias:excepcion-aprobada';
const POLICY_PATH = 'config/licenses/policy.json';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Excepciones del HEAD que no existen (idénticas) en la base. */
function diffExceptions(baseExceptions, headExceptions) {
  const base = new Set((Array.isArray(baseExceptions) ? baseExceptions : []).map(canonical));
  return (Array.isArray(headExceptions) ? headExceptions : []).filter((e) => !base.has(canonical(e)));
}

/**
 * Lee los labels del PR actual con la API de GitHub. Usa `pull-requests: read`
 * (ya otorgado por el workflow) vía `${{ github.token }}`, nunca `secrets.`.
 */
async function fetchPrLabelsFromEnv({ env = process.env, fs = nodeFs, fetchImpl = globalThis.fetch } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!repo || !token || !eventPath) {
    throw new Error('faltan GITHUB_REPOSITORY, GITHUB_TOKEN o GITHUB_EVENT_PATH para leer los labels del PR');
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const number = event && event.pull_request && event.pull_request.number;
  if (!Number.isInteger(number)) throw new Error('el evento no es un pull_request: no hay labels que leer');
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`la API de GitHub respondió ${res.status} al leer el PR #${number}`);
  const body = await res.json();
  return (Array.isArray(body.labels) ? body.labels : []).map((l) => (l && l.name) || '').filter(Boolean);
}

/**
 * @param {object} opts
 * @param {object} opts.headPolicy
 * @param {string|null} opts.baseRef       rama base del PR (null en schedule/push/manual)
 * @param {(args: string[]) => string} opts.execGit
 * @param {() => Promise<string[]>} opts.fetchLabels
 * @returns {Promise<{ status: 'skipped'|'unchanged'|'approved'|'rejected', changed: object[], findings: object[], note: string }>}
 */
async function checkExceptionApproval({ headPolicy, baseRef, execGit, fetchLabels }) {
  if (!baseRef) {
    return { status: 'skipped', changed: [], findings: [], note: 'sin rama base (schedule, push o corrida manual): no hay excepciones que comparar' };
  }
  const ref = `origin/${baseRef}`;
  try {
    execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return {
      status: 'rejected',
      changed: [],
      findings: [{
        type: 'EXCEPCIÓN SIN APROBAR',
        coordinate: POLICY_PATH,
        detail: `no está disponible ${ref} para comparar las excepciones (¿checkout sin fetch-depth: 0?)`,
        action: 'Revisá el checkout del job check-licenses',
      }],
      note: '',
    };
  }

  let baseExceptions = [];
  let note = '';
  try {
    const text = execGit(['show', `${ref}:${POLICY_PATH}`]);
    const basePolicy = JSON.parse(text);
    baseExceptions = Array.isArray(basePolicy.exceptions) ? basePolicy.exceptions : [];
  } catch {
    note = `la base no tiene ${POLICY_PATH}: todas las excepciones cuentan como nuevas`;
  }

  const changed = diffExceptions(baseExceptions, headPolicy.exceptions);
  if (changed.length === 0) return { status: 'unchanged', changed, findings: [], note: note || 'sin excepciones nuevas ni modificadas' };

  let labels;
  try {
    labels = await fetchLabels();
  } catch (e) {
    return {
      status: 'rejected',
      changed,
      findings: [{
        type: 'EXCEPCIÓN SIN APROBAR',
        coordinate: POLICY_PATH,
        detail: `hay ${changed.length} excepción(es) nueva(s) o modificada(s) y no se pudieron leer los labels del PR: ${e.message}`,
        action: `Un humano aplica el label ${APPROVAL_LABEL} y re-corre el job (gh run rerun --failed)`,
      }],
      note,
    };
  }
  if (labels.includes(APPROVAL_LABEL)) {
    return { status: 'approved', changed, findings: [], note: `excepciones aprobadas con el label ${APPROVAL_LABEL}` };
  }
  return {
    status: 'rejected',
    changed,
    findings: changed.map((exc) => ({
      type: 'EXCEPCIÓN SIN APROBAR',
      coordinate: (exc && exc.paquete) || '(excepción sin paquete)',
      detail: 'excepción nueva o modificada respecto de la base, sin aprobación humana',
      action: `Un humano aplica el label ${APPROVAL_LABEL} y re-corre el job (gh run rerun --failed)`,
    })),
    note,
  };
}

module.exports = {
  APPROVAL_LABEL,
  POLICY_PATH,
  canonical,
  checkExceptionApproval,
  diffExceptions,
  fetchPrLabelsFromEnv,
};
