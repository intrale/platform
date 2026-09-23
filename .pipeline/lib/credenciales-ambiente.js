'use strict';

/**
 * #7113 (split de #7102) — CREDENCIALES Y CANALES EXTERNOS POR AMBIENTE.
 *
 * Único punto del pipeline que decide QUÉ credenciales se hidratan y a QUÉ
 * destino apunta cada canal externo (Telegram, GitHub, proveedores de modelo,
 * vault), a partir del perfil descriptivo que devuelve `lib/pipeline-env.js`
 * (#7110). El resolvedor sigue puro y sin valores (SEC-6/SEC-7 de H1); este
 * módulo es el que los pone (D-3 del PO).
 *
 * ── Manual de uso ───────────────────────────────────────────────────────────
 *
 *   const credAmb = require('./lib/credenciales-ambiente').aplicar(entornoDelProceso, { logger });
 *   // credAmb = { ambiente, hidratacion, purgadas, canales, resumen }
 *   for (const linea of credAmb.resumen) stderr(linea);        // bloque UX-1, una sola vez
 *   const credLoad = credAmb.hidratacion;                       // misma forma que loadIntoEnv()
 *
 *   const tg = transporteTelegram(entornoDelProceso, { ambiente: credAmb.ambiente });
 *   if (tg.nulo) tg.trazar({ origen: 'pulpo:sendTelegram', texto });   // nunca abre red
 *
 * Reglas (CA-1..CA-6 del PO, RS-1..RS-9 de security):
 *
 *   - `modo === 'productivo'` ⇒ EXACTAMENTE lo de siempre: `credentials.json`
 *     hidratado sobre el env del proceso, canales reales. Una sola línea de
 *     resumen.
 *   - Cualquier otro modo (`pruebas`, `explicito`) ⇒ fail-closed por
 *     construcción (D-1):
 *       1. Se PURGAN del env las credenciales productivas heredadas de la shell
 *          (`CLAVES_PURGA`) ANTES de cualquier spawn: los hijos no pueden
 *          recibirlas ni por `{ ...env }` ni por `buildChildEnv`.
 *       2. Se hidrata SOLO el store de pruebas (`credentials.pruebas.json`,
 *          D-2) en un objeto temporal y se TRASPONE a variables con sufijo
 *          `_PRUEBAS` (`TELEGRAM_BOT_TOKEN_PRUEBAS`, `TELEGRAM_CHAT_ID_PRUEBAS`).
 *          Las productivas nunca se leen en pruebas, así que un `chat_id`
 *          productivo filtrado en la shell no puede usarse (CA-3 bullet 5).
 *          Sin legacy: el store ausente no cae al `telegram-config.json`
 *          productivo (R-C). API keys de proveedores y el ancla del operador
 *          NO se trasponen (CA-4).
 *       3. GitHub: `GH_CONFIG_DIR` apunta SIEMPRE a un directorio vacío dentro
 *          del dir de pruebas (el keyring del operador queda inalcanzable) y
 *          `GH_TOKEN` sólo se exporta si el store de pruebas trae
 *          `github.token` (identidad de pruebas sin `write`, RS-1). Si no lo
 *          trae, la variable queda AUSENTE, no vacía.
 *       4. Proveedores: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` apuntan a un sentinel
 *          bajo el dir de pruebas (inexistente salvo que el operador provisione
 *          una sesión de pruebas; técnica T2-1.4 de `secret-vault.js`), y el
 *          `agent-models.json` del dir se genera/regenera con `deterministic`
 *          como único provider (P-2 del guru): ningún agente resuelve a un LLM
 *          real por default.
 *       5. Vault: `projectId` del perfil (`intrale-pruebas`) y `awsProfile`
 *          propio. Si el `awsProfile` del dir de pruebas coincide con el del
 *          productivo (o está vacío), el vault queda APAGADO con motivo: la
 *          separación es de principal, no "lógica" (R-F).
 *   - Los escape hatches (`PIPELINE_ALLOW_*`) NO se leen acá: sólo
 *     `pipelineEnv.resolve` los interpreta (CA-6 / SEC-5).
 *   - Ninguna salida contiene VALORES: sólo nombres de archivo, de variable y
 *     paths (misma regla que SEC-6 de H1). El bloque de resumen se puede pegar
 *     en un issue.
 *   - Este archivo NO contiene el literal del nombre de la variable de ambiente
 *     (test CA-8 de H1): todo mensaje lo compone con `pipelineEnv.ENV_AMBIENTE`.
 *
 * @module credenciales-ambiente
 */

const fs = require('fs');
const path = require('path');

const pipelineEnv = require('./pipeline-env');
const credentials = require('./credentials');
const { redactTelegram } = require('./redact');

const { MODOS } = pipelineEnv;

/** Nombre del store de pruebas (sólo el nombre; el path lo fija `credentials`). */
const NOMBRE_STORE_PRUEBAS = path.basename(credentials.CANONICAL_PATH_PRUEBAS);

/** Nombre del store productivo. */
const NOMBRE_STORE_PRODUCTIVO = path.basename(credentials.CANONICAL_PATH);

/**
 * Claves productivas que se purgan del env en modo ≠ productivo: todo lo que
 * `credentials.loadIntoEnv` hidrata + las de GitHub (que `gh` lee del env).
 * Derivado del descriptor: no se duplica el inventario.
 */
const CLAVES_PURGA = Object.freeze([
    ...Object.values(credentials.HYDRATED_DESCRIPTORS).map((d) => d.env),
    'GH_TOKEN',
    'GITHUB_TOKEN',
]);

/** Variables por ambiente (nombres, nunca valores). */
const VARIABLES = Object.freeze({
    productivo: Object.freeze({
        botToken: credentials.HYDRATED_DESCRIPTORS['telegram.bot_token'].env,
        chatId: credentials.HYDRATED_DESCRIPTORS['telegram.chat_id'].env,
        openaiApiKey: credentials.HYDRATED_DESCRIPTORS['providers.openai.api_key'].env,
        anthropicApiKey: credentials.HYDRATED_DESCRIPTORS['providers.anthropic.api_key'].env,
    }),
    pruebas: Object.freeze({
        botToken: 'TELEGRAM_BOT_TOKEN_PRUEBAS',
        chatId: 'TELEGRAM_CHAT_ID_PRUEBAS',
    }),
});

/**
 * Sólo Telegram se traspone del store de pruebas al env (`<productiva>` →
 * `<productiva>_PRUEBAS`). API keys y ancla del operador NO (CA-4).
 */
const TRASPOSICION_PRUEBAS = Object.freeze({
    [VARIABLES.productivo.botToken]: VARIABLES.pruebas.botToken,
    [VARIABLES.productivo.chatId]: VARIABLES.pruebas.chatId,
});

/** Dot-path del token de GitHub dentro del store de pruebas. */
const DOTPATH_GITHUB_TOKEN = 'github.token';

/** Subdirectorios dentro del dir de pruebas. */
const SUBDIR_GH_CONFIG = 'gh-config';
const SUBDIR_SESIONES = 'sesiones-pruebas';
const SUBDIR_TRAZAS = Object.freeze(['servicios', 'telegram', 'trazas']);

/** Provider único habilitado en el `agent-models.json` de pruebas. */
const PROVIDER_PRUEBAS = 'deterministic';

/**
 * Raíz del sentinel cuando NO hay dir de pruebas (`dir === null`): paths que
 * no existen y que este módulo JAMÁS crea. Viven bajo el home (no bajo un temp
 * world-writable) por el mismo motivo que T2-1.4: plantarlos exige ya tener la
 * cuenta del operador.
 *
 * #7634 — vive en el módulo hoja `credential-sentinel.js` (compartido con
 * `build-child-env.js`, sin duplicar); acá se re-exporta con el mismo nombre.
 */
const { SENTINEL_SIN_DIR, pareceToken, sentinelPath } = require('./credential-sentinel');

/** Prefijo grepeable de todas las líneas del resumen (UX-1). */
const PREFIJO = '[ambiente]';

/** Sección del runbook a la que apuntan los motivos. */
const RUNBOOK = 'docs/runbooks/ambiente-pruebas-credenciales.md';

// ─── Helpers ────────────────────────────────────────────────────────────────

function esProductivo(ambiente) {
    return ambiente.modo === MODOS.PRODUCTIVO;
}

function leerJson(fsImpl, file) {
    try {
        if (!fsImpl.existsSync(file)) return { existe: false, data: null, error: null };
        return { existe: true, data: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null };
    } catch (e) {
        return { existe: true, data: null, error: e && e.message ? e.message : String(e) };
    }
}

function noVacio(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

// #7634 — `pareceToken` (forma de token de Telegram) y `sentinelPath` (ex
// `sentinel`) viven en `credential-sentinel.js`, importados arriba.

/** Lee la sección `vault` del `config.yaml` de un dir. `null` si no se puede leer. */
function leerVaultDeConfig(dir) {
    try {
        const cfg = require('./config-resolver').resolve({ pipelineDir: dir });
        return cfg && cfg.vault && typeof cfg.vault === 'object' ? cfg.vault : null;
    } catch {
        return null;
    }
}

// ─── Proveedores: agent-models.json de pruebas ───────────────────────────────

/**
 * ¿El `agent-models.json` sólo habilita `deterministic`? (P-2: el dir
 * provisionado por #7111 copia el productivo, que no lo es).
 */
function esSoloDeterministic(json) {
    if (!json || typeof json !== 'object') return false;
    if (json.default_provider !== PROVIDER_PRUEBAS) return false;
    const skills = json.skills && typeof json.skills === 'object' ? json.skills : {};
    for (const cfg of Object.values(skills)) {
        if (!cfg || typeof cfg !== 'object') return false;
        if (cfg.provider !== PROVIDER_PRUEBAS) return false;
        if (Array.isArray(cfg.fallbacks) && cfg.fallbacks.length > 0) return false;
    }
    return true;
}

/**
 * Deriva el `agent-models.json` de pruebas del productivo (es config, no
 * secreto): mismo inventario de providers y skills, pero `deterministic` como
 * único provider habilitado y sin cadenas de fallback. Un skill LLM ruteado a
 * `deterministic` falla en origen (`deterministic.js` · `DETERMINISTIC_SKILLS`)
 * con cero cuota consumida: es el comportamiento deseado (R-E).
 */
function derivarAgentModelsDePruebas(productivo) {
    const out = { ...productivo };
    out._doc = `${PREFIJO} generado por lib/credenciales-ambiente.js (#7113) para el ambiente de pruebas: `
        + `todo skill rutea a '${PROVIDER_PRUEBAS}'. No editar a mano; se regenera si deja de ser deterministic-only.`;
    out.default_provider = PROVIDER_PRUEBAS;
    const skills = {};
    for (const [nombre, cfg] of Object.entries(productivo.skills || {})) {
        const copia = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
        copia.provider = PROVIDER_PRUEBAS;
        delete copia.model_override;
        delete copia.fallbacks;
        skills[nombre] = copia;
    }
    out.skills = skills;
    return out;
}

/**
 * Garantiza que `<dir>/agent-models.json` exista y sea deterministic-only.
 *
 * @returns {{path: string|null, generado: boolean, motivo: string|null}}
 */
function asegurarAgentModelsDePruebas(destino, { fsImpl, productivoPath, logger }) {
    const actual = leerJson(fsImpl, destino);
    if (actual.existe && actual.data && esSoloDeterministic(actual.data)) {
        return { path: destino, generado: false, motivo: null };
    }
    const prod = leerJson(fsImpl, productivoPath);
    if (!prod.existe || !prod.data) {
        const causa = prod.error ? `JSON inválido: ${prod.error}` : 'no existe';
        logger(`${PREFIJO} proveedores: no se pudo derivar agent-models.json de pruebas (${productivoPath} ${causa})`);
        return { path: null, generado: false, motivo: `sin agent-models.json de pruebas: el productivo ${causa} (${productivoPath})` };
    }
    try {
        const derivado = derivarAgentModelsDePruebas(prod.data);
        fsImpl.mkdirSync(path.dirname(destino), { recursive: true });
        fsImpl.writeFileSync(destino, JSON.stringify(derivado, null, 2) + '\n', 'utf8');
    } catch (e) {
        logger(`${PREFIJO} proveedores: no se pudo escribir ${destino} (${e.message})`);
        return { path: null, generado: false, motivo: `no se pudo escribir agent-models.json de pruebas (${e.message})` };
    }
    const porque = actual.existe ? 'no era deterministic-only, regenerado' : 'no existía, generado';
    return { path: destino, generado: true, motivo: porque };
}

// ─── Vault ──────────────────────────────────────────────────────────────────

/**
 * Decide el vault del ambiente de pruebas (CA-5). Devuelve el `vaultConfig`
 * que se le pasa a `loadIntoEnv` (siempre explícito en pruebas: nunca se deja
 * que el loader lea el `config.yaml` productivo por su cuenta).
 */
function decidirVault(ambiente, opts) {
    const perfil = ambiente.canales.vault;
    const cfgPruebas = opts.vaultConfig !== undefined
        ? opts.vaultConfig
        : (ambiente.dir ? leerVaultDeConfig(ambiente.dir) : null);
    const cfgProd = opts.vaultConfigProductivo !== undefined
        ? opts.vaultConfigProductivo
        : leerVaultDeConfig(pipelineEnv.DEFAULT_PRODUCTIVE_DIR);

    const base = { prefix: perfil.prefix, projectId: perfil.projectId };
    if (!ambiente.dir) {
        return { ...base, enabled: false, awsProfile: null, vaultConfig: { enabled: false },
            motivo: 'sin dir de pruebas: nada que leer' };
    }
    if (!cfgPruebas || cfgPruebas.enabled !== true) {
        return { ...base, enabled: false, awsProfile: null, vaultConfig: { enabled: false },
            motivo: `vault.enabled no es true en config.yaml del dir de pruebas (ver ${RUNBOOK} §vault)` };
    }
    const perfilPruebas = noVacio(cfgPruebas.awsProfile) ? String(cfgPruebas.awsProfile).trim() : '';
    const perfilProd = cfgProd && noVacio(cfgProd.awsProfile) ? String(cfgProd.awsProfile).trim() : '';
    if (!perfilPruebas) {
        return { ...base, enabled: false, awsProfile: null, vaultConfig: { enabled: false },
            motivo: `vault.awsProfile vacío en el dir de pruebas: sin principal propio no hay separación (ver ${RUNBOOK} §vault)` };
    }
    if (cfgProd === null || perfilPruebas === perfilProd) {
        const causa = cfgProd === null
            ? 'no se pudo leer el config productivo para comparar'
            : 'coincide con el productivo';
        return { ...base, enabled: false, awsProfile: perfilPruebas, vaultConfig: { enabled: false },
            motivo: `vault.awsProfile ${causa} (ver ${RUNBOOK} §vault)` };
    }
    return { ...base, enabled: true, awsProfile: perfilPruebas,
        vaultConfig: { ...cfgPruebas, prefix: perfil.prefix, projectId: perfil.projectId }, motivo: null };
}

// ─── Resumen UX-1 ───────────────────────────────────────────────────────────

function lineaModo(ambiente) {
    const motivo = ambiente.motivo ? `  (${ambiente.motivo})` : '';
    return `${PREFIJO} modo=${ambiente.modo}  dir=${ambiente.dir === null ? 'null' : ambiente.dir}${motivo}`;
}

function linea(canal, estado, detalle) {
    return `${PREFIJO} ${canal.padEnd(12)} ${estado.padEnd(18)} ${detalle}`;
}

function armarResumenPruebas(ambiente, canales, purgadas) {
    const out = [lineaModo(ambiente)];
    if (purgadas.length) {
        out.push(`${PREFIJO} purgadas del env (heredadas de la shell, no cruzan a los hijos): ${purgadas.join(', ')}`);
    }
    const t = canales.telegram;
    out.push(linea('telegram', t.enabled ? 'ENCENDIDO' : 'APAGADO',
        t.enabled
            ? `bot de pruebas (${t.fuente}) → ${t.chatIdVar}; los HTTPS directos igual se trazan en ${t.trazasDir || 'stderr'}`
            : `${t.motivo} → traza en ${t.trazasDir || 'stderr (sin dir)'}`));
    const g = canales.github;
    out.push(linea('github', g.enabled ? 'ENCENDIDO' : 'APAGADO',
        `GH_CONFIG_DIR=${g.configDir} (vacío), GH_TOKEN ${g.tokenPresente ? `de ${NOMBRE_STORE_PRUEBAS} (identidad de pruebas, sin write)` : 'ausente'}`));
    const p = canales.proveedores;
    out.push(linea('proveedores', p.agentModelsPath ? `SOLO ${PROVIDER_PRUEBAS}` : 'APAGADO',
        p.agentModelsPath
            ? `agent-models.json ${p.generado ? 'generado' : 'ya deterministic-only'} en ${path.dirname(p.agentModelsPath)}; sesiones OAuth → ${p.claudeConfigDir}`
            : (p.motivo || 'sin agent-models.json')));
    const v = canales.vault;
    out.push(linea('vault', v.enabled ? 'ENCENDIDO' : 'APAGADO',
        v.enabled ? `namespace ${v.prefix}/${v.projectId} con awsProfile propio` : v.motivo));
    return out;
}

// ─── API principal ──────────────────────────────────────────────────────────

/**
 * Perfil de canales productivo (mismo contrato que en pruebas, con valores
 * descriptivos). No se lee ningún valor.
 */
function canalesProductivos(ambiente) {
    const c = ambiente.canales;
    return {
        telegram: {
            enabled: true, nulo: false, botTokenVar: VARIABLES.productivo.botToken,
            chatIdVar: c.telegram.chatIdVar, fuente: NOMBRE_STORE_PRODUCTIVO, trazasDir: null, motivo: null,
        },
        github: { enabled: true, escrituras: true, auth: 'gh-session', configDir: null, tokenPresente: false, motivo: null },
        proveedores: {
            agentModelsPath: c.proveedores.agentModelsPath, generado: false, soloDeterministic: false,
            claudeConfigDir: null, codexHome: null, motivo: null,
        },
        vault: { enabled: null, prefix: c.vault.prefix, projectId: c.vault.projectId, awsProfile: null, motivo: null },
    };
}

/**
 * Aplica el perfil de credenciales del ambiente sobre `env` (muta `env` a
 * propósito: es el env del proceso que va a spawnear).
 *
 * @param {object} env entorno del proceso, pasado por el llamador.
 * @param {object} [opts]
 * @param {function} [opts.logger]              stderr por default.
 * @param {object}   [opts.fsImpl]              `fs` inyectable (tests).
 * @param {string}   [opts.storePath]           store de pruebas (override para tests).
 * @param {object}   [opts.vaultConfig]         sección `vault` del dir de pruebas (tests).
 * @param {object}   [opts.vaultConfigProductivo] sección `vault` productiva (tests).
 * @param {object}   [opts.vaultDriver]         driver del vault (tests).
 * @param {string}   [opts.agentModelsProductivoPath] origen del derivado (tests).
 * @returns {{ambiente: object, hidratacion: object, purgadas: string[], canales: object, resumen: string[]}}
 */
function aplicar(env, opts = {}) {
    const e = env && typeof env === 'object' ? env : {};
    const logger = typeof opts.logger === 'function' ? opts.logger : (m) => process.stderr.write(m + '\n');
    const fsImpl = opts.fsImpl || fs;
    const ambiente = pipelineEnv.resolve(e);

    if (esProductivo(ambiente)) {
        const hidratacion = credentials.loadIntoEnv({ logger, env: e });
        const canales = canalesProductivos(ambiente);
        return {
            ambiente, hidratacion, purgadas: [], canales,
            resumen: [`${PREFIJO} modo=${ambiente.modo} dir=${ambiente.dir} canales=reales (${NOMBRE_STORE_PRODUCTIVO})`],
        };
    }

    // 1. Purga ANTES de cualquier spawn (CA-1 bullet 4, R-3).
    const purgadas = CLAVES_PURGA.filter((k) => Object.prototype.hasOwnProperty.call(e, k));
    for (const k of purgadas) delete e[k];

    // 5 (decisión previa a la hidratación). Vault: config explícita siempre.
    const vault = decidirVault(ambiente, opts);

    // 2. Store de pruebas → objeto temporal → trasposición `_PRUEBAS` (D-1/D-2).
    const storePath = opts.storePath || credentials.CANONICAL_PATH_PRUEBAS;
    const tmp = {};
    const hidratacion = credentials.loadIntoEnv({
        logger, env: tmp,
        canonicalPath: storePath,
        legacyPath: null,
        pipelineDir: ambiente.dir || undefined,
        vaultConfig: vault.vaultConfig,
        vaultDriver: opts.vaultDriver,
        projectId: ambiente.canales.vault.projectId,
    });
    for (const [prod, prueba] of Object.entries(TRASPOSICION_PRUEBAS)) {
        if (!noVacio(e[prueba]) && noVacio(tmp[prod])) e[prueba] = tmp[prod];
    }
    const telegramOk = pareceToken(e[VARIABLES.pruebas.botToken]) && noVacio(e[VARIABLES.pruebas.chatId]);
    const trazasDir = ambiente.dir ? path.join(ambiente.dir, ...SUBDIR_TRAZAS) : null;

    // 3. GitHub: config dir vacío SIEMPRE; token sólo si el store lo trae (RS-1).
    let configDir;
    if (ambiente.dir) {
        configDir = path.join(ambiente.dir, SUBDIR_GH_CONFIG);
        try { fsImpl.mkdirSync(configDir, { recursive: true }); } catch { /* el sentinel inexistente también aísla */ }
    } else {
        configDir = sentinelPath(SUBDIR_GH_CONFIG);
    }
    e.GH_CONFIG_DIR = configDir;
    const store = leerJson(fsImpl, storePath);
    const ghToken = store.data ? credentials.getNested(store.data, DOTPATH_GITHUB_TOKEN) : undefined;
    const tokenPresente = noVacio(ghToken);
    if (tokenPresente) e.GH_TOKEN = String(ghToken);

    // 4. Proveedores: sesiones OAuth sentinel + agent-models de pruebas (RS-4).
    const sesiones = sesionesDePruebas(ambiente.dir);
    e.CLAUDE_CONFIG_DIR = sesiones.CLAUDE_CONFIG_DIR;
    e.CODEX_HOME = sesiones.CODEX_HOME;
    let agentModels = { path: null, generado: false, motivo: 'sin dir de pruebas' };
    if (ambiente.dir && ambiente.canales.proveedores.agentModelsPath) {
        agentModels = asegurarAgentModelsDePruebas(ambiente.canales.proveedores.agentModelsPath, {
            fsImpl, logger,
            productivoPath: opts.agentModelsProductivoPath
                || path.join(pipelineEnv.DEFAULT_PRODUCTIVE_DIR, 'agent-models.json'),
        });
    }

    const canales = {
        telegram: {
            enabled: telegramOk,
            nulo: !telegramOk,
            botTokenVar: VARIABLES.pruebas.botToken,
            chatIdVar: VARIABLES.pruebas.chatId,
            fuente: NOMBRE_STORE_PRUEBAS,
            trazasDir,
            motivo: telegramOk ? null : (hidratacion.source === 'none'
                ? `sin ${NOMBRE_STORE_PRUEBAS} (${path.dirname(storePath)})`
                : `${NOMBRE_STORE_PRUEBAS} sin telegram.bot_token/telegram.chat_id válidos`),
        },
        github: {
            enabled: tokenPresente,
            escrituras: false,
            auth: tokenPresente ? 'GH_TOKEN+GH_CONFIG_DIR' : 'GH_CONFIG_DIR',
            configDir,
            tokenPresente,
            motivo: tokenPresente ? null : `sin ${DOTPATH_GITHUB_TOKEN} en ${NOMBRE_STORE_PRUEBAS}`,
        },
        proveedores: {
            agentModelsPath: agentModels.path,
            generado: agentModels.generado,
            soloDeterministic: agentModels.path !== null,
            claudeConfigDir: sesiones.CLAUDE_CONFIG_DIR,
            codexHome: sesiones.CODEX_HOME,
            motivo: agentModels.motivo,
        },
        vault: {
            enabled: vault.enabled,
            prefix: vault.prefix,
            projectId: vault.projectId,
            awsProfile: vault.awsProfile,
            motivo: vault.motivo,
        },
    };

    return { ambiente, hidratacion, purgadas, canales, resumen: armarResumenPruebas(ambiente, canales, purgadas) };
}

/**
 * Paths de sesión OAuth de los CLIs para un hijo en pruebas: bajo el dir de
 * pruebas (sentinel inexistente salvo provisión explícita del operador) o bajo
 * el sentinel del home si no hay dir. Nunca `~/.claude` / `~/.codex`.
 *
 * @param {string|null} dir
 * @returns {{CLAUDE_CONFIG_DIR: string, CODEX_HOME: string}}
 */
function sesionesDePruebas(dir) {
    const base = dir ? path.join(dir, SUBDIR_SESIONES) : sentinelPath(SUBDIR_SESIONES);
    return { CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex') };
}

/**
 * Purga de `out` (env de un hijo) toda credencial productiva (defensa en
 * profundidad sobre `stripReservedChildSecrets`). Devuelve las claves purgadas.
 */
function purgarClavesProductivas(out) {
    const purgadas = [];
    for (const k of CLAVES_PURGA) {
        if (Object.prototype.hasOwnProperty.call(out, k)) { delete out[k]; purgadas.push(k); }
    }
    return purgadas;
}

// ─── Transporte de Telegram ─────────────────────────────────────────────────

/**
 * Nombre del archivo JSONL diario (UX-2): `YYYY-MM-DD.jsonl` en UTC.
 */
function nombreTrazaDelDia(now) {
    return `${new Date(now).toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Transporte de Telegram por ambiente (CA-3):
 *
 *   - `directoBloqueado`: `true` en todo modo ≠ productivo. Los envíos HTTPS
 *     directos (`enviarDirecto`) se TRAZAN en vez de abrir conexión, aunque
 *     exista credencial de pruebas: el único camino a un bot de pruebas es la
 *     cola `<dir>/servicios/telegram/pendiente` que drena `servicio-telegram.js`.
 *   - `nulo`: `true` cuando el canal está apagado en este ambiente (modo ≠
 *     productivo sin credencial de pruebas). Los encolados y el propio
 *     `servicio-telegram.js` trazan en vez de enviar.
 *   - `trazar(...)`: escribe UNA línea JSONL en `<dir>/servicios/telegram/trazas/
 *     YYYY-MM-DD.jsonl` con campos en orden fijo `ts, chat_id, origen, texto,
 *     motivo`; `chat_id` va siempre como `<chat_id>` y `texto` pasa por
 *     `redact.redactTelegram`. Con `dir === null` la traza va al `logger`
 *     (stderr): NUNCA a un path productivo.
 *
 * @param {object} env entorno del proceso, pasado por el llamador.
 * @param {object} [opts]
 * @param {object}   [opts.ambiente]  resultado de `pipelineEnv.resolve(env)` ya calculado.
 * @param {object}   [opts.fsImpl]
 * @param {object}   [opts.httpsImpl] `https` inyectable (tests): SOLO se usa en productivo.
 * @param {function} [opts.logger]
 * @param {function} [opts.now]
 * @param {object}   [opts.estado]    contador compartido `{ trazados, ultimoArchivo }` (UX-2).
 */
function transporteTelegram(env, opts = {}) {
    const e = env && typeof env === 'object' ? env : {};
    const ambiente = opts.ambiente || pipelineEnv.resolve(e);
    const fsImpl = opts.fsImpl || fs;
    const logger = typeof opts.logger === 'function' ? opts.logger : (m) => process.stderr.write(m + '\n');
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const productivo = esProductivo(ambiente);
    const vars = productivo ? VARIABLES.productivo : VARIABLES.pruebas;
    const conCredencial = pareceToken(e[vars.botToken]) && noVacio(e[vars.chatId]);
    const trazasDir = !productivo && ambiente.dir ? path.join(ambiente.dir, ...SUBDIR_TRAZAS) : null;
    const nulo = !productivo && !conCredencial;
    const motivo = productivo ? null
        : (conCredencial
            ? `modo=${ambiente.modo}: los HTTPS directos no salen (sólo la cola de pruebas)`
            : `telegram.enabled:false (sin ${NOMBRE_STORE_PRUEBAS} ni ${vars.botToken}/${vars.chatId})`);

    // Contador compartible entre instancias (`opts.estado`): el resumen de UX-2
    // ("N mensajes trazados en <archivo>") se imprime al cierre del proceso.
    const estado = opts.estado && typeof opts.estado === 'object' ? opts.estado : { trazados: 0, ultimoArchivo: null };
    if (typeof estado.trazados !== 'number') estado.trazados = 0;
    if (!('ultimoArchivo' in estado)) estado.ultimoArchivo = null;

    function trazar({ origen, chatId, texto, motivo: motivoTraza, metodo } = {}) {
        const registro = {
            ts: new Date(now()).toISOString(),
            chat_id: '<chat_id>',
            origen: origen || 'desconocido',
            texto: redactTelegram(texto == null ? '' : String(texto), { chatId: chatId || e[vars.chatId] || null }),
            motivo: motivoTraza || motivo || 'transporte nulo',
        };
        if (metodo) registro.metodo = metodo;
        const lineaJson = JSON.stringify(registro);
        estado.trazados += 1;
        if (trazasDir === null) {
            logger(`${PREFIJO} telegram (traza sin dir de pruebas): ${lineaJson}`);
            return { archivo: null, registro };
        }
        const archivo = path.join(trazasDir, nombreTrazaDelDia(now()));
        try {
            fsImpl.mkdirSync(trazasDir, { recursive: true });
            fsImpl.appendFileSync(archivo, lineaJson + '\n', 'utf8');
            estado.ultimoArchivo = archivo;
            return { archivo, registro };
        } catch (err) {
            logger(`${PREFIJO} telegram: no se pudo escribir la traza en ${archivo} (${err.message}): ${lineaJson}`);
            return { archivo: null, registro };
        }
    }

    /**
     * Envío HTTPS directo a `api.telegram.org`. Sólo en productivo abre red;
     * en cualquier otro modo traza y devuelve `{ nulo: true }`.
     */
    function enviarDirecto({ metodo, token, chatId, payload, origen, onError, timeout } = {}) {
        if (!productivo) {
            const texto = payload && (payload.text || payload.caption || payload.action) || '';
            const r = trazar({ origen: origen || 'enviarDirecto', chatId, texto, metodo });
            return { nulo: true, archivo: r.archivo };
        }
        if (!token || !chatId) return { nulo: false, enviado: false };
        const https = opts.httpsImpl || require('https');
        const data = JSON.stringify({ chat_id: chatId, ...(payload || {}) });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/${metodo}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            ...(timeout ? { timeout } : {}),
        });
        req.on('error', (err) => { if (typeof onError === 'function') onError(err); });
        if (timeout) req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } });
        req.write(data);
        req.end();
        return { nulo: false, enviado: true };
    }

    function resumen() {
        if (!estado.trazados) return null;
        return `${PREFIJO} telegram: ${estado.trazados} mensaje/s trazado/s en ${estado.ultimoArchivo || 'stderr (sin dir de pruebas)'}`;
    }

    return {
        modo: ambiente.modo,
        productivo,
        nulo,
        directoBloqueado: !productivo,
        destino: productivo ? 'productivo' : (conCredencial ? 'cola-de-pruebas' : 'nulo'),
        trazasDir,
        motivo,
        chatIdVar: vars.chatId,
        botTokenVar: vars.botToken,
        trazar,
        enviarDirecto,
        resumen,
        _estado: estado,
    };
}

module.exports = {
    aplicar,
    transporteTelegram,
    sesionesDePruebas,
    purgarClavesProductivas,
    esSoloDeterministic,
    derivarAgentModelsDePruebas,
    CLAVES_PURGA,
    VARIABLES,
    TRASPOSICION_PRUEBAS,
    NOMBRE_STORE_PRUEBAS,
    SUBDIR_GH_CONFIG,
    SUBDIR_SESIONES,
    SUBDIR_TRAZAS,
    PROVIDER_PRUEBAS,
    PREFIJO,
    RUNBOOK,
    // Sólo para tests.
    _internal: { decidirVault, asegurarAgentModelsDePruebas, nombreTrazaDelDia, leerVaultDeConfig, SENTINEL_SIN_DIR },
};
