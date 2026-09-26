// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../lib/pulpo-runtime-auth');
const probe = require('../scripts/opstate-cutover-probe');
const { withEnv } = require('../lib/test-helpers/with-env');

function fixture(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-7189-'));
    const now = Date.now();
    const tick = { pid: 123, timestamp: new Date(now).toISOString(), runtimeAuth: {
        version: 1, pipelineDir: dir, startedAt: 'start', strict: true,
    } };
    const file = path.join(dir, 'last-tick.json');
    const write = () => fs.writeFileSync(file, JSON.stringify(tick));
    const deps = { now: () => now, processForPid: () => ({ pid: 123, commandLine: `node "${path.join(dir, 'pulpo.js')}"` }), identityMatches: () => true };
    write();
    return Promise.resolve().then(() => fn({ dir, tick, file, write, deps })).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('acredita strict desde el heartbeat del servicio vivo', () => fixture(({ dir, deps }) => {
    assert.equal(auth.read(dir, deps).strict, true);
    assert.equal(auth.read(dir, deps).ok, true);
}));

for (const [name, mutate] of [
    ['legacy', t => { delete t.runtimeAuth; }],
    ['sin identidad', t => { delete t.runtimeAuth.startedAt; }],
    ['strict ausente', t => { delete t.runtimeAuth.strict; }],
    ['strict string', t => { t.runtimeAuth.strict = '1'; }],
    ['viejo', t => { t.timestamp = new Date(Date.now() - 300000).toISOString(); }],
    ['futuro', t => { t.timestamp = new Date(Date.now() + 300000).toISOString(); }],
    ['timestamp inválido', t => { t.timestamp = 'no'; }],
    ['otro checkout', t => { t.runtimeAuth.pipelineDir = os.tmpdir(); }],
    ['pid inválido', t => { t.pid = -1; }],
]) test(`falla cerrado con heartbeat ${name}`, () => fixture(({ dir, tick, write, deps }) => {
    mutate(tick); write(); assert.equal(auth.read(dir, deps).ok, false);
}));

for (const [name, override] of [
    ['proceso muerto', { processForPid: () => null }],
    ['pid reutilizado', { identityMatches: () => false }],
    ['identidad ilegible', { identityMatches: () => null }],
    ['script distinto', { processForPid: () => ({ pid: 123, commandLine: 'node otro.js' }) }],
]) test(`falla cerrado con ${name}`, () => fixture(({ dir, deps }) => {
    assert.equal(auth.read(dir, { ...deps, ...override }).ok, false);
}));

test('falla cerrado sin archivo o JSON inválido', () => fixture(({ dir, file, deps }) => {
    fs.writeFileSync(file, '{'); assert.equal(auth.read(dir, deps).ok, false);
    fs.unlinkSync(file); assert.equal(auth.read(dir, deps).ok, false);
}));

test('CA-1 negativo shell=1/servicio=0 no permite VERDE; shell=0/servicio=1 sí', () => fixture(async ({ dir, tick, write, deps }) => {
    const probeDeps = {
        config: { kernel: { durable: false } },
        backend: { _describeDriver: () => ({ ok: true, kind: 'aws-cli-sync', atomicUpdate: true }), describeMode: () => ({ mode: 'fs' }) },
        verifyRuntimeIdentity: () => ({ ok: true, principal: 'runtime' }),
        namespaceStatus: () => ({ migrated: true, stateDir: dir }),
        projectContext: { namespaceEnabled: () => true, stateDir: () => dir },
        auditFile: path.join(dir, 'audit.jsonl'),
        readServiceAuth: () => auth.read(dir, deps),
    };
    fs.writeFileSync(probeDeps.auditFile, '');
    for (const [shell, service, expected] of [['0', false, 1], ['1', false, 1], ['0', true, 0]]) {
        tick.runtimeAuth.strict = service; write();
        const r = await withEnv({ PARTIAL_PAUSE_STRICT_AUTH: shell }, () => probe.runPreconditions({ deps: probeDeps }));
        console.log(`shell=${shell}/servicio=${Number(service)} -> CA-B1.ok=${r.checks[0].ok}, exitCode=${r.exitCode}`);
        assert.equal(r.exitCode, expected, JSON.stringify(r));
    }
    delete probeDeps.readServiceAuth;
    const r = await withEnv({ PARTIAL_PAUSE_STRICT_AUTH: '1', PIPELINE_DIR_OVERRIDE: dir }, () => {
        fs.unlinkSync(path.join(dir, 'last-tick.json'));
        return probe.runPreconditions({ deps: probeDeps });
    });
    assert.equal(r.exitCode, 1);
    console.log(`shell=1/servicio=sin señal -> CA-B1.ok=${r.checks[0].ok}, exitCode=${r.exitCode}`);
}));

test('el productor toma strict del proceso hijo y el lector acredita su identidad real en el SO', { timeout: 40000 }, () => fixture(async ({ dir }) => {
    const { fork } = require('node:child_process');
    const script = path.join(dir, 'pulpo.js');
    const modulePath = require.resolve('../lib/pulpo-runtime-auth');
    fs.writeFileSync(script, `const fs=require('fs'); const auth=require(${JSON.stringify(modulePath)}); fs.writeFileSync(${JSON.stringify(path.join(dir, 'last-tick.json'))}, JSON.stringify({pid:process.pid,timestamp:new Date().toISOString(),runtimeAuth:auth.snapshot(${JSON.stringify(dir)})})); process.send('ready'); setInterval(()=>{},1000);`);
    const child = fork(script, [], { env: { ...process.env, PARTIAL_PAUSE_STRICT_AUTH: '0' }, silent: true, windowsHide: true });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout del productor')), 10000);
            child.once('message', () => { clearTimeout(timer); resolve(); });
            child.once('error', err => { clearTimeout(timer); reject(err); });
        });
        const result = await withEnv({ PARTIAL_PAUSE_STRICT_AUTH: '1' }, () => auth.read(dir));
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.strict, false);
        assert.equal(result.pid, child.pid);
        console.log(`Proceso hijo real acreditado: strict=${result.strict}, ok=${result.ok}`);
    } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill(); await exited;
    }
}));
