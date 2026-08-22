// Verificación empírica del PO para #6117 (CA-5 / CA-6). Temporal, no versionado.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po6117-'));
fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
process.env.PIPELINE_DIR_OVERRIDE = dir;

const m = require(path.resolve(__dirname, '..', 'lib', 'metrics', 'auto-repair.js'));
const jsonl = path.join(dir, 'state', 'auto-repair.jsonl');
const cfg = { threshold: 3, windowMs: 3600000 };

m.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [100, 101], token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ruta: 'C:/secreto/x' });
m.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [200] });

const raw = fs.readFileSync(jsonl, 'utf8').trim();
console.log('CA-6 keys        =', JSON.stringify(Object.keys(JSON.parse(raw.split('\n')[0]))));
console.log('CA-6 WHITELIST   =', JSON.stringify(m.WHITELIST));
console.log('CA-6 fuga token  =', raw.includes('ABCDEFGH'), '| fuga path =', raw.includes('secreto'));

const at = (n) => JSON.stringify(m.shouldAlertRepetition({ tipo: n, nowMs: Date.now(), ...cfg }));
console.log('CA-5 tras 2      =', at('convergencia_aditiva'));
m.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [300, 301, 302] });
console.log('CA-5 tras 3      =', at('convergencia_aditiva'));
console.log('CA-5 otro tipo   =', at('reparacion_aditiva_wave_add'));

fs.appendFileSync(jsonl, '{{{corrupto\n');
console.log('SEC-4 corrupto   =', at('reparacion_aditiva_wave_add'));
console.log('CA-7 last        =', JSON.stringify(m.readLastAutoRepair()));
console.log('TMP              =', dir);
