// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests de saneamiento de strings de terceros (#7592 · SR-5 · SR-7 · CA-7 caso 7).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sanitize = require('../sanitize');
const { run } = require('../cli');
const { after } = require('node:test');
const { basePolicy, captureIo, cleanupAll, makeRepo } = require('./_fixture-repo');

after(cleanupAll);

test('forLog neutraliza workflow commands de Actions (::set-env, ::add-mask)', () => {
  const out = sanitize.forLog('::set-env name=NODE_OPTIONS::--require /tmp/x.js');
  assert.ok(!out.includes('::'), out);
  assert.ok(!/^\s*::/.test(out));
});

test('un salto de línea no permite abrir un workflow command en una línea nueva', () => {
  const out = sanitize.forLog('MIT\n::error::pwned\r\n::stop-commands::tok');
  assert.ok(!out.includes('\n') && !out.includes('\r'));
  assert.ok(!out.includes('::'));
});

test('se quitan secuencias ANSI, controles y overrides bidi', () => {
  const out = sanitize.text('\u001b[31mMIT\u001b[0m\u0007 ‮TXT‬\u0000');
  assert.equal(out, 'MIT TXT');
});

test('forMarkdown escapa HTML y Markdown (<script>, tablas, links)', () => {
  const out = sanitize.forMarkdown('<script>alert(1)</script> | [x](javascript:y) `c` *b*');
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;/);
  assert.ok(!/(^|[^\\])\|/.test(out), 'el pipe debe quedar escapado para no romper la tabla');
  assert.match(out, /\\\[x\\\]/);
});

test('se truncan los campos largos con un tope', () => {
  const out = sanitize.text('a'.repeat(5000), 50);
  assert.equal(Array.from(out).length, 50);
  assert.ok(out.endsWith('…'));
});

test('se redactan credenciales en URLs y tokens de npmrc', () => {
  assert.equal(sanitize.text('https://user:pass@registry.example.com/x'), 'https://***@registry.example.com/x'); // secret-scan:ignore (fixture falso)
  assert.equal(sanitize.text('//registry/:_authToken=npm_abcdef123'), '//registry/:_authToken=***');
});

test('caso 7: un campo license malicioso sale saneado en el log y en el reporte', async () => {
  const evil = '::set-env name=X::y <script>alert(1)</script>';
  const root = makeRepo({ npm: { malo: { license: evil } } });
  const gen = captureIo();
  assert.equal(await run(['generate', '--root', root], { ...gen }), 0);

  const io = captureIo();
  const code = await run(['check', '--root', root], { ...io, env: {}, now: new Date('2026-09-23T00:00:00Z') });
  assert.equal(code, 1, 'una licencia que no parsea es desconocida y falla');
  const log = io.text();
  assert.match(log, /LICENCIA DESCONOCIDA: malo@1\.0\.0/);
  for (const line of log.split('\n')) assert.ok(!line.includes('::'), `línea con workflow command: ${line}`);

  const report = fs.readFileSync(path.join(root, 'docs/legal/third-party-licenses.md'), 'utf8');
  assert.ok(!report.includes('<script>'), 'el reporte no puede llevar HTML crudo de terceros');
  assert.ok(!report.includes('::set-env'));
  assert.match(report, /&lt;script&gt;/);
});

test('el Step Summary también sale saneado', async () => {
  const root = makeRepo({ npm: { malo: { license: '<img src=x onerror=alert(1)> ::warning::x' } } });
  await run(['generate', '--root', root], captureIo());
  const summary = path.join(root, 'summary.md');
  const io = captureIo();
  await run(['check', '--root', root], { ...io, env: { GITHUB_STEP_SUMMARY: summary }, now: new Date('2026-09-23T00:00:00Z') });
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /Gate de licencias en rojo/);
  assert.ok(!text.includes('<img'), text);
  assert.ok(!text.includes('::warning'), text);
});

test('la política de fixture es válida (sanidad del helper)', () => {
  assert.ok(Array.isArray(basePolicy().exceptions));
});
