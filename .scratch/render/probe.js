const path = require('path');
const fs = require('fs');
const os = require('os');
// fixture: 1 peticion huerfana + 1 sana + 1 sin sidecar
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'rnd6459-'));
const t = Date.now();
fs.writeFileSync(path.join(tmp, `commander--1001234567890-${t}.log`), 'x');
fs.writeFileSync(path.join(tmp, `commander--1001234567890-${t}.meta.json`), JSON.stringify({resultado:'huerfano'}));
fs.writeFileSync(path.join(tmp, `commander--1001234567890-${t-1000}.log`), 'x');
fs.writeFileSync(path.join(tmp, `commander--1001234567890-${t-1000}.meta.json`), JSON.stringify({resultado:'ok'}));
fs.writeFileSync(path.join(tmp, `commander--1001234567890-${t-2000}.log`), 'x');
const ca = require('../../.pipeline/views/dashboard/commander-activity.js');
const html = ca.renderCommanderActivity({ logDir: tmp });
console.log(html);
console.log('--- CSS contiene .cmd-result-huerfano:', ca.commanderActivityStyles().includes('.cmd-result-huerfano'));
