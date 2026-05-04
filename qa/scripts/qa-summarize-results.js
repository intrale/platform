#!/usr/bin/env node
// qa-summarize-results.js — Pre-procesa reportes JUnit/Maestro a resumen estructurado.
//
// Uso:
//   node qa/scripts/qa-summarize-results.js [--out <path>]
//
// Sin argumentos: localiza reportes en paths estándar y emite JSON por stdout.
// Con --out: además persiste el JSON en el path indicado.
//
// Reportes que considera:
//   qa/build/test-results/test/*.xml                       (API JUnit)
//   app/composeApp/build/test-results/desktopTest/*.xml    (Desktop JUnit)
//   qa/recordings/maestro-results.xml                       (Maestro)
//
// Salida JSON:
//   {
//     "summary": { total, passed, failed, skipped, duration_ms, platforms: [...] },
//     "failures": [ { platform, class, name, duration_ms, reason, stack_top } ],
//     "slow_tests": [ { platform, class, name, duration_ms } ],   // top 5 si > 5s
//     "warnings": [ ... ],
//     "sources": { junit_api: [...], junit_desktop: [...], maestro: <path|null> }
//   }
// Exit code: 0 siempre (ausencia de reportes se reporta en warnings).

'use strict';

const fs = require('fs');
const path = require('path');

const SLOW_THRESHOLD_MS = 5000;
const SLOW_TOP_N = 5;

function readSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listXml(dir) {
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

function decodeXmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Parsea un XML JUnit. Acepta <testsuite> raíz o anidados en <testsuites>.
function parseJUnit(xml, platform, sourcePath) {
  const result = { tests: [], parseErrors: [] };
  if (!xml) return result;

  const testcaseRegex = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  const attrRegex = /(\w+)\s*=\s*"([^"]*)"/g;

  let match;
  while ((match = testcaseRegex.exec(xml)) !== null) {
    const attrs = {};
    let am;
    const attrStr = match[1];
    while ((am = attrRegex.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    const inner = match[3] || '';

    const className = attrs.classname || attrs.class || '';
    const name = attrs.name || '';
    const durationMs = attrs.time ? Math.round(parseFloat(attrs.time) * 1000) : 0;

    let status = 'passed';
    let reason = null;
    let stackTop = null;

    const failureMatch = inner.match(/<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/);
    if (failureMatch) {
      status = 'failed';
      const failAttrs = {};
      let fa;
      const fAttrRegex = /(\w+)\s*=\s*"([^"]*)"/g;
      while ((fa = fAttrRegex.exec(failureMatch[2])) !== null) {
        failAttrs[fa[1]] = fa[2];
      }
      reason = decodeXmlEntities(failAttrs.message || failAttrs.type || 'unknown');
      const body = decodeXmlEntities(failureMatch[4] || '');
      const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
      stackTop = firstLine.trim().slice(0, 240);
    } else if (/<skipped\b/.test(inner)) {
      status = 'skipped';
    }

    result.tests.push({
      platform,
      class: className,
      name,
      status,
      duration_ms: durationMs,
      reason,
      stack_top: stackTop,
      source: sourcePath,
    });
  }

  return result;
}

function buildSummary(tests, platforms) {
  const summary = {
    total: tests.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration_ms: 0,
    platforms: Array.from(new Set(platforms)).sort(),
  };
  for (const t of tests) {
    summary.duration_ms += t.duration_ms || 0;
    if (t.status === 'passed') summary.passed++;
    else if (t.status === 'failed') summary.failed++;
    else if (t.status === 'skipped') summary.skipped++;
  }
  return summary;
}

function buildSlowTests(tests) {
  return tests
    .filter((t) => (t.duration_ms || 0) >= SLOW_THRESHOLD_MS)
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, SLOW_TOP_N)
    .map(({ platform, class: cls, name, duration_ms }) => ({
      platform,
      class: cls,
      name,
      duration_ms,
    }));
}

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const warnings = [];

  const apiXml = listXml('qa/build/test-results/test');
  const desktopXml = listXml('app/composeApp/build/test-results/desktopTest');
  const maestroXml = fs.existsSync('qa/recordings/maestro-results.xml')
    ? 'qa/recordings/maestro-results.xml'
    : null;

  if (apiXml.length === 0 && desktopXml.length === 0 && !maestroXml) {
    warnings.push('no_reports_found');
  }

  const allTests = [];
  const platforms = [];
  const failures = [];

  for (const p of apiXml) {
    const xml = readSafe(p);
    if (!xml) {
      warnings.push(`unreadable: ${p}`);
      continue;
    }
    const r = parseJUnit(xml, 'api', p);
    allTests.push(...r.tests);
    if (r.tests.length > 0) platforms.push('api');
  }

  for (const p of desktopXml) {
    const xml = readSafe(p);
    if (!xml) {
      warnings.push(`unreadable: ${p}`);
      continue;
    }
    const r = parseJUnit(xml, 'desktop', p);
    allTests.push(...r.tests);
    if (r.tests.length > 0) platforms.push('desktop');
  }

  if (maestroXml) {
    const xml = readSafe(maestroXml);
    if (!xml) {
      warnings.push(`unreadable: ${maestroXml}`);
    } else {
      const r = parseJUnit(xml, 'android', maestroXml);
      allTests.push(...r.tests);
      if (r.tests.length > 0) platforms.push('android');
    }
  }

  for (const t of allTests) {
    if (t.status === 'failed') {
      failures.push({
        platform: t.platform,
        class: t.class,
        name: t.name,
        duration_ms: t.duration_ms,
        reason: t.reason,
        stack_top: t.stack_top,
      });
    }
  }

  const result = {
    summary: buildSummary(allTests, platforms),
    failures,
    slow_tests: buildSlowTests(allTests),
    warnings,
    sources: {
      junit_api: apiXml,
      junit_desktop: desktopXml,
      maestro: maestroXml,
    },
  };

  const json = JSON.stringify(result, null, 2);

  if (args.out) {
    try {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, json);
    } catch (err) {
      warnings.push(`failed to write ${args.out}: ${err.message}`);
    }
  }

  process.stdout.write(json + '\n');
  process.exit(0);
}

main();
