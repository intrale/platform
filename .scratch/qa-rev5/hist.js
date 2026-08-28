'use strict';
// QA rev4 #6459 — histograma de colores dominantes de un recorte.
// uso: node hist.js <png> <crop w:h:x:y> <etiqueta>
const { spawnSync } = require('child_process');
const FF = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg.exe';
const [png, crop, label] = process.argv.slice(2);
const r = spawnSync(FF, ['-v', 'error', '-i', png, '-vf', `crop=${crop}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
if (r.status !== 0) { console.error('ffmpeg fail', r.stderr.toString().slice(0, 400)); process.exit(1); }
const b = r.stdout, m = new Map();
for (let i = 0; i + 2 < b.length; i += 3) {
  const k = '#' + b[i].toString(16).padStart(2, '0') + b[i + 1].toString(16).padStart(2, '0') + b[i + 2].toString(16).padStart(2, '0');
  m.set(k.toUpperCase(), (m.get(k.toUpperCase()) || 0) + 1);
}
const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(String(label).padEnd(26) + top.map(([c, n]) => `${c} x${n}`).join('  '));
