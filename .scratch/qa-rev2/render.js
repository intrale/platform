'use strict';
const fs = require('fs');
const path = require('path');
const BS = String.fromCharCode(92); // backslash
const ROOT = 'C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev';
const DASH = path.join(ROOT, '.pipeline', 'dashboard.js');
const src = fs.readFileSync(DASH, 'utf8');
const lines = src.split('\n');

// --- 1. CSS real del dashboard (lineas 4651..6882, 1-indexed) ---
let css = lines.slice(4650, 6882).join('\n');
const tokens = fs.readFileSync(path.join(ROOT, '.pipeline', 'assets', 'design-tokens.css'), 'utf8');
css = css.replace('${loadDesignTokens()}', tokens);
if (css.includes('${')) throw new Error('quedaron interpolaciones en el CSS');
if (!/--result-huerfano\s*:/.test(tokens)) throw new Error('design-tokens.css NO define --result-huerfano');

// --- 2. Funciones REALES extraidas del archivo, sin reescribir ---
function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no encontre function ' + name);
  const i = src.indexOf('{', start);
  let depth = 0, inS = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (esc) { esc = false; continue; }
    if (c === BS) { esc = true; continue; }
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('no cerre ' + name);
}
const fnEscape = grab('escapeHtml');
const fnBadges = grab('renderCommanderResultBadges');
const fnLogs = grab('renderCommanderRequestLogs');
fs.writeFileSync(path.join(__dirname, 'extracted-functions.js'),
  '// Extraidas VERBATIM de .pipeline/dashboard.js en esta pasada de QA\n' + [fnEscape, fnBadges, fnLogs].join('\n\n'));

const commanderResultBadge = require(path.join(ROOT, '.pipeline/lib/commander/result-badge.js'));
const { escapeHtmlAttr: __escapeHtmlAttrShared } = require(path.join(ROOT, '.pipeline/lib/escape-html'));
const factory = new Function('fs', 'path', 'commanderResultBadge', '__escapeHtmlAttrShared',
  fnEscape + '\n' + fnBadges + '\n' + fnLogs + '\nreturn { renderCommanderRequestLogs, escapeHtml };');
const { renderCommanderRequestLogs } = factory(fs, path, commanderResultBadge, __escapeHtmlAttrShared);

// --- 3. Fixture de logs: huerfano / ok / error / sin metadata ---
const LOG_DIR = path.join(__dirname, 'logs');
fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const base = 1787611707632;
const fixtures = [
  { off: 0, meta: { resultado: 'huerfano', provider: 'anthropic' } },
  { off: -60000, meta: { resultado: 'ok', provider: 'anthropic', sameProviderVerification: true } },
  { off: -120000, meta: { resultado: 'error', provider: 'gemini-google' } },
  { off: -180000, meta: null },
];
for (const f of fixtures) {
  const id = '-1001234567890-' + (base + f.off);
  fs.writeFileSync(path.join(LOG_DIR, 'commander-' + id + '.log'), 'fixture\n');
  if (f.meta) fs.writeFileSync(path.join(LOG_DIR, 'commander-' + id + '.meta.json'), JSON.stringify(f.meta));
}

const rowsHtml = renderCommanderRequestLogs(LOG_DIR);
if (!/cmd-result-huerfano/.test(rowsHtml)) throw new Error('el render NO emitio cmd-result-huerfano');
fs.writeFileSync(path.join(__dirname, 'rows.html'), rowsHtml);

const page = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>QA #6459</title>\n'
  + '<style>' + css + '</style></head><body style="padding:24px">\n'
  + '<details class="collapse-section" open><summary>&#128172; Actividad Commander</summary>\n'
  + '<div class="collapse-body" style="max-height:300px;overflow-y:auto">' + rowsHtml
  + '<div class="dim"><em>Sin actividad</em></div></div>\n</details></body></html>';
fs.writeFileSync(path.join(__dirname, 'render.html'), page);
console.log('OK render.html ' + page.length + ' bytes | rows ' + rowsHtml.length);
console.log(rowsHtml.replace(/></g, '>\n<'));
