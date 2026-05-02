// =============================================================================
// split-long-message.js — Issue #2921
//
// Telegram limita sendMessage a 4096 chars por mensaje. Cuando el sender envia
// un texto mas largo, el API responde con error o lo trunca silenciosamente.
//
// Este modulo parte un mensaje largo en chunks <= LIMIT preservando el formato
// Markdown (no corta tablas, no rompe code fences ``` ni inline code, prefiere
// cortar en limite de parrafo, luego linea, luego palabra).
//
// Cada chunk lleva un prefijo "(N/M) " en la primera linea cuando hay mas de
// uno, asi el lector ve el orden y el total.
// =============================================================================

'use strict';

const DEFAULT_LIMIT = 3500; // margen sobre 4096 para parse_mode + prefijo
const PREFIX_RESERVE = 12;  // espacio reservado para "(NN/MM) "

/**
 * Parte texto en chunks <= limit.
 *
 * Estrategia:
 *  1. Si el texto entero cabe, retorna [text].
 *  2. Detecta bloques de codigo (``` ... ```) y los trata como unidades atomicas
 *     que no se pueden dividir. Si un bloque solo no cabe, se parte por lineas
 *     respetando los fences (cierra ``` al final del chunk y abre ``` al inicio
 *     del siguiente).
 *  3. Fuera de bloques de codigo, prefiere cortar en doble salto (\n\n), luego
 *     simple salto (\n), luego espacio.
 *  4. Si una linea es mas larga que el limite, parte por palabras; si una
 *     palabra sola excede, parte por chars (caso degenerado).
 *  5. Si hay >1 chunk, prefija "(i/N) " en cada uno.
 *
 * @param {string} text - texto a partir
 * @param {number} [limit=DEFAULT_LIMIT] - tamano maximo de cada chunk (incluye prefijo)
 * @returns {string[]} array de chunks listos para sendMessage
 */
function splitLongMessage(text, limit = DEFAULT_LIMIT) {
  if (typeof text !== 'string') return [];
  if (text.length === 0) return [''];
  if (text.length <= limit) return [text];

  const effectiveLimit = limit - PREFIX_RESERVE;
  const segments = segmentByCodeFences(text);
  const rawChunks = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      rawChunks.push(current);
      current = '';
    }
  };

  const appendUnit = (unit, joiner = '') => {
    const candidate = current.length === 0 ? unit : current + joiner + unit;
    if (candidate.length <= effectiveLimit) {
      current = candidate;
    } else {
      flush();
      current = unit;
    }
  };

  for (const seg of segments) {
    if (seg.type === 'code') {
      // Code block: tratar como atomo si cabe; si no, partir conservando fences.
      if (seg.text.length <= effectiveLimit) {
        appendUnit(seg.text, '\n');
      } else {
        // Cierra el chunk actual, parte el code block y emite chunks parciales.
        flush();
        const codeChunks = splitCodeBlock(seg.text, effectiveLimit);
        for (const c of codeChunks) rawChunks.push(c);
      }
      continue;
    }

    // Texto plano: partir por parrafos (\n\n), luego lineas, luego palabras.
    const paragraphs = seg.text.split(/\n\n/);
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p];
      const joiner = p === 0 ? '\n' : '\n\n';
      if (para.length <= effectiveLimit) {
        appendUnit(para, joiner);
      } else {
        // Parrafo solo no cabe: cortar por lineas
        const lines = para.split('\n');
        let firstLineOfPara = true;
        for (const line of lines) {
          const lineJoiner = firstLineOfPara ? joiner : '\n';
          if (line.length <= effectiveLimit) {
            appendUnit(line, lineJoiner);
          } else {
            // Linea sola no cabe: cortar por palabras
            const words = line.split(' ');
            let firstWord = true;
            for (const w of words) {
              const wJoiner = firstWord ? lineJoiner : ' ';
              if (w.length <= effectiveLimit) {
                appendUnit(w, wJoiner);
              } else {
                // Palabra sola no cabe: cortar por chars
                let rest = w;
                let firstSlice = true;
                while (rest.length > 0) {
                  const slice = rest.slice(0, effectiveLimit);
                  rest = rest.slice(effectiveLimit);
                  appendUnit(slice, firstSlice ? wJoiner : '');
                  firstSlice = false;
                }
              }
              firstWord = false;
            }
          }
          firstLineOfPara = false;
        }
      }
    }
  }
  flush();

  if (rawChunks.length <= 1) return rawChunks.length === 1 ? rawChunks : [text];

  const total = rawChunks.length;
  return rawChunks.map((c, i) => `(${i + 1}/${total}) ${c}`);
}

/**
 * Segmenta el texto en bloques de codigo y texto plano.
 * Un bloque de codigo empieza con ``` al principio de linea y termina con ```
 * al principio de linea siguiente. Si no hay cierre, todo el resto se trata como
 * codigo (Telegram tampoco lo cerraria, pero al menos no rompemos al partir).
 */
function segmentByCodeFences(text) {
  const segments = [];
  const fenceRe = /(^|\n)```/g;
  let inCode = false;
  let lastIdx = 0;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const fenceStart = m.index + (m[1] === '\n' ? 1 : 0);
    if (!inCode) {
      // texto plano hasta fenceStart
      if (fenceStart > lastIdx) {
        segments.push({ type: 'text', text: text.slice(lastIdx, fenceStart).replace(/\n+$/, '') });
      }
      lastIdx = fenceStart;
      inCode = true;
    } else {
      // cierre del bloque: incluir hasta fin de linea del cierre
      const endOfLine = text.indexOf('\n', m.index + 1);
      const blockEnd = endOfLine === -1 ? text.length : endOfLine;
      segments.push({ type: 'code', text: text.slice(lastIdx, blockEnd) });
      lastIdx = blockEnd + 1; // saltar el \n
      inCode = false;
    }
  }
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx);
    if (inCode) segments.push({ type: 'code', text: tail });
    else segments.push({ type: 'text', text: tail });
  }
  return segments.filter(s => s.text.length > 0);
}

/**
 * Parte un bloque de codigo en chunks <= limit, conservando fences. Cada chunk
 * empieza con ``` y termina con ``` para que Telegram lo renderice como codigo.
 * Detecta el lenguaje en la primera linea y lo replica.
 */
function splitCodeBlock(codeBlock, limit) {
  const lines = codeBlock.split('\n');
  // primera linea es ```lang (o solo ```), ultima linea es ```
  const firstFence = lines[0]; // p.ej. "```js"
  const lastIdx = lines.length - 1;
  // El cierre puede no existir si el texto venia mal formado
  const hasClose = lines[lastIdx].trim() === '```';
  const innerLines = hasClose ? lines.slice(1, lastIdx) : lines.slice(1);
  const lang = firstFence.replace(/^```/, '');
  const fenceOpen = '```' + lang;
  const fenceClose = '```';

  const chunks = [];
  let current = fenceOpen;
  for (const line of innerLines) {
    const candidate = current + '\n' + line + '\n' + fenceClose;
    if (candidate.length <= limit) {
      current = current + '\n' + line;
    } else {
      // cerrar el chunk actual
      chunks.push(current + '\n' + fenceClose);
      current = fenceOpen + '\n' + line;
    }
  }
  chunks.push(current + '\n' + fenceClose);
  return chunks;
}

module.exports = {
  splitLongMessage,
  // exportados para test
  _segmentByCodeFences: segmentByCodeFences,
  _splitCodeBlock: splitCodeBlock,
  DEFAULT_LIMIT,
};
