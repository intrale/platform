'use strict';

// Tests de ops-restart-audit.js (EP8-H7 #3960, CA-3 + REQ-SEC-H7-4).
// node --test .pipeline/lib/ops-restart-audit.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('./ops-restart-audit');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ora-test-'));
}

test('append + read básico, append-only y más reciente primero', () => {
    const dir = tmpPipeline();
    audit.appendOpsRestartAudit({ service: 'svc-drive', source: 'dashboard-ui', sourceIp: '127.0.0.1', ok: true, msg: 'reiniciado' }, { pipelineDir: dir, now: 1000 });
    audit.appendOpsRestartAudit({ service: 'svc-github', source: 'telegram', sourceIp: '127.0.0.1', ok: false, msg: 'falló' }, { pipelineDir: dir, now: 2000 });
    const rows = audit.readOpsRestartAudit({ pipelineDir: dir });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].service, 'svc-github', 'más reciente primero');
    assert.strictEqual(rows[1].service, 'svc-drive');
});

test('actor/msg con newline NO rompen el parseo línea-a-línea (log injection)', () => {
    const dir = tmpPipeline();
    // Intento de inyección: newline para fabricar una línea JSON falsa.
    const evilActor = 'real\n{"ts":"FAKE","service":"admin","ok":true}';
    const evilMsg = 'linea1\r\nlinea2 linea3 linea4';
    audit.appendOpsRestartAudit({ service: 'svc-drive', source: 'dashboard-ui', actor: evilActor, msg: evilMsg, ok: true }, { pipelineDir: dir });

    // El archivo debe tener exactamente UNA línea de contenido.
    const raw = fs.readFileSync(audit.auditPath({ pipelineDir: dir }), 'utf8');
    const contentLines = raw.split('\n').filter(Boolean);
    assert.strictEqual(contentLines.length, 1, 'una sola línea JSON pese al newline inyectado');

    const rows = audit.readOpsRestartAudit({ pipelineDir: dir });
    assert.strictEqual(rows.length, 1);
    assert.ok(!new RegExp('['+['\r','\n','\u0085','\u2028','\u2029'].join('')+']').test(rows[0].msg), 'msg sin separadores de línea');
    assert.notStrictEqual(rows[0].service, 'admin', 'la línea inyectada no se materializó');
});

test('source desconocido cae a "unknown" (atestación no autenticada)', () => {
    const dir = tmpPipeline();
    const r = audit.appendOpsRestartAudit({ service: 'svc-drive', source: 'spoofed-admin', ok: true }, { pipelineDir: dir });
    assert.strictEqual(r.source, 'unknown');
    const r2 = audit.appendOpsRestartAudit({ service: 'svc-drive', source: 'dashboard-ui', ok: true }, { pipelineDir: dir });
    assert.strictEqual(r2.source, 'dashboard-ui');
});

test('sourceIp se registra como dato objetivo y ok es booleano estricto', () => {
    const dir = tmpPipeline();
    const r = audit.appendOpsRestartAudit({ service: 'pulpo', source: 'dashboard-ui', sourceIp: '::1', ok: 'truthy-string' }, { pipelineDir: dir });
    assert.strictEqual(r.sourceIp, '::1');
    assert.strictEqual(r.ok, false, 'ok solo true si === true');
});

test('read tolera líneas corruptas', () => {
    const dir = tmpPipeline();
    const file = audit.auditPath({ pipelineDir: dir });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"service":"a","ok":true}\nESTO NO ES JSON\n{"service":"b","ok":false}\n');
    const rows = audit.readOpsRestartAudit({ pipelineDir: dir });
    assert.strictEqual(rows.length, 2);
});
