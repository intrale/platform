// =============================================================================
// Tests split-long-message.js — Issue #2921
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitLongMessage,
  _segmentByCodeFences,
  _splitCodeBlock,
} = require('../split-long-message');

test('texto corto: retorna [text] sin prefijo', () => {
  const r = splitLongMessage('hola mundo', 100);
  assert.deepEqual(r, ['hola mundo']);
});

test('texto vacio: retorna [\'\']', () => {
  assert.deepEqual(splitLongMessage('', 100), ['']);
});

test('input no-string: retorna []', () => {
  assert.deepEqual(splitLongMessage(null, 100), []);
  assert.deepEqual(splitLongMessage(undefined, 100), []);
  assert.deepEqual(splitLongMessage(123, 100), []);
});

test('texto largo: parte en >=2 chunks con prefijo (i/N)', () => {
  const para1 = 'A'.repeat(80);
  const para2 = 'B'.repeat(80);
  const para3 = 'C'.repeat(80);
  const text = [para1, para2, para3].join('\n\n');
  const chunks = splitLongMessage(text, 120);
  assert.ok(chunks.length >= 2, `esperaba >=2 chunks, recibi ${chunks.length}`);
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(
      chunks[i].startsWith(`(${i + 1}/${chunks.length}) `),
      `chunk ${i} debe empezar con prefijo: ${chunks[i].slice(0, 20)}`
    );
  }
});

test('chunks respetan el limite (incluyendo prefijo)', () => {
  const text = ('palabra '.repeat(2000)).trim();
  const limit = 1000;
  const chunks = splitLongMessage(text, limit);
  for (const c of chunks) {
    assert.ok(c.length <= limit, `chunk excede limit: ${c.length} > ${limit}`);
  }
});

test('reconstruccion: concat de chunks (sin prefijos) recupera el texto original', () => {
  const text = Array.from({ length: 20 }, (_, i) => `Parrafo ${i} con contenido moderado.`).join('\n\n');
  const chunks = splitLongMessage(text, 200);
  // remover prefijo "(i/N) " de cada chunk
  const stripped = chunks.map(c => c.replace(/^\(\d+\/\d+\) /, '')).join('\n\n');
  // El splitter puede meter joiners distintos en bordes, validamos que el contenido este
  for (let i = 0; i < 20; i++) {
    assert.ok(stripped.includes(`Parrafo ${i} con contenido moderado.`),
      `falta parrafo ${i} en reconstruccion`);
  }
});

test('respeta tablas Markdown (no parte en medio de fila)', () => {
  // Tabla compacta + texto largo antes para forzar chunking
  const filler = 'Texto previo. '.repeat(50);
  const tabla = [
    '| Col1 | Col2 |',
    '|------|------|',
    '| a | b |',
    '| c | d |',
  ].join('\n');
  const text = filler + '\n\n' + tabla;
  const chunks = splitLongMessage(text, 400);
  // las 4 lineas de la tabla deben estar todas en el mismo chunk (consecutivas)
  const tablaChunk = chunks.find(c => c.includes('| Col1 | Col2 |'));
  assert.ok(tablaChunk, 'tabla debe aparecer en algun chunk');
  assert.ok(tablaChunk.includes('|------|------|'), 'separador de tabla debe estar en mismo chunk que header');
  assert.ok(tablaChunk.includes('| a | b |'), 'fila a debe estar en mismo chunk');
  assert.ok(tablaChunk.includes('| c | d |'), 'fila c debe estar en mismo chunk');
});

test('code fence: bloque corto se mantiene atomico', () => {
  const filler = 'X'.repeat(200);
  const code = '```js\nconst x = 1;\nconsole.log(x);\n```';
  const text = filler + '\n\n' + code + '\n\n' + filler;
  const chunks = splitLongMessage(text, 400);
  // el code block debe estar entero en un solo chunk
  const codeChunk = chunks.find(c => c.includes('```js'));
  assert.ok(codeChunk, 'debe haber chunk con apertura de code fence');
  assert.ok(codeChunk.includes('console.log(x);'), 'codigo dentro del bloque preservado');
  assert.ok(codeChunk.match(/```js[\s\S]*```/), 'fences abren y cierran en el mismo chunk');
});

test('code fence: bloque largo se parte respetando fences en cada chunk', () => {
  const innerLines = Array.from({ length: 50 }, (_, i) => `linea ${i} con contenido razonable`).join('\n');
  const code = '```js\n' + innerLines + '\n```';
  const chunks = _splitCodeBlock(code, 200);
  assert.ok(chunks.length >= 2, 'bloque grande debe partirse en >=2 chunks');
  for (const c of chunks) {
    assert.ok(c.startsWith('```'), `chunk debe empezar con fence: ${c.slice(0, 10)}`);
    assert.ok(c.trimEnd().endsWith('```'), `chunk debe terminar con fence: ${c.slice(-10)}`);
    assert.ok(c.length <= 200 + 10, `chunk excede limite holgado: ${c.length}`);
  }
});

test('segmenta correctamente texto + code + texto', () => {
  const text = 'antes\n```\ncode here\n```\ndespues';
  const segs = _segmentByCodeFences(text);
  const types = segs.map(s => s.type);
  assert.deepEqual(types, ['text', 'code', 'text']);
});

test('segmenta sin fences: un solo segmento text', () => {
  const segs = _segmentByCodeFences('solo texto plano sin fences');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
});

test('limite por defecto 3500: texto de 4000 se parte', () => {
  const text = 'a '.repeat(2200); // ~4400 chars
  const chunks = splitLongMessage(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 3500);
  }
});

test('palabra mas larga que limite: se parte por chars', () => {
  const huge = 'A'.repeat(500);
  const text = 'inicio ' + huge + ' fin';
  const chunks = splitLongMessage(text, 200);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 200);
  }
});

test('caso real: el mensaje cortado de hoy con tabla + parrafos', () => {
  const text = `# Propuesta #3 de 5 — \`security\` ($22.41 / 21%)

## Anatomía del gasto

| Métrica | Valor | Observación |
|---|---|---|
| Sesiones | 4 | ~$5.60 c/u |
| **cache_read** | **7.0M** | Driver principal |
| tool_calls | 94 (~24/sesión) | OWASP scan + grep + dep check |
| **Modelo** | **YA Sonnet 4.6 ✅** | Palanca de modelo ya consumida |
| SKILL.md | **508 líneas** | Intermedio (pipeline-dev 224, qa 798) |

**Driver real:** corre en cada gate pre-delivery. Cada vez relee SKILL.md entero (OWASP Top 10 embebido, doctrina Hunt/Schneier, plantillas de reporte). Hace 24 tool calls de mecánica pura: gitleaks, grep patterns OWASP, npm audit, headers check. Ya está en Sonnet, así que **bajar modelo no aplica acá**.

---

## Propuestas, mayor a menor palanca

### 🎯 1. Determinismo parcial — **−65% (~$15 → $5)**

Toda la mecánica del scan es regex/shell deterministic. Scripts en \`.pipeline/scripts-security/\`:

| Script | Reemplaza |
|---|---|
| \`scan-secrets.js\` | grep de API keys, tokens, passwords hardcoded |
| \`check-headers.js\` | detector de XSS/CSRF en handlers backend |
| \`scan-deps.js\` | npm audit + parseo a JSON estructurado |
| \`check-cors.js\` | wildcard origins, headers permisivos |
| \`scan-sql.js\` | concatenacion en queries DynamoDB/SQL |

El agente solo decide PASS/FAIL, escribe el reporte y arma el issue. Toda la mecánica baja a node directamente desde el pipeline.

### 🎯 2. Recortar SKILL.md (508 → ~250 líneas) — **−40% cache_read**

Mover doctrina (Hunt/Schneier, ASVS), plantillas extendidas y referentes a \`docs/security-doctrina.md\`. Operativo concreto queda en SKILL.md.

### 🎯 3. Smart-skip cuando el diff no toca código sensible — **palanca variable**

Cuando el cambio es solo \`docs/\`, \`.pipeline/\`, \`.claude/hooks/\` o YAML de config, el agente no aporta valor. Saltarlo automáticamente con un check determinista de paths.

---

¿Te parece la propuesta? Mismo plan que con qa: creo los 3 issues hijos y empiezo implementación. Avísame.`;

  const chunks = splitLongMessage(text, 3500);
  // este texto en particular es ~2200 chars, deberia entrar en un solo chunk
  if (text.length <= 3500) {
    assert.equal(chunks.length, 1);
  } else {
    for (let i = 0; i < chunks.length; i++) {
      assert.ok(chunks[i].startsWith(`(${i + 1}/${chunks.length}) `));
      assert.ok(chunks[i].length <= 3500);
    }
  }
});
