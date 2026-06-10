// =============================================================================
// sherlock-audit-jsonl.test.js — Suite del writer del audit JSONL (#3896).
//
// Cubre los criterios de aceptación CA-1..CA-5 y los requisitos de seguridad
// NO NEGOCIABLES SEC-2/3/4:
//   - append-only + hash chain intacta tras N escrituras (CA-2).
//   - SEC-2 (3 casos): `ghp_` de 40 chars exactos, `github_pat_*` fine-grained,
//     AWS `AKIA…` → los tres AUSENTES del archivo final.
//   - SEC-2 no-env: el writer nunca serializa `process.env`.
//   - SEC-3 log forging: claim con `\n`/`\r` → 1 sola línea física, control
//     chars escapados (no salto real).
//   - SEC-4 path traversal: `../`, `..\`, separador absoluto, NUL, `%2e%2e`,
//     largo > 64, vacío → rechazados SIN crear archivo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    appendSherlockAudit,
    redactAll,
    resolveAuditFile,
    SESSION_RE,
    AUDIT_SUBDIR,
} = require('./sherlock-audit-jsonl');
const { verifyChain } = require('./audit-log');

// --- helpers -----------------------------------------------------------------

function tmpPipelineDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-audit-'));
}

function auditDirOf(pipelineDir) {
    return path.join(pipelineDir, AUDIT_SUBDIR);
}

function readLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
}

function baseRecord(extra = {}) {
    return {
        timestamp: '2026-06-10T12:00:00.000Z',
        claim: '#3896/entregable_en_main',
        canonical_command: 'git ls-tree origin/main .pipeline/lib/x.js',
        stdout: 'true',
        stderr: null,
        resultado: 'true',
        commander_vs_sherlock: 'consistent',
        resolucion: 'accepted',
        ...extra,
    };
}

// Tokens de prueba (NO son secrets reales — formatos sintéticos para el test).
const GHP_40 = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // 4 + 36 = 40 chars
const GITHUB_PAT_FG = 'github_pat_' + '11ABCDEFG0' + 'aZ9'.repeat(20) + 'xY'; // > 50 cuerpo
const AWS_AKIA = 'AKIAIOSFODNN7EXAMPLE'; // AKIA + 16 = 20 chars

// --- CA-1 / CA-2: shape + append-only + hash chain ---------------------------

test('CA-1 — el registro persiste todos los campos canónicos', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sess123';
    appendSherlockAudit({ session, pipelineDir, record: baseRecord() });

    const file = resolveAuditFile(session, pipelineDir);
    const lines = readLines(file);
    assert.strictEqual(lines.length, 1, 'una sola línea tras un append');
    const entry = JSON.parse(lines[0]);
    for (const k of ['timestamp', 'claim', 'canonical_command', 'stdout', 'stderr',
        'resultado', 'commander_vs_sherlock', 'resolucion']) {
        assert.ok(k in entry, `falta el campo ${k}`);
    }
    assert.strictEqual(entry.resultado, 'true');
    assert.strictEqual(entry.resolucion, 'accepted');
    assert.strictEqual(entry.commander_vs_sherlock, 'consistent');
    // appendChained agrega la cadena de integridad.
    assert.ok('hash_self' in entry && 'hash_prev' in entry && 'created_at' in entry);
});

test('CA-2 — append-only: cada escritura suma exactamente 1 línea y la chain queda intacta', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'chain-test';
    const file = resolveAuditFile(session, pipelineDir);

    const N = 5;
    for (let i = 0; i < N; i++) {
        appendSherlockAudit({
            session, pipelineDir,
            record: baseRecord({ claim: `#${3896 + i}/issue_cerrado` }),
        });
        assert.strictEqual(readLines(file).length, i + 1, `tras ${i + 1} writes hay ${i + 1} líneas`);
    }

    const v = verifyChain(file);
    assert.strictEqual(v.ok, true, `hash chain intacta: ${v.reason || ''}`);
    assert.strictEqual(v.entriesChecked, N);
});

// --- CA-3 / SEC-2: no-fuga de secrets ----------------------------------------

test('SEC-2 — `ghp_` de 40 chars exactos se redacta (ausente del archivo)', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec2ghp';
    assert.strictEqual(GHP_40.length, 40, 'el fixture debe medir 40 chars');
    appendSherlockAudit({
        session, pipelineDir,
        record: baseRecord({ stdout: `salida con token ${GHP_40} embebido` }),
    });
    const raw = fs.readFileSync(resolveAuditFile(session, pipelineDir), 'utf8');
    assert.ok(!raw.includes(GHP_40), 'el ghp_ no debe aparecer en claro');
});

test('SEC-2 — `github_pat_*` fine-grained se redacta (ausente del archivo)', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec2pat';
    assert.ok(GITHUB_PAT_FG.length > 50);
    appendSherlockAudit({
        session, pipelineDir,
        record: baseRecord({ claim: `claim con ${GITHUB_PAT_FG}` }),
    });
    const raw = fs.readFileSync(resolveAuditFile(session, pipelineDir), 'utf8');
    assert.ok(!raw.includes(GITHUB_PAT_FG), 'el github_pat_ no debe aparecer en claro');
});

test('SEC-2 — AWS AKIA… se redacta (ausente del archivo)', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec2aws';
    appendSherlockAudit({
        session, pipelineDir,
        record: baseRecord({ stderr: `error AWS key ${AWS_AKIA} denied` }),
    });
    const raw = fs.readFileSync(resolveAuditFile(session, pipelineDir), 'utf8');
    assert.ok(!raw.includes(AWS_AKIA), 'la AWS key no debe aparecer en claro');
});

test('SEC-2 — los tres tokens juntos en un mismo registro se redactan', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec2all';
    appendSherlockAudit({
        session, pipelineDir,
        record: baseRecord({
            claim: `claim ${GHP_40}`,
            canonical_command: `gh api ${GITHUB_PAT_FG}`,
            stdout: `out ${AWS_AKIA}`,
        }),
    });
    const raw = fs.readFileSync(resolveAuditFile(session, pipelineDir), 'utf8');
    assert.ok(!raw.includes(GHP_40));
    assert.ok(!raw.includes(GITHUB_PAT_FG));
    assert.ok(!raw.includes(AWS_AKIA));
});

test('SEC-2 — el writer nunca serializa process.env', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec2env';
    // Sembramos un valor reconocible en el entorno del test.
    const marker = 'SENTINEL_ENV_VALUE_9f3a';
    process.env.SHERLOCK_AUDIT_TEST_ENV = marker;
    try {
        appendSherlockAudit({ session, pipelineDir, record: baseRecord() });
        const raw = fs.readFileSync(resolveAuditFile(session, pipelineDir), 'utf8');
        const entry = JSON.parse(raw.trim());
        assert.ok(!('env' in entry), 'no debe existir un campo env');
        assert.ok(!raw.includes(marker), 'ningún valor de process.env debe filtrarse');
        // El shape de claves es cerrado y conocido.
        const keys = Object.keys(entry).sort();
        assert.deepStrictEqual(keys, [
            'canonical_command', 'claim', 'commander_vs_sherlock', 'created_at',
            'hash_prev', 'hash_self', 'resolucion', 'resultado', 'stderr',
            'stdout', 'timestamp',
        ]);
    } finally {
        delete process.env.SHERLOCK_AUDIT_TEST_ENV;
    }
});

test('redactAll — null/undefined se devuelven tal cual (null-safe)', () => {
    assert.strictEqual(redactAll(null), null);
    assert.strictEqual(redactAll(undefined), undefined);
    assert.strictEqual(redactAll('texto limpio'), 'texto limpio');
    assert.ok(!redactAll(`x ${GHP_40} y`).includes(GHP_40));
});

// --- CA-4 / SEC-3: log forging -----------------------------------------------

test('SEC-3 — claim con `\\n`/`\\r` no forja entradas (1 sola línea, escapado)', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'sec3forge';
    const file = resolveAuditFile(session, pipelineDir);

    appendSherlockAudit({
        session, pipelineDir,
        record: baseRecord({
            claim: 'línea1\nFORJADA: {"hash_self":"fake"}\r\notra',
        }),
    });

    // El archivo gana EXACTAMENTE 1 línea física pese a los \n embebidos.
    assert.strictEqual(readLines(file).length, 1);
    const raw = fs.readFileSync(file, 'utf8');
    // El salto embebido aparece ESCAPADO (\n literal), no como salto real.
    assert.ok(raw.includes('\\n'), 'el newline embebido debe quedar escapado como \\n');
    // Una segunda escritura sigue sumando 1 sola línea (no se rompió el conteo).
    appendSherlockAudit({ session, pipelineDir, record: baseRecord() });
    assert.strictEqual(readLines(file).length, 2);
    assert.strictEqual(verifyChain(file).ok, true);
});

// --- CA-5 / SEC-4: path traversal --------------------------------------------

test('SEC-4 — sesiones maliciosas son rechazadas SIN crear archivo', () => {
    const badSessions = [
        '../etc',
        '..\\windows',
        '/abs/path',
        'a/b',
        'a\\b',
        'a'+String.fromCharCode(0)+'b',          // NUL
        '%2e%2e',
        'dots..dots',        // contiene '.'
        '',                  // vacío
        'x'.repeat(65),      // > 64
        'tab\tname',
        'space name',
    ];
    for (const session of badSessions) {
        const pipelineDir = tmpPipelineDir();
        assert.throws(
            () => appendSherlockAudit({ session, pipelineDir, record: baseRecord() }),
            /SEC-4|session inválida/,
            `debió rechazar session=${JSON.stringify(session)}`,
        );
        // Fail-closed: no se creó ni el dir de audit ni archivo alguno.
        const auditDir = auditDirOf(pipelineDir);
        const created = fs.existsSync(auditDir) ? fs.readdirSync(auditDir) : [];
        assert.deepStrictEqual(created, [], `no debió crear archivos para ${JSON.stringify(session)}`);
    }
});

test('SEC-4 — resolveAuditFile acepta sesiones válidas y arma el path dentro de audit/', () => {
    const pipelineDir = tmpPipelineDir();
    const file = resolveAuditFile('Valid_session-123', pipelineDir);
    assert.ok(file.startsWith(auditDirOf(pipelineDir) + path.sep));
    assert.ok(file.endsWith('sherlock-Valid_session-123.jsonl'));
});

test('SEC-4 — pipelineDir inválido es rechazado', () => {
    assert.throws(() => resolveAuditFile('ok', ''), /pipelineDir/);
    assert.throws(() => resolveAuditFile('ok', null), /pipelineDir/);
});

test('SESSION_RE — allowlist exacta', () => {
    assert.ok(SESSION_RE.test('abc'));
    assert.ok(SESSION_RE.test('A-b_9'));
    assert.ok(!SESSION_RE.test('a.b'));
    assert.ok(!SESSION_RE.test('a/b'));
    assert.ok(!SESSION_RE.test(''));
    assert.ok(!SESSION_RE.test('x'.repeat(65)));
});

// --- validación de argumentos ------------------------------------------------

test('appendSherlockAudit — record inválido es rechazado', () => {
    const pipelineDir = tmpPipelineDir();
    for (const bad of [null, undefined, 'str', 42, [1, 2]]) {
        assert.throws(
            () => appendSherlockAudit({ session: 'ok', pipelineDir, record: bad }),
            /record requerido/,
        );
    }
});

test('appendSherlockAudit — timestamp ausente usa default ISO', () => {
    const pipelineDir = tmpPipelineDir();
    const session = 'nots';
    const rec = baseRecord();
    delete rec.timestamp;
    appendSherlockAudit({ session, pipelineDir, record: rec });
    const entry = JSON.parse(readLines(resolveAuditFile(session, pipelineDir))[0]);
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
