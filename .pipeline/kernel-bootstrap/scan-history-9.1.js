// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Escaneo de secretos de historia completa para la migración del motor al
// repositorio del kernel (Ola 9.1 · #4663).

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const { sanitize } = require('../sanitizer');
const { globToRe, loadAllowlist, isAllowlisted } = require('../lib/secret-allowlist');

function listBlobs(repoDir) {
  const objects = execSync('git rev-list --objects --all', {
    cwd: repoDir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  }).split('\n').filter(Boolean);

  const shaToPath = new Map();
  for (const line of objects) {
    const separator = line.indexOf(' ');
    if (separator === -1) continue;
    const sha = line.slice(0, separator);
    if (!shaToPath.has(sha)) shaToPath.set(sha, line.slice(separator + 1));
  }

  const shas = [...shaToPath.keys()];
  const check = execSync('git cat-file --batch-check="%(objecttype) %(objectname)"', {
    cwd: repoDir, encoding: 'utf8', input: shas.join('\n'), maxBuffer: 256 * 1024 * 1024,
  }).split('\n').filter(Boolean);

  const blobs = [];
  for (const line of check) {
    const [type, sha] = line.split(' ');
    if (type === 'blob') blobs.push({ sha, path: shaToPath.get(sha) });
  }
  return blobs;
}

function scanHistory(repoDir, allow) {
  allow = allow || { paths: new Set(), globs: [] };
  const blobs = listBlobs(repoDir);
  const hits = [];
  const adjudicated = [];
  for (const { sha, path: filePath } of blobs) {
    let raw;
    let output;
    try {
      raw = execFileSync('git', ['cat-file', 'blob', sha], {
        cwd: repoDir, maxBuffer: 128 * 1024 * 1024,
      }).toString('utf8');
    } catch (error) {
      hits.push({
        sha, path: filePath,
        reason: `no se pudo leer el blob: ${error?.message || 'unknown'}`,
      });
      continue;
    }
    try {
      output = sanitize(raw);
    } catch (error) {
      hits.push({
        sha, path: filePath,
        reason: `sanitize() tiró: ${error?.message || 'unknown'}`,
      });
      continue;
    }
    if (typeof output === 'string' && output.startsWith('[SANITIZER_ERROR')) {
      hits.push({
        sha, path: filePath,
        reason: `sanitizer error interno (${output.slice(0, 60)})`,
      });
      continue;
    }
    if (output !== raw) {
      const record = { sha, path: filePath, reason: 'patrón de secreto redactado' };
      if (isAllowlisted(filePath, allow)) adjudicated.push(record);
      else hits.push(record);
    }
  }
  return { blobCount: blobs.length, hits, adjudicated };
}

function assertClean(repoDir, allowFile) {
  const allow = loadAllowlist(allowFile);
  const { blobCount, hits, adjudicated } = scanHistory(repoDir, allow);
  if (hits.length) {
    const lines = hits
      .map((hit) => `  - ${hit.path} @ ${hit.sha.slice(0, 10)} :: ${hit.reason}`)
      .join('\n');
    throw new Error(
      `Secretos NO adjudicados en la historia (${hits.length} blob(s))`
      + ` — cutover BLOQUEADO:\n${lines}`,
    );
  }
  return { blobCount, adjudicated: adjudicated.length };
}

module.exports = {
  listBlobs, scanHistory, assertClean, loadAllowlist, isAllowlisted, globToRe,
};

if (require.main === module) {
  const repoDir = process.argv[2] || process.cwd();
  const allowFile = process.argv[3] || null;
  try {
    const { blobCount, adjudicated } = assertClean(path.resolve(repoDir), allowFile);
    console.log(
      `OK — ${blobCount} blob(s) de historia completa escaneados;`
      + ` cero hallazgos reales (${adjudicated} match(es) adjudicados).`,
    );
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
