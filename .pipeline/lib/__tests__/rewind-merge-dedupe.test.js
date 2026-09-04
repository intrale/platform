// =============================================================================
// rewind-merge-dedupe.test.js — Barrera dura de idempotencia (#4967 CA-9).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dedupe = require('../rewind-merge-dedupe');

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const TUPLE = Object.freeze({ repo: 'intrale/platform', pr: 4967, headRefOid: OID_A });

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-dedupe-'));
    fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
    return root;
}

// -----------------------------------------------------------------------------
// Validación de la tupla (fail-closed)
// -----------------------------------------------------------------------------

test('normalizeTuple acepta la tupla canónica y normaliza el pr a número', () => {
    const t = dedupe.normalizeTuple({ repo: 'intrale/platform', pr: '4967', headRefOid: OID_A });
    assert.deepEqual(t, { repo: 'intrale/platform', pr: 4967, headRefOid: OID_A });
});

test('normalizeTuple rechaza repo fuera del charset de GitHub', () => {
    for (const repo of ['../../etc', 'intrale/plat form', 'sin-slash', 'a/b/c', '', null, 42]) {
        assert.throws(
            () => dedupe.normalizeTuple({ repo, pr: 1, headRefOid: OID_A }),
            (e) => e.code === 'DEDUPE_REPO_INVALID',
            `repo ${JSON.stringify(repo)} debería ser rechazado`,
        );
    }
});

test('normalizeTuple rechaza pr no entero positivo', () => {
    for (const pr of [0, -1, 1.5, 'abc', null, undefined, {}]) {
        assert.throws(
            () => dedupe.normalizeTuple({ repo: 'intrale/platform', pr, headRefOid: OID_A }),
            (e) => e.code === 'DEDUPE_PR_INVALID',
        );
    }
});

test('normalizeTuple rechaza headRefOid que no sea hex de 7..64', () => {
    for (const oid of ['', 'zzzz', 'ABCDEF0', 'a'.repeat(6), 'a'.repeat(65), null, 12345]) {
        assert.throws(
            () => dedupe.normalizeTuple({ repo: 'intrale/platform', pr: 1, headRefOid: oid }),
            (e) => e.code === 'DEDUPE_OID_INVALID',
        );
    }
});

// -----------------------------------------------------------------------------
// Path traversal (CA-6): el nombre de archivo NUNCA deriva de `repo`
// -----------------------------------------------------------------------------

test('CA-6: la clave es sha256 hex — repo hostil no puede escapar del directorio', () => {
    const root = sandbox();
    // El repo hostil ni siquiera pasa la validación...
    assert.throws(() => dedupe.claim({ repo: '../../etc', pr: 1, headRefOid: OID_A }, root));
    // ...y aun con un repo válido, el archivo es hexadecimal puro.
    const r = dedupe.claim(TUPLE, root, { issue: 4967 });
    const base = path.basename(r.file);
    assert.match(base, /^[0-9a-f]{64}\.json$/);
    // El archivo queda estrictamente dentro del store.
    const store = path.resolve(dedupe.dedupeDir(root));
    assert.ok(path.resolve(r.file).startsWith(store + path.sep));
    // Y el `repo` original sigue disponible adentro del JSON, donde no es path.
    assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).repo, 'intrale/platform');
});

test('la clave depende de los tres componentes de la tupla', () => {
    const base = dedupe.dedupeKey(TUPLE);
    assert.notEqual(base, dedupe.dedupeKey({ ...TUPLE, pr: 4968 }));
    assert.notEqual(base, dedupe.dedupeKey({ ...TUPLE, headRefOid: OID_B }));
    assert.notEqual(base, dedupe.dedupeKey({ ...TUPLE, repo: 'intrale/otro' }));
    // Determinística: misma tupla, misma clave.
    assert.equal(base, dedupe.dedupeKey({ ...TUPLE }));
});

// -----------------------------------------------------------------------------
// Atomicidad + colisión + SHA nuevo
// -----------------------------------------------------------------------------

test('claim escribe la entrada y un segundo claim de la MISMA tupla no reclama', () => {
    const root = sandbox();
    const first = dedupe.claim(TUPLE, root, { issue: 4967, now: () => 1000 });
    assert.equal(first.claimed, true);
    assert.ok(fs.existsSync(first.file));

    const second = dedupe.claim(TUPLE, root, { issue: 4967, now: () => 2000 });
    assert.equal(second.claimed, false);
    assert.equal(second.existing.claimed_at, 1000, 'no debe pisar el claim original');
});

test('un headRefOid nuevo es un evento nuevo (no colisiona)', () => {
    const root = sandbox();
    assert.equal(dedupe.claim(TUPLE, root, { issue: 4967 }).claimed, true);
    assert.equal(dedupe.claim({ ...TUPLE, headRefOid: OID_B }, root, { issue: 4967 }).claimed, true);
    assert.equal(dedupe.has({ ...TUPLE, headRefOid: OID_B }, root).headRefOid, OID_B);
});

test('claim deja el archivo íntegro (no queda .tmp colgado del write atómico)', () => {
    const root = sandbox();
    dedupe.claim(TUPLE, root, { issue: 4967 });
    const entries = fs.readdirSync(dedupe.dedupeDir(root));
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].endsWith('.tmp'));
});

// -----------------------------------------------------------------------------
// Reinicio simulado (relee de disco, no de memoria)
// -----------------------------------------------------------------------------

test('reinicio simulado: el claim sobrevive a un require limpio del módulo', () => {
    const root = sandbox();
    dedupe.claim(TUPLE, root, { issue: 4967 });

    // Simula el reinicio del Pulpo: se descarta el módulo del cache y se vuelve
    // a cargar. Si el estado viviera en memoria, acá se perdería.
    delete require.cache[require.resolve('../rewind-merge-dedupe')];
    const fresh = require('../rewind-merge-dedupe');

    assert.ok(fresh.has(TUPLE, root), 'tras el reinicio la tupla sigue reclamada');
    assert.equal(fresh.claim(TUPLE, root, { issue: 4967 }).claimed, false);
});

// -----------------------------------------------------------------------------
// has(): ausencia, TTL y corrupción
// -----------------------------------------------------------------------------

test('has devuelve null cuando la tupla nunca se reclamó', () => {
    assert.equal(dedupe.has(TUPLE, sandbox()), null);
});

test('has devuelve null cuando el store ni siquiera existe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-dedupe-vacio-'));
    assert.equal(dedupe.has(TUPLE, root), null);
});

test('has respeta el TTL: un claim vencido deja pasar el evento de nuevo', () => {
    const root = sandbox();
    dedupe.claim(TUPLE, root, { issue: 4967, now: () => 0 });
    assert.ok(dedupe.has(TUPLE, root, { now: () => 500, ttlMs: 1000 }));
    assert.equal(dedupe.has(TUPLE, root, { now: () => 5000, ttlMs: 1000 }), null);
});

test('entrada corrupta se trata como RECLAMADA (fail-closed hacia "una sola transición")', () => {
    const root = sandbox();
    const file = dedupe.dedupeFile(TUPLE, root);
    fs.mkdirSync(dedupe.dedupeDir(root), { recursive: true });
    fs.writeFileSync(file, '{ esto no es json');

    const hit = dedupe.has(TUPLE, root);
    assert.ok(hit, 'una entrada ilegible no puede reabrir la ventana de duplicado');
    assert.equal(hit.corrupt, true);
    assert.equal(dedupe.claim(TUPLE, root, { issue: 4967 }).claimed, false);
});

// -----------------------------------------------------------------------------
// markOutcome / prune
// -----------------------------------------------------------------------------

test('markOutcome anota el desenlace sin liberar el claim', () => {
    const root = sandbox();
    dedupe.claim(TUPLE, root, { issue: 4967 });
    assert.equal(dedupe.markOutcome(TUPLE, root, 'done'), true);

    const hit = dedupe.has(TUPLE, root);
    assert.equal(hit.outcome, 'done');
    assert.equal(dedupe.claim(TUPLE, root, { issue: 4967 }).claimed, false, 'sigue reclamada');
});

test('markOutcome sobre una tupla no reclamada devuelve false y no crea nada', () => {
    const root = sandbox();
    assert.equal(dedupe.markOutcome(TUPLE, root, 'done'), false);
    assert.equal(dedupe.has(TUPLE, root), null);
});

test('prune borra sólo las entradas vencidas', () => {
    const root = sandbox();
    dedupe.claim(TUPLE, root, { issue: 4967, now: () => 0 });
    dedupe.claim({ ...TUPLE, headRefOid: OID_B }, root, { issue: 4967, now: () => 10_000 });

    const removed = dedupe.prune(root, { now: () => 11_000, ttlMs: 5_000 });
    assert.equal(removed, 1);
    assert.equal(dedupe.has(TUPLE, root, { ttlMs: 0 }), null, 'la vieja se borró');
    assert.ok(dedupe.has({ ...TUPLE, headRefOid: OID_B }, root, { now: () => 11_000, ttlMs: 5_000 }));
});

test('prune no borra entradas corruptas (borrarlas reabriría el duplicado)', () => {
    const root = sandbox();
    fs.mkdirSync(dedupe.dedupeDir(root), { recursive: true });
    fs.writeFileSync(dedupe.dedupeFile(TUPLE, root), 'basura');
    assert.equal(dedupe.prune(root, { now: () => 10 ** 12, ttlMs: 1 }), 0);
    assert.ok(dedupe.has(TUPLE, root));
});

// -----------------------------------------------------------------------------
// fsImpl inyectable (el store no obliga a tocar disco real en tests ajenos)
// -----------------------------------------------------------------------------

test('acepta un fsImpl inyectado sin caer al write atómico de waves', () => {
    const escrituras = [];
    const fake = {
        readFileSync: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
        mkdirSync: () => {},
        writeFileSync: (f, d) => escrituras.push([f, d]),
    };
    const r = dedupe.claim(TUPLE, '/no/existe', { fsImpl: fake, issue: 4967, now: () => 7 });
    assert.equal(r.claimed, true);
    assert.equal(escrituras.length, 1);
    assert.equal(JSON.parse(escrituras[0][1]).claimed_at, 7);
});
