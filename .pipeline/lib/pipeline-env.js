'use strict';

/**
 * #7110 (split de #7102) — RESOLVEDOR ÚNICO DE AMBIENTE DEL PIPELINE.
 *
 * Único módulo del repo que decide "¿a qué ambiente apunto?": productivo o
 * pruebas. Es el punto de decisión que antes estaba copiado ~125 veces como
 * `if (env.PIPELINE_DIR_OVERRIDE) return ...` sobre la global del proceso, cada
 * copia por su cuenta.
 * Esta historia crea el punto único; la migración de los escritores es #7112 y
 * los lectores migran por goteo.
 *
 * ── Manual de uso ───────────────────────────────────────────────────────────
 *
 *   const pipelineEnv = require('./lib/pipeline-env');
 *   const amb = pipelineEnv.resolve(entornoDelProceso);   // el LLAMADOR pasa su env
 *   // (`entornoDelProceso` es la global de entorno del proceso; este módulo
 *   //  nunca la lee por su cuenta — ver "Pureza")
 *   // amb = { modo, dir, origen, motivo, canales: { telegram, github, proveedores, vault } }
 *
 * - Cómo declarar productivo: `PIPELINE_AMBIENTE=productivo`. Es la ÚNICA forma
 *   de obtener canales productivos (Telegram real, escrituras a GitHub, vault
 *   `intrale`), y además el directorio resuelto tiene que ser exactamente el
 *   `.pipeline` del repo (`DEFAULT_PRODUCTIVE_DIR`). Con cualquier otro dir la
 *   declaración se degrada a `pruebas` (SEC-1).
 * - Qué pasa si no se declara: `modo: 'pruebas'`. Sin variable de directorio,
 *   `dir: null` — NUNCA cae a `__dirname/..` (fail-closed; #7111 provee el dir
 *   desechable). Los canales de pruebas sin valor quedan apagados, nunca heredan
 *   el valor productivo (SEC-4).
 * - Precedencia del directorio (misma lista D-1 que `config-resolver`, exportada
 *   como `ENV_ROOT_VARS`): `PIPELINE_DIR_OVERRIDE` > `PIPELINE_STATE_DIR` >
 *   `PIPELINE_REPO_ROOT` (+ `/.pipeline`). La variable aporta DIRECTORIO, nunca
 *   modo: `PIPELINE_DIR_OVERRIDE` seteado y sin declaración sigue siendo
 *   `pruebas` porque no hay declaración, no porque exista la variable.
 * - `opts.pipelineDir` → `modo: 'explicito'`: el dir es el parámetro y los
 *   canales son SIEMPRE los de pruebas (SEC-2). Path arbitrario + canales reales
 *   es una combinación inconstruible a propósito.
 * - Señales de corrida de prueba (`NODE_TEST_CONTEXT`, `PULPO_NO_AUTOSTART=1`,
 *   `NODE_ENV=test`) le ganan a la declaración productiva. El escape hatch
 *   `PIPELINE_ALLOW_PROD_SIDE_EFFECTS=1` sólo anula la señal; sin declaración
 *   productiva el resultado sigue siendo `pruebas`, y cuando el hatch cambió el
 *   resultado queda escrito en `motivo` (SEC-5).
 * - `motivo` es para humanos: `<qué pasó> (<variable o valor que lo causó>)`.
 *   `null` cuando no hubo nada que explicar.
 *
 * ── Pureza ──────────────────────────────────────────────────────────────────
 *
 * El módulo recibe el entorno POR PARÁMETRO y no lee la global de entorno del
 * proceso en ningún lugar del fuente: la resolución no depende del momento del
 * `require` (el bug de las const de módulo que capturan el dir antes del
 * override). Sin `fs`, sin `child_process`, sin red, sin `require` de módulos
 * que carguen secretos (`credentials`, `telegram-secrets`, `secret-vault`,
 * `pulpo`). El perfil de `canales` es DESCRIPTIVO: nombres de variables, paths
 * y namespaces; nunca valores (SEC-6). La salida completa se puede loggear tal
 * cual.
 *
 * Única const estática permitida: `DEFAULT_PRODUCTIVE_DIR` (fijada en código a
 * propósito, igual que `credentials.readVaultConfig` fija su raíz — B2.7).
 *
 * ── Discrepancias conocidas con los guards del pulpo (defensa en profundidad) ─
 *
 * Los guards `corridaDePrueba()`, `efectoProductivoBloqueado()` y
 * `ghWritesBloqueadas()` de `pulpo.js` NO se retiran (CA explícito de #7102).
 * Conviven con este resolvedor y ante discrepancia gana el más conservador:
 *
 * 1. `ghWritesBloqueadas()` trata `PIPELINE_DIR_OVERRIDE` como señal de pruebas;
 *    este resolvedor NO infiere modo de esa variable (5 sitios productivos la
 *    mutan en runtime — `commander-deterministic.js`, `wave-resolver.js`,
 *    `skills-deterministicos/delivery.js` — y se auto-clasificarían como pruebas
 *    a mitad de una operación; ver #7393). Se reconcilia en #7112.
 * 2. `corridaDePrueba()` evalúa el escape hatch ANTES que las señales y lo honra
 *    sin exigir declaración; este resolvedor lo evalúa DESPUÉS y sólo lo honra
 *    con `PIPELINE_AMBIENTE=productivo` (SEC-5). Deliberado: el resolvedor es
 *    más conservador que el guard.
 * 3. Vocabulario de señales: `corridaDePrueba()` nombra `NODE_TEST_CONTEXT`
 *    como `'node --test'`; acá se usa el NOMBRE DE LA VARIABLE (es lo que el
 *    operador puede grepear). Unificar cuando #7112 migre.
 *
 * @module pipeline-env
 */

const path = require('path');
const { ENV_ROOT_VARS } = require('./config-resolver');

/** Directorio productivo, fijado en código. Única const estática del módulo. */
const DEFAULT_PRODUCTIVE_DIR = path.resolve(__dirname, '..');

/** Nombre de la variable que declara el ambiente. Único valor productivo: `productivo`. */
const ENV_AMBIENTE = 'PIPELINE_AMBIENTE';

/** Valor de `ENV_AMBIENTE` que declara productivo. */
const VALOR_PRODUCTIVO = 'productivo';

/** Escape hatch que anula la señal de corrida de prueba (mismo que `corridaDePrueba()`). */
const ENV_ESCAPE_HATCH = 'PIPELINE_ALLOW_PROD_SIDE_EFFECTS';

const MODOS = Object.freeze({
    PRODUCTIVO: 'productivo',
    PRUEBAS: 'pruebas',
    EXPLICITO: 'explicito',
});

/** Valores reconocidos de `ENV_AMBIENTE`. Cualquier otro se reporta como no reconocido. */
const VALORES_AMBIENTE = Object.freeze([VALOR_PRODUCTIVO, MODOS.PRUEBAS]);

/**
 * Espejo de `corridaDePrueba()` (`pulpo.js`), sin el escape hatch (ese se
 * evalúa aparte en `resolve`) y nombrando cada señal por su variable.
 *
 * @param {object} e entorno ya normalizado.
 * @returns {string|null} nombre de la señal, o `null` si no hay corrida de prueba.
 */
function senalDePrueba(e) {
    if (e.NODE_TEST_CONTEXT) return 'NODE_TEST_CONTEXT';
    if (e.PULPO_NO_AUTOSTART === '1') return 'PULPO_NO_AUTOSTART=1';
    if (e.NODE_ENV === 'test') return 'NODE_ENV=test';
    return null;
}

/**
 * Resuelve el DIRECTORIO con la precedencia D-1 (misma lista congelada que
 * `config-resolver.resolveConfigPath`, pero sobre el `env` recibido).
 *
 * @param {object} e entorno ya normalizado.
 * @returns {{dir: string|null, origen: string}}
 */
function resolverDir(e) {
    for (const cand of ENV_ROOT_VARS) {
        const v = e[cand.env];
        if (typeof v === 'string' && v.trim()) {
            const base = path.resolve(v);
            return { dir: cand.suffix ? path.join(base, cand.suffix) : base, origen: cand.env };
        }
    }
    return { dir: null, origen: 'ninguno' };
}

/**
 * Mismo criterio que `efectoProductivoBloqueado()` (`pulpo.js`): `path.resolve`
 * de ambos lados y comparación con `path.sep` (funciona en Windows).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function dentroDelProductivo(dir) {
    const d = path.resolve(dir);
    return d === DEFAULT_PRODUCTIVE_DIR || d.startsWith(DEFAULT_PRODUCTIVE_DIR + path.sep);
}

/**
 * Perfil de canales, DESCRIPTIVO (SEC-4, SEC-6): misma forma en los tres modos,
 * nombres de variables/paths/namespaces, nunca valores.
 *
 * Canales productivos únicamente con `modo === 'productivo'` y
 * `dir === DEFAULT_PRODUCTIVE_DIR` (SEC-1). Todo lo demás es el perfil de pruebas:
 * canales apagados hasta que #7113 provea los valores de pruebas; jamás heredan
 * el valor productivo.
 *
 * El perfil de `vault` es un DATO: el módulo no llama a
 * `secret-vault.buildParameterPath` ni a `credentials.readVaultConfig` (B2.7,
 * SEC-8); el llamador se lo pasa explícito.
 *
 * @param {string} modo
 * @param {string|null} dir
 * @returns {object} perfil congelado.
 */
function perfilCanales(modo, dir) {
    const productivo = modo === MODOS.PRODUCTIVO && dir === DEFAULT_PRODUCTIVE_DIR;
    if (productivo) {
        return Object.freeze({
            telegram: Object.freeze({ enabled: true, chatIdVar: 'TELEGRAM_CHAT_ID', fuente: 'credentials.json' }),
            github: Object.freeze({ enabled: true, escrituras: true, auth: 'gh-session' }),
            proveedores: Object.freeze({ agentModelsPath: path.join(dir, 'agent-models.json') }),
            // config.yaml `vault.prefix` / `vault.projectId` — dato copiado, no lectura.
            vault: Object.freeze({ prefix: '/intrale', projectId: 'intrale' }),
        });
    }
    return Object.freeze({
        // Valor de `TELEGRAM_CHAT_ID_PRUEBAS` lo provee #7113; hasta entonces apagado.
        telegram: Object.freeze({ enabled: false, chatIdVar: 'TELEGRAM_CHAT_ID_PRUEBAS', fuente: null }),
        github: Object.freeze({ enabled: false, escrituras: false, auth: null }),
        proveedores: Object.freeze({ agentModelsPath: dir ? path.join(dir, 'agent-models.json') : null }),
        vault: Object.freeze({ prefix: '/intrale', projectId: 'intrale-pruebas' }),
    });
}

function armar(modo, dir, origen, motivo) {
    return { modo, dir, origen, motivo, canales: perfilCanales(modo, dir) };
}

/**
 * SEC-3: en `pruebas`, un dir que cae dentro del productivo se anula (`null`).
 * Es la versión declarativa de `efectoProductivoBloqueado()`: el derrame de
 * #7086 (avisos a Telegram real desde un test) no puede repetirse por un test
 * que apunte al `.pipeline` real.
 */
function armarPruebas(dir, origen, motivo) {
    if (dir !== null && dentroDelProductivo(dir)) {
        // `motivo` siempre viene con la causa original (señal, declaración, hatch):
        // se conserva a continuación para que el operador vea las dos cosas.
        return armar(MODOS.PRUEBAS, null, origen, `dir de pruebas apunta al productivo (${origen}); ${motivo}`);
    }
    return armar(MODOS.PRUEBAS, dir, origen, motivo);
}

/**
 * Describe la declaración de ambiente recibida.
 *
 * @param {object} e entorno ya normalizado.
 * @returns {{productivo: boolean, motivo: string|null}} `productivo` si la
 *   declaración es exactamente `productivo`; `motivo` explica una ausencia, una
 *   declaración explícita de pruebas o un valor no reconocido (typo visible).
 */
function leerDeclaracion(e) {
    const raw = e[ENV_AMBIENTE];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { productivo: false, motivo: `sin declaración de ambiente (falta ${ENV_AMBIENTE}=${VALOR_PRODUCTIVO})` };
    }
    const valor = String(raw);
    if (valor === VALOR_PRODUCTIVO) return { productivo: true, motivo: null };
    if (valor === MODOS.PRUEBAS) {
        return { productivo: false, motivo: `declaración explícita de pruebas (${ENV_AMBIENTE}=${valor})` };
    }
    return {
        productivo: false,
        motivo: `${ENV_AMBIENTE}='${valor}' no reconocido; el único valor productivo es '${VALOR_PRODUCTIVO}'`,
    };
}

/**
 * Resuelve el ambiente al que apunta el proceso.
 *
 * Orden de decisión:
 *   1. `opts.pipelineDir` → `explicito` (dir = parámetro; canales de pruebas, SEC-2).
 *   2. Señal de corrida de prueba → `pruebas`, salvo escape hatch (SEC-5).
 *   3. `PIPELINE_AMBIENTE=productivo` → `productivo`, sólo con dir productivo (SEC-1).
 *   4. Sin declaración (o valor no reconocido) → `pruebas`.
 *
 * Determinística y pura: mismo `env` ⇒ mismo resultado, en cualquier momento.
 *
 * @param {object} env entorno a evaluar (normalmente el env global del proceso, pasado por el llamador).
 * @param {{pipelineDir?: string}} [opts]
 * @returns {{modo: string, dir: string|null, origen: string, motivo: string|null, canales: object}}
 */
function resolve(env, opts = {}) {
    const e = env && typeof env === 'object' ? env : {};
    const o = opts && typeof opts === 'object' ? opts : {};

    // 1. explícito: dir = param, canales SIEMPRE de pruebas (SEC-2).
    if (typeof o.pipelineDir === 'string' && o.pipelineDir.trim()) {
        return armar(MODOS.EXPLICITO, path.resolve(o.pipelineDir), 'param', null);
    }

    const senal = senalDePrueba(e);
    const hatch = e[ENV_ESCAPE_HATCH] === '1';
    const declaracion = leerDeclaracion(e);
    const { dir, origen } = resolverDir(e);

    // 2. señal de test gana a la declaración; el escape hatch sólo la anula (SEC-5).
    if (senal && !hatch) {
        return armarPruebas(dir, origen, `corrida de prueba (${senal})`);
    }

    // 3. productivo requiere declaración + dir productivo fijo (SEC-1).
    if (declaracion.productivo) {
        const motivo = senal && hatch
            ? `escape hatch ${ENV_ESCAPE_HATCH} anuló la señal de prueba (${senal})`
            : null;
        if (dir === null) return armar(MODOS.PRODUCTIVO, DEFAULT_PRODUCTIVE_DIR, 'default', motivo);
        if (dir === DEFAULT_PRODUCTIVE_DIR) return armar(MODOS.PRODUCTIVO, dir, origen, motivo);
        return armarPruebas(dir, origen, `declaración productiva con dir no productivo (${origen})`);
    }

    // 4. sin declaración (o no reconocida) → pruebas.
    const motivo = senal && hatch
        ? `escape hatch ${ENV_ESCAPE_HATCH} sin declaración productiva (${declaracion.motivo})`
        : declaracion.motivo;
    return armarPruebas(dir, origen, motivo);
}

module.exports = {
    resolve,
    MODOS,
    DEFAULT_PRODUCTIVE_DIR,
    ENV_AMBIENTE,
    ENV_ESCAPE_HATCH,
    VALORES_AMBIENTE,
};
