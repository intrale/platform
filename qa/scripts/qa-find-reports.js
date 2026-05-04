#!/usr/bin/env node
// qa-find-reports.js — Localiza todos los reportes de tests existentes.
//
// Uso:
//   node qa/scripts/qa-find-reports.js
//
// Salida JSON:
//   {
//     "junit_api": [<paths .xml>],
//     "junit_desktop": [<paths .xml>],
//     "maestro": <path | null>,
//     "html_api": <dir | null>,
//     "html_desktop": <dir | null>
//   }
// Exit code: 0 siempre (reportar ausencia, no fallar).

'use strict';

const fs = require('fs');
const path = require('path');

function listXmlIn(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function existsOrNull(p) {
  try {
    fs.statSync(p);
    return p;
  } catch {
    return null;
  }
}

const result = {
  junit_api: listXmlIn('qa/build/test-results/test'),
  junit_desktop: listXmlIn('app/composeApp/build/test-results/desktopTest'),
  maestro: existsOrNull('qa/recordings/maestro-results.xml'),
  html_api: existsOrNull('qa/build/reports/tests/test'),
  html_desktop: existsOrNull('app/composeApp/build/reports/tests/desktopTest'),
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);
