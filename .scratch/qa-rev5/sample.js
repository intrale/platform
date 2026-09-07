'use strict';
// QA #6459 pasada 5 — muestreo de color REAL (ffmpeg rawvideo rgb24) de los badges.
const { spawnSync } = require('child_process');
const path = require('path');
const D = __dirname;
const FF = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg.exe';
const FP = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffprobe.exe';

function dims(f) {
  const r = spawnSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(D, f)]);
  return r.stdout.toString().trim();
}
function hist(f, crop, label) {
  const r = spawnSync(FF, ['-v', 'error', '-i', path.join(D, f), '-vf', 'crop=' + crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) { console.log(label.padEnd(28) + 'ffmpeg fail: ' + r.stderr.toString().slice(0, 200)); return; }
  const b = r.stdout, m = new Map();
  for (let i = 0; i + 2 < b.length; i += 3) {
    const k = ('#' + b[i].toString(16).padStart(2, '0') + b[i + 1].toString(16).padStart(2, '0') + b[i + 2].toString(16).padStart(2, '0')).toUpperCase();
    m.set(k, (m.get(k) || 0) + 1);
  }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(label.padEnd(28) + top.map(([c, n]) => c + ' x' + n).join('  '));
}

for (const f of ['render-rev5.png', 'mockup-rev5.png', 'render-degraded-rev5.png']) {
  try { console.log(f.padEnd(28) + 'dims=' + dims(f)); } catch (e) { console.log(f + ' (ausente)'); }
}
console.log('');
hist('render-rev5.png', '130:38:408:176', 'RENDER huerfano');
hist('render-rev5.png', '76:32:408:222', 'RENDER ok');
hist('render-rev5.png', '96:34:408:262', 'RENDER error');
hist('render-degraded-rev5.png', '130:38:408:176', 'DEGRADADO huerfano');
hist('mockup-rev5.png', '320:76:1390:320', 'MOCKUP huerfano');
hist('mockup-rev5.png', '260:76:1100:320', 'MOCKUP error');
