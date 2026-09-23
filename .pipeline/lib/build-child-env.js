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

// #5901 — punto ÚNICO de identidad de proyecto. Módulo HOJA (sin `fs`/`path` ni
// requires de otros módulos del pipeline): importarlo acá no puede abrir un
// ciclo ni fallar por IO.
const { isSafeProjectId, KERNEL_PROJECT_ID } = require('./safe-project-id');
// #7112 · CA-7 — la declaración de ambiente del hijo la fija el LANZADOR con el
// modo que el propio Pulpo resolvió; nunca se hereda por el loop `PIPELINE_*`.
const pipelineEnv = require('./pipeline-env');
// #7634 — módulos HOJA (sin dependencias del pipeline): sentinel de credenciales
// en disco + formas de secreto, y el error tipado del entorno del hijo.
const credentialSentinel = require('./credential-sentinel');
const { ChildEnvViolation } = require('./child-env-error');

// -----------------------------------------------------------------------------
// #7634 · B1 — lookupEnvCI: búsqueda de una variable SIN distinguir mayúsculas.
//
// En Windows `process.env` no distingue mayúsculas, pero `{ ...process.env }`
// (y cualquier objeto plano) sí: un objeto con `Path`/`windir` no matchea
// `PATH`/`WINDIR` por `hasOwnProperty`. No depende de `process.platform`, así
// los tests dan lo mismo en Linux y en Windows.
//
// Devuelve `{ key, value, ambiguous }` con la clave REAL encontrada, o `null`.
// Si hay varias grafías, gana la exacta (si existe) y `ambiguous` lista las
// claves ordenadas. Al LEER desde `processEnv` un duplicado se tolera (el
// `Path`/`PATH` de Git Bash no puede tumbar los lanzamientos); el error
// `case-duplicate` se evalúa sólo sobre el env FINAL en `assertChildEnvMinimal`.
// -----------------------------------------------------------------------------
function lookupEnvCI(src, name) {
    if (!src || typeof src !== 'object' || name === undefined || name === null) return null;
    const want = String(name).toUpperCase();
    const hits = Object.keys(src).filter((k) => k.toUpperCase() === want && src[k] !== undefined);
    if (hits.length === 0) return null;
    const exact = hits.find((k) => k === name);
    const key = exact || hits.slice().sort()[0];
    return { key, value: src[key], ambiguous: hits.length > 1 ? hits.slice().sort() : null };
}

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

// -----------------------------------------------------------------------------
// SCOPES_BY_FASE — TECHO de scopes por fase del pipeline (#5901 · REQ-SEC-4).
//
// **Esto NO es el pedido, es el máximo.** El scope efectivo de un child se
// resuelve como `pedido_del_skill ∩ techo_de_la_fase` — INTERSECCIÓN, nunca
// unión. Un skill no gana un scope por estar declarado en el techo, y no
// conserva uno que su fase no autoriza. Propiedad que se deriva de eso y que
// el test verifica para toda combinación viva: el efectivo es siempre
// SUBCONJUNTO del efectivo de hoy — el cambio es monótonamente restrictivo,
// ningún `(skill, fase)` puede ganar privilegios respecto del comportamiento
// previo. Esa es la red que hace seguro cablear el eje en los callsites.
//
// **Fail-closed**: una fase ausente o desconocida NO cae a "todos los scopes";
// cae a techo VACÍO (sólo `SCOPES_ALWAYS_ON`, que no lleva material
// criptográfico) y emite un diagnóstico accionable (UX-4). Degradar a
// permisivo sería exactamente el modo de falla que este techo viene a cerrar.
//
// Fases verificadas contra `config.yaml` (`pipelines.definicion.fases:6` y
// `pipelines.desarrollo.fases:11`) y los skills que realmente se despachan en
// cada una contra `pipeline.config.json · productConfig.pipelines.*
// .skills_por_fase`. Cada techo es la UNIÓN de lo que hoy piden los skills de
// esa fase (`DEFAULT_REQUIRES_BY_SKILL`), no una lista aspiracional: por eso
// ninguna combinación viva pierde un scope.
//
// **NO ampliar un techo sin justificar qué skill de esa fase lo necesita** —
// cada scope de más es blast radius que se le regala a todos los skills de la
// fase.
// -----------------------------------------------------------------------------

// Fase sintética del kernel (GURU-3): el commander no corre dentro de ningún
// pipeline, así que no tiene fase real. Sin una entrada propia caería al
// fail-closed y perdería scopes el día que #5040 active el aislamiento.
const KERNEL_FASE = 'kernel';

const SCOPES_BY_FASE = Object.freeze({
    // --- pipeline `definicion` (config.yaml:6) --------------------------------
    // guru, security · po, ux, architect · planner — todos sólo leen/comentan
    // issues por `gh`. Ninguno compila ni toca AWS.
    analisis:     Object.freeze(['github']),
    criterios:    Object.freeze(['github']),
    sizing:       Object.freeze(['github']),

    // --- pipeline `desarrollo` (config.yaml:11) -------------------------------
    // po, ux, guru — igual que en definición.
    validacion:   Object.freeze(['github']),
    // backend-dev pide aws + gradle-android; android-dev/web-dev gradle-android;
    // pipeline-dev sólo github. El techo es la unión de los cuatro.
    dev:          Object.freeze(['github', 'gradle-android', 'aws']),
    // skill determinístico `build`: compila, no habla con GitHub.
    build:        Object.freeze(['gradle-android']),
    // tester (gradle) · security (github) · qa (gradle + aws + github).
    verificacion: Object.freeze(['github', 'gradle-android', 'aws']),
    // `linter` es Node puro sobre el worktree: no necesita ninguna credencial.
    linteo:       Object.freeze([]),
    // review, po, ux, architect — comentan el PR.
    aprobacion:   Object.freeze(['github']),
    // `delivery` mergea a main.
    entrega:      Object.freeze(['github']),

    // --- kernel (commander) ---------------------------------------------------
    [KERNEL_FASE]: Object.freeze(['github']),
});

// Material reservado que jamás puede cruzar al child, ni con aislamiento
// desactivado ni reintroducido desde pipelineExtras bajo otro nombre.
const RESERVED_CHILD_SECRET_NAMES = Object.freeze(['TELEGRAM_BOT_TOKEN']);

// -----------------------------------------------------------------------------
// #7112 · CA-7.1 / CA-7.2 / CA-7.3 — declaración de ambiente EXPLÍCITA del launcher.
//
// Vale para los DOS caminos del launcher (env isolation ON → `buildChildEnv`;
// legacy → `pulpo.js` spread de `process.env`): el hijo nunca hereda
// la declaración de ambiente (`pipelineEnv.ENV_AMBIENTE`) "porque empieza con
// PIPELINE_" (denylist, CA-7.1), y
// recibe el MODO QUE EL PULPO RESOLVIÓ (`pipelineEnv.resolve(processEnv).modo`),
// nunca un literal `productivo` hardcodeado: un Pulpo corriendo en pruebas jamás
// declara productivo a sus hijos (CA-7.2). Nunca sale sin `PIPELINE_REPO_ROOT`
// (CA-7.3): sin el contexto del repo principal no hay declaración, y el hijo
// cae en `pruebas` con `dir: null` → sus escritores fallan ruidoso (SEC-10).
//
// Por qué alcanza con la señal de test (SEC-5) para que esto sea seguro: un
// test corrido DENTRO de un agente con `NODE_TEST_CONTEXT`/`NODE_ENV=test`/
// `PULPO_NO_AUTOSTART=1` sigue resolviendo `pruebas` aunque herede la
// declaración (CA-7.4), y los agentes de `dev` cargan `lib/` del worktree, donde
// SEC-1 degrada la declaración porque el dir no es el productivo de esas libs.
// -----------------------------------------------------------------------------
function conDeclaracionExplicita(envHijo = {}, processEnv = process.env) {
    const out = { ...envHijo };
    delete out[pipelineEnv.ENV_AMBIENTE];
    const repoRoot = out.PIPELINE_REPO_ROOT;
    if (typeof repoRoot === 'string' && repoRoot.trim()) {
        out[pipelineEnv.ENV_AMBIENTE] = pipelineEnv.resolve(processEnv).modo;
    }
    return out;
}

// #7634 · S3/E1 — la comparación de nombres NO distingue mayúsculas: en
// Windows `telegram_bot_token` ES `TELEGRAM_BOT_TOKEN` para el hijo. La lista
// sigue siendo SÓLO Telegram (camino legacy en producción): GH_TOKEN y AWS_*
// siguen pasando por acá con el flag OFF.
const RESERVED_CHILD_SECRET_NAMES_UPPER = new Set(RESERVED_CHILD_SECRET_NAMES.map((n) => n.toUpperCase()));

function stripReservedChildSecrets(candidateEnv = {}, operatorEnv = process.env) {
    const reservedValues = new Set();
    for (const name of RESERVED_CHILD_SECRET_NAMES) {
        const hit = lookupEnvCI(operatorEnv, name);
        const value = hit ? hit.value : undefined;
        if (value !== undefined && value !== null && String(value) !== '') {
            reservedValues.add(String(value));
        }
    }

    const safe = {};
    for (const [name, value] of Object.entries(candidateEnv || {})) {
        if (RESERVED_CHILD_SECRET_NAMES_UPPER.has(String(name).toUpperCase())) continue;
        if (value !== undefined && reservedValues.has(String(value))) continue;
        safe[name] = value;
    }
    return safe;
}

// -----------------------------------------------------------------------------
// buildMinimalCliEnv — env MÍNIMO para un child de clase "juez sin agencia"
// (#6563, hallazgo security del rebote 1: LLM01 → LLM08).
//
// Caso de uso: `semantic-dedup.js` invoca al CLI OAuth del plantel (codex /
// claude) para clasificar duplicados. El prompt de ese juez lleva títulos de
// issues ABIERTOS del repo (público): contenido NO confiable. Si el child
// hereda `process.env` del pulpo (aunque pase por `stripReservedChildSecrets`,
// que sólo retira el material de firma de Telegram), una inyección en un título
// puede derivar en bash con GH_TOKEN / AWS_* / *_API_KEY en la máquina del
// operador. Este helper construye el env por ALLOWLIST, jamás por sustracción:
//
//   - SYSTEM_ALLOWLIST (PATH, HOME, USERPROFILE, APPDATA, TEMP, ...): lo que
//     cualquier binario necesita para arrancar y para encontrar su config.
//   - CLI_OAUTH_ALLOWLIST: las vars con las que los CLIs OAuth redirigen su
//     directorio de credenciales (`~/.codex` / `~/.claude`). Sin ellas, el CLI
//     usa HOME/USERPROFILE (ya en SYSTEM_ALLOWLIST). NO son credenciales: son
//     paths.
//   - `extras`: claves de transporte que el caller inyecta a propósito
//     (CODEX_MODEL, CLAUDE_PROJECT_DIR). Una extra con nombre reservado o con
//     el valor de un secreto reservado se descarta igual (`strip` al final).
//
// NO propaga PIPELINE_* (el juez no es un agente del pipeline), NO propaga
// ninguna `*_API_KEY` ni `GH_TOKEN` ni `AWS_*`: los CLIs autentican por OAuth
// fuera del env. Si algún día un provider HTTP-only necesitara una key acá, la
// decisión pasa por `buildChildEnv` (scopes por skill), no por este helper.
// -----------------------------------------------------------------------------
const CLI_OAUTH_ALLOWLIST = Object.freeze([
    'CODEX_HOME',        // codex: directorio de auth.json/config.toml (default ~/.codex)
    'CLAUDE_CONFIG_DIR', // claude: directorio de config/credenciales (default ~/.claude)
]);

function buildMinimalCliEnv({ processEnv = process.env, extras = {} } = {}) {
    const src = (processEnv && typeof processEnv === 'object') ? processEnv : {};
    const out = {};
    for (const k of [...SYSTEM_ALLOWLIST, ...CLI_OAUTH_ALLOWLIST]) {
        // #7634 · B1 — sin distinguir mayúsculas; salida con el nombre canónico.
        const hit = lookupEnvCI(src, k);
        if (hit) out[k] = hit.value;
    }
    for (const [k, v] of Object.entries(extras || {})) {
        if (v === undefined || v === null) continue;
        out[k] = String(v);
    }
    // Última operación, DESPUÉS del merge: una extra no puede reintroducir
    // material reservado bajo otro nombre.
    return stripReservedChildSecrets(out, src);
}

// -----------------------------------------------------------------------------
// PROVIDER_MODEL_ENV — nombre de la variable de entorno por la que cada provider
// NO-Anthropic espera recibir el modelo a usar (#6272).
//
// CONSTANTE de código, scopeada al provider ACTIVO del despacho, jamás derivada
// de `processEnv` ni de input del operador. El valor que se inyecta es el modelo
// resuelto, y pasa antes por la whitelist estricta de `lib/model-propagation.js`
// (SR-A.1).
//
// Los providers cuyo launcher es `claude` (anthropic) NO figuran acá a
// propósito: reciben el modelo por el flag `--model` en el array de args
// (ver providers/anthropic.js::buildSpawn), no por env. `lib/model-propagation.js`
// decide el canal (`arg` vs `env`) y usa este mapa como fuente única de nombres.
//
// Los nombres coinciden con lo que cada handler YA lee hoy:
//   - openai-codex   → providers/openai-codex.js  (`env.CODEX_MODEL`)
//   - antigravity    → providers/antigravity.js (SÓLO `env.ANTIGRAVITY_MODEL` — #6858/#6861)
//
// Nota histórica: el mapa `PROVIDER_STATIC_ENV` (#4880, `ANTHROPIC_BASE_URL`
// para el drop-in de Kimi) se eliminó junto con el provider en #6563. Ningún
// provider vigente necesita env estático: NO reintroducirlo sin justificación
// de seguridad (SSRF / redirección del tráfico Anthropic).
//
// **NO agregar entradas sin que el handler correspondiente lea esa variable** —
// el guardrail anti-regresión (CA-7) verifica justamente esa correspondencia.
const PROVIDER_MODEL_ENV = Object.freeze({
    'openai-codex': 'CODEX_MODEL',
    'antigravity': 'ANTIGRAVITY_MODEL',
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

    // #7634 — skills del kernel. `[]` = mismo efectivo que tenían sin entrada
    // (sólo SCOPES_ALWAYS_ON): no gana ningún scope. La entrada existe para que
    // `assertChildEnvMinimal` los reconozca como roles declarados aunque
    // `agent-models.json` no se pueda leer (unknown-skill bloquearía al Commander).
    'telegram-commander': [],
    'telegram-sherlock': [],
});

// -----------------------------------------------------------------------------
// #7634 · E1 — ISOLATION_RESERVED_NAMES: credenciales que NUNCA pueden llegar a
// un hijo fuera de su scope efectivo (AWS, GitHub, keys de providers, Telegram).
//
// Es una constante NUEVA a propósito (R1 del Guru): la usan SÓLO
// `assertChildEnvMinimal` y el camino ON (`buildChildEnv`). NO reemplaza a
// `RESERVED_CHILD_SECRET_NAMES`, que sigue siendo sólo Telegram porque la usa el
// camino legacy en producción — ampliarla le quitaría GH_TOKEN/AWS_* a todos los
// agentes con el flag OFF.
// -----------------------------------------------------------------------------
const ISOLATION_RESERVED_NAMES = Object.freeze(Array.from(new Set([
    ...CREDENTIAL_SCOPES.aws,
    ...CREDENTIAL_SCOPES.github,
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    ...Object.values(PROVIDER_DEFAULT_CREDENTIAL_ENV).filter(Boolean),
    ...RESERVED_CHILD_SECRET_NAMES,
].map((n) => n.toUpperCase()))));

// -----------------------------------------------------------------------------
// #7634 — CHILD_TRANSPORT_ALLOWLIST: claves de TRANSPORTE (no credenciales) que
// el lanzador inyecta a propósito por `pipelineExtras` y que no empiezan con
// `PIPELINE_`. Sin esta lista el assert marcaría como "no declaradas" las extras
// que hoy pasa `pulpo.js` (lanzarAgenteClaude, QA y Commander).
//
// **NO agregar entradas que transporten material secreto.** Su valor igual pasa
// por el chequeo de forma de secreto del assert.
// -----------------------------------------------------------------------------
const CHILD_TRANSPORT_ALLOWLIST = Object.freeze([
    'PROVIDER_RESOLUTION_LOG', // pulpo.js · lanzarAgenteClaude (#3823): texto legible
    'CLAUDE_PROJECT_DIR',      // pulpo.js · Commander: raíz del repo
    'QA_MODE',                 // pulpo.js · QA (extraEnv)
    'QA_ISSUE',
    'QA_BASE_URL',
    'QA_FLAVOR',
    'QA_EMULATOR_SERIAL',
    ...CLI_OAUTH_ALLOWLIST,    // paths de sesión OAuth (sesiones de pruebas, #7113)
    ...Object.values(PROVIDER_MODEL_ENV), // modelo del provider activo (#6272)
]);

// -----------------------------------------------------------------------------
// #7634 · D1…D4 — assertChildEnvMinimal: verificación PURA del env FINAL de un
// hijo del camino ON. Acumula todas las causas y tira UNA sola vez
// `ChildEnvViolation` (code `CHILD_ENV_VIOLATION`) cuyo mensaje sólo lleva
// nombres (nunca valores).
//
// Tira si:
//   - la fase no está en SCOPES_BY_FASE                         → unknown-phase
//   - el skill no está declarado (config resuelta ni defaults)  → unknown-skill
//   - una clave no está permitida (allowlist, PIPELINE_*, key del provider del
//     intento, scope efectivo, neutralizador, transporte, excepción) → undeclared
//   - una clave de ISOLATION_RESERVED_NAMES fuera de su scope   → reserved-alias
//   - un valor con forma de secreto bajo un nombre que no es de
//     su scope ni la key del provider → aws-access-key | github-token | …
//   - dos claves que sólo difieren en mayúsculas                → case-duplicate
//   - una excepción con comodín o que nombra una reservada      → invalid-exception
//     (las reservadas GANAN sobre las excepciones)
//
// Todas las comparaciones de nombre son SIN distinguir mayúsculas (S3).
// `exceptions` se copia y congela al recibirla; el loader llega en #7635.
// -----------------------------------------------------------------------------
function assertChildEnvMinimal(env, opts = {}) {
    const {
        skill,
        fase,
        intento,
        providerKeyVar = null,
        effectiveScopes = [],
        exceptions = [],
        skillDeclared,
        ancla,
    } = opts;
    const excepciones = Object.freeze([...(Array.isArray(exceptions) ? exceptions : [])].map(String));
    const causas = [];
    const push = (kind, nombre) => causas.push({ kind, nombres: nombre === undefined ? [] : [nombre] });

    if (typeof fase !== 'string' || !Object.prototype.hasOwnProperty.call(SCOPES_BY_FASE, fase)) {
        push('unknown-phase');
    }
    const skillOk = (typeof skill === 'string' && skill !== '')
        && (skillDeclared === true || Object.prototype.hasOwnProperty.call(DEFAULT_REQUIRES_BY_SKILL, skill));
    if (!skillOk) push('unknown-skill');

    const reservadas = new Set(ISOLATION_RESERVED_NAMES);
    // Nombres cuyo VALOR es legítimamente una credencial (scope efectivo + key del intento).
    const credencialesPermitidas = new Set();
    for (const sc of effectiveScopes || []) {
        for (const v of (CREDENTIAL_SCOPES[sc] || [])) credencialesPermitidas.add(v.toUpperCase());
    }
    if (providerKeyVar) credencialesPermitidas.add(String(providerKeyVar).toUpperCase());

    const excepcionesValidas = new Set();
    for (const ex of excepciones) {
        const u = ex.toUpperCase();
        if (ex.includes('*') || reservadas.has(u) || ex.trim() === '') {
            push('invalid-exception', ex);
            continue;
        }
        excepcionesValidas.add(u);
    }

    const permitidas = new Set([
        ...SYSTEM_ALLOWLIST.map((n) => n.toUpperCase()),
        ...CHILD_TRANSPORT_ALLOWLIST.map((n) => n.toUpperCase()),
        ...credentialSentinel.NEUTRALIZER_VARS.aws,
        ...credentialSentinel.NEUTRALIZER_VARS.github,
        ...credencialesPermitidas,
        ...excepcionesValidas,
    ]);

    const src = (env && typeof env === 'object') ? env : {};
    const vistos = new Map();
    for (const name of Object.keys(src)) {
        const u = name.toUpperCase();
        if (!vistos.has(u)) vistos.set(u, []);
        vistos.get(u).push(name);

        if (reservadas.has(u) && !credencialesPermitidas.has(u)) {
            push('reserved-alias', name);
        } else if (!name.startsWith('PIPELINE_') && !permitidas.has(u)) {
            push('undeclared', name);
        }
        if (!credencialesPermitidas.has(u)) {
            const kind = credentialSentinel.looksLikeSecret(src[name]);
            if (kind) push(kind, name);
        }
    }
    for (const nombres of vistos.values()) {
        if (nombres.length > 1) for (const n of nombres) push('case-duplicate', n);
    }

    if (causas.length > 0) {
        throw new ChildEnvViolation({
            rol: skill,
            fase,
            intento,
            ancla,
            causas,
        });
    }
    return true;
}

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
            skillKnown: !!skillConfigOverride.skill,
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
            skillKnown: !!(models && models.skills && models.skills[skill]),
        };
    }

    const models = readAgentModelsDefensive(pipelineDir, fsImpl);
    if (!models || typeof models !== 'object') {
        return { skillCfg: {}, providersCfg: {}, skillKnown: false };
    }
    const skillCfg = (models.skills && models.skills[skill]) || {};
    const providersCfg = models.providers || {};
    return { skillCfg, providersCfg, skillKnown: !!(models.skills && models.skills[skill]) };
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
        // #5901 — eje de identidad de proyecto y techo por fase.
        fase,
        projectId,
        // Diagnóstico inyectable (UX-4). Default a `console.warn` para que el
        // fail-closed NUNCA sea mudo: un techo faltante que no se ve es un
        // agente sin credenciales que nadie sabe por qué falla.
        warn = (m) => console.warn(m),
        // #7634 · C4 — fuente inyectable del token de GitHub para roles con
        // scope `github` (default: ninguna; sólo el env del intento).
        githubTokenSource,
        // #7634 · E2 — `assertChildEnvMinimal` sobre el env final. Default
        // `true`; en producción nadie pasa `false` (existe para el test que
        // separa el warn de fase ausente del throw del assert).
        assertMinimal = true,
    } = opts;

    if (!skill || typeof skill !== 'string') {
        throw new Error('[build-child-env] buildChildEnv: parámetro "skill" requerido (string).');
    }

    // #5901 · CA-1 — identidad de proyecto, fail-closed sobre lo PRESENTE.
    //
    // Dos casos que NO son el mismo y por eso no se tratan igual:
    //   - AUSENTE (`undefined`/`null`): es el camino single-project vigente. El
    //     `projectBinding` del pulpo es best-effort y vale `null` cuando no se
    //     pudo escribir (`pulpo.js`, catch del binding), así que exigirlo
    //     rompería un spawn que hoy funciona. Se resuelve al slug del kernel y
    //     se deja rastro. Nunca se toma de `processEnv`: `PIPELINE_PROJECT_ID`
    //     viaja en el env pero el env NO es autoridad (#5110 · SEC-1) — el
    //     `projectId` autoritativo lo resuelve el CALLER con
    //     `project-context.resolveProjectContext()` y lo pasa por parámetro.
    //   - PRESENTE PERO INVÁLIDO (`''`, `__proto__`, `constructor`, con `/`,
    //     con `..`, no-string): alguien declaró una identidad y no es usable
    //     como clave ni como segmento de path. Fail-closed ruidoso: throw.
    const projectIdAusente = (projectId === undefined || projectId === null);
    if (!projectIdAusente && !isSafeProjectId(projectId)) {
        throw new Error(
            `[build-child-env] buildChildEnv: "projectId" inválido para skill '${skill}'. `
            + 'Debe cumplir ^[a-z0-9][a-z0-9-]{1,63}$ y no ser un nombre reservado de prototipo '
            + '(__proto__, constructor, prototype) ni contener "..", "/" o "\\". '
            + 'Acción: resolvelo con lib/project-context.resolveProjectContext(), '
            + `no lo tomes del env. Ver lib/safe-project-id.js.`
        );
    }
    const effectiveProjectId = projectIdAusente ? KERNEL_PROJECT_ID : projectId;

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

    const { skillCfg, providersCfg, skillKnown } = resolveSkillConfig(skill, {
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
    //    #7634 · B2 — lectura sin distinguir mayúsculas; la salida usa SIEMPRE el
    //    nombre canónico de la constante (`Path` → `PATH`, `windir` → `WINDIR`).
    const out = Object.create(null);
    for (const k of SYSTEM_ALLOWLIST) {
        const hit = lookupEnvCI(processEnv, k);
        if (hit) out[k] = hit.value;
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
        // #7112 · CA-7.1 — denylist: la declaración de ambiente no viaja por
        // herencia; la fija `conDeclaracionExplicita` al final.
        if (k === pipelineEnv.ENV_AMBIENTE) continue;
        if (k.startsWith('PIPELINE_') && processEnv[k] !== undefined) {
            out[k] = processEnv[k];
        }
    }

    // 2b. #7113 · CA-4 / RS-4 — hijo en ambiente de PRUEBAS. Cuelga del mismo
    //     `resolve(processEnv)` que usa `conDeclaracionExplicita` (P-5 del
    //     guru), nunca de la variable heredada: un Pulpo en pruebas no puede
    //     "colar" productivo a un hijo. Las sesiones OAuth de los CLIs
    //     (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) apuntan a un sentinel bajo el dir
    //     de pruebas (inexistente salvo provisión explícita): un CLI real falla
    //     en origen en vez de caer a `~/.claude` / `~/.codex` y consumir cuota
    //     productiva. La purga de credenciales productivas se aplica al FINAL
    //     (después de scopes y extras), ver paso 7.
    const ambienteHijo = pipelineEnv.resolve(processEnv);
    const hijoEnPruebas = ambienteHijo.modo !== pipelineEnv.MODOS.PRODUCTIVO;
    if (hijoEnPruebas) {
        Object.assign(out, require('./credenciales-ambiente').sesionesDePruebas(ambienteHijo.dir));
    }

    // 3. API key del provider (fail-fast si declara una y no existe).
    if (providerKeyVar) {
        const providerHit = lookupEnvCI(processEnv, providerKeyVar);
        if (!providerHit) {
            throw new Error(
                `[build-child-env] Skill '${skill}' configurado para provider '${providerName}', ` +
                `pero ${providerKeyVar} no está en el env del pulpo. ` +
                `Definila como variable de entorno o cambiá el 'provider' del skill en agent-models.json. ` +
                `Ver docs/pipeline-multi-provider.md §5.2.`
            );
        }
        out[providerKeyVar] = providerHit.value;
    }

    // 4. Scopes declarados por el skill (`requires_credentials`) o defaults
    //    hardcoded por skill (DEFAULT_REQUIRES_BY_SKILL) cuando el archivo no
    //    los declara.
    const declared = Array.isArray(skillCfg.requires_credentials)
        ? skillCfg.requires_credentials
        : (DEFAULT_REQUIRES_BY_SKILL[skill] || []);

    // I-S3 (preservado) — un scope declarado que no existe en CREDENTIAL_SCOPES
    // es un error de configuración y sigue siendo FATAL. Se valida ANTES de la
    // intersección con el techo a propósito: si se validara después, un scope
    // mal escrito quedaría filtrado por el techo y el error se volvería mudo
    // — el agente arrancaría sin la credencial y el operador no sabría por qué.
    for (const scope of declared) {
        if (!CREDENTIAL_SCOPES[scope]) {
            throw new Error(
                `[build-child-env] Scope desconocido '${scope}' declarado por skill '${skill}'. ` +
                `Scopes válidos: ${Object.keys(CREDENTIAL_SCOPES).join(', ')}. ` +
                `Verificar agent-models.json o DEFAULT_REQUIRES_BY_SKILL.`
            );
        }
    }

    // #5901 · REQ-SEC-4 — techo por fase e INTERSECCIÓN, nunca unión.
    //
    // Fase ausente o no declarada en SCOPES_BY_FASE → techo `null` = VACÍO
    // (fail-closed). El child se queda con `SCOPES_ALWAYS_ON`, que no lleva
    // material criptográfico. Nunca se degrada a "todos los scopes": ese es
    // justamente el modo de falla que el techo cierra.
    const ceiling = (typeof fase === 'string'
        && Object.prototype.hasOwnProperty.call(SCOPES_BY_FASE, fase))
        ? SCOPES_BY_FASE[fase]
        : null;
    if (ceiling === null) {
        // UX-4 · CA-4 — diagnosticable, no mudo: skill + fase + projectId +
        // scopes omitidos + acción concreta. SÓLO NOMBRES de scope: ningún
        // valor de credencial cruza al log (invariante I-S2).
        const omitidos = declared.filter((sc) => !SCOPES_ALWAYS_ON.includes(sc));
        warn(
            `[build-child-env] fase '${fase === undefined ? '(ausente)' : fase}' sin techo declarado `
            + `— skill='${skill}' projectId='${effectiveProjectId}' `
            + `scopes omitidos=[${omitidos.join(', ')}]. `
            + 'Acción: agregar la fase a SCOPES_BY_FASE en lib/build-child-env.js '
            + `(fases con techo: ${Object.keys(SCOPES_BY_FASE).join(', ')}).`
        );
    }
    const allowed = ceiling || [];

    // Intersección + always-on. Set para deduplicar si el skill ya los declaró.
    // Propiedad garantizada por construcción y verificada por test: el
    // resultado es SUBCONJUNTO de `declared ∪ SCOPES_ALWAYS_ON`, que es el
    // efectivo previo a este issue (monotonía).
    const effectiveScopes = Array.from(new Set([
        ...declared.filter((sc) => allowed.includes(sc)),
        ...SCOPES_ALWAYS_ON,
    ]));

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
            const hit = lookupEnvCI(processEnv, v);
            if (hit) out[v] = hit.value;
        }
    }

    // #7634 · C4 — un rol CON scope `github` recibe `GH_TOKEN` ANTES de que se
    // neutralice el disco. Fuente: el env del intento (ya copiado arriba) o la
    // opción inyectable `githubTokenSource` (el cableado real con el store va
    // con el encendido, #7636). El token nunca se loguea ni viaja por argv.
    if (effectiveScopes.includes('github') && !lookupEnvCI(out, 'GH_TOKEN')
        && typeof githubTokenSource === 'function') {
        const token = githubTokenSource();
        if (typeof token === 'string' && token !== '') out.GH_TOKEN = token;
    }

    // 5. pipelineExtras al final (PIPELINE_ISSUE, PIPELINE_SKILL, etc.). El
    //    filtro final impide reintroducir el nombre reservado o un alias cuyo
    //    valor coincida con el material del operador. El descarte es silencioso
    //    para no revelar nombres alternativos ni valores en logs.
    // 6. #7112 · CA-7.2/7.3 — declaración de ambiente explícita, con el modo
    //    que resolvió ESTE proceso; sólo si el hijo lleva PIPELINE_REPO_ROOT.
    // 7. #7113 · CA-1 bullet 4 — defensa en profundidad sobre
    //    `stripReservedChildSecrets` (que sólo retira el material de firma de
    //    Telegram): en pruebas NINGUNA credencial productiva cruza al hijo,
    //    aunque un scope (`github`, `telegram-hooks`) o una extra la hubiera
    //    copiado. El env del Pulpo ya viene purgado por `credenciales-ambiente`;
    //    esto cubre un `processEnv` entregado por el caller (snapshot #5799).
    //
    // #7634 · C5 — orden fijo del camino ON (`buildChildEnv` sólo se invoca con
    // `env_isolation_enabled: true`): scopes → GH_TOKEN → merge de extras →
    // declaración explícita → neutralización de disco (DESPUÉS del merge: una
    // extra no puede pisar el sentinel) → strip de reservadas → purga de
    // pruebas → assert sobre el env final.
    const merged = conDeclaracionExplicita({ ...out, ...pipelineExtras }, processEnv);
    credentialSentinel.neutralizarDisco(merged, {
        aws: !effectiveScopes.includes('aws'),
        github: !effectiveScopes.includes('github'),
    });
    const final = stripReservedChildSecrets(merged, processEnv);
    if (hijoEnPruebas) require('./credenciales-ambiente').purgarClavesProductivas(final);
    if (assertMinimal) {
        assertChildEnvMinimal(final, {
            skill,
            fase,
            intento: providerName,
            providerKeyVar,
            effectiveScopes,
            skillDeclared: skillKnown,
            ancla: fase === KERNEL_FASE ? 'commander' : 'lanzaragenteclaude',
        });
    }
    return final;
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
    PROVIDER_MODEL_ENV,
    CREDENTIAL_SCOPES,
    SCOPES_ALWAYS_ON,
    // #5901 — techo por fase + fase sintética del kernel.
    SCOPES_BY_FASE,
    KERNEL_FASE,
    KERNEL_PROJECT_ID,
    RESERVED_CHILD_SECRET_NAMES,
    DEFAULT_REQUIRES_BY_SKILL,
    stripReservedChildSecrets,
    // #7112 — declaración de ambiente explícita del launcher (los dos caminos).
    conDeclaracionExplicita,
    // #6563 — env por allowlist para childs de clase "juez sin agencia".
    CLI_OAUTH_ALLOWLIST,
    buildMinimalCliEnv,
    // #7634 — mayúsculas, reservadas del camino ON y assert del env final.
    lookupEnvCI,
    assertChildEnvMinimal,
    ISOLATION_RESERVED_NAMES,
    CHILD_TRANSPORT_ALLOWLIST,
    // Internos exportados para tests.
    _resolveSkillConfig: resolveSkillConfig,
    _readAgentModelsDefensive: readAgentModelsDefensive,
};
