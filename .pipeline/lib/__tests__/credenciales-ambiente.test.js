'use strict';

/**
 * #7113 (split de #7102) — credenciales y canales externos por ambiente.
 *
 * Cubre CA-1..CA-6 y CA-9 del PO con un test por canal (Telegram, GitHub,
 * proveedores, vault) y los escenarios Gherkin del issue mapeados por nombre.
 * Todo corre sobre un `mkdtemp` como dir de pruebas (`PIPELINE_DIR_OVERRIDE`,
 * que `pipeline-env` y el pulpo honran por igual — R-G) y con stores de
 * pruebas sintéticos: ningún valor real, ningún path productivo, cero red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ca = require('../credenciales-ambiente');
const pipelineEnv = require('../pipeline-env');
const credentials = require('../credentials');
const telegramSecrets = require('../telegram-secrets');
const { hydrateProviderEnv } = require('../hydrate-provider-env');
const { buildChildEnv } = require('../build-child-env');
const agentModelsValidate = require('../agent-models-validate');
const sv = require('../secret-vault');

const { MODOS } = pipelineEnv;

// Valores SINTÉTICOS con forma real (para que el sanitizer los reconozca si se
// filtran a un log), armados en runtime para no disparar el gate de pre-commit.
const BOT_PRUEBAS = ['987654321', ':', 'AAHfiqksKZ8WmR2zSjiQ7_v4TVd4jrIkT9Q'].join('');
const BOT_PRODUCTIVO = ['123456789', ':', 'BBHfiqksKZ8WmR2zSjiQ7_v4TVd4jrIkT9Z'].join('');
const CHAT_PRUEBAS = '-1001111111111';
const CHAT_PRODUCTIVO = '-1009999999999';
const PAT_PRUEBAS = ['github', '_pat_', 'P'.repeat(82)].join('');
const PAT_PRODUCTIVO = ['gh', 'p_', 'Q'.repeat(36)].join('');
const API_KEY_PRODUCTIVA = ['sk-ant-', 'api03-', 'R'.repeat(40)].join('');

const AGENT_MODELS_PRODUCTIVO = path.join(pipelineEnv.DEFAULT_PRODUCTIVE_DIR, 'agent-models.json');

const SILENCIO = () => {};

function mkdir(prefijo = 'ca7113-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
}

/** Dir de pruebas con `config.yaml` mínimo (vault apagado) — es lo que #7111 provisiona. */
function dirDePruebas({ vaultYaml = 'vault:\n  enabled: false\n' } = {}) {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), vaultYaml);
    return dir;
}

function escribirStore(dir, json, nombre = 'credentials.pruebas.json') {
    const p = path.join(dir, nombre);
    fs.writeFileSync(p, JSON.stringify(json, null, 2));
    return p;
}

function storeDePruebasCompleto() {
    return {
        telegram: { bot_token: BOT_PRUEBAS, chat_id: CHAT_PRUEBAS },
        github: { token: PAT_PRUEBAS },
    };
}

/** Env de shell "sucio": credenciales productivas heredadas + dir de pruebas. */
function envSucio(dir, extra = {}) {
    return {
        PIPELINE_DIR_OVERRIDE: dir,
        TELEGRAM_BOT_TOKEN: BOT_PRODUCTIVO,
        TELEGRAM_CHAT_ID: CHAT_PRODUCTIVO,
        TELEGRAM_LEO_OPERATOR_CHAT_ID: CHAT_PRODUCTIVO,
        GH_TOKEN: PAT_PRODUCTIVO,
        GITHUB_TOKEN: PAT_PRODUCTIVO,
        ANTHROPIC_API_KEY: API_KEY_PRODUCTIVA,
        OPENAI_API_KEY: API_KEY_PRODUCTIVA,
        ...extra,
    };
}

function aplicarEnPruebas(dir, { store = storeDePruebasCompleto(), env, opts = {} } = {}) {
    const storePath = store === null ? path.join(dir, 'no-existe.pruebas.json') : escribirStore(dir, store);
    const e = env || envSucio(dir);
    const r = ca.aplicar(e, { logger: SILENCIO, storePath, agentModelsProductivoPath: AGENT_MODELS_PRODUCTIVO, ...opts });
    return { env: e, r, storePath };
}

/** `https` falso: cualquier `request` es un fallo (CA-3: cero red en pruebas). */
function httpsQueNoDebeUsarse() {
    const llamadas = [];
    return {
        llamadas,
        request(opts) {
            llamadas.push(opts);
            throw new Error(`https.request NO debe llamarse en pruebas (${opts && opts.path})`);
        },
    };
}

function leerTrazas(dir) {
    const trazasDir = path.join(dir, ...ca.SUBDIR_TRAZAS);
    if (!fs.existsSync(trazasDir)) return [];
    return fs.readdirSync(trazasDir).flatMap((f) => fs.readFileSync(path.join(trazasDir, f), 'utf8')
        .split('\n').filter(Boolean).map((l) => ({ archivo: f, linea: l, registro: JSON.parse(l) })));
}

// ─── CA-1 · store por modo, purga ─────────────────────────────────────────────

test('CA-1 · en productivo aplicar() hidrata credentials.json sobre el env sin purgar nada (idéntico a hoy)', () => {
    const original = credentials.loadIntoEnv;
    const llamadas = [];
    credentials.loadIntoEnv = (opts) => { llamadas.push(opts); return { source: 'canonical', hydrated: [], skipped_already_set: [], missing: [], sources: {} }; };
    try {
        const env = { [pipelineEnv.ENV_AMBIENTE]: pipelineEnv.VALOR_PRODUCTIVO, GH_TOKEN: PAT_PRODUCTIVO, TELEGRAM_BOT_TOKEN: BOT_PRODUCTIVO };
        const r = ca.aplicar(env, { logger: SILENCIO });
        assert.equal(r.ambiente.modo, MODOS.PRODUCTIVO);
        assert.equal(llamadas.length, 1);
        assert.equal(llamadas[0].env, env, 'hidrata sobre el env del proceso');
        assert.equal(llamadas[0].canonicalPath, undefined, 'sin override de store: credentials.json canónico');
        assert.deepEqual(r.purgadas, []);
        assert.equal(env.GH_TOKEN, PAT_PRODUCTIVO, 'no purga en productivo');
        assert.equal(env.TELEGRAM_BOT_TOKEN, BOT_PRODUCTIVO);
        assert.equal(r.hidratacion.source, 'canonical', 'misma forma de retorno que loadIntoEnv');
        assert.equal(r.resumen.length, 1, 'una sola línea en productivo');
        assert.equal(r.canales.telegram.fuente, 'credentials.json');
        assert.equal(r.canales.github.escrituras, true);
    } finally {
        credentials.loadIntoEnv = original;
    }
});

test('CA-1 · en pruebas se purgan del env TODAS las credenciales productivas heredadas antes de cualquier spawn', () => {
    const dir = dirDePruebas();
    const { env, r } = aplicarEnPruebas(dir);
    assert.equal(r.ambiente.modo, MODOS.PRUEBAS);
    assert.equal(r.ambiente.dir, dir);
    for (const k of ca.CLAVES_PURGA) {
        if (k === 'GH_TOKEN') continue; // se repone SOLO con la identidad de pruebas del store (ver abajo)
        assert.equal(Object.prototype.hasOwnProperty.call(env, k), false, `${k} purgada`);
    }
    assert.equal(env.GH_TOKEN, PAT_PRUEBAS, 'GH_TOKEN productivo purgado y reemplazado por el del store de pruebas');
    assert.deepEqual([...r.purgadas].sort(), [...ca.CLAVES_PURGA].sort());
    // La purga es observable en `{ ...env }` (spawn con env copiado)…
    const copia = { ...env };
    assert.equal(copia.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(copia.ANTHROPIC_API_KEY, undefined);
    // …y el resumen no filtra valores.
    const texto = r.resumen.join('\n');
    for (const v of [BOT_PRODUCTIVO, BOT_PRUEBAS, CHAT_PRODUCTIVO, PAT_PRUEBAS, PAT_PRODUCTIVO, API_KEY_PRODUCTIVA]) {
        assert.equal(texto.includes(v), false, 'el resumen no contiene valores');
    }
});

test('CA-1 · en pruebas se hidrata SOLO credentials.pruebas.json y se traspone a variables _PRUEBAS', () => {
    const dir = dirDePruebas();
    const { env, r } = aplicarEnPruebas(dir);
    assert.equal(env.TELEGRAM_BOT_TOKEN_PRUEBAS, BOT_PRUEBAS);
    assert.equal(env.TELEGRAM_CHAT_ID_PRUEBAS, CHAT_PRUEBAS);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, 'la productiva no se repone');
    assert.equal(env.TELEGRAM_CHAT_ID, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API keys no se trasponen (CA-4)');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.TELEGRAM_LEO_OPERATOR_CHAT_ID, undefined, 'el ancla del operador no se traspone');
    assert.equal(r.canales.telegram.enabled, true);
    assert.equal(r.canales.telegram.fuente, ca.NOMBRE_STORE_PRUEBAS);
});

test('CA-1 · store de pruebas ausente ⇒ source:none sin crash y SIN caer al legacy productivo (R-C)', () => {
    const dir = dirDePruebas();
    // Un legacy "productivo" presente que NADIE debe leer en pruebas.
    const legacy = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(legacy, JSON.stringify({ bot_token: BOT_PRODUCTIVO, chat_id: CHAT_PRODUCTIVO }));
    const { env, r } = aplicarEnPruebas(dir, { store: null });
    assert.equal(r.hidratacion.source, 'none');
    assert.equal(env.TELEGRAM_BOT_TOKEN_PRUEBAS, undefined);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(r.canales.telegram.enabled, false);
    assert.match(r.canales.telegram.motivo, /sin credentials\.pruebas\.json/);

    // Y el loader en sí: `legacyPath: null` neutraliza el legacy aunque exista.
    const tmp = {};
    const h = credentials.loadIntoEnv({
        logger: SILENCIO, env: tmp, canonicalPath: path.join(dir, 'no.json'), legacyPath: null,
        vaultConfig: { enabled: false },
    });
    assert.equal(h.source, 'none');
    assert.equal(tmp.TELEGRAM_BOT_TOKEN, undefined, 'con legacyPath:null el legacy presente no se lee');
    // Contraste: con el legacy declarado sí se leería (comportamiento productivo intacto).
    const tmp2 = {};
    const h2 = credentials.loadIntoEnv({
        logger: SILENCIO, env: tmp2, canonicalPath: path.join(dir, 'no.json'), legacyPath: legacy,
        vaultConfig: { enabled: false },
    });
    assert.notEqual(h2.source, 'none');
});

// ─── CA-2 · GitHub ───────────────────────────────────────────────────────────

test('CA-2 / Gherkin "la credencial de pruebas no puede escribir en el repo real" · GH_CONFIG_DIR vacío dentro del dir y GH_TOKEN sólo del store', () => {
    const dir = dirDePruebas();
    const { env, r } = aplicarEnPruebas(dir);
    assert.equal(env.GH_CONFIG_DIR, path.join(dir, ca.SUBDIR_GH_CONFIG));
    assert.ok(env.GH_CONFIG_DIR.startsWith(dir), 'dentro del mkdtemp');
    assert.ok(fs.existsSync(env.GH_CONFIG_DIR), 'existe');
    assert.deepEqual(fs.readdirSync(env.GH_CONFIG_DIR), [], 'vacío: sin hosts.yml del operador');
    assert.equal(env.GH_TOKEN, PAT_PRUEBAS, 'identidad de pruebas del store');
    assert.equal(env.GITHUB_TOKEN, undefined, 'la productiva se purgó y no se repone');
    assert.equal(r.canales.github.escrituras, false);
    assert.equal(r.canales.github.auth, 'GH_TOKEN+GH_CONFIG_DIR');
});

test('CA-2 · sin github.token en el store, GH_TOKEN queda AUSENTE (no vacío) y gh no está logueado', (t) => {
    const dir = dirDePruebas();
    const { env } = aplicarEnPruebas(dir, { store: { telegram: { bot_token: BOT_PRUEBAS, chat_id: CHAT_PRUEBAS } } });
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'GH_TOKEN'), false, 'ausente, no ""');
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'GITHUB_TOKEN'), false);

    // Evidencia empírica (DoD): `gh` con ese GH_CONFIG_DIR no ve el keyring del operador.
    const candidatos = ['gh', 'C:\\Workspaces\\gh-cli\\bin\\gh.exe'];
    let salida = null;
    for (const bin of candidatos) {
        const r = spawnSync(bin, ['auth', 'status'], {
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GH_CONFIG_DIR: env.GH_CONFIG_DIR, GH_NO_UPDATE_NOTIFIER: '1' },
            encoding: 'utf8', timeout: 15000, windowsHide: true,
        });
        if (!r.error) { salida = `${r.stdout || ''}${r.stderr || ''}`; break; }
    }
    if (salida === null) { t.skip('gh no disponible en este host'); return; }
    assert.match(salida, /not logged into any GitHub hosts/i, `gh auth status con GH_CONFIG_DIR vacío: ${salida}`);
    assert.deepEqual(fs.readdirSync(env.GH_CONFIG_DIR), [], 'gh no creó hosts.yml');
});

// ─── CA-3 · Telegram ─────────────────────────────────────────────────────────

test('CA-3 / Gherkin "un test no alcanza el chat del operador" · el HTTPS directo no abre red y deja traza JSONL redactada', () => {
    const dir = dirDePruebas();
    const { env, r } = aplicarEnPruebas(dir, { store: null });
    const https = httpsQueNoDebeUsarse();
    const now = () => Date.parse('2026-09-20T10:00:00.000Z');
    const tg = ca.transporteTelegram(env, { ambiente: r.ambiente, httpsImpl: https, now, logger: SILENCIO });
    assert.equal(tg.nulo, true);
    assert.equal(tg.directoBloqueado, true);
    assert.equal(tg.destino, 'nulo');

    const texto = `aviso al chat ${CHAT_PRODUCTIVO} vía https://api.telegram.org/bot${BOT_PRODUCTIVO}/sendMessage`;
    const res = tg.enviarDirecto({
        metodo: 'sendMessage', token: BOT_PRODUCTIVO, chatId: CHAT_PRODUCTIVO,
        payload: { text: texto }, origen: 'test:directo',
    });
    assert.equal(res.nulo, true);
    assert.equal(https.llamadas.length, 0, 'https.request nunca se llamó');

    const trazas = leerTrazas(dir);
    assert.equal(trazas.length, 1);
    assert.equal(trazas[0].archivo, '2026-09-20.jsonl', 'JSONL diario UTC');
    const reg = trazas[0].registro;
    assert.deepEqual(Object.keys(reg).slice(0, 5), ['ts', 'chat_id', 'origen', 'texto', 'motivo'], 'orden fijo de campos (UX-2)');
    assert.equal(reg.ts, '2026-09-20T10:00:00.000Z');
    assert.equal(reg.chat_id, '<chat_id>');
    assert.equal(reg.origen, 'test:directo');
    assert.equal(reg.metodo, 'sendMessage');
    assert.equal(trazas[0].linea.includes(BOT_PRODUCTIVO), false, 'el token no queda en la traza');
    assert.equal(trazas[0].linea.includes(CHAT_PRODUCTIVO), false, 'el chat_id no queda en la traza');
    assert.match(tg.resumen(), /1 mensaje\/s trazado\/s en .*2026-09-20\.jsonl/);
});

test('CA-3 · un chat_id productivo filtrado en el env se ignora: sin variables _PRUEBAS el canal es nulo', () => {
    const dir = dirDePruebas();
    const env = { PIPELINE_DIR_OVERRIDE: dir, TELEGRAM_BOT_TOKEN: BOT_PRODUCTIVO, TELEGRAM_CHAT_ID: CHAT_PRODUCTIVO };
    // Sin pasar por aplicar(): el transporte por sí solo tampoco mira las productivas.
    const tg = ca.transporteTelegram(env, { logger: SILENCIO });
    assert.equal(tg.productivo, false);
    assert.equal(tg.nulo, true);
    assert.equal(tg.chatIdVar, 'TELEGRAM_CHAT_ID_PRUEBAS');
    assert.throws(() => telegramSecrets.loadTelegramSecrets({ env, log: SILENCIO }), { code: 'TELEGRAM_SECRETS_MISSING' });
});

test('CA-3 · con bot de pruebas presente el destino es la cola de pruebas y los HTTPS directos igual se trazan', () => {
    const dir = dirDePruebas();
    const { env, r } = aplicarEnPruebas(dir);
    const https = httpsQueNoDebeUsarse();
    const tg = ca.transporteTelegram(env, { ambiente: r.ambiente, httpsImpl: https, logger: SILENCIO });
    assert.equal(tg.nulo, false, 'canal encendido hacia el bot de pruebas');
    assert.equal(tg.destino, 'cola-de-pruebas');
    assert.equal(tg.directoBloqueado, true);
    const res = tg.enviarDirecto({ metodo: 'sendChatAction', token: BOT_PRUEBAS, chatId: CHAT_PRUEBAS, payload: { action: 'typing' } });
    assert.equal(res.nulo, true);
    assert.equal(https.llamadas.length, 0);
    assert.equal(leerTrazas(dir).length, 1);
    // telegram-secrets resuelve el bot de pruebas desde las `_PRUEBAS` (vía 1) y nada más.
    const s = telegramSecrets.loadTelegramSecrets({ env, ambiente: r.ambiente, log: SILENCIO });
    assert.equal(s.bot_token, BOT_PRUEBAS);
    assert.equal(s.chat_id, CHAT_PRUEBAS);
});

test('CA-3 · la vía 4 (archivo commiteado en el repo) no se lee en pruebas aunque exista', () => {
    const dir = dirDePruebas();
    const repoFile = path.join(dir, 'telegram-config.json');
    fs.writeFileSync(repoFile, JSON.stringify({ bot_token: BOT_PRODUCTIVO, chat_id: CHAT_PRODUCTIVO }));
    const env = { PIPELINE_DIR_OVERRIDE: dir };
    assert.throws(
        () => telegramSecrets.loadTelegramSecrets({ env, legacyConfigPath: repoFile, log: SILENCIO }),
        { code: 'TELEGRAM_SECRETS_MISSING' },
    );
    assert.deepEqual(telegramSecrets.loadApiKeys({ env, legacyConfigPath: repoFile }), { openai_api_key: '', anthropic_api_key: '' });
});

test('CA-3 · sin dir de pruebas la traza va al logger y nunca a un path productivo', () => {
    const lineas = [];
    const env = {};
    const tg = ca.transporteTelegram(env, { logger: (m) => lineas.push(m) });
    assert.equal(tg.trazasDir, null);
    const r = tg.trazar({ origen: 'sin-dir', texto: 'hola' });
    assert.equal(r.archivo, null);
    assert.equal(lineas.length, 1);
    assert.match(lineas[0], /traza sin dir de pruebas/);
    assert.equal(fs.existsSync(path.join(pipelineEnv.DEFAULT_PRODUCTIVE_DIR, 'servicios', 'telegram', 'trazas', '__nunca__')), false);
});

// ─── CA-4 · proveedores ──────────────────────────────────────────────────────

test('CA-4 · buildChildEnv en pruebas: sesiones OAuth bajo el dir, sin API keys, aunque el processEnv las traiga', () => {
    const dir = dirDePruebas();
    const { env } = aplicarEnPruebas(dir);
    // Un snapshot del env "sucio" entregado por el caller (no el ya purgado).
    const sucio = { ...envSucio(dir), ...env, TELEGRAM_BOT_TOKEN: BOT_PRODUCTIVO, ANTHROPIC_API_KEY: API_KEY_PRODUCTIVA, GH_TOKEN: PAT_PRODUCTIVO };
    const hijo = buildChildEnv({ skill: 'guru', pipelineDir: dir, processEnv: sucio, warn: SILENCIO });
    assert.equal(hijo.CLAUDE_CONFIG_DIR, path.join(dir, ca.SUBDIR_SESIONES, 'claude'));
    assert.equal(hijo.CODEX_HOME, path.join(dir, ca.SUBDIR_SESIONES, 'codex'));
    assert.equal(fs.existsSync(hijo.CLAUDE_CONFIG_DIR), false, 'sentinel inexistente: el CLI falla en origen');
    for (const k of ca.CLAVES_PURGA) assert.equal(hijo[k], undefined, `${k} no cruza al hijo`);
});

test('CA-4 · hydrateProviderEnv no corre en pruebas (no consume el pozo productivo)', () => {
    const dir = dirDePruebas();
    const env = { PIPELINE_DIR_OVERRIDE: dir };
    const r = hydrateProviderEnv({ env, ambiente: pipelineEnv.resolve(env), logger: SILENCIO });
    assert.equal(r.omitido, 'pruebas');
    assert.deepEqual(r.hydrated, []);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('CA-4 · el agent-models.json de pruebas se genera deterministic-only, valida, y se regenera si alguien lo pisa', () => {
    const dir = dirDePruebas();
    const { r } = aplicarEnPruebas(dir);
    const p = r.canales.proveedores.agentModelsPath;
    assert.equal(p, path.join(dir, 'agent-models.json'));
    assert.equal(r.canales.proveedores.generado, true);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(json.default_provider, ca.PROVIDER_PRUEBAS);
    assert.ok(Object.keys(json.skills).length > 0, 'mismo inventario de skills que el productivo');
    for (const [nombre, cfg] of Object.entries(json.skills)) {
        assert.equal(cfg.provider, ca.PROVIDER_PRUEBAS, `${nombre} rutea a deterministic`);
        assert.equal(cfg.fallbacks, undefined, `${nombre} sin cadena de fallback`);
    }
    assert.ok(ca.esSoloDeterministic(json));
    const val = agentModelsValidate.validate(p, { skipCredentialsEnvPresence: true, processEnv: {} });
    assert.equal(val.ok, true, `agent-models de pruebas válido: ${JSON.stringify(val.errors || val)}`);

    // Alguien copia el productivo encima (#7111 provisiona copiando) ⇒ se regenera.
    fs.copyFileSync(AGENT_MODELS_PRODUCTIVO, p);
    assert.equal(ca.esSoloDeterministic(JSON.parse(fs.readFileSync(p, 'utf8'))), false);
    const { r: r2 } = aplicarEnPruebas(dir);
    assert.equal(r2.canales.proveedores.generado, true);
    assert.match(r2.canales.proveedores.motivo, /regenerado/);
    assert.ok(ca.esSoloDeterministic(JSON.parse(fs.readFileSync(p, 'utf8'))));
});

// ─── CA-5 · vault ────────────────────────────────────────────────────────────

test('CA-5 · el vault de pruebas usa el namespace intrale-pruebas y nunca un path bajo /intrale/intrale/', () => {
    const dir = dirDePruebas();
    const cfgPruebas = {
        enabled: true, prefix: '/intrale', projectId: 'intrale', hostId: 'host-pruebas', awsProfile: 'intrale-pruebas',
        cache_ttl_seconds: 300, required_scopes: [], shared_secrets: [], region: 'us-east-1',
    };
    const driver = sv.createInMemoryVaultDriver({ parameters: {} });
    const { r } = aplicarEnPruebas(dir, {
        store: { telegram: { bot_token: BOT_PRUEBAS, chat_id: CHAT_PRUEBAS } },
        opts: { vaultConfig: cfgPruebas, vaultConfigProductivo: { enabled: true, awsProfile: 'intrale-prod' }, vaultDriver: driver },
    });
    assert.equal(r.canales.vault.enabled, true);
    assert.equal(r.canales.vault.projectId, 'intrale-pruebas');
    assert.equal(r.canales.vault.prefix, '/intrale');
    assert.equal(r.canales.vault.awsProfile, 'intrale-pruebas');
    const paths = driver.calls.map((c) => c.root || c.name || '').filter(Boolean);
    for (const p of paths) {
        assert.ok(p.startsWith('/intrale/intrale-pruebas/'), `path del vault bajo el namespace de pruebas: ${p}`);
        assert.equal(p.startsWith('/intrale/intrale/'), false);
    }
    // El namespace que se construye para cualquier scope es el de pruebas.
    const ruta = sv.buildParameterPath({ prefix: '/intrale', projectId: r.canales.vault.projectId, hostId: 'host-pruebas', scope: 'telegram', tier: 'host' });
    assert.ok(ruta.startsWith('/intrale/intrale-pruebas/'), ruta);
    assert.equal(ruta.includes('/intrale/intrale/'), false);
});

test('CA-5 · mismo awsProfile que el productivo ⇒ vault APAGADO con motivo (separación de principal, no lógica)', () => {
    const dir = dirDePruebas();
    const cfg = { enabled: true, prefix: '/intrale', projectId: 'intrale', hostId: 'h', awsProfile: 'intrale-prod' };
    const { r } = aplicarEnPruebas(dir, { opts: { vaultConfig: cfg, vaultConfigProductivo: { awsProfile: 'intrale-prod' } } });
    assert.equal(r.canales.vault.enabled, false);
    assert.match(r.canales.vault.motivo, /coincide con el productivo/);
    // awsProfile vacío tampoco alcanza.
    const { r: r2 } = aplicarEnPruebas(dir, { opts: { vaultConfig: { ...cfg, awsProfile: '' }, vaultConfigProductivo: { awsProfile: 'intrale-prod' } } });
    assert.equal(r2.canales.vault.enabled, false);
    assert.match(r2.canales.vault.motivo, /awsProfile vacío/);
    // Y con vault.enabled:false en el dir de pruebas (lo que #7111 provisiona) queda apagado leyendo el config.yaml real del dir.
    const { r: r3 } = aplicarEnPruebas(dir);
    assert.equal(r3.canales.vault.enabled, false);
    assert.match(r3.canales.vault.motivo, /vault\.enabled no es true/);
});

// ─── CA-6 · escape hatches ───────────────────────────────────────────────────

test('CA-6 · los hatches heredados sin declaración productiva NO cambian el store: sigue siendo el de pruebas y el motivo lo dice', () => {
    const dir = dirDePruebas();
    const env = envSucio(dir, { PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1', PIPELINE_ALLOW_GH_WRITES: '1' });
    const { env: e, r } = aplicarEnPruebas(dir, { env });
    assert.equal(r.ambiente.modo, MODOS.PRUEBAS);
    assert.match(r.ambiente.motivo, new RegExp(pipelineEnv.ENV_AMBIENTE));
    assert.equal(e.TELEGRAM_BOT_TOKEN, undefined, 'purgada igual');
    assert.equal(e.TELEGRAM_BOT_TOKEN_PRUEBAS, BOT_PRUEBAS, 'store de pruebas igual');
    assert.equal(r.canales.github.escrituras, false);
    // El módulo no interpreta los hatches por su cuenta.
    const src = fs.readFileSync(require.resolve('../credenciales-ambiente'), 'utf8');
    for (const hatch of ['PIPELINE_ALLOW_PROD_SIDE_EFFECTS', 'PIPELINE_ALLOW_GH_WRITES']) {
        assert.equal(src.includes(hatch), false, `credenciales-ambiente no lee ${hatch} (SEC-5)`);
    }
});

// ─── R-B · literal de la variable de ambiente ────────────────────────────────

test('R-B · credenciales-ambiente.js no contiene el literal del nombre de la variable de ambiente (CA-8 de H1)', () => {
    const src = fs.readFileSync(require.resolve('../credenciales-ambiente'), 'utf8');
    assert.equal(src.includes(pipelineEnv.ENV_AMBIENTE), false);
});

// ─── CA-9 · un test por canal: el destino de pruebas es el que se usa ────────

test('CA-9 · resumen por canal: los cuatro canales reportan destino de pruebas y ningún valor', () => {
    const dir = dirDePruebas();
    const { r } = aplicarEnPruebas(dir);
    const texto = r.resumen.join('\n');
    assert.match(texto, /^\[ambiente\] modo=pruebas/m);
    assert.match(texto, /telegram\s+ENCENDIDO\s+bot de pruebas \(credentials\.pruebas\.json\) → TELEGRAM_CHAT_ID_PRUEBAS/);
    assert.match(texto, /github\s+ENCENDIDO\s+GH_CONFIG_DIR=.*gh-config \(vacío\), GH_TOKEN de credentials\.pruebas\.json/);
    assert.match(texto, /proveedores\s+SOLO deterministic/);
    assert.match(texto, /vault\s+APAGADO/);
    assert.equal(texto.includes(BOT_PRUEBAS), false);
    assert.equal(texto.includes(PAT_PRUEBAS), false);
    assert.equal(texto.includes(CHAT_PRUEBAS), false);
});

test('CA-9 · sin dir (modo pruebas por default, sin override): sentinels bajo el home, nada se crea, nada productivo', () => {
    const env = {};
    const r = ca.aplicar(env, { logger: SILENCIO, storePath: path.join(mkdir(), 'no.json') });
    assert.equal(r.ambiente.dir, null);
    assert.ok(env.GH_CONFIG_DIR.startsWith(ca._internal.SENTINEL_SIN_DIR));
    assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(ca._internal.SENTINEL_SIN_DIR));
    assert.equal(fs.existsSync(ca._internal.SENTINEL_SIN_DIR), false, 'el sentinel nunca se crea');
    assert.equal(r.canales.proveedores.agentModelsPath, null);
    assert.equal(r.canales.vault.enabled, false);
    assert.equal(env.GH_CONFIG_DIR.startsWith(pipelineEnv.DEFAULT_PRODUCTIVE_DIR), false);
});
