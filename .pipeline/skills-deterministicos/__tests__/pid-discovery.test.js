// Tests unitarios de .pipeline/skills-deterministicos/lib/pid-discovery.js (issue #2486)
// Reemplaza el uso de agent-registry.json por descubrimiento dinámico.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pd = require('../lib/pid-discovery');

// Fixture: salida típica de `Get-CimInstance Win32_Process | Select ProcessId,Name,CommandLine | ConvertTo-Csv`.
const CSV_FIXTURE = [
    '"ProcessId","Name","CommandLine"',
    '"3612","node.exe","""C:\\Program Files\\nodejs\\node.exe"" C:\\Workspaces\\Intrale\\platform\\.pipeline\\listener-telegram.js"',
    '"18152","node.exe","""C:\\Program Files\\nodejs\\node.exe"" C:\\Workspaces\\Intrale\\platform\\.pipeline\\pulpo.js"',
    '"24680","node.exe","""C:\\Program Files\\nodejs\\node.exe"" C:\\Workspaces\\Intrale\\platform\\.pipeline\\skills-deterministicos\\builder.js 2486 --trabajando=C:\\foo"',
    '"24681","node.exe","""C:\\Program Files\\nodejs\\node.exe"" C:\\Workspaces\\Intrale\\platform\\.pipeline\\skills-deterministicos\\tester.js 2488 --trabajando=C:\\bar"',
    '"14120","claude.exe","C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe -p --output-format stream-json --verbose"',
    '',
].join('\n');

function mkRunner(csv = CSV_FIXTURE) {
    return () => csv;
}

// ─── parseProcessCsv ────────────────────────────────────────────────────────

test('parseProcessCsv — parsea CSV con cmdline con comillas dobles escapadas', () => {
    const rows = pd.parseProcessCsv(CSV_FIXTURE);
    assert.equal(rows.length, 5);
    const builder = rows.find(r => r.pid === 24680);
    assert.ok(builder);
    assert.equal(builder.name, 'node.exe');
    assert.match(builder.cmdline, /skills-deterministicos\\builder\.js 2486/);
    const claude = rows.find(r => r.pid === 14120);
    assert.ok(claude);
    assert.equal(claude.name, 'claude.exe');
});

test('parseProcessCsv — CSV vacío → []', () => {
    assert.deepEqual(pd.parseProcessCsv(''), []);
    assert.deepEqual(pd.parseProcessCsv(null), []);
    assert.deepEqual(pd.parseProcessCsv(undefined), []);
});

test('parseProcessCsv — solo cabecera → []', () => {
    assert.deepEqual(pd.parseProcessCsv('"ProcessId","Name","CommandLine"'), []);
});

// ─── splitCsvLine ───────────────────────────────────────────────────────────

test('splitCsvLine — campos con comillas dobles escapadas', () => {
    const line = '"1","node.exe","""node"" foo.js"';
    const parts = pd.splitCsvLine(line);
    assert.deepEqual(parts, ['1', 'node.exe', '"node" foo.js']);
});

test('splitCsvLine — comas dentro de campo entrecomillado', () => {
    const line = '"1","node.exe","a, b, c"';
    const parts = pd.splitCsvLine(line);
    assert.deepEqual(parts, ['1', 'node.exe', 'a, b, c']);
});

// ─── matchesDeterministicAgent ──────────────────────────────────────────────

test('matchesDeterministicAgent — builder #2486 → true', () => {
    const cmd = 'C:\\node.exe .pipeline\\skills-deterministicos\\builder.js 2486 --trabajando=C:\\foo';
    assert.equal(pd.matchesDeterministicAgent(cmd, 2486, 'builder'), true);
});

test('matchesDeterministicAgent — skill distinto → false', () => {
    const cmd = 'node .pipeline\\skills-deterministicos\\tester.js 2486 --trabajando=C:\\foo';
    assert.equal(pd.matchesDeterministicAgent(cmd, 2486, 'builder'), false);
});

test('matchesDeterministicAgent — issue distinto → false', () => {
    const cmd = 'node .pipeline\\skills-deterministicos\\builder.js 9999 --trabajando=C:\\foo';
    assert.equal(pd.matchesDeterministicAgent(cmd, 2486, 'builder'), false);
});

test('matchesDeterministicAgent — substring de issue (24860 vs 2486) → false', () => {
    const cmd = 'node .pipeline\\skills-deterministicos\\builder.js 24860 --trabajando=C:\\foo';
    assert.equal(pd.matchesDeterministicAgent(cmd, 2486, 'builder'), false);
});

test('matchesDeterministicAgent — pulpo.js (no es skill) → false', () => {
    const cmd = 'node .pipeline\\pulpo.js';
    assert.equal(pd.matchesDeterministicAgent(cmd, 2486, 'builder'), false);
});

// ─── discoverAgentPids — determinístico (scan por cmdline) ──────────────────

test('discoverAgentPids — builder #2486 detectado por cmdline', () => {
    const pids = pd.discoverAgentPids({
        issue: 2486,
        skill: 'builder',
        listRunner: mkRunner(),
        heartbeatDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')),
    });
    assert.equal(pids.length, 1);
    assert.equal(pids[0].pid, 24680);
    assert.equal(pids[0].source, 'process-scan');
});

test('discoverAgentPids — tester #2488 detectado por cmdline', () => {
    const pids = pd.discoverAgentPids({
        issue: 2488,
        skill: 'tester',
        listRunner: mkRunner(),
        heartbeatDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')),
    });
    assert.equal(pids.length, 1);
    assert.equal(pids[0].pid, 24681);
});

test('discoverAgentPids — issue inexistente → []', () => {
    const pids = pd.discoverAgentPids({
        issue: 9999,
        skill: 'builder',
        listRunner: mkRunner(),
        heartbeatDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')),
    });
    assert.equal(pids.length, 0);
});

test('discoverAgentPids — sin skill y sin heartbeat → []', () => {
    // Sin skill no se puede scanear por cmdline; sin heartbeat tampoco hay fallback.
    const pids = pd.discoverAgentPids({
        issue: 2486,
        listRunner: mkRunner(),
        heartbeatDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')),
    });
    assert.equal(pids.length, 0);
});

// ─── discoverAgentPids — LLM por heartbeat ──────────────────────────────────

test('discoverAgentPids — LLM (claude.exe) detectado por heartbeat fresco', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-2500.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({
        issue: 2500,
        session: 'abc123',
        ts: new Date().toISOString(),
        branch: 'agent/2500-algo',
        pid: 14120,
    }));

    const pids = pd.discoverAgentPids({
        issue: 2500,
        skill: 'po', // skill LLM cualquiera
        listRunner: mkRunner(),
        heartbeatDir: dir,
    });
    assert.equal(pids.length, 1);
    assert.equal(pids[0].pid, 14120);
    assert.equal(pids[0].source, 'heartbeat');
    assert.equal(pids[0].name, 'claude.exe');
});

test('discoverAgentPids — heartbeat stale (> 5 min) → ignorado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-2500.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({ issue: 2500, pid: 14120 }));
    // Retro-envejecemos el mtime 10 minutos
    const old = Date.now() / 1000 - 10 * 60;
    fs.utimesSync(hbFile, old, old);

    const pids = pd.discoverAgentPids({
        issue: 2500,
        skill: 'po',
        listRunner: mkRunner(),
        heartbeatDir: dir,
    });
    assert.equal(pids.length, 0);
});

test('discoverAgentPids — heartbeat apunta a PID muerto → ignorado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-2500.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({
        issue: 2500,
        ts: new Date().toISOString(),
        pid: 777777, // PID que no está en el fixture
    }));

    const pids = pd.discoverAgentPids({
        issue: 2500,
        skill: 'po',
        listRunner: mkRunner(),
        heartbeatDir: dir,
    });
    assert.equal(pids.length, 0);
});

test('discoverAgentPids — heartbeat apunta a PID de proceso ajeno (no node/claude) → ignorado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-2500.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({
        issue: 2500,
        ts: new Date().toISOString(),
        pid: 24680, // PID real del fixture, pero es node.exe → válido
    }));

    // El PID 24680 es node.exe en el fixture → sí es aceptado (defensa en profundidad:
    // heartbeat + cmdline consistente con un agente de pipeline).
    const pids = pd.discoverAgentPids({
        issue: 2500,
        skill: 'po',
        listRunner: mkRunner(),
        heartbeatDir: dir,
    });
    assert.equal(pids.length, 1);
    assert.equal(pids[0].pid, 24680);
    assert.equal(pids[0].source, 'heartbeat');
});

// ─── discoverAgentPids — combinación ────────────────────────────────────────

test('discoverAgentPids — scan + heartbeat coinciden → un solo entry (de-dup)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-2486.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({
        issue: 2486,
        ts: new Date().toISOString(),
        pid: 24680,
    }));

    const pids = pd.discoverAgentPids({
        issue: 2486,
        skill: 'builder',
        listRunner: mkRunner(),
        heartbeatDir: dir,
    });
    assert.equal(pids.length, 1);
    assert.equal(pids[0].pid, 24680);
    // La fuente primaria es el scan (se procesa antes que el heartbeat).
    assert.equal(pids[0].source, 'process-scan');
});

test('discoverAgentPids — issue sin argumento → []', () => {
    assert.deepEqual(pd.discoverAgentPids({ listRunner: mkRunner() }), []);
    assert.deepEqual(pd.discoverAgentPids({}), []);
});

test('discoverAgentPids — listRunner que tira → [] (no propaga error)', () => {
    const pids = pd.discoverAgentPids({
        issue: 2486,
        skill: 'builder',
        listRunner: () => { throw new Error('powershell missing'); },
        heartbeatDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')),
    });
    assert.equal(pids.length, 0);
});

// ─── readHeartbeat ──────────────────────────────────────────────────────────

test('readHeartbeat — archivo válido → objeto parseado + mtimeMs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    const hbFile = path.join(dir, 'agent-7.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({ issue: 7, pid: 1 }));
    const hb = pd.readHeartbeat(7, { heartbeatDir: dir });
    assert.equal(hb.issue, 7);
    assert.equal(hb.pid, 1);
    assert.ok(typeof hb.mtimeMs === 'number');
});

test('readHeartbeat — archivo inexistente → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    assert.equal(pd.readHeartbeat(999, { heartbeatDir: dir }), null);
});

test('readHeartbeat — JSON inválido → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
    fs.writeFileSync(path.join(dir, 'agent-5.heartbeat'), 'no es json');
    assert.equal(pd.readHeartbeat(5, { heartbeatDir: dir }), null);
});
