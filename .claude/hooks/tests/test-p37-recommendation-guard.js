// P-37: recommendation-guard.js — corte transitorio de recomendaciones (#7673)
//
// El hook PreToolUse[Bash] bloquea (exit 2) los `gh` que crean o etiquetan
// issues de recomendación mientras `recomendaciones.crear_issues` no sea `true`,
// deja una línea de auditoría sin comando ni body, y NUNCA bloquea Bash ajeno
// ni ante una excepción interna.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'recommendation-guard.js');

function sandbox(configYaml) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-reco-guard-'));
    if (configYaml != null) fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
    return dir;
}

function runHook(stdin, dir, extraEnv = {}) {
    const env = { ...process.env, PIPELINE_DIR_OVERRIDE: dir, PIPELINE_SKILL: 'guru', PIPELINE_ISSUE: '4242', ...extraEnv };
    return spawnSync(process.execPath, [HOOK], {
        input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
        encoding: 'utf8',
        env,
        timeout: 15000,
    });
}

function bash(command) {
    return { tool_name: 'Bash', tool_input: { command } };
}

function auditLines(dir) {
    const d = path.join(dir, 'audit');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
        .filter((f) => f.startsWith('recommendation-guard-'))
        .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean))
        .map((l) => JSON.parse(l));
}

const OFF = 'recomendaciones:\n  crear_issues: false\n';
const ON = 'recomendaciones:\n  crear_issues: true\n';

test('P-37: bloquea gh issue create con tipo:recomendacion (exit 2) y audita sin body', () => {
    const dir = sandbox(OFF);
    const r = runHook(bash('gh issue create --title "[guru] algo" --label "enhancement,tipo:recomendacion" --body "SECRETO-P37"'), dir);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /Otras oportunidades observadas/);
    assert.match(r.stderr, /#7673/);
    const lines = auditLines(dir);
    assert.strictEqual(lines.length, 1);
    const e = lines[0];
    assert.ok(e.timestamp);
    assert.strictEqual(e.skill, 'guru');
    assert.strictEqual(e.issue, 4242);
    assert.deepStrictEqual(e.labels, ['tipo:recomendacion']);
    assert.strictEqual(e.motivo, 'recomendaciones-corte-transitorio');
    assert.strictEqual(e.title, '[guru] algo');
    const raw = fs.readFileSync(path.join(dir, 'audit', fs.readdirSync(path.join(dir, 'audit'))[0]), 'utf8');
    assert.ok(!raw.includes('SECRETO-P37'), 'SEC-4: el body no entra a la auditoría');
    assert.ok(!raw.includes('gh issue create'), 'SEC-4: el comando completo no entra a la auditoría');
});

test('P-37: bloquea -l, --label=, gh issue edit --add-label y gh api labels[]=', () => {
    const cmds = [
        'gh issue create -l Source:Recommendation -t x',
        'gh issue create --label=tipo:recomendacion',
        'gh issue edit 12 --add-label tipo:recomendacion',
        "gh api repos/o/r/issues -f title=x -f 'labels[]=source:recommendation'",
    ];
    for (const c of cmds) {
        const r = runHook(bash(c), sandbox(OFF));
        assert.strictEqual(r.status, 2, c);
    }
});

test('P-37: bandera "true" (string) o config ausente ⇒ bloquea igual (fail-closed)', () => {
    assert.strictEqual(runHook(bash('gh issue create -l tipo:recomendacion'), sandbox('recomendaciones:\n  crear_issues: "true"\n')).status, 2);
    assert.strictEqual(runHook(bash('gh issue create -l tipo:recomendacion'), sandbox(null)).status, 2);
    assert.strictEqual(runHook(bash('gh issue create -l tipo:recomendacion'), sandbox('::: yaml roto [')).status, 2);
});

test('P-37: con crear_issues: true no bloquea (reversible sin tocar código)', () => {
    const dir = sandbox(ON);
    const r = runHook(bash('gh issue create --label "tipo:recomendacion,source:recommendation"'), dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(auditLines(dir), []);
});

test('P-37: no bloquea comandos ajenos', () => {
    const cmds = [
        'gh issue list --label tipo:recomendacion',
        'gh issue edit 5 --add-label priority:low',
        'git commit -m "tipo:recomendacion"',
        'gh issue create --label enhancement --title x',
        'ls -la',
    ];
    for (const c of cmds) {
        const dir = sandbox(OFF);
        const r = runHook(bash(c), dir);
        assert.strictEqual(r.status, 0, `${c}: ${r.stderr}`);
        assert.deepStrictEqual(auditLines(dir), [], c);
    }
});

test('P-37: herramientas que no son Bash no se tocan', () => {
    const r = runHook({ tool_name: 'Write', tool_input: { content: 'gh issue create -l tipo:recomendacion' } }, sandbox(OFF));
    assert.strictEqual(r.status, 0);
});

test('P-37: excepción interna (stdin inválido / forma rara) ⇒ exit 0, no bloquea Bash', () => {
    assert.strictEqual(runHook('{esto no es json', sandbox(OFF)).status, 0);
    assert.strictEqual(runHook('', sandbox(OFF)).status, 0);
    assert.strictEqual(runHook({ tool_name: 'Bash', tool_input: null }, sandbox(OFF)).status, 0);
    assert.strictEqual(runHook({ tool_name: 'Bash', tool_input: { command: 42 } }, sandbox(OFF)).status, 0);
});

test('P-37: sin destino de auditoría resoluble igual bloquea', () => {
    const dir = sandbox(OFF);
    // writeAudit con un dir imposible no tira y devuelve false.
    const { writeAudit } = require(HOOK);
    const archivo = path.join(dir, 'no-es-dir');
    fs.writeFileSync(archivo, 'x');
    assert.strictEqual(writeAudit({ kind: 'create', labels: ['tipo:recomendacion'], title: null }, { dir: path.join(archivo, 'sub') }), false);
});

test('P-37: el hook está registrado en .claude/settings.json como PreToolUse[Bash]', () => {
    const settings = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'settings.json'), 'utf8'));
    const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
    const bashHooks = pre.filter((h) => h.matcher === 'Bash').flatMap((h) => h.hooks || []);
    assert.ok(bashHooks.some((h) => /recommendation-guard\.js/.test(h.command)), 'recommendation-guard.js debe estar registrado');
});
