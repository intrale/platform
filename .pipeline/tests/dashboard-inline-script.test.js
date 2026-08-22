'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { getFreePort } = require('./helpers/free-port');
const { seedConfig } = require('./helpers/sandbox-config');

const PIPELINE_SRC = path.resolve(__dirname, '..');

function request(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 15000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function waitUntilReady(child, port) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`el dashboard murió durante el arranque (exit ${child.exitCode})`);
        }
        try {
            if ((await request(port, '/api/health')).status === 200) return;
        } catch { /* todavía no escucha */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('el dashboard no quedó listo dentro del timeout');
}

test('#5978 el script inline completo de /legacy parsea sin SyntaxError', async t => {
    const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash5978-script-'));
    fs.mkdirSync(path.join(pipelineDir, 'logs'), { recursive: true });
    seedConfig(pipelineDir);
    const port = await getFreePort();
    const child = spawn(process.execPath, [path.join(PIPELINE_SRC, 'dashboard.js')], {
        env: {
            ...process.env,
            PIPELINE_STATE_DIR: pipelineDir,
            PIPELINE_DIR_OVERRIDE: pipelineDir,
            DASHBOARD_PORT: String(port),
            DASHBOARD_HOST: '127.0.0.1',
            GH_BIN: 'gh-noop-nonexistent',
        },
        stdio: 'ignore',
    });
    t.after(() => {
        try { child.kill('SIGKILL'); } catch {}
        try { fs.rmSync(pipelineDir, { recursive: true, force: true }); } catch {}
    });

    await waitUntilReady(child, port);
    const response = await request(port, '/legacy');
    assert.equal(response.status, 200);

    const scripts = [...response.body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1]);
    const dashboardScript = scripts.find(script => script.includes('function refreshDepsBanner'));
    assert.ok(dashboardScript, 'el HTML servido incluye el bloque cliente del banner');
    assert.doesNotThrow(
        () => new vm.Script(dashboardScript, { filename: 'dashboard-legacy-inline.js' }),
        'el bloque inline completo tiene que parsear como JavaScript de browser',
    );
});
