// Tests para splitTextForTTSChunks — issue #3485.
//
// Cubre los CAs del refinamiento PO:
//   CA-1: default del helper debe ser 1500 (no 3800).
//   CA-3: división nunca parte palabras a la mitad.
//   CA-4: texto ~1200 chars genera 1 chunk.
//   CA-5: texto ~3000 chars genera 2 chunks.
//   CA-6: texto ~4500 chars genera 3 chunks.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitTextForTTSChunks } = require('../multimedia');

// --- Helpers ---

// Genera un texto de aproximadamente `targetChars` caracteres compuesto por
// oraciones de longitud "razonable" (10-15 palabras) terminadas en ".".
// Garantiza palabras sin truncar y delimitadas por espacio.
function generateSpanishText(targetChars) {
  const palabras = [
    'el', 'pipeline', 'procesa', 'cada', 'issue', 'con', 'agentes', 'que',
    'colaboran', 'para', 'entregar', 'cambios', 'al', 'codigo', 'principal',
    'durante', 'el', 'ciclo', 'continuo', 'sin', 'intervencion', 'manual',
    'aunque', 'siempre', 'queda', 'el', 'gate', 'humano', 'antes', 'del',
    'merge', 'final', 'a', 'main', 'como', 'safety', 'net', 'operativo'
  ];
  let texto = '';
  let i = 0;
  while (texto.length < targetChars) {
    const len = 10 + (i % 6); // 10 a 15 palabras por oración
    const oracion = Array.from({ length: len }, (_, k) => palabras[(i + k) % palabras.length]).join(' ');
    texto += (texto.length === 0 ? '' : ' ') + oracion + '.';
    i++;
  }
  return texto;
}

// --- CA-1: default ---

test('splitTextForTTSChunks default debe ser 1500 (no 3800)', () => {
  // Texto de 1800 chars: con default antiguo 3800 daría 1 chunk;
  // con default nuevo 1500 da 2.
  const texto = generateSpanishText(1800);
  const chunks = splitTextForTTSChunks(texto); // sin segundo argumento
  assert.equal(chunks.length >= 2, true,
    `Texto de ${texto.length} chars debería dividirse en >=2 chunks con default 1500, pero quedó en ${chunks.length}`);
});

// --- CA-3: no parte palabras ---

test('splitTextForTTSChunks nunca parte una palabra a la mitad', () => {
  const texto = generateSpanishText(4500);
  const chunks = splitTextForTTSChunks(texto, 1500);
  for (const chunk of chunks) {
    // Cada chunk debe empezar y terminar en un caracter no-espacio,
    // y al recomponer debería haber espacios entre piezas.
    assert.equal(chunk.trim(), chunk, 'Chunk con whitespace residual al borde');
    // Verificación más fuerte: ninguna palabra del texto original aparece
    // partida (medio fragmento al final de un chunk y la otra mitad al
    // principio del siguiente).
  }
  // Recomposición: al juntar los chunks con espacio, el texto resultante
  // debe contener todas las palabras del original sin alterar (módulo
  // espacios). Si alguna palabra se cortó, la reconstrucción tendría
  // tokens "raros".
  const recompuesto = chunks.join(' ');
  const palabrasOriginal = texto.split(/\s+/).filter(Boolean);
  const palabrasRecompuesto = recompuesto.split(/\s+/).filter(Boolean);
  assert.equal(palabrasRecompuesto.length, palabrasOriginal.length,
    `Cantidad de palabras cambió: original=${palabrasOriginal.length}, recompuesto=${palabrasRecompuesto.length}`);
  for (let i = 0; i < palabrasOriginal.length; i++) {
    assert.equal(palabrasRecompuesto[i], palabrasOriginal[i],
      `Palabra #${i} difiere: "${palabrasOriginal[i]}" vs "${palabrasRecompuesto[i]}"`);
  }
});

// --- CA-4: texto ≤ cap genera 1 chunk ---

test('texto de ~1200 chars genera 1 chunk (CA-4)', () => {
  const texto = generateSpanishText(1200);
  // Asegurar que efectivamente cae bajo el cap
  assert.equal(texto.length <= 1500, true,
    `Helper de test generó texto más largo del esperado: ${texto.length}`);
  const chunks = splitTextForTTSChunks(texto, 1500);
  assert.equal(chunks.length, 1, `Esperaba 1 chunk para texto de ${texto.length} chars, obtuve ${chunks.length}`);
});

// --- CA-5: texto entre 1×cap y 2×cap genera ~2 chunks (CA "aprox.") ---
// El algoritmo respeta límites de oración (no se redistribuye), así que un
// texto de 3000 chars con oraciones de ~80-100 chars puede producir 2 o 3
// chunks dependiendo de dónde caigan los bordes. El PO refinó como "aprox.
// 3000 chars → 2 audios". Aceptamos tolerancia ±1 chunk: lo importante es
// que ninguno excede el cap y nadie se trunca a mitad de palabra.

test('texto de ~3000 chars genera entre 2 y 3 chunks (CA-5 con tolerancia por borde de oracion)', () => {
  const texto = generateSpanishText(3000);
  const chunks = splitTextForTTSChunks(texto, 1500);
  assert.equal(chunks.length >= 2 && chunks.length <= 3, true,
    `Esperaba 2-3 chunks para texto de ${texto.length} chars, obtuve ${chunks.length}. Largos: ${chunks.map(c => c.length).join(',')}`);
  for (const c of chunks) {
    assert.equal(c.length <= 1500, true, `Chunk excede el cap: ${c.length} > 1500`);
  }
  // El total preservado (cantidad de chars no-espacio)
  const charsOriginal = texto.replace(/\s+/g, '').length;
  const charsRecompuesto = chunks.join(' ').replace(/\s+/g, '').length;
  assert.equal(charsOriginal, charsRecompuesto, 'Se perdieron caracteres en el split');
});

// --- CA-6: texto entre 2×cap y 3×cap genera ~3 chunks ---

test('texto de ~4500 chars genera entre 3 y 4 chunks (CA-6 con tolerancia por borde de oracion)', () => {
  const texto = generateSpanishText(4500);
  const chunks = splitTextForTTSChunks(texto, 1500);
  assert.equal(chunks.length >= 3 && chunks.length <= 4, true,
    `Esperaba 3-4 chunks para texto de ${texto.length} chars, obtuve ${chunks.length}. Largos: ${chunks.map(c => c.length).join(',')}`);
  for (const c of chunks) {
    assert.equal(c.length <= 1500, true, `Chunk excede el cap: ${c.length} > 1500`);
  }
  const charsOriginal = texto.replace(/\s+/g, '').length;
  const charsRecompuesto = chunks.join(' ').replace(/\s+/g, '').length;
  assert.equal(charsOriginal, charsRecompuesto, 'Se perdieron caracteres en el split');
});

// --- Verificación adicional del cap: ningún chunk excede 1500 ---

test('ningún chunk excede el cap de 1500 (defensa contra truncado de Edge TTS en español)', () => {
  // Múltiples tamaños de input para cubrir bordes
  for (const target of [1501, 2000, 2999, 3001, 4499, 6000, 9000]) {
    const texto = generateSpanishText(target);
    const chunks = splitTextForTTSChunks(texto, 1500);
    for (const c of chunks) {
      assert.equal(c.length <= 1500, true,
        `Texto de ${texto.length} chars produjo chunk de ${c.length} (>1500)`);
    }
  }
});

// --- Edge cases ---

test('texto vacío retorna [""]', () => {
  const chunks = splitTextForTTSChunks('', 1500);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '');
});

test('texto exactamente del tamaño del cap retorna 1 chunk', () => {
  const texto = 'a'.repeat(1500);
  const chunks = splitTextForTTSChunks(texto, 1500);
  assert.equal(chunks.length, 1);
});

test('oración única más larga que el cap se parte por palabras sin truncar', () => {
  // Una sola oración de ~2200 chars (sin puntos intermedios) → debe partirse
  // por palabras respetando el cap.
  const texto = generateSpanishText(2200).replace(/\./g, ',');
  const chunks = splitTextForTTSChunks(texto, 1500);
  assert.equal(chunks.length >= 2, true,
    `Oración única de ${texto.length} chars debería partirse, pero quedó en ${chunks.length}`);
  for (const c of chunks) {
    assert.equal(c.length <= 1500, true, `Chunk excede el cap: ${c.length} > 1500`);
  }
});
