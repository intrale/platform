// Tests de `.pipeline/lib/secrets-guard.js` (#5245, TRAMO 3 de #5218).
//
// TODO se corre con `spawnImpl` / `fsImpl` inyectados: ningún test toca el repo
// real ni escribe en `.pipeline/secrets-health.json`.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const guard = require('../secrets-guard');
const { REDACTION_MARKER } = require('../redact');

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

const FAKE_ROOT = '/fake/repo';
const FAKE_WT2 = '/fake/worktrees/agent-1234';
const OUTSIDE_DIR = '/fake/home/.claude/secrets';

function norm(p) {
    return path.resolve(p);
}

/**
 * fsImpl de mentira.
 * @param {object} opts
 * @param {string[]} [opts.existing] paths que existen
 * @param {object}   [opts.links]    origen -> destino de realpath (symlinks)
 * @param {string[]} [opts.realpathFails] paths cuyo realpath tira
 */
function makeFs({ existing = [], links = {}, realpathFails = [] } = {}) {
    const existSet = new Set(existing.map(norm));
    const linkMap = new Map(Object.entries(links).map(([k, v]) => [norm(k), norm(v)]));
    const failSet = new Set(realpathFails.map(norm));
    // Los destinos de un symlink también existen.
    for (const dest of linkMap.values()) existSet.add(dest);

    return {
        existsSync(p) { return existSet.has(norm(p)); },
        realpathSync(p) {
            const key = norm(p);
            if (failSet.has(key)) {
                const err = new Error(`ENOENT: no such file or directory, realpath '${p}'`);
                err.code = 'ENOENT';
                throw err;
            }
            if (linkMap.has(key)) return linkMap.get(key);
            if (existSet.has(key)) return key;
            const err = new Error(`ENOENT: no such file or directory, realpath '${p}'`);
            err.code = 'ENOENT';
            throw err;
        },
        readFileSync() { throw new Error('no usado'); },
        writeFileSync() { throw new Error('no usado'); },
    };
}

function porcelain(roots) {
    return roots.map((r) => `worktree ${r}\nHEAD abc123\nbranch refs/heads/x\n`).join('\n');
}

/** spawnImpl que devuelve un `git worktree list --porcelain` fijo y cuenta llamadas. */
function makeSpawn(roots, counter = { calls: 0 }) {
    const impl = () => {
        counter.calls += 1;
        return { status: 0, stdout: porcelain(roots), stderr: '' };
    };
    impl.counter = counter;
    return impl;
}

/** Manifiesto de mentira: sólo `telegram.bot_token` es secreto. */
const fakeManifest = {
    load: () => ({
        entries: [
            { name: 'telegram.bot_token' },
            { name: 'telegram.chat_id' },
            { name: 'providers.openai.api_key' },
        ],
    }),
};

const TG_CONFIG = `${FAKE_ROOT}/.claude/hooks/telegram-config.json`;
const OUTSIDE_CREDS = `${OUTSIDE_DIR}/credentials.json`;

function baseFs(extra = {}) {
    return makeFs({
        existing: [
            FAKE_ROOT,
            FAKE_WT2,
            OUTSIDE_DIR,
            OUTSIDE_CREDS,
            TG_CONFIG,
            `${FAKE_ROOT}/.gitignored/secret.json`,
            `${FAKE_WT2}/.claude/hooks/telegram-config.json`,
            ...(extra.existing || []),
        ],
        links: extra.links,
        realpathFails: extra.realpathFails,
    });
}

/** Opciones comunes: siempre manifiesto y worktrees inyectados. */
function opts(extra = {}) {
    return {
        fsImpl: extra.fsImpl || baseFs(),
        spawnImpl: extra.spawnImpl || makeSpawn([FAKE_ROOT, FAKE_WT2]),
        manifestImpl: fakeManifest,
        platform: extra.platform || 'linux',
        testMode: extra.testMode === undefined ? false : extra.testMode,
        log: extra.log || (() => {}),
        ...extra,
    };
}

beforeEach(() => guard.resetForTests());
afterEach(() => guard.resetForTests());

// -----------------------------------------------------------------------------
// CA-10 · un test por vector
// -----------------------------------------------------------------------------

describe('CA-10 · classifyOrigin — un vector por test', () => {
    it('origen fuera del repo pasa', () => {
        const o = opts();
        assert.equal(guard.classifyOrigin(OUTSIDE_CREDS, o), 'outside');
        const r = guard.assertSecretOrigin(OUTSIDE_CREDS, {
            ...o, secret: 'telegram.bot_token', strict: true,
        });
        assert.equal(r.ok, true);
        assert.equal(guard.getCounters().in_repo_reads, 0);
    });

    it('origen trackeado por git (el caso real telegram-config.json) rechaza', () => {
        const o = opts();
        assert.equal(guard.classifyOrigin(TG_CONFIG, o), 'in_repo');
    });

    it('origen in-repo pero gitignored rechaza igual (defensa en profundidad)', () => {
        const o = opts();
        // El guard no consulta el índice de git a propósito: lo que decide es
        // dónde vive el archivo, no si está versionado.
        assert.equal(guard.classifyOrigin(`${FAKE_ROOT}/.gitignored/secret.json`, o), 'in_repo');
    });

    it('symlink que apunta hacia adentro del repo rechaza', () => {
        const link = `${OUTSIDE_DIR}/link-a-repo.json`;
        const o = opts({
            fsImpl: baseFs({ links: { [link]: TG_CONFIG } }),
        });
        assert.equal(guard.classifyOrigin(link, o), 'in_repo');
    });

    it('casing distinto en win32 (NTFS case-insensitive) rechaza', () => {
        const upper = `${FAKE_ROOT.toUpperCase()}/.claude/hooks/telegram-config.json`;
        const o = opts({
            platform: 'win32',
            fsImpl: baseFs({ existing: [upper] }),
        });
        assert.equal(guard.classifyOrigin(upper, o), 'in_repo');
    });

    it('el mismo casing distinto NO rechaza en linux (case-sensitive de verdad)', () => {
        const upper = `${FAKE_ROOT.toUpperCase()}/.claude/hooks/telegram-config.json`;
        const o = opts({
            platform: 'linux',
            fsImpl: baseFs({ existing: [upper] }),
        });
        assert.equal(guard.classifyOrigin(upper, o), 'outside');
    });

    it('origen indeterminado (error de fs) rechaza — default deny', () => {
        const o = opts({
            fsImpl: baseFs({ realpathFails: [TG_CONFIG] }),
        });
        assert.equal(guard.classifyOrigin(TG_CONFIG, o), 'undetermined');
    });

    it('sin listado de worktrees el origen es indeterminado, no "outside"', () => {
        const failSpawn = () => { throw new Error('git no está en el PATH'); };
        const o = opts({ spawnImpl: failSpawn });
        assert.equal(guard.classifyOrigin(OUTSIDE_CREDS, o), 'undetermined');
    });

    it('cubre TODOS los worktrees, no sólo el toplevel', () => {
        const o = opts();
        assert.equal(
            guard.classifyOrigin(`${FAKE_WT2}/.claude/hooks/telegram-config.json`, o),
            'in_repo',
        );
    });

    it('un path hermano con prefijo parecido NO es in-repo (/repo-backup vs /repo)', () => {
        const hermano = `${FAKE_ROOT}-backup/telegram-config.json`;
        const o = opts({ fsImpl: baseFs({ existing: [hermano] }) });
        assert.equal(guard.classifyOrigin(hermano, o), 'outside');
    });
});

describe("CA-10 · op: 'write' rechaza igual que 'read'", () => {
    it('escritura sobre un archivo in-repo rechaza (vector api-keys-guardian, P-1)', () => {
        // `.claude/hooks/api-keys-guardian.js` reinyecta las API keys HACIA
        // ADENTRO de este archivo. No se migra en esta historia, pero el vector
        // queda cubierto por el guard.
        const o = opts();
        assert.equal(guard.classifyOrigin(TG_CONFIG, { ...o, op: 'write' }), 'in_repo');
        assert.throws(
            () => guard.assertSecretOrigin(TG_CONFIG, {
                ...o, op: 'write', secret: 'providers.openai.api_key', strict: true,
            }),
            (e) => e instanceof guard.SecretOriginError && e.code === 'SECRET_ORIGIN_IN_REPO',
        );
    });

    it('hoja inexistente FUERA del repo pasa (primera escritura del store canónico)', () => {
        // El store todavía no existe en una máquina limpia: eso no es
        // "indeterminado", es el caso normal.
        const o = opts();
        assert.equal(
            guard.classifyOrigin(`${OUTSIDE_DIR}/credentials-nuevo.json`, { ...o, op: 'write' }),
            'outside',
        );
    });

    it('ancestro irresoluble en escritura rechaza', () => {
        const o = opts({ fsImpl: makeFs({ existing: [FAKE_ROOT, FAKE_WT2] }) });
        assert.equal(
            guard.classifyOrigin('/no/existe/nada/creds.json', { ...o, op: 'write' }),
            'undetermined',
        );
    });
});

// -----------------------------------------------------------------------------
// CA-10a · clasificación por (archivo, clave)
// -----------------------------------------------------------------------------

describe('CA-10a · clasifica por (archivo, clave), no por archivo', () => {
    it('clave operativa sobre el MISMO archivo in-repo pasa y no cuenta', () => {
        const o = opts();
        const r = guard.assertSecretOrigin(TG_CONFIG, {
            ...o, secret: 'quiet_hours', strict: true,
        });
        assert.equal(r.ok, true);
        assert.equal(r.origin, 'not_a_secret');
        assert.equal(guard.getCounters().in_repo_reads, 0);
    });

    it('clave secreta sobre el MISMO archivo in-repo rechaza y cuenta', () => {
        const o = opts();
        const r = guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        assert.equal(r.ok, false);
        assert.equal(r.origin, 'in_repo');
        assert.equal(guard.getCounters().in_repo_reads, 1);
        assert.equal(guard.getCounters().distinct_sources, 1);
    });

    it("el parámetro 'secret' es obligatorio", () => {
        assert.throws(() => guard.assertSecretOrigin(TG_CONFIG, opts()), TypeError);
        assert.throws(() => guard.assertSecretOrigin(TG_CONFIG, { ...opts(), secret: '  ' }), TypeError);
    });

    it('si el manifiesto no se puede leer, todo dot-path se trata como secreto (fail-closed)', () => {
        const roto = { load: () => { throw new Error('manifiesto ilegible'); } };
        const o = opts();
        const r = guard.assertSecretOrigin(TG_CONFIG, {
            ...o, manifestImpl: roto, secret: 'quiet_hours',
        });
        assert.equal(r.ok, false);
        assert.equal(r.origin, 'in_repo');
    });
});

// -----------------------------------------------------------------------------
// CA-11 · strict vs warn, dedup, memoización
// -----------------------------------------------------------------------------

describe('CA-11 · strict es opt-in por env', () => {
    it('con PIPELINE_SECRETS_GUARD_STRICT=1 lanza SecretOriginError', () => {
        const previo = process.env[guard.STRICT_ENV];
        process.env[guard.STRICT_ENV] = '1';
        try {
            const o = opts();
            delete o.strict;
            assert.throws(
                () => guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' }),
                (e) => e instanceof guard.SecretOriginError,
            );
        } finally {
            if (previo === undefined) delete process.env[guard.STRICT_ENV];
            else process.env[guard.STRICT_ENV] = previo;
        }
    });

    it('sin la variable (modo warn) loguea y NO tira', () => {
        const previo = process.env[guard.STRICT_ENV];
        delete process.env[guard.STRICT_ENV];
        try {
            const lineas = [];
            const o = opts({ log: (l) => lineas.push(l) });
            delete o.strict;
            const r = guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
            assert.equal(r.ok, false);
            assert.equal(r.strict, false);
            assert.equal(lineas.length, 1);
        } finally {
            if (previo !== undefined) process.env[guard.STRICT_ENV] = previo;
        }
    });

    it('un valor distinto de "1" NO activa strict (comparación estricta)', () => {
        const previo = process.env[guard.STRICT_ENV];
        process.env[guard.STRICT_ENV] = 'true';
        try {
            const o = opts();
            delete o.strict;
            const r = guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
            assert.equal(r.ok, false);
        } finally {
            if (previo === undefined) delete process.env[guard.STRICT_ENV];
            else process.env[guard.STRICT_ENV] = previo;
        }
    });
});

describe('CA-11 · dedup por (secreto, archivo) y memoización de worktrees', () => {
    it('dos llamadas con el mismo par cuentan una sola vez', () => {
        const lineas = [];
        const o = opts({ log: (l) => lineas.push(l) });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        assert.equal(guard.getCounters().in_repo_reads, 1);
        assert.equal(lineas.length, 1, 'el warn tampoco se repite');
    });

    it('dos secretos distintos sobre el mismo archivo cuentan dos veces, con una sola fuente', () => {
        const o = opts();
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.chat_id' });
        const c = guard.getCounters();
        assert.equal(c.in_repo_reads, 2);
        assert.equal(c.distinct_sources, 1);
    });

    it('`git worktree list` se invoca UNA sola vez por proceso', () => {
        const counter = { calls: 0 };
        const spawnImpl = makeSpawn([FAKE_ROOT, FAKE_WT2], counter);
        const o = opts({ spawnImpl });
        // Paths fuera del root real: obligan a consultar el listado de worktrees.
        guard.assertSecretOrigin(OUTSIDE_CREDS, { ...o, secret: 'telegram.bot_token' });
        guard.assertSecretOrigin(`${FAKE_WT2}/.claude/hooks/telegram-config.json`, {
            ...o, secret: 'telegram.chat_id',
        });
        guard.classifyOrigin(TG_CONFIG, o);
        assert.equal(counter.calls, 1);
    });

    it('instrumented_sites cuenta call sites distintos', () => {
        const o = opts();
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token', site: 'a' });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.chat_id', site: 'a' });
        guard.assertSecretOrigin(OUTSIDE_CREDS, { ...o, secret: 'telegram.bot_token', site: 'b' });
        assert.equal(guard.getCounters().instrumented_sites, 2);
    });
});

// -----------------------------------------------------------------------------
// CA-11a · allowlist de fixtures, con su test negativo
// -----------------------------------------------------------------------------

describe('CA-11a · allowlist de fixtures: las DOS condiciones', () => {
    it('fixture bajo __tests__ Y corrida de test: pasa', () => {
        const p = `${FAKE_ROOT}/.pipeline/lib/__tests__/fixture-creds.json`;
        assert.equal(guard.isFixtureAllowlisted(p, { testMode: true }), true);
        const o = opts({ fsImpl: baseFs({ existing: [p] }), testMode: true });
        const r = guard.assertSecretOrigin(p, { ...o, secret: 'telegram.bot_token', strict: true });
        assert.equal(r.ok, true);
        assert.equal(r.origin, 'fixture_allowlisted');
    });

    it('fixture bajo __tests__ SIN corrida de test: NO pasa', () => {
        const p = `${FAKE_ROOT}/.pipeline/lib/__tests__/fixture-creds.json`;
        assert.equal(guard.isFixtureAllowlisted(p, { testMode: false }), false);
    });

    it('NEGATIVO: la allowlist no cubre un path fuera de tests aunque sea corrida de test', () => {
        assert.equal(guard.isFixtureAllowlisted(TG_CONFIG, { testMode: true }), false);
        const o = opts({ testMode: true });
        assert.throws(
            () => guard.assertSecretOrigin(TG_CONFIG, {
                ...o, secret: 'telegram.bot_token', strict: true,
            }),
            guard.SecretOriginError,
        );
    });

    it('NEGATIVO: un segmento que sólo CONTIENE "fixtures" no alcanza', () => {
        const p = `${FAKE_ROOT}/mis-fixtures-viejos/creds.json`;
        assert.equal(guard.isFixtureAllowlisted(p, { testMode: true }), false);
    });
});

// -----------------------------------------------------------------------------
// CA-7d + U-1 + U-2 · mensajes
// -----------------------------------------------------------------------------

describe('CA-7d · la salida del guard no lleva material derivado del valor', () => {
    it('el mensaje nombra el archivo y el dot-path, y redacta cualquier valor embebido', () => {
        const conToken = `${FAKE_ROOT}/tmp/sk-ant-api03-AAAAAAAAAAAAAAAAAAAA/creds.json`;
        const o = opts({ fsImpl: baseFs({ existing: [conToken] }) });
        let capturado = null;
        try {
            guard.assertSecretOrigin(conToken, {
                ...o, secret: 'telegram.bot_token', strict: true,
            });
        } catch (e) { capturado = e; }
        assert.ok(capturado instanceof guard.SecretOriginError);
        assert.ok(capturado.message.includes('telegram.bot_token'), 'nombra el dot-path');
        assert.ok(!capturado.message.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'), 'no filtra el valor');
        assert.ok(capturado.message.includes(REDACTION_MARKER), 'el valor embebido queda redactado');
    });

    it('el error no expone ni la longitud ni un hash del valor', () => {
        const o = opts();
        let capturado = null;
        try {
            guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token', strict: true });
        } catch (e) { capturado = e; }
        assert.ok(!/len=|length=|sha256|md5|hash=/i.test(capturado.message));
        assert.equal(typeof capturado.details, 'object');
    });
});

describe('U-1 · el mensaje de strict tiene las cuatro partes y distingue los dos casos', () => {
    function mensaje(origenIndeterminado) {
        const o = origenIndeterminado
            ? opts({ fsImpl: baseFs({ realpathFails: [TG_CONFIG] }) })
            : opts();
        try {
            guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token', strict: true });
        } catch (e) { return e; }
        return null;
    }

    it('in_repo: cuatro partes + runbook + issue de activación', () => {
        const e = mensaje(false);
        for (const parte of ['qué pasó', 'qué frena', 'cómo se arregla', 'cómo sigue']) {
            assert.ok(e.message.includes(parte), `falta la parte "${parte}"`);
        }
        assert.ok(e.message.includes(guard.RUNBOOK));
        assert.ok(e.message.includes(guard.ACTIVATION_ISSUE));
        assert.ok(e.message.includes(guard.STRICT_ENV));
    });

    it('undetermined: texto DISTINTO y code distinto', () => {
        const inRepo = mensaje(false);
        const indet = mensaje(true);
        assert.equal(inRepo.code, 'SECRET_ORIGIN_IN_REPO');
        assert.equal(indet.code, 'SECRET_ORIGIN_UNDETERMINED');
        assert.notEqual(inRepo.message, indet.message);
        assert.ok(indet.message.includes('NO se pudo determinar'));
        assert.ok(!inRepo.message.includes('NO se pudo determinar'));
    });
});

describe('U-2 · el warn es UNA línea con prefijo estable', () => {
    it('sin saltos de línea, con el prefijo declarado y contable con grep', () => {
        const lineas = [];
        const o = opts({ log: (l) => lineas.push(l) });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        assert.equal(lineas.length, 1);
        const linea = lineas[0];
        assert.ok(linea.startsWith(guard.WARN_PREFIX), 'prefijo estable');
        assert.ok(!linea.includes('\n'), 'una sola línea');
        assert.ok(linea.includes('in-repo-read'));
        assert.ok(linea.includes('telegram.bot_token'));
        assert.ok(linea.includes('telegram-config.json'));
        assert.ok(linea.includes('no se frenó nada'), 'aclara que todavía no cortó nada');
        assert.ok(linea.includes(guard.RUNBOOK));
    });

    it('el warn de origen indeterminado usa otro slug', () => {
        const lineas = [];
        const o = opts({
            log: (l) => lineas.push(l),
            fsImpl: baseFs({ realpathFails: [TG_CONFIG] }),
        });
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        assert.ok(lineas[0].includes('origen-indeterminado-read'));
    });
});

// -----------------------------------------------------------------------------
// D-6 · persistencia de la métrica
// -----------------------------------------------------------------------------

describe('D-6 · contadores persistidos en secrets-health.json', () => {
    function memFs(initial) {
        const store = new Map();
        if (initial) store.set(norm('/fake/health.json'), JSON.stringify(initial));
        return {
            store,
            existsSync: (p) => store.has(norm(p)),
            readFileSync: (p) => {
                if (!store.has(norm(p))) throw new Error('ENOENT');
                return store.get(norm(p));
            },
            writeFileSync: (p, data) => { store.set(norm(p), data); },
        };
    }

    it('escribe sólo números bajo la clave migration, sin ningún path', () => {
        const fsImpl = memFs();
        const o = opts();
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        const res = guard.flushCounters({ targetPath: '/fake/health.json', fsImpl });
        assert.equal(res.ok, true);
        const doc = JSON.parse(fsImpl.store.get(norm('/fake/health.json')));
        const m = doc[guard.HEALTH_MIGRATION_KEY];
        assert.equal(m.in_repo_reads, 1);
        assert.equal(m.distinct_sources, 1);
        assert.equal(typeof m.instrumented_sites, 'number');
        assert.ok(!JSON.stringify(m).includes('telegram-config.json'), 'ningún path en la métrica');
    });

    it('el denominador sin medir vale -1, nunca 0 (no habilita el corte por accidente)', () => {
        const fsImpl = memFs();
        guard.flushCounters({ targetPath: '/fake/health.json', fsImpl });
        const doc = JSON.parse(fsImpl.store.get(norm('/fake/health.json')));
        assert.equal(doc[guard.HEALTH_MIGRATION_KEY].uninstrumented_readers, -1);
    });

    it('acumula entre procesos y preserva el resto del documento', () => {
        const fsImpl = memFs({
            ok: true,
            counts: { ok: 3 },
            migration: { in_repo_reads: 4, distinct_sources: 2, uninstrumented_readers: 50 },
        });
        const o = opts();
        guard.assertSecretOrigin(TG_CONFIG, { ...o, secret: 'telegram.bot_token' });
        guard.flushCounters({ targetPath: '/fake/health.json', fsImpl });
        const doc = JSON.parse(fsImpl.store.get(norm('/fake/health.json')));
        assert.equal(doc.ok, true, 'no pisa lo que escribió el health-check de #5243');
        assert.deepEqual(doc.counts, { ok: 3 });
        assert.equal(doc[guard.HEALTH_MIGRATION_KEY].in_repo_reads, 5);
        assert.equal(doc[guard.HEALTH_MIGRATION_KEY].uninstrumented_readers, 50);
    });

    it('resetHealthCounters pone el numerador en cero y conserva el denominador', () => {
        const fsImpl = memFs({
            migration: { in_repo_reads: 9, distinct_sources: 3, uninstrumented_readers: 48 },
        });
        guard.resetHealthCounters({ targetPath: '/fake/health.json', fsImpl });
        const m = JSON.parse(fsImpl.store.get(norm('/fake/health.json')))[guard.HEALTH_MIGRATION_KEY];
        assert.equal(m.in_repo_reads, 0);
        assert.equal(m.distinct_sources, 0);
        assert.equal(m.uninstrumented_readers, 48);
        assert.equal(typeof m.ts_reset, 'string');
    });

    it('un fs que falla no tumba al llamador', () => {
        const roto = {
            existsSync: () => { throw new Error('fs roto'); },
            readFileSync: () => { throw new Error('fs roto'); },
            writeFileSync: () => { throw new Error('fs roto'); },
        };
        const res = guard.flushCounters({ targetPath: '/fake/health.json', fsImpl: roto });
        assert.equal(res.ok, false);
        assert.equal(typeof res.error, 'string');
    });
});

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

describe('isSubPath', () => {
    it('un path es subpath de sí mismo', () => {
        assert.equal(guard.isSubPath('/a/b', '/a/b', 'linux'), true);
    });
    it('exige separador: /repo-backup no está adentro de /repo', () => {
        assert.equal(guard.isSubPath('/repo-backup/x', '/repo', 'linux'), false);
    });
    it('en win32 ignora el casing', () => {
        assert.equal(guard.isSubPath('/Repo/X/y.json', '/repo/x', 'win32'), true);
        assert.equal(guard.isSubPath('/Repo/X/y.json', '/repo/x', 'linux'), false);
    });
});
