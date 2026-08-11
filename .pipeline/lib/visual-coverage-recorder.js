'use strict';

// #5708: persiste la cobertura de una pasada visual aprobada desde el camino
// real de cierre del Pulpo. El rejection report sólo existe para rechazos, por
// lo que acoplar el store a ese proceso dejaba toda aprobación sin baseline.

const fs = require('fs');
const path = require('path');
const visualCoverageStore = require('./visual-coverage-store');

function recordApprovedCoverage({ root, issue, skill, fase, data, baseDir } = {}) {
  if (skill !== 'qa' || fase !== 'verificacion' || !data || data.resultado !== 'aprobado') {
    return { written: false, reason: 'no-aplica' };
  }

  const rev = Number(data.rebote_numero) || 0;
  const evidenceDir = baseDir || path.join(root, 'qa', 'evidence', String(issue));
  const contractPath = path.join(evidenceDir, 'visual-comparison.json');
  let contract;
  try {
    const stat = fs.lstatSync(contractPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { written: false, reason: 'contrato-invalido' };
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    return { written: false, reason: error && error.code === 'ENOENT' ? 'sin-contrato' : 'contrato-invalido' };
  }

  if (!contract || contract.verdict !== 'approved') return { written: false, reason: 'veredicto-no-aprobado' };
  if (Number(contract.rev) !== rev) return { written: false, reason: 'rev-no-coincide' };
  if (!contract.coverage || !Array.isArray(contract.coverage.verificadas)) {
    return { written: false, reason: 'cobertura-invalida' };
  }

  return visualCoverageStore.writeCoverage({
    issue,
    rev,
    coverage: contract.coverage,
    diffs: [],
    baseDir: evidenceDir,
  });
}

module.exports = { recordApprovedCoverage };
