'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../lib/agent-models-validate');
const { buildMatrixFromAgentModels } = require('../lib/multi-provider/smoke-test');
const config = require('../agent-models.json');

test('la baja conserva exactamente tres proveedores LLM y cobertura Codex por skill', () => {
    const matrix = buildMatrixFromAgentModels(config);
    assert.deepEqual([...new Set(matrix.map(cell => cell.provider))].sort(),
        ['anthropic', 'gemini-google', 'openai-codex']);
    for (const skill of new Set(matrix.map(cell => cell.skill))) {
        assert.ok(matrix.some(cell => cell.skill === skill &&
            cell.provider === 'openai-codex' && cell.eligible), skill);
    }
});

test('Gemini conserva billing free y sigue admitido después del vencimiento anterior', () => {
    const gemini = config.providers['gemini-google'];
    assert.equal(gemini.billing, 'free');
    assert.equal(gemini.admission.exception.issue, 6564);
    for (const date of ['2026-09-16', '2026-11-01']) {
        const result = validator.validate(undefined, { now: new Date(`${date}T00:00:00Z`) });
        assert.equal(result.ok, true, JSON.stringify(result.errors));
    }
    for (const provider of Object.values(config.providers)) {
        assert.notEqual(provider.admission?.exception?.issue, 6563);
    }
});

// CA-4 — el plan de rollback (§17.2 de docs/pipeline/multi-provider.md) tiene
// que ser ejecutable tal como está escrito. Dos pasadas de QA y una de review
// lo rebotaron por citar scripts inexistentes y por elegir el SHA equivocado.
test('CA-4 · cada script citado en el plan de rollback §17.2 existe en el repo', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'pipeline', 'multi-provider.md'), 'utf8');
    const start = doc.indexOf('### 17.2 Comandos');
    const end = doc.indexOf('### 17.3', start);
    assert.ok(start > 0 && end > start, 'la sección 17.2 existe y precede a 17.3');
    const section = doc.slice(start, end);
    const cited = [...section.matchAll(/^(?:node|bash) (\.pipeline\/[\w./-]+\.(?:js|sh))/gm)].map(m => m[1]);
    assert.ok(cited.length >= 4, `la sección cita scripts: ${cited.join(', ')}`);
    for (const rel of cited) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', rel)), `${rel} no existe`);
    }
});

test('CA-4 · el plan de rollback no elige SHA_BAJA con git log --grep | tail -1 y verifica el SHA', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'pipeline', 'multi-provider.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### 17.2 Comandos'), doc.indexOf('### 17.3'));
    // `--grep '#6563'` también matchea #7295 y #7307; `tail -1` devuelve el más antiguo.
    assert.doesNotMatch(section, /git log[^\n]*--grep '#6563'[^\n]*\| tail -1/);
    assert.match(section, /closedByPullRequestsReferences/, 'SHA_BAJA sale del PR que cerró el issue');
    assert.match(section, /git diff --diff-filter=D[^\n]*"\$SHA_BAJA\^" "\$SHA_BAJA"/, 'sanidad sobre el diff del merge');
    // kimi-moonshot nunca tuvo quota-adapter: el checkout es condicional.
    assert.match(section, /git cat-file -e "\$SHA_BAJA\^:\$f"/);
});

// CA-4 (rebote QA #2) — el paso 4 del plan (heredoc `node - <<'EOF'`) se ejecuta
// textualmente contra un repo sintético con dos commits: A tiene al proveedor
// X en `providers` y en un fallback; B (= SHA_BAJA) lo borra. En Windows
// `execSync` corre por cmd.exe, donde `^` es escape: `git show SHA^:ruta`
// llegaba como `SHA:ruta` (estado post-baja) y el script moría con
// TypeError sobre `prev.providers[X]`. El test reproduce ese escenario real.
test('CA-4 · el paso 4 del plan de rollback corre tal cual contra un merge sintético (Windows incluido)', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { execFileSync, spawnSync } = require('node:child_process');
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'pipeline', 'multi-provider.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### 17.2 Comandos'), doc.indexOf('### 17.3'));
    const m = section.match(/^X=\$X SHA_BAJA=\$SHA_BAJA node - <<'EOF'\r?\n([\s\S]*?)^EOF\r?$/m);
    assert.ok(m, 'el paso 4 es un heredoc `node -` con X y SHA_BAJA en el entorno');
    const script = m[1];

    const X = 'nvidia-nim';
    const before = {
        providers: {
            anthropic: { billing: 'paid', admission: { status: 'admitted' } },
            [X]: { billing: 'free', admission: { status: 'admitted' } },
        },
        skills: {
            'pipeline-dev': { fallbacks: [{ provider: 'anthropic' }, { provider: X }] },
            qa: { fallbacks: [{ provider: 'anthropic' }] },
        },
    };
    const after = JSON.parse(JSON.stringify(before));
    delete after.providers[X];
    after.skills['pipeline-dev'].fallbacks.pop();

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-6563-'));
    try {
        const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const jsonPath = path.join(repo, '.pipeline', 'agent-models.json');
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        git('init', '-q');
        git('config', 'user.email', 'test@intrale.local');
        git('config', 'user.name', 'test');
        fs.writeFileSync(jsonPath, JSON.stringify(before, null, 2));
        git('add', '-A');
        git('commit', '-q', '-m', 'A: con el proveedor');
        fs.writeFileSync(jsonPath, JSON.stringify(after, null, 2));
        git('add', '-A');
        git('commit', '-q', '-m', 'B: baja del proveedor');
        const shaBaja = git('rev-parse', 'HEAD');

        const run = spawnSync(process.execPath, ['-'], {
            cwd: repo, input: script, encoding: 'utf8',
            env: { ...process.env, X, SHA_BAJA: shaBaja },
        });
        assert.equal(run.status, 0, `el paso 4 falló:\n${run.stderr}`);

        const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        assert.ok(result.providers[X], 'el bloque providers.<x> se repuso desde SHA_BAJA^');
        assert.equal(result.providers[X].billing, 'free');
        assert.equal(result.providers[X].admission.status, 'admitted');
        assert.ok(result.providers[X].admission.exception, 'lleva excepción de admisión');
        assert.deepEqual(result.providers[X].admission.exception.issue, 0, 'placeholder de issue nuevo');
        assert.deepEqual(result.skills['pipeline-dev'].fallbacks.map(f => f.provider), ['anthropic', X],
            'vuelve al final de la cadena donde estaba');
        assert.deepEqual(result.skills.qa.fallbacks.map(f => f.provider), ['anthropic'],
            'no se agrega a cadenas donde no estaba');
        assert.deepEqual(result.providers.anthropic, before.providers.anthropic);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});
