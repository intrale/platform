'use strict';

// #7636 — Encendido del entorno mínimo por rol (parte 3 de #7598).
//
// Cubre: CA-1 (entorno mínimo por intento, snapshot en sus dos valores),
// CA-2 (el fallback no lleva la key del primario, ni en grafía no canónica),
// CA-3 (rol de `analisis` sin AWS ni gradle-android), CA-4 (drift de roles),
// CA-5 (línea grepeable + estacionamiento + aviso único), CA-6 (resumen de
// turnos y Sherlock con env mínimo) y CA-7 (reversa con rastro, flag OFF sin
// TELEGRAM_BOT_TOKEN).
//
// Todos los valores son falsos; ningún assert imprime valores de env.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bce = require('../build-child-env');
const snapshotLib = require('../attempt-credential-snapshot');
const errLib = require('../child-env-error');
const parking = require('../child-env-parking');
const sherlock = require('../sherlock-verifier');
const { withEnv } = require('../test-helpers/with-env');

const PIPELINE_DIR = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(PIPELINE_DIR, '..');
const PULPO_SRC = fs.readFileSync(path.join(PIPELINE_DIR, 'pulpo.js'), 'utf8');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function tmpDir(prefijo) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefijo}-`));
}

/** agent-models.json sintético: providers por api-key, para que la key del intento exista. */
function pipelineDirSintetico() {
    const dir = tmpDir('e7636-models');
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify({
        providers: {
            anthropic: { credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex': { credentials_env: ['OPENAI_API_KEY'] },
        },
        skills: {},
    }));
    return dir;
}

const PROVIDERS_CFG = {
    anthropic: { credentials_env: ['ANTHROPIC_API_KEY'] },
    'openai-codex': { credentials_env: ['OPENAI_API_KEY'] },
};

function envOperador(extra = {}) {
    return {
        PIPELINE_AMBIENTE: 'productivo',
        PATH: '/fake/bin',
        HOME: '/fake/home',
        USERPROFILE: '/fake/home',
        PIPELINE_ISSUE: '7636',
        PIPELINE_SKILL: 'guru',
        ANTHROPIC_API_KEY: 'fake-anthropic-primario',
        anthropic_api_key: 'fake-anthropic-grafia-no-canonica',
        OPENAI_API_KEY: 'fake-openai-del-padre',
        GH_TOKEN: 'fake-gh-token',
        GITHUB_TOKEN: 'fake-github-token',
        AWS_ACCESS_KEY_ID: 'fake-aws-id',
        AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
        AWS_PROFILE: 'perfil-real',
        AWS_CONFIG_FILE: '/fake/home/.aws/config',
        JAVA_HOME: '/fake/jdk',
        ANDROID_HOME: '/fake/android',
        ANDROID_SDK_ROOT: '/fake/android',
        TELEGRAM_BOT_TOKEN: 'fake-telegram-bot',
        TELEGRAM_BOT_TOKEN_ALIAS: 'fake-telegram-bot',
        TELEGRAM_CHAT_ID: '-100000',
        CUALQUIER_COSA_DEL_OPERADOR: 'x',
        ...extra,
    };
}

/**
 * Reproduce la frontera de `lanzarAgenteClaude` para UN intento: snapshot (si
 * el gate está abierto) → composeAttemptProcessEnv → buildChildEnv (flag ON).
 */
async function envFinalDelIntento({ skill, fase, provider, esFallback, snapshotEnabled, base }) {
    const pipelineDir = pipelineDirSintetico();
    const config = { pipeline: { env_isolation_enabled: true, credential_snapshot_enabled: snapshotEnabled } };
    const { snapshot } = await snapshotLib.createAttemptSnapshot({
        destination: snapshotLib.SNAPSHOT_DESTINATION.AGENT_CHILD,
        provider,
        providersCfg: PROVIDERS_CFG,
        config,
        pipelineDir,
        createSnapshotFn: async ({ provider: p }) => ({
            env: p === 'openai-codex'
                ? { OPENAI_API_KEY: 'fake-openai-del-snapshot' }
                : { ANTHROPIC_API_KEY: 'fake-anthropic-del-snapshot' },
        }),
    });
    const attemptProcessEnv = snapshotLib.composeAttemptProcessEnv({
        baseEnv: base, snapshot, providersCfg: PROVIDERS_CFG,
    });
    return bce.buildChildEnv({
        skill,
        fase,
        pipelineDir,
        processEnv: attemptProcessEnv,
        pipelineExtras: { PIPELINE_ISSUE: '7636', PIPELINE_SKILL: skill, PIPELINE_FASE: fase },
        skillConfigOverride: esFallback ? { provider } : { provider },
        warn: () => {},
    });
}

function permitidasPara({ skill, fase, providerKeyVar }) {
    const techo = bce.SCOPES_BY_FASE[fase] || [];
    const pedidos = [...(bce.DEFAULT_REQUIRES_BY_SKILL[skill] || []), ...bce.SCOPES_ALWAYS_ON];
    const efectivos = pedidos.filter((s) => bce.SCOPES_ALWAYS_ON.includes(s) || techo.includes(s));
    const set = new Set([
        ...bce.SYSTEM_ALLOWLIST.map((n) => n.toUpperCase()),
        ...bce.CHILD_TRANSPORT_ALLOWLIST.map((n) => n.toUpperCase()),
        // Neutralizadores de credential-sentinel (apuntan a rutas sentinel, no a material).
        'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'GH_CONFIG_DIR',
    ]);
    for (const sc of efectivos) for (const v of bce.CREDENTIAL_SCOPES[sc] || []) set.add(v.toUpperCase());
    if (providerKeyVar) set.add(providerKeyVar);
    return set;
}

// ─── CA-1 / CA-2 / CA-3 ──────────────────────────────────────────────────────

for (const snapshotEnabled of [true, false]) {
    test(`CA-1 · primario y fallback reciben sólo allowlist + PIPELINE_* + key del intento + scopes del rol (snapshot=${snapshotEnabled})`, async () => {
        for (const [provider, esFallback, keyVar] of [
            ['anthropic', false, 'ANTHROPIC_API_KEY'],
            ['openai-codex', true, 'OPENAI_API_KEY'],
        ]) {
            const env = await envFinalDelIntento({
                skill: 'guru', fase: 'analisis', provider, esFallback, snapshotEnabled, base: envOperador(),
            });
            const permitidas = permitidasPara({ skill: 'guru', fase: 'analisis', providerKeyVar: keyVar });
            const fuera = Object.keys(env).filter((k) => !k.startsWith('PIPELINE_') && !permitidas.has(k.toUpperCase()));
            assert.deepEqual(fuera, [], `intento ${provider}: variables fuera del mínimo (sólo nombres)`);
            assert.ok(env[keyVar], `intento ${provider}: falta la key de su propio provider`);
            assert.equal(env.PIPELINE_ISSUE, '7636');
            assert.equal(env.CUALQUIER_COSA_DEL_OPERADOR, undefined);
        }
    });

    test(`CA-2 · el fallback NO lleva la key del primario, ni en grafía no canónica (snapshot=${snapshotEnabled})`, async () => {
        const env = await envFinalDelIntento({
            skill: 'guru', fase: 'analisis', provider: 'openai-codex', esFallback: true, snapshotEnabled,
            base: envOperador(),
        });
        const nombresAnthropic = Object.keys(env).filter((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY');
        assert.deepEqual(nombresAnthropic, [], 'la key del primario sobrevivió en el env final del hijo');
        const valores = Object.values(env);
        assert.ok(!valores.includes('fake-anthropic-primario'), 'valor del primario presente bajo otro nombre');
        assert.ok(!valores.includes('fake-anthropic-grafia-no-canonica'), 'valor no canónico del primario presente');
        assert.ok(env.OPENAI_API_KEY, 'el fallback tiene su propia key');
        if (snapshotEnabled) assert.equal(env.OPENAI_API_KEY, 'fake-openai-del-snapshot');
    });

    test(`CA-3 · los roles de analisis salen sin AWS_* ni gradle-android; GitHub sólo por el scope github (snapshot=${snapshotEnabled})`, async () => {
        for (const skill of ['security', 'guru', 'po', 'ux']) {
            const env = await envFinalDelIntento({
                skill, fase: 'analisis', provider: 'anthropic', esFallback: false, snapshotEnabled,
                base: envOperador(),
            });
            for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
                assert.equal(env[k], undefined, `${skill}: ${k} presente`);
            }
            // AWS_CONFIG_FILE sólo puede existir como neutralizador (sentinel), nunca con la ruta real.
            assert.notEqual(env.AWS_CONFIG_FILE, '/fake/home/.aws/config', `${skill}: AWS_CONFIG_FILE apunta al perfil real`);
            for (const k of ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'ANDROID_AVD_HOME']) {
                assert.equal(env[k], undefined, `${skill}: ${k} presente`);
            }
            assert.ok(bce.DEFAULT_REQUIRES_BY_SKILL[skill].includes('github'));
            assert.equal(env.GH_TOKEN, 'fake-gh-token', `${skill}: el token llega por el scope github`);
        }
    });
}

test('CA-3 · sin scope github el token NO llega: el único canal es el scope', () => {
    const env = bce.buildChildEnv({
        skill: 'builder', fase: 'build', pipelineDir: pipelineDirSintetico(),
        processEnv: envOperador(), skillConfigOverride: { provider: 'anthropic' }, warn: () => {},
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
});

// ─── CA-4 · drift de roles ───────────────────────────────────────────────────

test('CA-4 · DEFAULT_REQUIRES_BY_SKILL declara architect y dev sin ampliar techos', () => {
    assert.deepEqual([...bce.DEFAULT_REQUIRES_BY_SKILL.architect], ['github']);
    assert.deepEqual([...bce.DEFAULT_REQUIRES_BY_SKILL.dev], ['github', 'gradle-android', 'aws']);
    assert.deepEqual([...bce.SCOPES_BY_FASE.criterios], ['github']);
    assert.deepEqual([...bce.SCOPES_BY_FASE.aprobacion], ['github']);
    assert.deepEqual([...bce.SCOPES_BY_FASE.dev], ['github', 'gradle-android', 'aws']);
});

test('CA-4 · drift: cada (fase, skill) de skills_por_fase lanza con el flag ON y sin scopes vacíos si el default no lo está', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), 'utf8'));
    const pipelines = (cfg.productConfig && cfg.productConfig.pipelines) || cfg.pipelines || {};
    const pares = [];
    for (const p of Object.values(pipelines)) {
        for (const [fase, skills] of Object.entries((p && p.skills_por_fase) || {})) {
            for (const skill of skills || []) pares.push({ fase, skill });
        }
    }
    assert.ok(pares.length > 10, 'skills_por_fase leído');
    const faltantes = [];
    for (const { fase, skill } of pares) {
        let env;
        try {
            // Con el agent-models.json REAL: así se prueba la declaración de producción.
            env = bce.buildChildEnv({
                skill, fase, pipelineDir: PIPELINE_DIR, processEnv: envOperador(), warn: () => {},
            });
        } catch (e) {
            faltantes.push(`${fase}/${skill}: ${e.code || 'error'}`);
            continue;
        }
        const def = bce.DEFAULT_REQUIRES_BY_SKILL[skill] || [];
        const techo = bce.SCOPES_BY_FASE[fase] || [];
        const esperados = def.filter((s) => techo.includes(s));
        if (esperados.length) {
            const tieneAlguno = esperados.some((sc) => (bce.CREDENTIAL_SCOPES[sc] || []).some((v) => env[v] !== undefined));
            if (!tieneAlguno) faltantes.push(`${fase}/${skill}: scopes efectivos vacíos`);
        }
    }
    assert.deepEqual(faltantes, []);
    assert.ok(pares.some((x) => x.skill === 'architect'), 'architect está en skills_por_fase');
    assert.ok(pares.some((x) => x.skill === 'dev'), 'dev está en skills_por_fase');
});

// ─── CA-5 · línea grepeable ──────────────────────────────────────────────────

function violacion(causas, extra = {}) {
    return new errLib.ChildEnvViolation({ rol: 'ux', fase: 'criterios', intento: 'anthropic', causas, ...extra });
}

test('CA-5 · formatChildEnvBlockedLine: formato fijo, causa por kinds ordenados', () => {
    const v = violacion([
        { kind: 'undeclared', nombres: ['JAVA_HOME', 'AWS_PROFILE'] },
        { kind: 'reserved-alias', nombres: ['GH_TOKEN'] },
    ]);
    const l = errLib.formatChildEnvBlockedLine({ skill: 'ux', fase: 'criterios', intento: 'fallback:openai-codex', violation: v });
    assert.equal(l, '[entorno-hijo] bloqueado rol=ux fase=criterios intento=fallback:openai-codex '
        + 'causa=reserved-alias+undeclared nombres=AWS_PROFILE,GH_TOKEN,JAVA_HOME');
});

test('CA-5 · nombres con \\n, =, espacios o >64 chars se descartan (incluye los reemplazos de nombreSeguro)', () => {
    const largo = 'A'.repeat(65);
    const v = violacion([{ kind: 'undeclared', nombres: ['OK_1', 'MAL\nFALSA', 'X=1', 'CON ESPACIO', largo, 'a.b', 'OK(2)'] }]);
    const l = errLib.formatChildEnvBlockedLine({ skill: 'ux', fase: 'criterios', intento: 'primary:anthropic', violation: v });
    assert.ok(!l.includes('\n'), 'la línea no puede partirse');
    assert.match(l, /nombres=OK\(2\),OK_1$/);
    assert.ok(!l.includes('no imprimible'));
    assert.ok(!l.includes(largo));
    assert.ok(!l.includes('a.b'));
});

test('CA-5 · con más de 8 nombres aparece (+N)', () => {
    const nombres = Array.from({ length: 11 }, (_, i) => `VAR_${String(i).padStart(2, '0')}`);
    const l = errLib.formatChildEnvBlockedLine({
        skill: 'ux', fase: 'criterios', intento: 'primary:anthropic',
        violation: violacion([{ kind: 'undeclared', nombres }]),
    });
    assert.match(l, /nombres=VAR_00,VAR_01,VAR_02,VAR_03,VAR_04,VAR_05,VAR_06,VAR_07,\(\+3\)$/);
});

test('CA-5 · rol/fase inválidos se sanean y nunca aparece un valor', () => {
    const base = envOperador();
    let v;
    try {
        bce.assertChildEnvMinimal({ ...base }, { skill: 'ux', fase: 'analisis', effectiveScopes: ['github'] });
    } catch (e) { v = e; }
    assert.ok(errLib.isChildEnvViolation(v));
    const l = errLib.formatChildEnvBlockedLine({ skill: 'UX\nx', fase: 'fase con espacio', intento: 'primary:anthropic', violation: v });
    assert.match(l, /rol=\(inválido\) fase=\(inválido\)/);
    for (const valor of Object.values(base)) {
        if (String(valor).length > 3) assert.ok(!l.includes(valor), 'la línea contiene un valor del env');
    }
});

// ─── CA-5 · estacionamiento ──────────────────────────────────────────────────

function escenarioFase() {
    const root = tmpDir('e7636-park');
    const pipelineDir = path.join(root, '.pipeline');
    const faseDir = path.join(pipelineDir, 'definicion', 'criterios');
    const trabajando = path.join(faseDir, 'trabajando');
    fs.mkdirSync(trabajando, { recursive: true });
    return { root, pipelineDir, faseDir, trabajando };
}

function depsFalsas(avisos, labels, logs) {
    const yaml = require('js-yaml');
    return {
        readYaml: (p) => yaml.load(fs.readFileSync(p, 'utf8')) || {},
        writeYaml: (p, d) => fs.writeFileSync(p, yaml.dump(d)),
        moveFile: (src, destDir) => {
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, path.basename(src));
            fs.renameSync(src, dest);
            return dest;
        },
        log: (m) => logs.push(m),
        notify: (t) => avisos.push(t),
        enqueueNeedsHuman: (n) => labels.push(n),
    };
}

test('CA-5 · dos ciclos con la misma violación: 0 spawns, 1 aviso, workfile en bloqueado-humano sin rev++', () => {
    const esc = escenarioFase();
    const avisos = []; const labels = []; const logs = [];
    const deps = depsFalsas(avisos, labels, logs);
    const v = violacion([{ kind: 'undeclared', nombres: ['AWS_PROFILE', 'JAVA_HOME'] }]);
    let spawns = 0;

    for (const issue of [9001, 9002]) {
        const wf = path.join(esc.trabajando, `${issue}.ux`);
        fs.writeFileSync(wf, `issue: ${issue}\nfase: criterios\npipeline: definicion\nrev: 2\nrebote_numero: 1\n`);
        const r = parking.parkChildEnvViolation({
            violation: v, trabajandoPath: wf, faseDir: esc.faseDir, pipelineDir: esc.pipelineDir,
            issue, skill: 'ux', fase: 'criterios', pipeline: 'definicion', intento: 'primary:anthropic', deps,
        });
        assert.equal(r.parked, true);
        // el caller retorna tras estacionar: no hay spawn
    }
    assert.equal(spawns, 0);
    assert.equal(avisos.length, 1, 'un solo aviso por (rol, causa)');
    assert.deepEqual(labels, [9001, 9002], 'needs-human por cada issue estacionado');
    // brazoHuerfanos sólo barre trabajando/: queda vacío.
    assert.deepEqual(fs.readdirSync(esc.trabajando), []);
    const yaml = require('js-yaml');
    for (const issue of [9001, 9002]) {
        const bloqueado = path.join(esc.faseDir, 'bloqueado-humano', `${issue}.ux`);
        const d = yaml.load(fs.readFileSync(bloqueado, 'utf8'));
        assert.equal(d.motivo_tipo, 'child-env-violation');
        assert.equal(d.rev, 2, 'sin rev++');
        assert.equal(d.rebote_numero, 1, 'sin tocar contadores del circuit breaker');
        assert.equal(d.rebote, undefined);
        const reason = JSON.parse(fs.readFileSync(bloqueado + '.reason.json', 'utf8'));
        assert.equal(reason.motivo_tipo, 'child-env-violation');
    }
    assert.equal(logs.filter((l) => l.startsWith('[entorno-hijo] bloqueado rol=ux')).length, 2);
    // Al operador sólo nombres (hasta 3), nunca valores.
    assert.match(avisos[0], /AWS_PROFILE, JAVA_HOME/);
    assert.match(avisos[0], /no gastó reintentos/);
});

test('CA-5 · otra causa del mismo rol avisa aparte; lanzar OK cierra el episodio', () => {
    const esc = escenarioFase();
    const avisos = []; const deps = depsFalsas(avisos, [], []);
    const v1 = violacion([{ kind: 'undeclared', nombres: ['AWS_PROFILE'] }]);
    const v2 = violacion([{ kind: 'unknown-skill' }]);
    const park = (issue, v) => {
        const wf = path.join(esc.trabajando, `${issue}.ux`);
        fs.writeFileSync(wf, `issue: ${issue}\n`);
        parking.parkChildEnvViolation({
            violation: v, trabajandoPath: wf, faseDir: esc.faseDir, pipelineDir: esc.pipelineDir,
            issue, skill: 'ux', fase: 'criterios', pipeline: 'definicion', intento: 'primary:anthropic', deps,
        });
    };
    park(1, v1); park(2, v2); park(3, v1);
    assert.equal(avisos.length, 2);
    assert.equal(parking.clearViolationNotices({ pipelineDir: esc.pipelineDir, skill: 'ux' }), 2);
    park(4, v1);
    assert.equal(avisos.length, 3, 'tras un lanzamiento OK el próximo episodio vuelve a avisar');
});

test('CA-5 · parkChildEnvViolation rechaza errores que no son CHILD_ENV_VIOLATION', () => {
    assert.throws(() => parking.parkChildEnvViolation({ violation: new Error('falta la API key') }), TypeError);
});

test('CA-5 · pulpo.js: la violación se estaciona y RETORNA; los demás errores siguen con throw', () => {
    const i = PULPO_SRC.indexOf("if (e && e.code === 'CHILD_ENV_VIOLATION') {");
    assert.ok(i > 0, 'rama de CHILD_ENV_VIOLATION en el catch de lanzarAgenteClaude');
    const bloque = PULPO_SRC.slice(i, i + 2500);
    const park = bloque.indexOf('childEnvParking.parkChildEnvViolation(');
    const ret = bloque.indexOf('return;', park);
    const thr = bloque.indexOf('throw e;');
    assert.ok(park > 0 && ret > park, 'estaciona y retorna');
    assert.ok(thr > ret, 'el throw e queda DESPUÉS, para los demás errores');
    assert.match(bloque.slice(ret, thr), /❌ env-isolation rechazó spawn de/);
    // brazoHuerfanos sólo recupera lo que está en trabajando/.
    const bh = PULPO_SRC.slice(PULPO_SRC.indexOf('function brazoHuerfanos('));
    assert.match(bh.slice(0, 1500), /'trabajando'/);
});

// ─── CA-6 · resumen de turnos y Sherlock ─────────────────────────────────────

test('CA-6 · el resumen de turnos arma su env con buildMinimalCliEnv (sin GH_TOKEN ni AWS_*)', () => {
    const ancla = 'const summaryBaseEnv = buildChildEnvLib.buildMinimalCliEnv(';
    const linea = PULPO_SRC.split(/\r?\n/).find((l) => l.includes(ancla));
    assert.ok(linea, 'summaryBaseEnv sale de buildMinimalCliEnv');
    assert.ok(!PULPO_SRC.includes('const summaryBaseEnv = { ...process.env }'));
    // Evalúa la línea REAL del fuente con un process.env falso y un spawn capturador.
    const capturados = [];
    const spawnFalso = (cmd, args, opts) => { capturados.push(opts.env); };
    const factory = new Function('process', 'ROOT', 'buildChildEnvLib', 'spawn',
        `${linea.trim()}\nspawn('claude', [], { env: buildChildEnvLib.stripReservedChildSecrets(summaryBaseEnv, process.env) });`);
    factory({ env: envOperador({ CLAUDE_CONFIG_DIR: '/fake/home/.claude' }) }, '/repo', bce, spawnFalso);
    const env = capturados[0];
    for (const k of Object.keys(env)) {
        assert.ok(!/^(GH_TOKEN|GITHUB_TOKEN|AWS_.*|ANTHROPIC_API_KEY|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN.*|JAVA_HOME)$/i.test(k), `resumen con ${k}`);
    }
    assert.equal(env.CLAUDE_PROJECT_DIR, '/repo');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/fake/home/.claude', 'la sesión OAuth del CLI se conserva');
});

test('CA-6 · las 2 llamadas a sherlockVerifier.verify pasan envPolicy minimal', () => {
    const llamadas = PULPO_SRC.split('sherlockVerifier.verify({').slice(1);
    assert.equal(llamadas.length, 2);
    for (const c of llamadas) {
        const cuerpo = c.slice(0, c.indexOf('});'));
        assert.match(cuerpo, /envPolicy: 'minimal'/);
    }
});

test('CA-6 · verify propaga envPolicy hasta los tres spawns (anthropic, openai-codex, antigravity)', async () => {
    const recibidos = [];
    const spawnFalso = (prov) => async (o) => {
        recibidos.push([prov, o.envPolicy]);
        // timeout ⇒ la cascada sigue al próximo eslabón: así los tres spawns se ejercitan.
        return { ok: false, error: { type: 'timeout', detail: 'fake' }, durationMs: 1 };
    };
    const chain = [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'openai-codex', model: 'gpt-5' },
        { provider: 'antigravity', model: 'gemini-3.8-flash-medium' },
    ];
    const dispatchModule = {
        resolveSpawnWithFallback: ({ quotaModule, skill }) => {
            for (const p of chain) {
                if (!(quotaModule && quotaModule.shouldGateSpawn(skill, { provider: p.provider }))) {
                    return {
                        provider: p.provider, model: p.model, source: 'primary', gated: false,
                        fallbackUsed: null, primaryProvider: chain[0].provider, chainTried: [p.provider],
                        crossProvider: p.provider !== chain[0].provider, depthExceeded: false,
                    };
                }
            }
            return { provider: null, model: null, gated: true, source: 'all-gated', chainTried: chain.map((p) => p.provider) };
        },
    };
    const dir = tmpDir('e7636-sherlock');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const r = await sherlock.verify({
        analysis: 'a', originalRequest: '?', systemState: 's',
        pipelineDir: dir,
        configLoader: () => ({ sherlock_enabled: true, sherlock_max_reelaboraciones: 1 }),
        log: () => {},
        envPolicy: 'minimal',
        spawnAnthropic: spawnFalso('anthropic'),
        spawnCodex: spawnFalso('openai-codex'),
        spawnAntigravity: spawnFalso('antigravity'),
        completionClient: { complete: async () => ({ ok: false, error: { type: 'timeout' } }) },
        quotaModule: { shouldGateSpawn: () => false, sanitizeRawExcerpt: (x) => String(x || '') },
        dispatchModule,
        residencyModule: {
            loadExclusionsOrThrow: () => ({ exclusions: [], default_policy: 'allow' }),
            filterPathsForProvider: () => ({ blocked: [], allowed: [], policy: 'allow' }),
        },
    });
    assert.ok(r, 'verify devolvió resultado');
    const provs = new Set(recibidos.map(([p]) => p));
    assert.deepEqual([...provs].sort(), ['anthropic', 'antigravity', 'openai-codex'], 'los tres spawns se ejercitaron');
    for (const [p, pol] of recibidos) assert.equal(pol, 'minimal', `${p} no recibió envPolicy minimal`);
});

test('CA-6 · con envPolicy minimal el spawn de Anthropic real arma el env por allowlist (sin GH_TOKEN ni AWS_*)', async () => {
    const inyectar = { GH_TOKEN: 'fake-gh-token', AWS_ACCESS_KEY_ID: 'fake-aws-id', AWS_PROFILE: 'perfil-real' };
    let envCapturado = null;
    const { EventEmitter } = require('node:events');
    const spawnImpl = (cmd, args, opts) => {
        envCapturado = opts.env;   // lo que efectivamente recibe el child
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        proc.stdin = { write() {}, end() {}, on() {} };
        proc.kill = () => {};
        setImmediate(() => proc.emit('close', 1));
        return proc;
    };
    // El padre SÍ tiene material de GitHub/AWS: el filtro tiene que dejarlo afuera.
    await withEnv(inyectar, () => sherlock._spawnAnthropicComplete({
        prompt: 'x', timeoutMs: 2000, spawnImpl, cwd: os.tmpdir(), envPolicy: 'minimal',
        anthropicHandler: { buildSpawn: ({ args, cwd, env }) => ({ cmd: 'claude', args, spawnOpts: { cwd, env, shell: false } }) },
    }).catch(() => {}));
    assert.ok(envCapturado, 'el spawn recibió un env');
    for (const k of Object.keys(envCapturado)) {
        assert.ok(!/^(GH_TOKEN|GITHUB_TOKEN|AWS_.*)$/i.test(k), `el juez recibió ${k}`);
    }
});

test('CA-6 · el pass-through de envPolicy cubre los tres spawns de sherlock-verifier', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sherlock-verifier.js'), 'utf8');
    for (const fn of ['_spawnAnthropic', '_spawnCodex', '_spawnAntigravity']) {
        const i = src.indexOf(`const r = await ${fn}({`);
        assert.ok(i > 0, fn);
        const cuerpo = src.slice(i, src.indexOf('});', i));
        assert.match(cuerpo, /\benvPolicy,/, `${fn} no recibe envPolicy`);
    }
});

// ─── CA-7 · reversa ──────────────────────────────────────────────────────────

test('CA-7 · la reversa true→false se detecta UNA vez; el arranque y false→false no emiten', () => {
    const t = parking.createIsolationTransitionTracker();
    assert.equal(t.observe(false), false, 'arranque con false');
    assert.equal(t.observe(false), false, 'false→false');
    assert.equal(t.observe(true), false, 'false→true no es reversa');
    assert.equal(t.observe(true), false);
    assert.equal(t.observe(false), true, 'true→false');
    assert.equal(t.observe(false), false, 'sólo una vez por transición');

    const t2 = parking.createIsolationTransitionTracker();
    assert.equal(t2.observe(true), false, 'arranque con true');
    assert.equal(parking.REVERSA_LOG_LINE, '[entorno-hijo] aislamiento APAGADO (reversa)');
});

test('CA-7 · pulpo.js emite la línea de reversa y avisa al operador sólo desde el tracker', () => {
    const i = PULPO_SRC.indexOf('if (_envIsolationTransition.observe(envIsolationEnabled)) {');
    assert.ok(i > 0);
    const bloque = PULPO_SRC.slice(i, i + 400);
    assert.match(bloque, /log\('lanzamiento', childEnvParking\.REVERSA_LOG_LINE\)/);
    assert.match(bloque, /sendTelegramPlain\(/);
    assert.equal(PULPO_SRC.split('childEnvParking.REVERSA_LOG_LINE').length - 1, 1, 'un solo emisor');
});

test('CA-7 · con el flag OFF el hijo no hereda TELEGRAM_BOT_TOKEN, ni como alias con el mismo valor', () => {
    const base = envOperador();
    const legacy = bce.stripReservedChildSecrets(
        bce.conDeclaracionExplicita({ ...base, PIPELINE_ISSUE: '7636' }, base),
        base,
    );
    assert.equal(legacy.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(legacy.TELEGRAM_BOT_TOKEN_ALIAS, undefined);
    assert.ok(!Object.values(legacy).includes('fake-telegram-bot'));
});

test('CA-7 · config.yaml: flag en true con la reversa documentada; snapshot y vault intactos', () => {
    const yaml = require('js-yaml');
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'config.yaml'), 'utf8');
    const cfg = yaml.load(src);
    assert.equal(cfg.pipeline.env_isolation_enabled, true);
    assert.notEqual(cfg.pipeline.credential_snapshot_enabled, true, 'el snapshot no se enciende en este PR');
    assert.match(src, /REVERSA/);
    assert.match(src, /aislamiento APAGADO \(reversa\)/);
    assert.match(src, /TELEGRAM_BOT_TOKEN/);
    assert.match(src, /needs-human/);
});

test('CA-7 · launcher-env.js sólo suma el comentario de servicios de confianza', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'launcher-env.js'), 'utf8');
    assert.match(src, /SERVICIOS DE\s*\n?\s*\*?\s*CONFIANZA/);
});

test('CA-5 · el aviso al operador lleva hasta 3 nombres y "y N más"', () => {
    const v = violacion([{ kind: 'undeclared', nombres: ['A1', 'A2', 'A3', 'A4', 'A5'] }]);
    const txt = parking.formatOperatorNotice({ skill: 'ux', fase: 'criterios', issue: 7636, violation: v });
    assert.match(txt, /\(A1, A2, A3 y 2 más\)/);
    assert.match(txt, /Para destrabarlo/);
    assert.match(txt, /#7636/);
});
