#!/usr/bin/env node
'use strict';

/**
 * Runner E2E de paridad — Ola 9.1 · #4665
 * ---------------------------------------
 * Ejercita los ejes de paridad del motor migrado contra el baseline
 * `pre-ola9-migracion` y emite evidencia estructurada (JSON) + un resumen legible.
 *
 * Uso:
 *   node .pipeline/kernel-bootstrap/parity-e2e-9.1.js [--baseline <ref>] [--out <file.json>] [--quiet]
 *
 * Salida:
 *   - stdout: resumen por eje/flujo con ✓/✗.
 *   - archivo JSON de evidencia (default: .pipeline/logs/parity-9.1.json).
 *   - exit 0 si paridad total; exit 1 si hay regresión (fail-closed).
 *
 * Determinístico: no arranca procesos ni muta estado del pipeline. Sólo lee
 * blobs de git de dos refs y compara. Reproducible por cualquier operador/CI.
 */

const fs = require('fs');
const path = require('path');
const parity = require('../lib/kernel-parity');

function parseArgs(argv) {
  const out = { baselineRef: parity.BASELINE_TAG, outFile: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') out.baselineRef = argv[++i];
    else if (a === '--out') out.outFile = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function mark(ok) { return ok ? '✓' : '✗'; }

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('node .pipeline/kernel-bootstrap/parity-e2e-9.1.js [--baseline <ref>] [--out <file>] [--quiet]');
    process.exit(0);
  }

  const report = parity.runParity({ baselineRef: args.baselineRef });
  const { axes } = report;

  if (!args.quiet) {
    console.log(`\n=== Paridad E2E post-migración kernel (Ola 9.1 · #4665) ===`);
    console.log(`baseline: ${report.baselineRef}   head: ${report.headRef}\n`);

    console.log(`${mark(axes.engine.ok)} Motor byte-idéntico (wiring · CA-2)`);
    for (const f of axes.engine.files) {
      console.log(`    ${mark(f.identical)} ${f.file}  ${f.baselineSha || '∅'}${f.identical ? '' : ` != ${f.postSha || '∅'}`}`);
    }

    console.log(`${mark(axes.flows.ok)} Flujos clave sin regresión (CA-1/CA-2)`);
    for (const fl of axes.flows.flows || []) {
      console.log(`    ${mark(fl.identical)} ${fl.flow}`);
    }

    console.log(`${mark(axes.resolver.ok)} Resolver default → motor local (coexistencia · CA-2)`);
    for (const e of axes.resolver.entries) {
      console.log(`    ${mark(e.pointsLocal)} ${e.name} → ${e.resolved ? e.resolved.source : e.error}`);
    }

    console.log(`${mark(axes.rollback.ok)} Rollback a ${axes.rollback.baselineRef} como salida segura (CA-3)`);
    console.log(`    ${mark(axes.rollback.tagExists)} tag existe (${axes.rollback.baselineSha || '∅'})`);
    console.log(`    ${mark(axes.rollback.defaultIsLocalEngine)} default = motor local (rollback sin cambio de path)`);

    console.log(`${mark(axes.security.ok)} Paridad de gates de seguridad (CA-4)`);
    for (const [k, v] of Object.entries(axes.security.checks)) {
      console.log(`    ${mark(v)} ${k}`);
    }

    console.log(`${mark(axes.secretScan.ok)} Tooling de secret-scan de historia presente (CA-5)`);
    for (const [k, v] of Object.entries(axes.secretScan.present)) {
      console.log(`    ${mark(v)} ${k}`);
    }

    console.log(`\n${report.passed ? '✓ PARIDAD TOTAL' : '✗ REGRESIÓN DETECTADA'}\n`);
  }

  const outFile = args.outFile || path.join(__dirname, '..', 'logs', 'parity-9.1.json');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    if (!args.quiet) console.log(`evidencia: ${outFile}`);
  } catch (e) {
    console.error(`no se pudo escribir la evidencia en ${outFile}: ${e.message}`);
  }

  process.exit(report.passed ? 0 : 1);
}

main();
