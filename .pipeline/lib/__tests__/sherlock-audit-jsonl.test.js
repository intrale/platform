// =============================================================================
// sherlock-audit-jsonl.test.js — Tests del writer del audit JSONL (issue #3896)
//
// Cobertura de los criterios de aceptación CA-1..CA-5 (CA-6 = cableado en
// sherlock-verifier, fuera de scope de este unit test):
//   - CA-1/CA-2 append-only: cada escritura suma EXACTAMENTE 1 línea, hash
//     chain (`verifyChain`) intacta tras N escrituras.
//   - CA-3 / SEC-2 redacción: `ghp_` de 40 chars exactos, `github_pat_*`
//     fine-grained, AWS `AKIA…` → los tres ausentes del archivo final.
//     No-env: ningún path serializa `process.env`.
//   - CA-4 / SEC-3 log forging: claim con `\n`/`\r` → 1 sola línea, control
//     chars escapados (no salto real).
//   - CA-5 / SEC-4 path traversal: session con `../`, `..\`, separador
//     absoluto, NUL, `%2e%2e` → rechazado SIN crear archivo.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const writer = require('../sherlock-audit-jsonl');
const { verifyChain, readAll } = require('../audit-log');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function freshPipelineDir() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-audit-'));
    // El writer escribe en <pipelineDir>/audit/.
    return base;
}

function auditFile(pipelineDir, session) {
    return path.join(pipelineDir, 'audit', `sherlock-${session}.jsonl`);
}

function readLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
}

function baseRecord(overrides = {}) {
    return {
        timestamp: '2026-06-10T00:00:00.000Z',
        claim: '#3896/entregable_en_main',
        canonical_command: 'git branch --all --merged origin/main --list *agent/3896-*',
        stdout: 'agent/3896-pipeline-dev',
        stderr: null,
        resultado: 'true',
        commander_vs_sherlock: 'consistent',
        resolucion: 'accepted',
        ...overrides,
    };
}

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — append-only + hash chain
// -----------------------------------------------------------------------------

test('CA-2: cada escritura agrega exactamente 1 línea y verifyChain queda intacto', () => {
    const dir = freshPipelineDir();
    const session = 'sess1';
    const file = auditFile(dir, session);

    for (let i = 0; i < 5; i++) {
        writer.appendSherlockAudit({
            session,
            pipelineDir: dir,
            record: baseRecord({ claim: `#3896/claim_${i}` }),
        });
        assert.equal(readLines(file).length, i + 1, `tras ${i + 1} escrituras hay ${i + 1} líneas`);
    }

    const chain = verifyChain(file);
    assert.equal(chain.ok, true, 'hash chain íntegra');
    assert.equal(chain.entriesChecked, 5);
});

test('CA-1: el registro persiste el shape canónico completo', () => {
    const dir = freshPipelineDir();
    const session = 'shape';
    writer.appendSherlockAudit({ session, pipelineDir: dir, record: baseRecord() });

    const [entry] = readAll(auditFile(dir, session));
    for (const k of ['timestamp', 'claim', 'canonical_command', 'stdout', 'stderr',
        'resultado', 'commander_vs_sherlock', 'resolucion']) {
        assert.ok(k in entry, `el registro tiene la clave ${k}`);
    }
    assert.equal(entry.resultado, 'true');
    assert.equal(entry.resolucion, 'accepted');
    assert.equal(entry.commander_vs_sherlock, 'consistent');
    // appendChained agrega la cadena de integridad.
    assert.ok(typeof entry.hash_self === 'string' && entry.hash_self.length > 0);
    assert.ok('hash_prev' in entry);
});

test('CA-1: timestamp ausente se completa con un default (no rompe el shape)', () => {
    const dir = freshPipelineDir();
    const session = 'tsdef';
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ timestamp: undefined }),
    });
    const [entry] = readAll(auditFile(dir, session));
    assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 0);
});

// -----------------------------------------------------------------------------
// #3921 CA-3 / SEC-3 — el record canónico persiste `same_provider`
// -----------------------------------------------------------------------------

test('#3921 CA-3: el record canónico persiste same_provider:true cuando el veredicto fue same-provider (incl. último recurso)', () => {
    const dir = freshPipelineDir();
    const session = 'sp-true';
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ same_provider: true }),
    });
    const [entry] = readAll(auditFile(dir, session));
    assert.equal(entry.same_provider, true, 'same_provider=true persistido en el record canónico');
});

test('#3921 CA-3: same_provider:false persistido cuando la verificación fue cross-provider', () => {
    const dir = freshPipelineDir();
    const session = 'sp-false';
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ same_provider: false }),
    });
    const [entry] = readAll(auditFile(dir, session));
    assert.equal(entry.same_provider, false, 'same_provider=false persistido (cuenta en el denominador del %)');
});

test('#3921 CA-3: callers viejos sin same_provider NO contaminan el record con un false espurio', () => {
    const dir = freshPipelineDir();
    const session = 'sp-absent';
    writer.appendSherlockAudit({ session, pipelineDir: dir, record: baseRecord() });
    const [entry] = readAll(auditFile(dir, session));
    assert.ok(!('same_provider' in entry), 'sin el campo, no se agrega un false espurio que falsearía el %');
});

// -----------------------------------------------------------------------------
// CA-3 / SEC-2 — no-fuga de secrets
// -----------------------------------------------------------------------------

test('SEC-2: ghp_ de 40 chars exactos → redactado', () => {
    const dir = freshPipelineDir();
    const session = 'ghp40';
    // ghp_ (4) + 36 alfanum = 40 chars exactos (el caso frágil del fallback de entropía).
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'; // 4 + 36 = 40
    assert.equal(token.length, 40, 'precondición: token de 40 chars');

    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ stdout: `el token es ${token} fin` }),
    });

    const raw = fs.readFileSync(auditFile(dir, session), 'utf8');
    assert.ok(!raw.includes(token), 'el ghp_ de 40 chars NO aparece en claro');
});

test('SEC-2: github_pat_* fine-grained → redactado', () => {
    const dir = freshPipelineDir();
    const session = 'ghpat';
    // github_pat_ + 22 + _ + 59 ~= formato fine-grained real.
    const token = 'github_pat_11ABCDE0Y0' + 'a'.repeat(60);
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ claim: `commander dijo: usa ${token}` }),
    });
    const raw = fs.readFileSync(auditFile(dir, session), 'utf8');
    assert.ok(!raw.includes(token), 'el github_pat_* NO aparece en claro');
});

test('SEC-2: AWS AKIA… → redactado', () => {
    const dir = freshPipelineDir();
    const session = 'aws';
    const key = 'AKIAIOSFODNN7EXAMPLE'; // AKIA + 16 = 20 chars
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ stderr: `creds: ${key}` }),
    });
    const raw = fs.readFileSync(auditFile(dir, session), 'utf8');
    assert.ok(!raw.includes(key), 'la AWS access key NO aparece en claro');
});

test('SEC-2: los tres secretos en un solo registro → ninguno en claro', () => {
    const dir = freshPipelineDir();
    const session = 'mix';
    const ghp = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'; // 40
    const ghpat = 'github_pat_22ZZZZ' + 'b'.repeat(70);
    const akia = 'AKIAABCDEFGHIJKLMNOP';
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({
            claim: `claim con ${ghp}`,
            canonical_command: `gh con ${ghpat}`,
            stdout: `out con ${akia}`,
        }),
    });
    const raw = fs.readFileSync(auditFile(dir, session), 'utf8');
    assert.ok(!raw.includes(ghp));
    assert.ok(!raw.includes(ghpat));
    assert.ok(!raw.includes(akia));
});

test('SEC-2: el writer nunca serializa process.env aunque el record lo intente colar', () => {
    const dir = freshPipelineDir();
    const session = 'noenv';
    // El record solo expone los 8 campos canónicos. Un campo extra (env) NO se
    // copia al entry: el writer toma claves explícitas.
    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: { ...baseRecord(), env: JSON.stringify(process.env), secretField: 'X' },
    });
    const [entry] = readAll(auditFile(dir, session));
    assert.ok(!('env' in entry), 'el campo env NO se persiste');
    assert.ok(!('secretField' in entry), 'campos arbitrarios NO se persisten');
});

test('SEC-2: redactAll es null-safe e idempotente', () => {
    assert.equal(writer.redactAll(null), null);
    assert.equal(writer.redactAll(undefined), undefined);
    const token = 'ghp_' + 'a'.repeat(36);
    const once = writer.redactAll(`x ${token} y`);
    const twice = writer.redactAll(once);
    assert.ok(!once.includes(token));
    assert.equal(once, twice, 'idempotente: redactar dos veces no cambia');
});

// -----------------------------------------------------------------------------
// CA-4 / SEC-3 — log forging
// -----------------------------------------------------------------------------

test('SEC-3: claim con \\n y \\r → exactamente 1 línea, control chars escapados', () => {
    const dir = freshPipelineDir();
    const session = 'forge';
    const file = auditFile(dir, session);
    const malicious = 'claim real\n{"hash_self":"FORJADO","resultado":"true"}\rmás texto';

    writer.appendSherlockAudit({
        session, pipelineDir: dir,
        record: baseRecord({ claim: malicious }),
    });

    const lines = readLines(file);
    assert.equal(lines.length, 1, 'una sola línea: el \\n no forjó una entrada nueva');

    const raw = fs.readFileSync(file, 'utf8');
    // El \n embebido aparece escapado como literal `\n`, no como salto real.
    assert.ok(raw.includes('\\n'), 'el \\n quedó escapado');
    // La entrada parsea y el claim conserva el contenido (sin forja de hash).
    const [entry] = readAll(file);
    assert.ok(entry.claim.includes('claim real'));
    assert.notEqual(entry.hash_self, 'FORJADO', 'el hash NO fue forjado por la inyección');
});

// -----------------------------------------------------------------------------
// CA-5 / SEC-4 — path traversal
// -----------------------------------------------------------------------------

const TRAVERSAL_SESSIONS = [
    '../escape',
    '..\\escape',
    '/etc/passwd',
    'C:\\Windows\\system32',
    'a/b',
    'a\0b',
    '%2e%2e/secret',
    'with.dot',
    'with space',
    '',
    'x'.repeat(65), // excede el cap de 64
];

for (const bad of TRAVERSAL_SESSIONS) {
    test(`SEC-4: session inválida ${JSON.stringify(bad)} → rechazada sin crear archivo`, () => {
        const dir = freshPipelineDir();
        const auditDir = path.join(dir, 'audit');
        assert.throws(() => {
            writer.appendSherlockAudit({ session: bad, pipelineDir: dir, record: baseRecord() });
        }, /SEC-4|inválida|fuera/);
        // Fail-closed: NO se crea ni el directorio audit/ ni archivo alguno.
        const created = fs.existsSync(auditDir)
            ? fs.readdirSync(auditDir)
            : [];
        assert.deepEqual(created, [], 'no se creó ningún archivo de audit');
    });
}

test('SEC-4: session no-string → rechazada', () => {
    const dir = freshPipelineDir();
    assert.throws(() => {
        writer.appendSherlockAudit({ session: 12345, pipelineDir: dir, record: baseRecord() });
    }, /SEC-4|inválida/);
});

test('SEC-4: resolveAuditFile acepta sesiones válidas y resuelve dentro de audit/', () => {
    const dir = freshPipelineDir();
    const file = writer.resolveAuditFile('valid_Session-123', dir);
    const auditDir = path.resolve(dir, 'audit');
    assert.ok(file.startsWith(auditDir + path.sep), 'el path cae dentro de audit/');
    assert.ok(file.endsWith(`sherlock-valid_Session-123.jsonl`));
});

test('SEC-4: pipelineDir ausente → throw', () => {
    assert.throws(() => writer.resolveAuditFile('ok', ''), /pipelineDir/);
});

// -----------------------------------------------------------------------------
// Validación de inputs
// -----------------------------------------------------------------------------

test('record ausente o no-objeto → throw sin crear archivo', () => {
    const dir = freshPipelineDir();
    assert.throws(() => writer.appendSherlockAudit({ session: 'ok', pipelineDir: dir }), /record/);
    assert.throws(() => writer.appendSherlockAudit({ session: 'ok', pipelineDir: dir, record: [] }), /record/);
    assert.equal(fs.existsSync(path.join(dir, 'audit')), false);
});
