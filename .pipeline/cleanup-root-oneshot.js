#!/usr/bin/env node
// =============================================================================
// cleanup-root-oneshot.js — Limpieza one-shot de basura de la raíz (#3943, CA-4)
//
// Borra EXCLUSIVAMENTE los items de la ALLOWLIST de abajo (RS-5: allowlist
// explícita item por item, nunca glob amplio sobre la raíz). Los items
// trackeados por git se eliminan vía PR (git rm) — este script solo cubre los
// UNTRACKED que un merge no puede tocar.
//
// Seguridad:
//   - Cada path se resuelve con fs.realpathSync y se asserta que queda DENTRO
//     de la raíz del repo (C:/Workspaces/Intrale/platform). Un item que
//     resuelva afuera (ej. junction) se rechaza.
//   - ⚠️ `gh-cli/` acá es la carpeta de la RAÍZ DEL REPO. La instalación real
//     del CLI vive en C:/Workspaces/gh-cli (fuera del repo) y este script
//     jamás puede alcanzarla por el assert de confinamiento.
//   - Default dry-run. Borrado real solo con --run.
//
// Uso:
//   node .pipeline/cleanup-root-oneshot.js          # dry-run (default)
//   node .pipeline/cleanup-root-oneshot.js --run    # borrado real
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = 'C:/Workspaces/Intrale/platform';

// Allowlist verificada empíricamente (issue #3943, 2026-06-12). Solo items
// UNTRACKED — los trackeados se borran vía git rm en el PR del issue.
const ALLOWLIST = [
  'gh.zip',
  'Workspacesgh.zip',
  'Workspacesgh-cli',
  'gh-cli',                 // la de la RAÍZ DEL REPO (no C:/Workspaces/gh-cli)
  'deps_commonMain.txt',
  'C:temp_issues.json',
  'hs_err_pid15268.log',
];

function norm(p) { return p.replace(/\\/g, '/').toLowerCase(); }

// MSYS/Cygwin mapea chars ilegales de NTFS (ej. `:`) al rango privado U+F000.
// `C:temp_issues.json` en disco es `Ctemp_issues.json`. Para comparar
// contra la allowlist, des-mapeamos ese rango a ASCII.
function msysDenorm(name) {
  return name.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xF000));
}

function main() {
  const dryRun = !process.argv.includes('--run');
  const rootReal = norm(fs.realpathSync(REPO_ROOT));
  const rootEntries = fs.readdirSync(REPO_ROOT);
  let freed = 0;

  console.log(`cleanup-root-oneshot (#3943) — ${dryRun ? 'DRY-RUN' : 'BORRADO REAL'}`);
  for (const item of ALLOWLIST) {
    // Resolver el nombre REAL en disco (cubre nombres mangled por MSYS).
    const actualName = rootEntries.find((e) => msysDenorm(e) === item) || item;
    const target = path.join(REPO_ROOT, actualName);
    if (!fs.existsSync(target)) {
      console.log(`  ∅ ${item} — no existe, skip`);
      continue;
    }
    // Assert de confinamiento: el path real debe quedar dentro del repo.
    let real;
    try { real = norm(fs.realpathSync(target)); } catch (e) {
      console.log(`  🛑 ${item} — realpath irresoluble (${e.message.slice(0, 60)}), skip`);
      continue;
    }
    if (real !== rootReal + '/' + norm(actualName) || !real.startsWith(rootReal + '/')) {
      console.log(`  🛑 ${item} — resuelve fuera del repo (${real}), SKIP por seguridad`);
      continue;
    }
    const st = fs.statSync(target);
    const size = st.isDirectory() ? dirSize(target) : st.size;
    if (dryRun) {
      console.log(`  🔍 ${item} — se borraría (${(size / (1024 ** 2)).toFixed(1)} MB)`);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`  🗑 ${item} — borrado (${(size / (1024 ** 2)).toFixed(1)} MB)`);
    }
    freed += size;
  }
  console.log(`Total ${dryRun ? 'potencial' : 'liberado'}: ${(freed / (1024 ** 2)).toFixed(1)} MB`);
  if (dryRun) console.log('Ejecutá con --run para aplicar.');
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory() && !e.isSymbolicLink()) total += dirSize(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {}
    }
  } catch {}
  return total;
}

main();
