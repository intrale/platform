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
 * - SEC-9 (#7112): en `pruebas`, `PIPELINE_REPO_ROOT` NO es fuente válida de
 *   `dir`. Es la variable de contexto productivo que el Pulpo hereda a todos
 *   sus hijos (agentes en worktree incluidos), no la declaración de un test:
 *   sin `PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` explícitos ⇒ `dir: null`.
 *   Además, "dentro del productivo" es la UNIÓN de `DEFAULT_PRODUCTIVE_DIR` y
 *   `PIPELINE_REPO_ROOT/.pipeline`: un módulo cargado desde un worktree sigue
 *   protegiendo el `.pipeline` del repo principal (aditivo, nunca menos).
 * - Los escritores NO llaman a `resolve` directo: usan el envoltorio
 *   `lib/write-target.js` (`writeDir(env, { canal })`), que aplica la regla de
 *   #7112 — con `dir === null` no se escribe y se falla ruidoso (SEC-10).
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
 * Conviven con este resolvedor y la reconciliación (#7112, SEC-12) es SÓLO POR
 * AND: una escritura sale si este resolvedor habilita el canal Y el guard
 * devuelve `null`. Ningún guard perdió una condición:
 *
 * 1. `ghWritesBloqueadas()` trata `PIPELINE_DIR_OVERRIDE` como señal de pruebas;
 *    este resolvedor NO infiere modo de esa variable (5 sitios productivos la
 *    mutan en runtime — `commander-deterministic.js`, `wave-resolver.js`,
 *    `skills-deterministicos/delivery.js` — y se auto-clasificarían como pruebas
 *    a mitad de una operación; ver #7393). El guard conserva ese check y ADEMÁS
 *    exige `canales.github.escrituras === true` de este resolvedor.
 * 2. `corridaDePrueba()` evalúa el escape hatch ANTES que las señales y lo honra
 *    sin exigir declaración; este resolvedor lo evalúa DESPUÉS y sólo lo honra
 *    con `PIPELINE_AMBIENTE=productivo` (SEC-5). Deliberado: el resolvedor es
 *    más conservador que el guard.
 * 3. Vocabulario de señales: unificado en #7112 — `corridaDePrueba()` también
 *    nombra cada señal por su VARIABLE (`NODE_TEST_CONTEXT`), que es lo que el
 *    operador puede grepear.
 * 4. `efectoProductivoBloqueado()` bloquea la misma unión que `esProductivo`
 *    (SEC-9): `.pipeline` propio + `PIPELINE_REPO_ROOT/.pipeline`.
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
 * SEC-9 (#7112): variable de contexto productivo que el Pulpo hereda a sus
 * hijos. En `pruebas` NO cuenta como declaración de directorio.
 */
const ENV_CONTEXTO_HEREDADO = 'PIPELINE_REPO_ROOT';

/**
 * `.pipeline` del repo principal según el contexto heredado, o `null` si no
 * viene. Segundo miembro de la unión que protege `dentroDelProductivo` (SEC-9).
 *
 * @param {object} e entorno ya normalizado.
 * @returns {string|null}
 */
function productivoHeredado(e) {
    const v = e[ENV_CONTEXTO_HEREDADO];
    if (typeof v !== 'string' || !v.trim()) return null;
    const cand = ENV_ROOT_VARS.find((c) => c.env === ENV_CONTEXTO_HEREDADO);
    const base = path.resolve(v);
    return cand && cand.suffix ? path.join(base, cand.suffix) : base;
}

function dentroDe(dir, raiz) {
    return dir === raiz || dir.startsWith(raiz + path.sep);
}

/**
 * Mismo criterio que `efectoProductivoBloqueado()` (`pulpo.js`): `path.resolve`
 * de ambos lados y comparación con `path.sep` (funciona en Windows).
 *
 * SEC-9 (#7112): se evalúa contra la UNIÓN `{ DEFAULT_PRODUCTIVE_DIR,
 * PIPELINE_REPO_ROOT/.pipeline }`. Cargado desde un worktree, el módulo sigue
 * reconociendo el `.pipeline` del repo principal como productivo. Aditivo:
 * nunca protege menos que antes.
 *
 * @param {string} dir
 * @param {object} [e] entorno ya normalizado (aporta el miembro heredado).
 * @returns {boolean}
 */
function dentroDelProductivo(dir, e = {}) {
    const d = path.resolve(dir);
    if (dentroDe(d, DEFAULT_PRODUCTIVE_DIR)) return true;
    const heredado = productivoHeredado(e);
    return heredado !== null && dentroDe(d, heredado);
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
function armarPruebas(dir, origen, motivo, e = {}) {
    if (dir === null) return armar(MODOS.PRUEBAS, null, origen, motivo);
    // El dir que sale de PIPELINE_REPO_ROOT cae trivialmente dentro de su propio
    // miembro de la unión: para ese origen sólo cuenta el productivo PROPIO como
    // "apunta al productivo"; el resto es SEC-9.
    const dentro = origen === ENV_CONTEXTO_HEREDADO
        ? dentroDe(path.resolve(dir), DEFAULT_PRODUCTIVE_DIR)
        : dentroDelProductivo(dir, e);
    if (dentro) {
        // `motivo` siempre viene con la causa original (señal, declaración, hatch):
        // se conserva a continuación para que el operador vea las dos cosas.
        return armar(MODOS.PRUEBAS, null, origen, `dir de pruebas apunta al productivo (${origen}); ${motivo}`);
    }
    if (origen === ENV_CONTEXTO_HEREDADO && e[ENV_AMBIENTE] !== MODOS.PRUEBAS) {
        // SEC-9: el contexto heredado del Pulpo no es la declaración de un test.
        // Excepción: con `PIPELINE_AMBIENTE=pruebas` EXPLÍCITO el proceso sí
        // declaró (es el par que emite `provision-test-env --print-env`, #7111):
        // ahí PIPELINE_REPO_ROOT es el root del ambiente de pruebas, no herencia.
        // Un agente hereda `productivo` (CA-7.2), nunca `pruebas`, así que V2
        // sigue cerrado; y SEC-3 (arriba) ya anuló el caso en que apunte al productivo.
        return armar(MODOS.PRUEBAS, null, origen,
            `${ENV_CONTEXTO_HEREDADO} es contexto heredado, no un dir de pruebas (SEC-9); ${motivo}`);
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
        return armarPruebas(dir, origen, `corrida de prueba (${senal})`, e);
    }

    // 3. productivo requiere declaración + dir productivo fijo (SEC-1).
    if (declaracion.productivo) {
        const motivo = senal && hatch
            ? `escape hatch ${ENV_ESCAPE_HATCH} anuló la señal de prueba (${senal})`
            : null;
        if (dir === null) return armar(MODOS.PRODUCTIVO, DEFAULT_PRODUCTIVE_DIR, 'default', motivo);
        if (dir === DEFAULT_PRODUCTIVE_DIR) return armar(MODOS.PRODUCTIVO, dir, origen, motivo);
        return armarPruebas(dir, origen, `declaración productiva con dir no productivo (${origen})`, e);
    }

    // 4. sin declaración (o no reconocida) → pruebas.
    const motivo = senal && hatch
        ? `escape hatch ${ENV_ESCAPE_HATCH} sin declaración productiva (${declaracion.motivo})`
        : declaracion.motivo;
    return armarPruebas(dir, origen, motivo, e);
}

/**
 * ¿`dir` cae dentro del productivo? Exportado para que los guards del Pulpo
 * (`efectoProductivoBloqueado`) bloqueen la misma unión que este módulo (SEC-9).
 * Nunca lanza: un destino no resoluble no es productivo.
 *
 * @param {string} dir
 * @param {object} env entorno del proceso, pasado por el llamador.
 * @returns {boolean}
 */
function esProductivo(dir, env) {
    const e = env && typeof env === 'object' ? env : {};
    try {
        return dentroDelProductivo(String(dir || ''), e);
    } catch {
        return false;
    }
}

module.exports = {
    resolve,
    esProductivo,
    VALOR_PRODUCTIVO,
    MODOS,
    DEFAULT_PRODUCTIVE_DIR,
    ENV_AMBIENTE,
    ENV_ESCAPE_HATCH,
    VALORES_AMBIENTE,
};
