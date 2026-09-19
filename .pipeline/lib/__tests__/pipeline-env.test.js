'use strict';

// #7110 — tests del resolvedor único de ambiente (`lib/pipeline-env.js`).
//
// REGLA: todos los tests pasan `env` como objeto literal y JAMÁS mutan
// `process.env` (`PIPELINE_DIR_OVERRIDE` y `NODE_ENV` están en la
// `NO_CONTROL_BLACKLIST` de `test-env-lint`). El módulo es puro: no hay
// nada que setear ni restaurar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pipelineEnv = require('../pipeline-env');
const { resolve, MODOS, DEFAULT_PRODUCTIVE_DIR, ENV_AMBIENTE } = pipelineEnv;

const PRODUCTIVO = { [ENV_AMBIENTE]: 'productivo' };
const CANALES_KEYS = ['telegram', 'github', 'proveedores', 'vault'];

/** Directorio temporal REAL (funciona en Windows), fuera de `DEFAULT_PRODUCTIVE_DIR`. */
function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-env-7110-${tag}-`));
}

const SRC_PATH = path.join(__dirname, '..', 'pipeline-env.js');

/** Fuente sin comentarios (la cabecera nombra a propósito lo que el CÓDIGO no puede usar). */
function fuenteSinComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function assertPerfilPruebas(canales, ctx) {
    assert.strictEqual(canales.telegram.enabled, false, `${ctx}: telegram apagado`);
    assert.notStrictEqual(canales.telegram.chatIdVar, 'TELEGRAM_CHAT_ID', `${ctx}: no hereda el chat productivo (SEC-4)`);
    assert.strictEqual(canales.telegram.fuente, null, `${ctx}: telegram sin fuente`);
    assert.strictEqual(canales.github.enabled, false, `${ctx}: github apagado`);
    assert.strictEqual(canales.github.escrituras, false, `${ctx}: github sin escrituras`);
    assert.strictEqual(canales.github.auth, null, `${ctx}: github sin auth`);
    assert.notStrictEqual(canales.vault.projectId, 'intrale', `${ctx}: vault no productivo`);
    assert.strictEqual(canales.vault.projectId, 'intrale-pruebas', `${ctx}: vault de pruebas`);
}

function assertPerfilProductivo(canales, ctx) {
    assert.strictEqual(canales.telegram.enabled, true, `${ctx}: telegram encendido`);
    assert.strictEqual(canales.telegram.chatIdVar, 'TELEGRAM_CHAT_ID', `${ctx}: chat productivo`);
    assert.strictEqual(canales.telegram.fuente, 'credentials.json', `${ctx}: fuente productiva`);
    assert.strictEqual(canales.github.enabled, true, `${ctx}: github encendido`);
    assert.strictEqual(canales.github.escrituras, true, `${ctx}: github con escrituras`);
    assert.strictEqual(canales.github.auth, 'gh-session', `${ctx}: auth de sesión gh`);
    assert.strictEqual(canales.vault.projectId, 'intrale', `${ctx}: vault productivo`);
    assert.strictEqual(canales.vault.prefix, '/intrale', `${ctx}: prefix del vault`);
    assert.strictEqual(canales.proveedores.agentModelsPath, path.join(DEFAULT_PRODUCTIVE_DIR, 'agent-models.json'));
}

function assertForma(out, ctx) {
    assert.deepStrictEqual(Object.keys(out).sort(), ['canales', 'dir', 'modo', 'motivo', 'origen'], `${ctx}: forma fija`);
    assert.deepStrictEqual(Object.keys(out.canales).sort(), [...CANALES_KEYS].sort(), `${ctx}: 4 canales`);
    assert.deepStrictEqual(Object.keys(out.canales.telegram).sort(), ['chatIdVar', 'enabled', 'fuente'], `${ctx}: telegram`);
    assert.deepStrictEqual(Object.keys(out.canales.github).sort(), ['auth', 'enabled', 'escrituras'], `${ctx}: github`);
    assert.deepStrictEqual(Object.keys(out.canales.proveedores), ['agentModelsPath'], `${ctx}: proveedores`);
    assert.deepStrictEqual(Object.keys(out.canales.vault).sort(), ['prefix', 'projectId'], `${ctx}: vault`);
    assert.ok(out.motivo === null || (typeof out.motivo === 'string' && out.motivo.length > 0), `${ctx}: motivo string o null`);
    assert.ok(Object.values(MODOS).includes(out.modo), `${ctx}: modo válido`);
}

// ─── CA-1 · exports y constantes ────────────────────────────────────────────

test('CA-1 · exporta resolve, MODOS, DEFAULT_PRODUCTIVE_DIR y ENV_AMBIENTE con los valores del contrato', () => {
    assert.strictEqual(typeof resolve, 'function');
    assert.ok(Object.isFrozen(MODOS), 'MODOS congelado');
    assert.deepStrictEqual(Object.values(MODOS).sort(), ['explicito', 'productivo', 'pruebas']);
    assert.strictEqual(ENV_AMBIENTE, 'PIPELINE_AMBIENTE');
    assert.strictEqual(DEFAULT_PRODUCTIVE_DIR, path.resolve(__dirname, '..', '..'));
    assert.strictEqual(path.basename(DEFAULT_PRODUCTIVE_DIR), '.pipeline');
});

test('CA-1 · reutiliza ENV_ROOT_VARS de config-resolver (precedencia D-1 exportada, no copiada)', () => {
    const { ENV_ROOT_VARS } = require('../config-resolver');
    assert.strictEqual(typeof ENV_ROOT_VARS, 'object');
    assert.ok(Object.isFrozen(ENV_ROOT_VARS));
    assert.deepStrictEqual(ENV_ROOT_VARS.map((c) => c.env), ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT']);
});

// ─── CA-2 · los tres modos, cada uno con dir + perfil de canales ─────────────

test('CA-2 · sin declaración de ambiente resuelve a pruebas con dir null y canales de pruebas', () => {
    for (const env of [{}, undefined, null, 'no-es-objeto', { OTRA_VAR: 'x' }]) {
        const out = resolve(env);
        assertForma(out, `env=${JSON.stringify(env)}`);
        assert.strictEqual(out.modo, MODOS.PRUEBAS);
        assert.strictEqual(out.dir, null, 'nunca cae a __dirname/.. (fail-closed)');
        assert.strictEqual(out.origen, 'ninguno');
        assert.match(out.motivo, /sin declaración de ambiente/);
        assert.match(out.motivo, /PIPELINE_AMBIENTE=productivo/, 'el motivo dice cómo declarar');
        assertPerfilPruebas(out.canales, 'pruebas');
        assert.strictEqual(out.canales.proveedores.agentModelsPath, null);
    }
});

test('CA-2 · PIPELINE_AMBIENTE=productivo sin variable de directorio resuelve a productivo con el dir fijo y canales productivos', () => {
    const out = resolve(PRODUCTIVO);
    assertForma(out, 'productivo');
    assert.strictEqual(out.modo, MODOS.PRODUCTIVO);
    assert.strictEqual(out.dir, DEFAULT_PRODUCTIVE_DIR);
    assert.strictEqual(out.origen, 'default');
    assert.strictEqual(out.motivo, null, 'nada que explicar');
    assertPerfilProductivo(out.canales, 'productivo');
});

test('CA-2 · opts.pipelineDir resuelve a explicito con dir del parámetro y canales de pruebas aunque el env declare productivo (SEC-2)', () => {
    const tmp = tmpDir('explicito');
    for (const env of [PRODUCTIVO, {}, { PIPELINE_DIR_OVERRIDE: tmpDir('ignorado') }]) {
        const out = resolve(env, { pipelineDir: tmp });
        assertForma(out, 'explicito');
        assert.strictEqual(out.modo, MODOS.EXPLICITO);
        assert.strictEqual(out.dir, path.resolve(tmp));
        assert.strictEqual(out.origen, 'param');
        assert.strictEqual(out.motivo, null);
        assertPerfilPruebas(out.canales, 'explicito');
        assert.strictEqual(out.canales.proveedores.agentModelsPath, path.join(path.resolve(tmp), 'agent-models.json'));
    }
});

test('CA-2 · opts.pipelineDir vacío o no-string no cuenta como explícito', () => {
    for (const opts of [{ pipelineDir: '' }, { pipelineDir: '   ' }, { pipelineDir: 42 }, {}, undefined, null]) {
        assert.strictEqual(resolve(PRODUCTIVO, opts).modo, MODOS.PRODUCTIVO, `opts=${JSON.stringify(opts)}`);
    }
});

test('CA-2 · el perfil de canales está congelado en los tres modos (no se puede mutar desde el llamador)', () => {
    const tmp = tmpDir('frozen');
    for (const out of [resolve({}), resolve(PRODUCTIVO), resolve({}, { pipelineDir: tmp })]) {
        assert.ok(Object.isFrozen(out.canales), `${out.modo}: canales`);
        for (const k of CANALES_KEYS) assert.ok(Object.isFrozen(out.canales[k]), `${out.modo}: canales.${k}`);
    }
});

// ─── CA-3 · el modo NUNCA se infiere de la variable de directorio ────────────

test('CA-3 · PIPELINE_DIR_OVERRIDE sin declaración da pruebas con ese dir (la variable aporta directorio, no modo)', () => {
    const tmp = tmpDir('dironly');
    const out = resolve({ PIPELINE_DIR_OVERRIDE: tmp });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.strictEqual(out.dir, path.resolve(tmp));
    assert.strictEqual(out.origen, 'PIPELINE_DIR_OVERRIDE');
    assert.match(out.motivo, /sin declaración de ambiente/);
    assertPerfilPruebas(out.canales, 'dir-only');
    assert.strictEqual(out.canales.proveedores.agentModelsPath, path.join(path.resolve(tmp), 'agent-models.json'));
});

test('CA-3/SEC-1 · declaración productiva con PIPELINE_DIR_OVERRIDE fuera del productivo se degrada a pruebas y lo explica', () => {
    const tmp = tmpDir('sec1');
    const out = resolve({ ...PRODUCTIVO, PIPELINE_DIR_OVERRIDE: tmp });
    assert.strictEqual(out.modo, MODOS.PRUEBAS, 'no productivo');
    assert.strictEqual(out.dir, path.resolve(tmp));
    assert.strictEqual(out.origen, 'PIPELINE_DIR_OVERRIDE');
    assert.match(out.motivo, /declaración productiva con dir no productivo/);
    assert.match(out.motivo, /PIPELINE_DIR_OVERRIDE/, 'el motivo nombra la variable que causó la degradación');
    assertPerfilPruebas(out.canales, 'sec1');
});

test('CA-3/SEC-1 · la degradación también aplica con PIPELINE_STATE_DIR y PIPELINE_REPO_ROOT', () => {
    for (const varName of ['PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT']) {
        const out = resolve({ ...PRODUCTIVO, [varName]: tmpDir(varName) });
        assert.strictEqual(out.modo, MODOS.PRUEBAS, varName);
        assert.strictEqual(out.origen, varName);
        assert.match(out.motivo, new RegExp(varName));
        assertPerfilPruebas(out.canales, varName);
    }
});

test('CA-3/SEC-1 · declaración productiva con PIPELINE_DIR_OVERRIDE apuntando EXACTAMENTE al productivo sigue siendo productivo', () => {
    for (const varName of ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR']) {
        const out = resolve({ ...PRODUCTIVO, [varName]: DEFAULT_PRODUCTIVE_DIR });
        assert.strictEqual(out.modo, MODOS.PRODUCTIVO, varName);
        assert.strictEqual(out.dir, DEFAULT_PRODUCTIVE_DIR);
        assert.strictEqual(out.origen, varName);
        assert.strictEqual(out.motivo, null);
        assertPerfilProductivo(out.canales, varName);
    }
    // PIPELINE_REPO_ROOT = repo → + '.pipeline' = productivo.
    const viaRepo = resolve({ ...PRODUCTIVO, PIPELINE_REPO_ROOT: path.dirname(DEFAULT_PRODUCTIVE_DIR) });
    assert.strictEqual(viaRepo.modo, MODOS.PRODUCTIVO);
    assert.strictEqual(viaRepo.dir, DEFAULT_PRODUCTIVE_DIR);
    assert.strictEqual(viaRepo.origen, 'PIPELINE_REPO_ROOT');
});

test('CA-3 · precedencia D-1: PIPELINE_DIR_OVERRIDE > PIPELINE_STATE_DIR > PIPELINE_REPO_ROOT (+/.pipeline), origen refleja la ganadora', () => {
    const a = tmpDir('override');
    const b = tmpDir('state');
    const c = tmpDir('reporoot');

    const todos = resolve({ PIPELINE_DIR_OVERRIDE: a, PIPELINE_STATE_DIR: b, PIPELINE_REPO_ROOT: c });
    assert.strictEqual(todos.dir, path.resolve(a));
    assert.strictEqual(todos.origen, 'PIPELINE_DIR_OVERRIDE');

    const sinOverride = resolve({ PIPELINE_STATE_DIR: b, PIPELINE_REPO_ROOT: c });
    assert.strictEqual(sinOverride.dir, path.resolve(b));
    assert.strictEqual(sinOverride.origen, 'PIPELINE_STATE_DIR');

    const soloRepo = resolve({ PIPELINE_REPO_ROOT: c });
    assert.strictEqual(soloRepo.dir, path.join(path.resolve(c), '.pipeline'), 'REPO_ROOT suma el sufijo .pipeline');
    assert.strictEqual(soloRepo.origen, 'PIPELINE_REPO_ROOT');

    for (const out of [todos, sinOverride, soloRepo]) assert.strictEqual(out.modo, MODOS.PRUEBAS);
});

test('CA-3 · una variable de directorio vacía o de espacios se ignora y sigue la cadena', () => {
    const b = tmpDir('blank');
    const out = resolve({ PIPELINE_DIR_OVERRIDE: '   ', PIPELINE_STATE_DIR: b });
    assert.strictEqual(out.dir, path.resolve(b));
    assert.strictEqual(out.origen, 'PIPELINE_STATE_DIR');
    const nada = resolve({ PIPELINE_DIR_OVERRIDE: '', PIPELINE_STATE_DIR: 7 });
    assert.strictEqual(nada.dir, null);
    assert.strictEqual(nada.origen, 'ninguno');
});

// ─── CA-4 · fail-closed: pruebas jamás termina apuntando al productivo ───────

test('CA-4/SEC-3 · en pruebas, un dir igual al productivo o subpath de él se anula a null y lo explica', () => {
    const casos = [
        { PIPELINE_DIR_OVERRIDE: DEFAULT_PRODUCTIVE_DIR },
        { PIPELINE_DIR_OVERRIDE: path.join(DEFAULT_PRODUCTIVE_DIR, 'state') },
        { PIPELINE_STATE_DIR: path.join(DEFAULT_PRODUCTIVE_DIR, 'desarrollo', 'dev') },
        { PIPELINE_REPO_ROOT: path.dirname(DEFAULT_PRODUCTIVE_DIR) },
        // Sin normalizar: el guard usa path.resolve de ambos lados.
        { PIPELINE_DIR_OVERRIDE: path.join(DEFAULT_PRODUCTIVE_DIR, 'lib', '..', 'state', '.') },
    ];
    for (const env of casos) {
        const out = resolve(env);
        const varName = Object.keys(env)[0];
        assert.strictEqual(out.modo, MODOS.PRUEBAS, varName);
        assert.strictEqual(out.dir, null, `${varName}: dir anulado`);
        assert.strictEqual(out.origen, varName);
        assert.match(out.motivo, /apunta al productivo/, varName);
        assert.match(out.motivo, new RegExp(varName), 'el motivo nombra la variable');
        assertPerfilPruebas(out.canales, varName);
        assert.strictEqual(out.canales.proveedores.agentModelsPath, null);
    }
});

test('CA-4/SEC-3 · un hermano del productivo con prefijo de nombre igual NO se confunde con subpath (comparación con path.sep)', () => {
    const hermano = `${DEFAULT_PRODUCTIVE_DIR}-otro`;
    const out = resolve({ PIPELINE_DIR_OVERRIDE: hermano });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.strictEqual(out.dir, path.resolve(hermano), 'no es subpath: se respeta');
    assert.doesNotMatch(out.motivo, /apunta al productivo/);
});

test('CA-4/SEC-3 · con señal de test y dir dentro del productivo también se anula (el derrame de #7086 no puede repetirse)', () => {
    const out = resolve({ NODE_TEST_CONTEXT: '1', PIPELINE_DIR_OVERRIDE: DEFAULT_PRODUCTIVE_DIR });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.strictEqual(out.dir, null);
    assert.match(out.motivo, /apunta al productivo/);
    assert.match(out.motivo, /NODE_TEST_CONTEXT/, 'conserva la causa original');
});

// ─── CA-5 · señales de test y escape hatch ───────────────────────────────────

test('CA-5/SEC-5 · una señal de test le gana a la declaración productiva', () => {
    const senales = [
        [{ NODE_TEST_CONTEXT: '1' }, /NODE_TEST_CONTEXT/],
        [{ NODE_ENV: 'test' }, /NODE_ENV=test/],
        [{ PULPO_NO_AUTOSTART: '1' }, /PULPO_NO_AUTOSTART=1/],
    ];
    for (const [senal, re] of senales) {
        const out = resolve({ ...PRODUCTIVO, ...senal });
        assert.strictEqual(out.modo, MODOS.PRUEBAS, JSON.stringify(senal));
        assert.strictEqual(out.dir, null, 'sin dir de pruebas declarado');
        assert.match(out.motivo, /corrida de prueba/);
        assert.match(out.motivo, re, 'el motivo nombra la variable de la señal');
        assertPerfilPruebas(out.canales, JSON.stringify(senal));
    }
});

test('CA-5/SEC-5 · señal de test + escape hatch + declaración productiva da productivo y el motivo cita el hatch', () => {
    const out = resolve({ ...PRODUCTIVO, NODE_TEST_CONTEXT: '1', PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' });
    assert.strictEqual(out.modo, MODOS.PRODUCTIVO);
    assert.strictEqual(out.dir, DEFAULT_PRODUCTIVE_DIR);
    assert.match(out.motivo, /escape hatch PIPELINE_ALLOW_PROD_SIDE_EFFECTS/, 'queda trazado');
    assert.match(out.motivo, /NODE_TEST_CONTEXT/, 'dice qué señal anuló');
    assertPerfilProductivo(out.canales, 'hatch');
});

test('CA-5/SEC-5 · escape hatch + señal de test SIN declaración sigue en pruebas (el hatch no crea productivo)', () => {
    const out = resolve({ NODE_TEST_CONTEXT: '1', PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.strictEqual(out.dir, null);
    assert.match(out.motivo, /escape hatch PIPELINE_ALLOW_PROD_SIDE_EFFECTS sin declaración productiva/);
    assertPerfilPruebas(out.canales, 'hatch-sin-declaracion');
});

test('CA-5/SEC-5 · escape hatch con declaración productiva pero sin señal no deja rastro (no cambió nada)', () => {
    const out = resolve({ ...PRODUCTIVO, PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' });
    assert.strictEqual(out.modo, MODOS.PRODUCTIVO);
    assert.strictEqual(out.motivo, null);
});

test('CA-5/SEC-5 · el escape hatch sólo enciende con el valor exacto "1"', () => {
    for (const v of ['true', 'yes', '0', '', ' 1']) {
        const out = resolve({ ...PRODUCTIVO, NODE_TEST_CONTEXT: '1', PIPELINE_ALLOW_PROD_SIDE_EFFECTS: v });
        assert.strictEqual(out.modo, MODOS.PRUEBAS, `hatch=${JSON.stringify(v)}`);
    }
});

test('CA-5/SEC-1+SEC-5 · escape hatch + declaración productiva + dir no productivo sigue degradando a pruebas', () => {
    const tmp = tmpDir('hatch-dir');
    const out = resolve({ ...PRODUCTIVO, NODE_ENV: 'test', PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1', PIPELINE_DIR_OVERRIDE: tmp });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.strictEqual(out.dir, path.resolve(tmp));
    assert.match(out.motivo, /declaración productiva con dir no productivo \(PIPELINE_DIR_OVERRIDE\)/);
});

// ─── Declaración: valores no reconocidos (guideline UX #2) ──────────────────

test('UX · un valor no reconocido de PIPELINE_AMBIENTE cae a pruebas y el motivo hace visible el typo', () => {
    for (const v of ['prod', 'produccion', 'PRODUCTIVO', ' productivo', 'production']) {
        const out = resolve({ [ENV_AMBIENTE]: v });
        assert.strictEqual(out.modo, MODOS.PRUEBAS, v);
        assert.strictEqual(out.dir, null);
        assert.match(out.motivo, /no reconocido/, v);
        assert.ok(out.motivo.includes(`'${v}'`), `${v}: el motivo muestra el valor recibido`);
        assert.match(out.motivo, /'productivo'/, 'dice cuál es el único valor productivo');
        assertPerfilPruebas(out.canales, v);
    }
});

test('UX · PIPELINE_AMBIENTE=pruebas es una declaración explícita reconocida y se explica como tal', () => {
    const out = resolve({ [ENV_AMBIENTE]: 'pruebas' });
    assert.strictEqual(out.modo, MODOS.PRUEBAS);
    assert.match(out.motivo, /declaración explícita de pruebas \(PIPELINE_AMBIENTE=pruebas\)/);
    assert.deepStrictEqual([...pipelineEnv.VALORES_AMBIENTE], ['productivo', 'pruebas']);
});

test('UX · PIPELINE_AMBIENTE vacío o de espacios equivale a no declarado', () => {
    for (const v of ['', '   ']) {
        const out = resolve({ [ENV_AMBIENTE]: v });
        assert.strictEqual(out.modo, MODOS.PRUEBAS);
        assert.match(out.motivo, /sin declaración de ambiente/);
    }
});

// ─── CA-6 · la resolución no depende del momento del require ─────────────────

test('CA-6 · override tardío: el módulo ya cargado refleja el env recibido en cada llamada, no el del require', () => {
    // El módulo ya fue cargado arriba (`require('../pipeline-env')`) y ya se
    // llamó `resolve({})` en tests anteriores. Ahora un env distinto:
    const antes = resolve({});
    const tmp = tmpDir('tardio');
    const despues = resolve({ PIPELINE_DIR_OVERRIDE: tmp });
    assert.strictEqual(antes.dir, null);
    assert.strictEqual(despues.dir, path.resolve(tmp));
    assert.strictEqual(despues.origen, 'PIPELINE_DIR_OVERRIDE');
    assert.notDeepStrictEqual(antes, despues);
    // Y volver atrás también funciona: no hay estado capturado.
    assert.deepStrictEqual(resolve({}), antes);
});

test('CA-6 · resolve es determinístico: dos llamadas con el mismo env son deepStrictEqual', () => {
    const tmp = tmpDir('determinista');
    const envs = [
        {},
        PRODUCTIVO,
        { PIPELINE_DIR_OVERRIDE: tmp },
        { ...PRODUCTIVO, NODE_TEST_CONTEXT: '1', PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' },
    ];
    for (const env of envs) {
        assert.deepStrictEqual(resolve(env), resolve(env), JSON.stringify(env));
        assert.deepStrictEqual(resolve(env, { pipelineDir: tmp }), resolve(env, { pipelineDir: tmp }));
    }
});

test('CA-6 · resolve no muta el env que recibe', () => {
    const env = Object.freeze({ ...PRODUCTIVO, PIPELINE_DIR_OVERRIDE: tmpDir('nomuta') });
    const copia = { ...env };
    resolve(env);
    assert.deepStrictEqual({ ...env }, copia);
});

// ─── CA-7 · perfil descriptivo, sin secretos ni efectos ──────────────────────

test('CA-7/SEC-6 · la salida de los tres modos no contiene valores del env (tokens, keys, chat ids)', () => {
    const secretos = {
        TELEGRAM_BOT_TOKEN: 'tok-xyz',
        OPENAI_API_KEY: 'sk-abc',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ID_PRUEBAS: '67890',
        ANTHROPIC_API_KEY: 'ant-secret',
    };
    const tmp = tmpDir('secretos');
    const salidas = [
        resolve({ ...secretos }),
        resolve({ ...secretos, ...PRODUCTIVO }),
        resolve({ ...secretos, ...PRODUCTIVO }, { pipelineDir: tmp }),
        resolve({ ...secretos, ...PRODUCTIVO, PIPELINE_DIR_OVERRIDE: tmp }),
    ];
    for (const out of salidas) {
        const json = JSON.stringify(out);
        assert.doesNotMatch(json, /tok-xyz|sk-abc|12345|67890|ant-secret/, `${out.modo}: sin secretos en la salida`);
    }
});

test('CA-7/SEC-7 · pureza estructural: el fuente no lee process.env ni tiene efectos ni carga módulos con secretos', () => {
    const raw = fs.readFileSync(SRC_PATH, 'utf8');
    // Pre-checklist del arquitecto: `grep -n "process.env"` sobre el ARCHIVO COMPLETO → 0 líneas.
    assert.doesNotMatch(raw, /process\.env/, 'sin process.env ni siquiera en comentarios (CA-6: independiente del require)');
    // El resto se evalúa sobre el CÓDIGO: la cabecera nombra a propósito lo que el módulo no usa.
    const src = fuenteSinComentarios(raw);
    assert.doesNotMatch(src, /process\.cwd/, 'sin process.cwd');
    assert.doesNotMatch(src, /child_process/, 'sin child_process');
    assert.doesNotMatch(src, /writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync/, 'sin escrituras a disco');
    assert.doesNotMatch(src, /require\(['"]fs['"]\)|require\(['"]node:fs['"]\)/, 'sin fs');
    assert.doesNotMatch(src, /require\(['"](node:)?(http|https|net)['"]\)/, 'sin red');
    assert.doesNotMatch(src, /require\(['"]\.\/(credentials|telegram-secrets|secret-vault|pulpo)/, 'sin módulos con secretos');
    assert.doesNotMatch(src, /require\(['"]\.\.\/pulpo/, 'sin pulpo');
    assert.doesNotMatch(src, /buildParameterPath|readVaultConfig|loadIntoEnv/, 'vault es un dato, no una lectura (SEC-8)');
    assert.match(src, /require\('\.\/config-resolver'\)/, 'reutiliza la lista D-1 en vez de copiarla');
    assert.match(src, /const \{ ENV_ROOT_VARS \} = require\('\.\/config-resolver'\)/);
});

test('CA-7/SEC-7 · el único require del módulo además de path es config-resolver', () => {
    const src = fuenteSinComentarios(fs.readFileSync(SRC_PATH, 'utf8'));
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(requires, ['./config-resolver', 'path']);
});

test('CA-7 · el JSDoc de cabecera documenta la discrepancia con los guards del pulpo y el manual de uso (CA-8, UX #3/#4)', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    const cabecera = src.slice(0, src.indexOf("const path = require('path')"));
    assert.match(cabecera, /ghWritesBloqueadas/, 'discrepancia con ghWritesBloqueadas escrita');
    assert.match(cabecera, /corridaDePrueba/, 'discrepancia con corridaDePrueba escrita');
    assert.match(cabecera, /#7112/, 'referencia a la reconciliación');
    assert.match(cabecera, /PIPELINE_AMBIENTE=productivo/, 'cómo declarar productivo');
    assert.match(cabecera, /PIPELINE_DIR_OVERRIDE.*>.*PIPELINE_STATE_DIR.*>[\s\S]*PIPELINE_REPO_ROOT/, 'precedencia documentada');
    assert.match(cabecera, /pipelineEnv\.resolve\(entornoDelProceso\)/, 'ejemplo de llamada con el env del proceso pasado por el llamador');
    assert.doesNotMatch(cabecera, /process\.env/, 'ni el ejemplo nombra la global (pre-checklist grep = 0)');
});

// ─── CA-8 · convivencia ──────────────────────────────────────────────────────

test('CA-8 · config-resolver.resolveConfigPath sigue funcionando igual tras exportar ENV_ROOT_VARS', () => {
    const cr = require('../config-resolver');
    const tmp = tmpDir('cr');
    const r = cr.resolveConfigPath({ pipelineDir: tmp });
    assert.strictEqual(r.dir, path.resolve(tmp));
    assert.strictEqual(r.via, 'arg:pipelineDir');
    assert.strictEqual(r.file, path.join(path.resolve(tmp), 'config.yaml'));
    assert.strictEqual(typeof cr.resolveConfigPath, 'function');
});

test('CA-8 · pipeline-env es el único módulo del lib que exporta un resolvedor de ambiente (PIPELINE_AMBIENTE)', () => {
    const libDir = path.join(__dirname, '..');
    const conDeclaracion = fs.readdirSync(libDir)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => /PIPELINE_AMBIENTE/.test(fs.readFileSync(path.join(libDir, f), 'utf8')));
    assert.deepStrictEqual(conDeclaracion, ['pipeline-env.js']);
});
