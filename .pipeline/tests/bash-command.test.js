'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUsableBash, BASH_SKIP_REASON } = require('../lib/bash-command');

test('Windows prefiere Git Bash y evita el wrapper WSL roto del PATH', () => {
    const calls = [];
    const bash = resolveUsableBash({ platform: 'win32', env: {}, spawnSyncFn: (cmd, args, options) => {
        calls.push(cmd);
        assert.deepEqual(args, ['-c', 'exit 0']);
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 5000);
        return { status: cmd === 'bash' ? 1 : 0 };
    }});
    assert.match(bash, /Git\\bin\\bash.exe$/);
    assert.equal(calls.length, 1);
});

test('override inutilizable permite probar los candidatos siguientes', () => {
    const calls = [];
    const bash = resolveUsableBash({ platform: 'win32', env: { GIT_BASH_PATH: 'invalid' }, spawnSyncFn: (cmd) => {
        calls.push(cmd);
        return cmd === 'invalid' ? { status: 1 } : { status: 0 };
    }});
    assert.equal(calls[0], 'invalid');
    assert.equal(bash, calls[1]);
});

test('errores, timeout y excepciones no impiden encontrar Bash por PATH', () => {
    let calls = 0;
    const bash = resolveUsableBash({ platform: 'win32', env: {}, spawnSyncFn: (cmd) => {
        calls++;
        if (calls === 1) throw new Error('ENOENT');
        if (cmd !== 'bash') return { error: { code: 'ETIMEDOUT' }, status: null };
        return { status: 0 };
    }});
    assert.equal(bash, 'bash');
});

test('sin Bash usable devuelve null y un motivo explícito de omisión', () => {
    const bash = resolveUsableBash({ platform: 'win32', env: {}, spawnSyncFn: () => ({ status: 1 }) });
    assert.equal(bash, null);
    assert.match(BASH_SKIP_REASON, /No hay Bash usable/);
});

test('en Unix verifica el Bash de PATH sin buscar instalaciones Windows', () => {
    const calls = [];
    assert.equal(resolveUsableBash({ platform: 'linux', env: {}, spawnSyncFn: cmd => {
        calls.push(cmd); return { status: 0 };
    }}), 'bash');
    assert.deepEqual(calls, ['bash']);
});

// Ejecuta el test real con un child_process falso: el probe no puede convertir
// un fallo del script en un skip, y la ausencia debe quedar visible en TAP.
for (const scenario of ['missing', 'regression']) {
    test(`el test SIGPIPE real distingue ${scenario} de aprobación`, () => {
        const { spawnSync } = require('node:child_process');
        const file = require.resolve('./smart-build-sigpipe-7591.test.js');
        const script = `
            const cp = require('node:child_process');
            cp.spawnSync = (cmd, args) => args[1] === 'exit 0'
                ? { status: ${scenario === 'missing' ? 1 : 0} }
                : { status: 141, stdout: '', stderr: 'regresión SIGPIPE simulada' };
            require(${JSON.stringify(file)});
        `;
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test-reporter=tap', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, scenario === 'missing' ? 0 : 1, result.stderr);
        assert.match(result.stdout, scenario === 'missing' ? /SKIP.*No hay Bash usable/ : /regresión SIGPIPE simulada/);
    });
}
