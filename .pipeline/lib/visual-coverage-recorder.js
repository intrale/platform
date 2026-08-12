'use strict';

// #5708: persiste la cobertura de una pasada visual aprobada desde el camino
// real de cierre del Pulpo. El rejection report sólo existe para rechazos, por
// lo que acoplar el store a ese proceso dejaba toda aprobación sin baseline.

const fs = require('fs');
const path = require('path');
const visualCoverageStore = require('./visual-coverage-store');
const {
  MAX_VISUAL_JSON_BYTES,
  MAX_VISUAL_COVERAGE_SECTIONS,
  MAX_VISUAL_SECTION_BYTES,
} = require('./visual-contract-limits');

function reject(reason, detail) {
  console.error(`[visual-coverage] contrato rechazado (${reason}): ${detail}`);
  return { written: false, reason, detail };
}

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
    if (stat.size > MAX_VISUAL_JSON_BYTES) {
      return reject('contrato-oversize', `${stat.size} B > MAX_VISUAL_JSON_BYTES ${MAX_VISUAL_JSON_BYTES}`);
    }
    const realEvidenceDir = fs.realpathSync(evidenceDir);
    const realContractPath = fs.realpathSync(contractPath);
    if (!realContractPath.startsWith(realEvidenceDir + path.sep)) {
      return reject('contrato-fuera-de-evidencia', realContractPath);
    }
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    return { written: false, reason: error && error.code === 'ENOENT' ? 'sin-contrato' : 'contrato-invalido' };
  }

  if (!contract || contract.verdict !== 'approved') return { written: false, reason: 'veredicto-no-aprobado' };
  if (Number(contract.rev) !== rev) return { written: false, reason: 'rev-no-coincide' };
  if (!contract.coverage || !Array.isArray(contract.coverage.verificadas)) {
    return { written: false, reason: 'cobertura-invalida' };
  }
  if (contract.coverage.verificadas.length > MAX_VISUAL_COVERAGE_SECTIONS) {
    return reject('cobertura-oversize', `${contract.coverage.verificadas.length} secciones > MAX_VISUAL_COVERAGE_SECTIONS ${MAX_VISUAL_COVERAGE_SECTIONS}`);
  }
  const oversizedSection = contract.coverage.verificadas.find(
    section => Buffer.byteLength(String(section), 'utf8') > MAX_VISUAL_SECTION_BYTES
  );
  if (oversizedSection !== undefined) {
    return reject('seccion-oversize', `una sección supera MAX_VISUAL_SECTION_BYTES ${MAX_VISUAL_SECTION_BYTES}`);
  }

  return visualCoverageStore.writeCoverage({
    issue,
    rev,
    coverage: contract.coverage,
    diffs: [],
    baseDir: evidenceDir,
  });
}

module.exports = {
  recordApprovedCoverage,
  MAX_VISUAL_JSON_BYTES,
  MAX_VISUAL_COVERAGE_SECTIONS,
  MAX_VISUAL_SECTION_BYTES,
};
