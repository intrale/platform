// =============================================================================
// build-child-env.js — Aislamiento de credenciales por proceso (#3085 / S7)
// multi-provider.
//
// **Problema que resuelve**: hoy `pulpo.js` propaga `...process.env` completo al
// child de cada agente (LLM o determinístico). Al habilitar el segundo provider
// (#3075), una `OPENAI_API_KEY` viajaría en el env del proceso de un agente
// Anthropic (y viceversa). Si el CLI third-party hace panic dump del env en
// un stack trace, exfiltra una credencial que el agente nunca usó. El
// `redact.js` (#2334) sanitiza output, pero NO impide que la key llegue al
// child — eso es lo que resolvemos acá (defensa en profundidad complementaria,
// ninguna reemplaza a la otra).
//
// **Contrato público**:
//   const env = buildChildEnv({
//     skill: 'guru',
//     pipelineDir: '/repo/.pipeline',     // optional — para leer agent-models.json
//     processEnv: process.env,            // default: process.env
//     pipelineExtras: { PIPELINE_ISSUE: '1234', ... },
//     // inyectables para tests:
//     fsImpl, skillConfigOverride: { skill: {...}, providers: {...} },
//     // o partial-override #3198 (cross-provider fallback runtime):
//     skillConfigOverride: { provider: 'openai-codex' },
//   });
//
// **Override shapes** (`skillConfigOverride`):
//   - Full: `{ skill: {...}, providers: {...} }` — reemplaza por completo lo
//     que se hubiera leído de `agent-models.json`. Usado por tests y por el
//     commander (pulpo.js).
//   - Partial (#3198): `{ provider: '<name>' }` — el dispatcher de fallback
//     resolvió que el child debe correr con otro provider. Mergeamos el
//     skill leído de disk con `{ provider: <override> }` y conservamos el
//     `providers` config completo del disk para resolver `credentials_env`
//     del fallback. Indispensable para S-2: garantiza que el child del
//     fallback reciba SOLO la API key del fallback (no la del primary).
//
// **Estrategia**:
//   1. Allowlist hardcoded de variables del sistema (Windows-compatible).
//   2. Todas las `PIPELINE_*` (siempre — son contexto del child).
//   3. UNA sola API key del LLM: la del provider declarado por el skill.
//   4. Scopes adicionales declarados por el skill (`requires_credentials` en
//      agent-models.json o defaults hardcoded por skill).
//   5. `telegram-hooks` SIEMPRE, sin material criptográfico: las
//      notificaciones se delegan a la frontera local privilegiada.
//   6. Fail-fast: si el provider declara una `credentials_env` y la var no
//      está en el env del pulpo → throw con mensaje accionable.
//
// **Invariantes de seguridad**:
//   I-S1: ninguna variable que NO esté en allowlist/scope llega al child.
//   I-S2: nunca se loguea VALOR de una variable, solo nombre (+ hash truncado).
//   I-S3: provider desconocido / scope desconocido → throw, no degradar a env
//         vacío (silencioso es peor).
//   I-S4: handler determinístico no recibe `*_API_KEY` (no consume LLM tokens).
//
// **Compatibilidad con #3072 (H1)**: si `agent-models.json` no existe, el
// helper usa defaults hardcoded por skill. Cuando #3072 entregue el archivo,
// los entries de `requires_credentials` lo sobreescriben por skill.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// -----------------------------------------------------------------------------
// SYSTEM_ALLOWLIST — variables del sistema permitidas en TODOS los childs.
//
// **NO agregar variables sin justificar por qué el child la necesita**. Cada
// addición es una decisión de seguridad: aumenta blast radius si el child o
// un sub-proceso filtra el env.
//
// Justificación entry-by-entry:
//   PATH         — todos los childs (busca binarios)
//   PATHEXT      — Windows: extensiones ejecutables (.exe, .cmd, .ps1)
//   HOME         — Unix-like, algunos binarios fallan sin él
//   USERPROFILE  — Windows equiv de HOME
//   USERNAME     — usado por gh/git/ssh para identidad
//   APPDATA      — Windows: Claude Code lee config de acá
//   LOCALAPPDATA — Windows: Claude Code state, npm cache
//   PROGRAMFILES, PROGRAMFILES(X86), PROGRAMDATA — Windows: paths de instalación
//   SystemRoot   — Windows OBLIGATORIA (sin ella, Node y muchos nativos crashean)
//   ComSpec      — Windows: cmd.exe path para shims .cmd (ej. claude.cmd)
//   WINDIR       — Windows: legacy alias de SystemRoot
//   TEMP, TMP    — Windows: directorio temp
//   LANG, LC_ALL — locale (afecta output de gh/git)
//   TZ           — timezone
//   NODE_PATH    — resolución de módulos Node globales
//   NODE_OPTIONS — flags de Node (--max-old-space-size, etc.)
// -----------------------------------------------------------------------------
const SYSTEM_ALLOWLIST = Object.freeze([
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'USERNAME',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'SystemRoot',
    'ComSpec',
    'WINDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_PATH',
    'NODE_OPTIONS',
]);

// -----------------------------------------------------------------------------
// PROVIDER_DEFAULT_CREDENTIAL_ENV — fallback si `agent-models.json` no declara
// el `providers.<name>.credentials_env`. Se usa cuando #3072 todavía no
// entregó el archivo o no especifica el campo.
//
// `deterministic` no tiene credencial LLM (no va al provider).
// -----------------------------------------------------------------------------
const PROVIDER_DEFAULT_CREDENTIAL_ENV = Object.freeze({
    'anthropic': 'ANTHROPIC_API_KEY',
    'openai-codex': 'OPENAI_API_KEY',
    'deterministic': null,
});

// -----------------------------------------------------------------------------
// CREDENTIAL_SCOPES — agrupaciones de variables por dominio. Cada skill puede
// declarar `requires_credentials: [scope, ...]` en agent-models.json para
// pedir las vars de los scopes que necesita.
//
// **NO agregar scopes sin justificación** — cada scope es un permiso adicional
// que se le da al child.
// -----------------------------------------------------------------------------
const CREDENTIAL_SCOPES = Object.freeze({
    github: Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']),
    aws: Object.freeze([
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_REGION',
        'AWS_PROFILE',
    ]),
    'gradle-android': Object.freeze([
        'JAVA_HOME',
        'GRADLE_USER_HOME',
        'ANDROID_HOME',
        'ANDROID_SDK_ROOT',
        'ANDROID_AVD_HOME',
    ]),
    // Los hooks pueden conservar contexto de destino, pero nunca reciben el
    // token: notifican mediante la cola/frontera local privilegiada.
    'telegram-hooks': Object.freeze(['TELEGRAM_CHAT_ID']),
});

// Scope always-on sin secretos, conservado por compatibilidad de hooks.
const SCOPES_ALWAYS_ON = Object.freeze(['telegram-hooks']);

// Material reservado que jamás puede cruzar al child, ni con aislamiento
// desactivado ni reintroducido desde pipelineExtras bajo otro nombre.
const RESERVED_CHILD_SECRET_NAMES = Object.freeze(['TELEGRAM_BOT_TOKEN']);

function stripReservedChildSecrets(candidateEnv = {}, operatorEnv = process.env) {
    const reservedValues = new Set();
    for (const name of RESERVED_CHILD_SECRET_NAMES) {
        const value = operatorEnv && operatorEnv[name];
        if (value !== undefined && value !== null && String(value) !== '') {
            reservedValues.add(String(value));
        }
    }

    const safe = {};
    for (const [name, value] of Object.entries(candidateEnv || {})) {
        if (RESERVED_CHILD_SECRET_NAMES.includes(name)) continue;
        if (value !== undefined && reservedValues.has(String(value))) continue;
        safe[name] = value;
    }
    return safe;
}

// -----------------------------------------------------------------------------
// PROVIDER_STATIC_ENV — variables de entorno ESTÁTICAS por provider (#4880).
//
// A diferencia de las API keys (que vienen del env del pulpo hidratado desde
// credentials.json), estas son CONSTANTES DE CÓDIGO: no derivan del issue, del
// prompt, del título ni de ningún input de usuario. Se vuelcan al env del child
// SOLO cuando el provider activo coincide con la clave del mapa.
//
// Caso `kimi-moonshot` (SEC-2, #4880): Kimi (Moonshot) se integra como drop-in
// de Claude Code apuntando `ANTHROPIC_BASE_URL` a su endpoint Anthropic-compat.
// Requisitos de seguridad que este diseño satisface:
//   - La URL es una CONSTANTE HTTPS literal (no `NODE_TLS_REJECT_UNAUTHORIZED=0`,
//     sin proxy, jamás derivada de input). Previene SSRF / redirección de
//     tráfico Anthropic a un endpoint atacante.
//   - Se inyecta SOLO en el child con `providerName === 'kimi-moonshot'`. NUNCA
//     global en el pulpo ni en childs de anthropic/codex/otros → no envenena el
//     tráfico Anthropic legítimo (que va a api.anthropic.com por default).
//   - `ANTHROPIC_BASE_URL` no está en SYSTEM_ALLOWLIST ni en ningún scope, así
//     que aunque el operador la exporte global NUNCA se propaga desde processEnv:
//     el único origen posible es este mapa.
//
// **NO agregar entradas sin justificación de seguridad** — cada var estática es
// una decisión de plataforma (igual criterio que SYSTEM_ALLOWLIST / SCOPES).
const PROVIDER_STATIC_ENV = Object.freeze({
    'kimi-moonshot': Object.freeze({
        // Endpoint Anthropic-compatible de Moonshot (spike #4871). El launcher
        // `claude` habla contra esta base URL en vez de api.anthropic.com.
        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
    }),
});

// -----------------------------------------------------------------------------
// PROVIDER_MODEL_ENV — nombre de la variable de entorno por la que cada provider
// NO-Anthropic espera recibir el modelo a usar (#6272).
//
// Mismo criterio de diseño que PROVIDER_STATIC_ENV (#4880): CONSTANTE de código,
// scopeada al provider ACTIVO del despacho, jamás derivada de `processEnv` ni de
// input del operador. El valor que se inyecta es el modelo resuelto, y pasa antes
// por la whitelist estricta de `lib/model-propagation.js` (SR-A.1).
//
// Los providers cuyo launcher es `claude` (anthropic, kimi-moonshot) NO figuran
// acá a propósito: reciben el modelo por el flag `--model` en el array de args
// (ver providers/anthropic.js::buildSpawn), no por env. `lib/model-propagation.js`
// decide el canal (`arg` vs `env`) y usa este mapa como fuente única de nombres.
//
// Los nombres coinciden con lo que cada handler YA lee hoy:
//   - openai-codex   → providers/openai-codex.js  (`env.CODEX_MODEL`)
//   - gemini-google  → providers/gemini-google.js (`env.AGY_MODEL || env.GEMINI_MODEL`)
//   - cerebras       → providers/cerebras.js      (`env.CEREBRAS_MODEL`)
//   - nvidia-nim     → providers/nvidia-nim.js    (`env.NVIDIA_NIM_MODEL`)
//
// **NO agregar entradas sin que el handler correspondiente lea esa variable** —
// el guardrail anti-regresión (CA-7) verifica justamente esa correspondencia.
const PROVIDER_MODEL_ENV = Object.freeze({
    'openai-codex': 'CODEX_MODEL',
    'gemini-google': 'GEMINI_MODEL',
    'cerebras': 'CEREBRAS_MODEL',
    'nvidia-nim': 'NVIDIA_NIM_MODEL',
});

// -----------------------------------------------------------------------------
// DEFAULT_REQUIRES_BY_SKILL — defaults usados cuando agent-models.json no
// existe o el skill no declara `requires_credentials`. Se sobreescribe por el
// archivo cuando #3072 (H1) lo entregue.
//
// Listado curado a partir del análisis previo (security + guru) del issue
// #3085 (comments del issue). Skills que no aparecen acá obtienen `[]`
// (solo SYSTEM_ALLOWLIST + PIPELINE_* + SCOPES_ALWAYS_ON + provider key).
// -----------------------------------------------------------------------------
const DEFAULT_REQUIRES_BY_SKILL = Object.freeze({
    // Skills LLM que postean comentarios / leen issues vía gh CLI.
    security: ['github'],
    guru: ['github'],
    po: ['github'],
    ux: ['github'],
    planner: ['github'],
    review: ['github'],
    refinar: ['github'],
    priorizar: ['github'],
    historia: ['github'],
    doc: ['github'],
    handoff: ['github'],

    // Skills LLM que tocan código → necesitan github (comentarios + branches).
    'pipeline-dev': ['github'],
    'android-dev': ['github', 'gradle-android'],
    'backend-dev': ['github', 'aws', 'gradle-android'],
    'web-dev': ['github', 'gradle-android'],

    // Skills determinísticos (bypass LLM).
    builder: ['gradle-android'],
    tester: ['gradle-android'],
    delivery: ['github'],
    linter: [],

    // Verificación.
    qa: ['gradle-android', 'aws', 'github'],
    build: ['gradle-android'],
});

// -----------------------------------------------------------------------------
// readAgentModelsDefensive — lee agent-models.json o devuelve null sin tirar.
//
// Reusa el patrón de `lib/agent-launcher/resolve-provider.js`: cualquier error
// (no existe, JSON inválido, IO error) retorna null y el caller cae al default.
// -----------------------------------------------------------------------------
function readAgentModelsDefensive(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(modelsPath)) return null;
        const raw = _fs.readFileSync(modelsPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// resolveSkillConfig — devuelve { provider, requires_credentials } para un
// skill, leyendo agent-models.json si existe, o cayendo a defaults.
//
// Permite override directo (tests) vía `skillConfigOverride`.
// -----------------------------------------------------------------------------
function resolveSkillConfig(skill, opts = {}) {
    const { pipelineDir, fsImpl, skillConfigOverride } = opts;

    // Full override: tests + commander pasan ambos campos.
    if (skillConfigOverride && skillConfigOverride.skill !== undefined) {
        return {
            skillCfg: skillConfigOverride.skill || {},
            providersCfg: skillConfigOverride.providers || {},
        };
    }

    // Partial override (#3198): el dispatcher de fallback decide en runtime
    // que el child debe correr con otro provider (ej. anthropic→openai-codex).
    // Mergeamos el skillCfg leído de disk con `{ provider: <override> }` para
    // que el resto de la config (requires_credentials, model, etc.) se
    // preserve, pero el `provider` apunte al FALLBACK. Conservamos los
    // `providers` config completos del disk para que `credentials_env` del
    // fallback se resuelva correctamente.
    //
    // INVARIANTE S-2 (defensa cross-provider credential isolation):
    //   Cuando esta rama dispara, el `providerKeyVar` resultante DEBE ser el
    //   del fallback (ej. OPENAI_API_KEY), nunca el del primary
    //   (ej. ANTHROPIC_API_KEY). Tests dedicados en
    //   build-child-env.test.js (#3198) verifican el invariante.
    if (skillConfigOverride && typeof skillConfigOverride.provider === 'string') {
        const models = readAgentModelsDefensive(pipelineDir, fsImpl);
        const diskSkillCfg = (models && models.skills && models.skills[skill]) || {};
        const providersCfg = (models && models.providers) || {};
        return {
            skillCfg: { ...diskSkillCfg, provider: skillConfigOverride.provider },
            providersCfg,
        };
    }

    const models = readAgentModelsDefensive(pipelineDir, fsImpl);
    if (!models || typeof models !== 'object') {
        return { skillCfg: {}, providersCfg: {} };
    }
    const skillCfg = (models.skills && models.skills[skill]) || {};
    const providersCfg = models.providers || {};
    return { skillCfg, providersCfg };
}

// -----------------------------------------------------------------------------
// buildChildEnv — función pública. Devuelve el objeto env mínimo para el
// spawn del child del agente.
//
// Ver el contrato en el header del archivo. El resultado SOLO contiene:
//   - SYSTEM_ALLOWLIST que existan en processEnv
//   - Todas las PIPELINE_* de processEnv
//   - Una sola API key del LLM (la del provider declarado)
//   - Vars de los scopes declarados por el skill (+ SCOPES_ALWAYS_ON)
//   - pipelineExtras (mezclado al final, override permitido para PIPELINE_*)
//
// Throws si:
//   - skill no se pasa o no es string.
//   - El provider declara una credentials_env que no está en processEnv
//     (fail-fast — el operador entiende qué setear).
//   - Un scope declarado por el skill no existe en CREDENTIAL_SCOPES.
// -----------------------------------------------------------------------------
function buildChildEnv(opts = {}) {
    const {
        skill,
        pipelineDir,
        processEnv = process.env,
        pipelineExtras = {},
        fsImpl,
        skillConfigOverride,
    } = opts;

    if (!skill || typeof skill !== 'string') {
        throw new Error('[build-child-env] buildChildEnv: parámetro "skill" requerido (string).');
    }

    // #5799 — cuando el caller ENTREGA un env (el snapshot por intento de
    // `attempt-credential-snapshot.js`), ése es el ÚNICO origen del material:
    // no hay fallback implícito a `process.env`. Un `processEnv` presente pero
    // no-objeto sería exactamente ese fallback silencioso disfrazado de default
    // de parámetro (`null` no dispara el default de desestructuración, y el
    // resultado sería un env vacío que aparenta éxito). Fail-closed y ruidoso.
    if (opts.processEnv !== undefined
        && (opts.processEnv === null || typeof opts.processEnv !== 'object')) {
        throw new Error(
            '[build-child-env] buildChildEnv: "processEnv" entregado por el caller debe ser un objeto. '
            + 'No se degrada a process.env: el env del intento es su única fuente (#5799).'
        );
    }

    const { skillCfg, providersCfg } = resolveSkillConfig(skill, {
        pipelineDir, fsImpl, skillConfigOverride,
    });

    // Provider del skill (default: anthropic).
    const providerName = skillCfg.provider || 'anthropic';
    const providerEntry = providersCfg[providerName] || {};
    // #4306 — providers OAuth/CLI login (auth_mode: 'oauth') autentican fuera
    // del env (~/.codex, cuenta Google, OAuth Max). NO exigimos ni inyectamos
    // su key: ni desde `credentials_env` ni desde el fallback
    // PROVIDER_DEFAULT_CREDENTIAL_ENV (REQ-SEC-3, env-isolation). Default-safe:
    // provider sin auth_mode → camino api_key (exige key, fail-fast más abajo).
    const isOauthProvider = providerEntry.auth_mode === 'oauth';
    const providerKeyVar = isOauthProvider
        ? null
        : ((providerEntry.credentials_env !== undefined)
            ? providerEntry.credentials_env
            : PROVIDER_DEFAULT_CREDENTIAL_ENV[providerName]);

    // 1. SYSTEM_ALLOWLIST.
    const out = Object.create(null);
    for (const k of SYSTEM_ALLOWLIST) {
        if (Object.prototype.hasOwnProperty.call(processEnv, k) && processEnv[k] !== undefined) {
            out[k] = processEnv[k];
        }
    }

    // 2. PIPELINE_* — siempre se propagan (contexto del child).
    //
    // #5110 · SEC-1 — este loop es exactamente la mecánica que hace que
    // `PIPELINE_PROJECT_ID` NO pueda ser autoridad: cualquier `PIPELINE_*` que
    // esté en el env del pulpo (o que un agente exporte y herede un nieto) se
    // propaga sin validar. Por eso `lib/project-context.js` trata esa var como
    // TRANSPORTE y exige que venga apareada con `PIPELINE_PROJECT_BINDING`, un
    // nonce que sólo el pulpo escribe en `.pipeline/state/project-bindings/`.
    // El comportamiento de este loop NO cambia — se documenta la razón por la
    // que el consumidor desconfía de lo que acá se propaga.
    for (const k of Object.keys(processEnv)) {
        if (k.startsWith('PIPELINE_') && processEnv[k] !== undefined) {
            out[k] = processEnv[k];
        }
    }

    // 3. API key del provider (fail-fast si declara una y no existe).
    if (providerKeyVar) {
        if (processEnv[providerKeyVar] === undefined) {
            throw new Error(
                `[build-child-env] Skill '${skill}' configurado para provider '${providerName}', ` +
                `pero ${providerKeyVar} no está en el env del pulpo. ` +
                `Definila como variable de entorno o cambiá el 'provider' del skill en agent-models.json. ` +
                `Ver docs/pipeline-multi-provider.md §5.2.`
            );
        }
        out[providerKeyVar] = processEnv[providerKeyVar];
    }

    // 3.b Env estático por provider (#4880). Constantes de código scopeadas al
    //     provider activo (ej. ANTHROPIC_BASE_URL → endpoint Kimi para
    //     `kimi-moonshot`). Se vuelca DESPUÉS de la key del provider y ANTES de
    //     los scopes/pipelineExtras. Nunca se toma de processEnv (SEC-2): el
    //     único origen es PROVIDER_STATIC_ENV, así el operador no puede
    //     envenenar el tráfico Anthropic legítimo con una var global.
    const staticEnv = PROVIDER_STATIC_ENV[providerName];
    if (staticEnv) {
        for (const [k, v] of Object.entries(staticEnv)) {
            out[k] = v;
        }
    }

    // 4. Scopes declarados por el skill (`requires_credentials`) o defaults
    //    hardcoded por skill (DEFAULT_REQUIRES_BY_SKILL) cuando el archivo no
    //    los declara.
    const declared = Array.isArray(skillCfg.requires_credentials)
        ? skillCfg.requires_credentials
        : (DEFAULT_REQUIRES_BY_SKILL[skill] || []);

    // Mergear con scopes always-on (telegram-hooks). Set para deduplicar si
    // el skill ya los declaró.
    const effectiveScopes = Array.from(new Set([...declared, ...SCOPES_ALWAYS_ON]));

    for (const scope of effectiveScopes) {
        const vars = CREDENTIAL_SCOPES[scope];
        if (!vars) {
            throw new Error(
                `[build-child-env] Scope desconocido '${scope}' declarado por skill '${skill}'. ` +
                `Scopes válidos: ${Object.keys(CREDENTIAL_SCOPES).join(', ')}. ` +
                `Verificar agent-models.json o DEFAULT_REQUIRES_BY_SKILL.`
            );
        }
        for (const v of vars) {
            if (Object.prototype.hasOwnProperty.call(processEnv, v) && processEnv[v] !== undefined) {
                out[v] = processEnv[v];
            }
        }
    }

    // 5. pipelineExtras al final (PIPELINE_ISSUE, PIPELINE_SKILL, etc.). El
    //    filtro final impide reintroducir el nombre reservado o un alias cuyo
    //    valor coincida con el material del operador. El descarte es silencioso
    //    para no revelar nombres alternativos ni valores en logs.
    return stripReservedChildSecrets({ ...out, ...pipelineExtras }, processEnv);
}

// -----------------------------------------------------------------------------
// auditDroppedEnvVars — compara processEnv vs el env que produciría
// buildChildEnv para un skill genérico, y devuelve la lista de keys
// descartadas + hash truncado SHA-256-12 (sin VALORES — invariante I-S2).
//
// Pensado para correr al boot del pulpo y dejar registro forense de qué env
// vars del operador no entraron al allowlist. El caller decide dónde
// loguearlo (ver `pulpo.js` boot).
//
// El "skill genérico" es uno con todos los scopes posibles (worst-case
// permissive). Si una var aún así queda fuera, es candidata real a auditar.
// -----------------------------------------------------------------------------
function auditDroppedEnvVars(processEnv = process.env) {
    // Allowed = SYSTEM_ALLOWLIST + PIPELINE_* + todas las vars de todos los
    // scopes + todas las API keys de todos los providers.
    const allowed = new Set();
    for (const k of SYSTEM_ALLOWLIST) allowed.add(k);
    for (const scope of Object.keys(CREDENTIAL_SCOPES)) {
        for (const v of CREDENTIAL_SCOPES[scope]) allowed.add(v);
    }
    for (const p of Object.keys(PROVIDER_DEFAULT_CREDENTIAL_ENV)) {
        const k = PROVIDER_DEFAULT_CREDENTIAL_ENV[p];
        if (k) allowed.add(k);
    }

    const dropped = [];
    const reservedValues = new Set(RESERVED_CHILD_SECRET_NAMES
        .map((name) => processEnv[name])
        .filter((value) => value !== undefined && value !== null && String(value) !== '')
        .map(String));
    for (const k of Object.keys(processEnv)) {
        if (RESERVED_CHILD_SECRET_NAMES.includes(k)) continue;
        if (k.startsWith('PIPELINE_')) continue; // siempre van
        if (allowed.has(k)) continue;
        const v = processEnv[k];
        if (v === undefined) continue;
        if (reservedValues.has(String(v))) continue;
        const hash = crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
        dropped.push({ key: k, hash });
    }
    dropped.sort((a, b) => a.key.localeCompare(b.key));
    return dropped;
}

// -----------------------------------------------------------------------------
// formatAuditLogEntry — produce la entrada multilínea humano-legible para
// `.pipeline/logs/env-allowlist-audit.log` (DX — UX feedback CA-10b del issue).
// -----------------------------------------------------------------------------
function formatAuditLogEntry({ timestamp, pid, nodeVersion, osInfo, dropped }) {
    const ts = timestamp || new Date().toISOString();
    const header = `${ts} [boot pid=${pid} node=${nodeVersion} os=${osInfo}] vars descartadas:`;
    if (!dropped || dropped.length === 0) {
        return `${header}\n  (ninguna — env del operador limpio)\n`;
    }
    // Pad para alinear hashes en columna.
    const maxLen = Math.max(...dropped.map((d) => d.key.length));
    const lines = dropped.map((d) => `  ${d.key.padEnd(maxLen, ' ')}  (hash:${d.hash})`);
    return `${header}\n${lines.join('\n')}\n`;
}

module.exports = {
    buildChildEnv,
    auditDroppedEnvVars,
    formatAuditLogEntry,
    // Constantes exportadas para inspección (tests + dashboard futuro).
    SYSTEM_ALLOWLIST,
    PROVIDER_DEFAULT_CREDENTIAL_ENV,
    PROVIDER_STATIC_ENV,
    PROVIDER_MODEL_ENV,
    CREDENTIAL_SCOPES,
    SCOPES_ALWAYS_ON,
    RESERVED_CHILD_SECRET_NAMES,
    DEFAULT_REQUIRES_BY_SKILL,
    stripReservedChildSecrets,
    // Internos exportados para tests.
    _resolveSkillConfig: resolveSkillConfig,
    _readAgentModelsDefensive: readAgentModelsDefensive,
};
