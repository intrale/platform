#!/usr/bin/env node
/**
 * extract.js — Extrae un icono individual desde el sprite.svg como SVG standalone.
 *
 * Uso:
 *   node .pipeline/assets/icons/extract.js <id-del-icono> [color] [size]
 *
 * Ejemplos:
 *   node .pipeline/assets/icons/extract.js ic-fase-dev
 *   node .pipeline/assets/icons/extract.js ic-estado-rebote "#00D6FF" 48
 *
 * Salida: stdout con el SVG standalone listo para guardar o convertir a PNG.
 *
 * Uso tipico (render para Telegram):
 *   node extract.js ic-health-ok "#3FB950" 64 > /tmp/ok.svg
 *   rsvg-convert /tmp/ok.svg > /tmp/ok.png
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SPRITE_PATH = path.join(__dirname, 'sprite.svg');

function extract(id, color = 'currentColor', size = 24) {
  const sprite = fs.readFileSync(SPRITE_PATH, 'utf8');

  // Match <symbol id="..."> ... </symbol>
  const re = new RegExp(
    `<symbol\\s+id="${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"([^>]*)>([\\s\\S]*?)<\\/symbol>`,
    'i'
  );
  const m = re.exec(sprite);
  if (!m) {
    throw new Error(`Icon id="${id}" not found in sprite.svg`);
  }

  const attrs = m[1];
  const body = m[2].trim();

  // Extraer viewBox del symbol (default 0 0 24 24)
  const vbMatch = /viewBox="([^"]+)"/i.exec(attrs);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 24 24';

  // Sustituir currentColor por el color pedido en stroke= y fill= (solo los que lo usan)
  const bodyColored =
    color === 'currentColor'
      ? body
      : body.replace(/currentColor/g, color);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" role="img" aria-label="${id}">\n${bodyColored}\n</svg>\n`;
}

function main() {
  const [, , id, color, sizeArg] = process.argv;
  if (!id) {
    console.error('Uso: node extract.js <id-del-icono> [color] [size]');
    console.error('Ejemplo: node extract.js ic-fase-dev "#00D6FF" 48');
    process.exit(1);
  }
  const size = sizeArg ? parseInt(sizeArg, 10) : 24;
  try {
    process.stdout.write(extract(id, color || 'currentColor', size));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { extract };
