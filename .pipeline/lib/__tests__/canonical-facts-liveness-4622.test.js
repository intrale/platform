// =============================================================================
// canonical-facts-liveness-4622.test.js — Cross-check de identidad en el fact
// `agentes_activos` (#4622, CA-1 / SEC-1). Reproduce el escenario Gherkin A
// (heartbeat con ts fresco pero pid inexistente ⇒ NO cuenta como vivo) y el
// test de reuso de PID (pid vivo pero identidad NO matchea ⇒ NO cuenta).
//
// Sandbox de FS real (config.yaml + heartbeats) igual que canonical-facts.test.js,
// con processCheck/startTimeProbe inyectables. CERO shell/OS real.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canonical = require('../canonical-facts');
const { resolveClaim } = canonical;

function mkSandbox() {
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf4622-pipe-'));
    const hbdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf4622-hb-'));
    fs.writeFileSync(path.join(pdir, 'config.yaml'),
        'pipelines:\n' +
        '  desarrollo:\n' +
        '    fases: [dev, build]\n' +
        '    skills_por_fase:\n' +
        '      dev: [pipeline-dev]\n' +
        '      build: [build]\n');
    process.env.PIPELINE_DIR_OVERRIDE = pdir;
    process.env.CANONICAL_HEARTBEAT_DIR_OVERRIDE = hbdir;
    canonical._resetConfigCache();
    return { pdir, hbdir };
}
function clearSandbox() {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.CANONICAL_HEARTBEAT_DIR_OVERRIDE;
    canonical._resetConfigCache();
}
function writeMarker(pdir, { fase, issue, skill }) {
    const dir = path.join(pdir, 'desarrollo', fase, 'trabajando');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${issue}.${skill}`), `issue: ${issue}\n`);
}
function writeHb(hbdir, issue, obj) {
    fs.writeFileSync(path.join(hbdir, `agent-${issue}.heartbeat`), JSON.stringify(obj));
}

test('Gherkin A · agentes_activos: heartbeat ts-fresco con pid inexistente NO cuenta como vivo', async () => {
    const sb = mkSandbox();
    try {
        writeMarker(sb.pdir, { fase: 'dev', issue: 4534, skill: 'pipeline-dev' });
        // Latido con ts fresco pero el pid está muerto en el OS.
        writeHb(sb.hbdir, 4534, { issue: 4534, pid: 8292, ts: new Date().toISOString(), pid_started_at: 'A' });
        const r = await resolveClaim('agentes_activos', { expected: 0 }, {
            processCheck: () => false, // pid 8292 muerto
        });
        assert.equal(r.value, 0);
        assert.equal(r.status, 'consistent');
    } finally { clearSandbox(); }
});

test('SEC-1 · agentes_activos: pid vivo RECICLADO (identidad no matchea) NO cuenta como vivo', async () => {
    const sb = mkSandbox();
    try {
        writeMarker(sb.pdir, { fase: 'dev', issue: 4507, skill: 'pipeline-dev' });
        // Latido grabó start-time 'ORIG'; el pid está vivo pero es OTRO proceso
        // (start-time 'REUSED') → reuso de PID → NO es el agente.
        writeHb(sb.hbdir, 4507, { issue: 4507, pid: 8292, pid_started_at: 'ORIG' });
        const r = await resolveClaim('agentes_activos', { expected: 0 }, {
            processCheck: () => true,           // pid 8292 vivo...
            startTimeProbe: () => 'REUSED',     // ...pero es otro proceso
        });
        assert.equal(r.value, 0);
    } finally { clearSandbox(); }
});

test('agentes_activos: pid vivo con identidad que matchea SÍ cuenta como vivo', async () => {
    const sb = mkSandbox();
    try {
        writeMarker(sb.pdir, { fase: 'dev', issue: 4509, skill: 'pipeline-dev' });
        writeHb(sb.hbdir, 4509, { issue: 4509, pid: 1234, pid_started_at: 'MATCH' });
        const r = await resolveClaim('agentes_activos', { expected: 1 }, {
            processCheck: () => true,
            startTimeProbe: () => 'MATCH',
        });
        assert.equal(r.value, 1);
        assert.equal(r.status, 'consistent');
    } finally { clearSandbox(); }
});

test('Compat · agentes_activos: latido legacy sin pid_started_at + pid vivo cuenta como vivo', async () => {
    const sb = mkSandbox();
    try {
        writeMarker(sb.pdir, { fase: 'dev', issue: 4600, skill: 'pipeline-dev' });
        writeHb(sb.hbdir, 4600, { issue: 4600, pid: 1234 }); // sin token
        const r = await resolveClaim('agentes_activos', { expected: 1 }, { processCheck: () => true });
        assert.equal(r.value, 1);
    } finally { clearSandbox(); }
});

test('SEC-4 · agentes_activos: heartbeat malformado → tratado como muerto (no throw)', async () => {
    const sb = mkSandbox();
    try {
        writeMarker(sb.pdir, { fase: 'dev', issue: 4601, skill: 'pipeline-dev' });
        fs.writeFileSync(path.join(sb.hbdir, 'agent-4601.heartbeat'), '{ truncado');
        let r;
        await assert.doesNotReject(async () => {
            r = await resolveClaim('agentes_activos', { expected: 0 }, { processCheck: () => true });
        });
        assert.equal(r.value, 0);
    } finally { clearSandbox(); }
});
