'use strict';

// -----------------------------------------------------------------------------
// #5462 — Contención de credenciales en ambientes hijo: barrido de los sitios de
// spawn de CLASE AGENTE de `.pipeline/pulpo.js` Y de los módulos de `.pipeline/lib/`
// que crean hijos de clase agente/provider (hoy `sherlock-verifier.js` y
// `agent-launcher.js` — ver sección 3).
//
// Por qué existe este archivo
// ---------------------------
// La pasada anterior endureció la librería (`lib/build-child-env.js`) y sacó la
// suite en verde, pero CA-1 igual no se cumplía: el material de firma de Telegram
// no cruzaba por la librería, cruzaba por los CALL SITES de `pulpo.js` que armaban
// el env a mano y nunca la llamaban. Un test que sólo mira la librería es ciego a
// eso. Este barrido mira el fuente de `pulpo.js`.
//
// Diseño del barrido (aporte de `guru`, #5550)
// --------------------------------------------
// De ~69 `spawn`/`execSync` en `pulpo.js` sólo unos pocos pasan `env` explícito;
// el resto hereda `process.env` entero por omisión pero son utilitarios (git, gh,
// adb, tasklist, scripts node propios), NO childs de clase agente/provider. Por eso
// el test NO se ancla en "nadie spreadea process.env" (daría verde ante un quinto
// spawn de agente sin opción `env`), sino en dos invariantes:
//
//   1. ENUMERACIÓN CON CARDINALIDAD — los sitios que pasan `env` explícito son
//      exactamente los conocidos, clasificados en utilitarios (allowlist justificada)
//      y de clase agente (deben resolver a un env construido por `build-child-env`).
//      Si aparece un 5º sitio de clase agente, el test falla POR CONTEO y fuerza
//      revisión humana en vez de pasar en silencio.
//   2. CANARIO FUNCIONAL SOBRE EL FUENTE REAL — el texto fuente de cada sitio se
//      extrae de `pulpo.js` y se EVALÚA en un sandbox con un `process.env` falso.
//      No se testea una copia del código: si alguien edita el sitio en `pulpo.js`,
//      este test evalúa la versión editada. Cubre ambos valores del flag de rollout
//      `pipeline.env_isolation_enabled` (hoy `false` en config.yaml → el camino
//      legacy ES producción).
//
// Método de canario (obligatorio por la receta)
// ---------------------------------------------
// Se marca fuga si el env del child expone la clave reservada POR NOMBRE **o**
// cualquier variable cuyo VALOR sea igual al canario (cubre el alias renombrado).
// Buscar sólo por nombre no alcanza.
//
// El canario es sintético: este archivo NUNCA lee ni imprime el token real.
// -----------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PIPELINE_DIR = path.join(__dirname, '..');
const PULPO_PATH = path.join(PIPELINE_DIR, 'pulpo.js');
const buildChildEnvLib = require('../lib/build-child-env');

const FUENTE = fs.readFileSync(PULPO_PATH, 'utf8');
const LINEAS = FUENTE.split(/\r?\n/);

// Valor sintético. NO es un token real y nunca se compara contra el env real.
const CANARIO = 'canario-sintetico-5462-NO-ES-UN-TOKEN-REAL';
const ROOT_FAKE = 'C:\\fake\\root';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Env del operador simulado: incluye el material reservado por nombre y bajo
 *  dos alias hostiles con el MISMO valor (uno "parecido", otro renombrado). */
function fakeOperatorEnv(extra = {}) {
    return {
        PATH: 'C:\\fake\\bin',
        HOME: 'C:\\fake\\home',
        USERPROFILE: 'C:\\fake\\home',
        // --- material reservado (canario) ---
        TELEGRAM_BOT_TOKEN: CANARIO,
        TELEGRAM_BOT_TOKEN_BACKUP: CANARIO,   // alias con el mismo valor
        NOTIF_SIGNING_MATERIAL: CANARIO,      // alias totalmente renombrado
        // --- observabilidad que NO debe perderse ---
        TELEGRAM_CHAT_ID: '-1009999999',
        PIPELINE_ISSUE: '5462',
        PIPELINE_SKILL: 'pipeline-dev',
        // --- ruido/infra ---
        CLAUDECODE: '1',
        ANTHROPIC_API_KEY: 'fake-anthropic-key',
        ANTHROPIC_AUTH_TOKEN: 'fake-kimi-key',
        OPENAI_API_KEY: 'fake-openai-key',
        CEREBRAS_API_KEY: 'fake-cerebras-key',
        NVIDIA_NIM_API_KEY: 'fake-nvidia-key',
        ...extra,
    };
}

/** Devuelve los NOMBRES de vars que filtran el material (por nombre o por valor).
 *  Nunca devuelve valores: el mensaje de assert sólo expone nombres. */
function detectarFugas(env) {
    const fugas = [];
    for (const [nombre, valor] of Object.entries(env || {})) {
        if (buildChildEnvLib.RESERVED_CHILD_SECRET_NAMES.includes(nombre)) {
            fugas.push(`${nombre} (por nombre)`);
            continue;
        }
        if (valor !== undefined && valor !== null && String(valor) === CANARIO) {
            fugas.push(`${nombre} (por valor == canario)`);
        }
    }
    return fugas;
}

/** Índice (0-based) de la única línea que contiene `aguja`. Falla si hay 0 o >1. */
function lineaUnica(aguja) {
    const idxs = [];
    LINEAS.forEach((l, i) => { if (l.includes(aguja)) idxs.push(i); });
    assert.strictEqual(
        idxs.length, 1,
        `Se esperaba exactamente 1 línea con ${JSON.stringify(aguja)} en pulpo.js, ` +
        `se encontraron ${idxs.length} (líneas ${idxs.map((i) => i + 1).join(', ') || 'ninguna'}). ` +
        `Si el sitio se movió o se duplicó, actualizar este barrido conscientemente.`,
    );
    return idxs[0];
}

/** Texto fuente real entre dos anclas de línea (inclusive). */
function bloqueFuente(anclaInicio, anclaFin) {
    const i = lineaUnica(anclaInicio);
    const j = lineaUnica(anclaFin);
    assert.ok(j >= i, `Ancla de fin antes que la de inicio (${anclaInicio} / ${anclaFin}).`);
    return LINEAS.slice(i, j + 1).join('\n');
}

/** Cuerpo completo de un arrow/función que arranca en `anclaInicio` y termina en
 *  la primera línea posterior cuyo contenido trimmeado es exactamente `};`. */
function bloqueHastaCierre(anclaInicio) {
    const i = lineaUnica(anclaInicio);
    for (let j = i + 1; j < LINEAS.length; j++) {
        if (LINEAS[j].trim() === '};') return LINEAS.slice(i, j + 1).join('\n');
    }
    assert.fail(`No se encontró el cierre '};' del bloque que arranca en ${anclaInicio}`);
}

/** Expresión a la derecha de `env:` en una línea, sin la coma final. */
function expresionEnv(linea) {
    const m = /\benv:\s*(.+?),?\s*$/.exec(linea);
    assert.ok(m, `La línea no tiene una opción env: ${linea}`);
    return m[1];
}

// -----------------------------------------------------------------------------
// 1. Enumeración con cardinalidad de los sitios que pasan `env` explícito
// -----------------------------------------------------------------------------

// Llamadas que terminan creando un proceso hijo. Incluye los wrappers de
// lanzamiento de agentes (`launchAgent`, `commanderMP.safeBuildSpawn`): el env
// que reciben es exactamente el que termina en el `spawn` de adentro, así que
// para este barrido son sitios de spawn de pleno derecho.
const CALLEES_CHILD = /\b(spawnSync|spawn|execFileSync|execSync|execFile|exec|fork|launchAgent|safeBuildSpawn)\s*\(/g;

/**
 * Si la línea `i` está DENTRO de la lista de argumentos de una llamada que crea
 * un proceso hijo, devuelve el nombre del callee; si no, null.
 *
 * Método: busca hacia atrás (hasta 40 líneas) las llamadas candidatas y se queda
 * con la más interna cuyo paréntesis siga abierto al llegar a la línea `i`. Esto
 * distingue `execSync(..., { env: adbEnv })` (child real) de un `env: process.env`
 * que es sólo un argumento de una función pura (ej. shouldEvaluateGate0).
 */
function calleeDeChild(i, col, lineas = LINEAS, callees = CALLEES_CHILD) {
    // Se reconstruye desde `lineas` (no por offsets sobre el fuente): los archivos
    // tienen finales de línea CRLF y cualquier aritmética de offsets se desincroniza.
    // Incluye la PROPIA línea hasta la columna del `env:` — si no, un spawn de una
    // sola línea (`spawn(x, [], { env: ... })`) no se detectaría como child y el
    // sitio se escaparía del barrido por completo.
    const previas = lineas.slice(Math.max(0, i - 40), i).join('\n');
    const slice = `${previas}\n${lineas[i].slice(0, col)}`;
    let encontrado = null;
    callees.lastIndex = 0;
    let m;
    while ((m = callees.exec(slice)) !== null) {
        // `function launchAgent({ ... env ... })` es la DECLARACIÓN del helper, no
        // una llamada: su lista de parámetros no es un sitio de spawn.
        if (/\bfunction\s+$/.test(slice.slice(0, m.index))) continue;
        let depth = 0;
        for (let k = m.index + m[0].length - 1; k < slice.length; k++) {
            const c = slice[k];
            if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        if (depth > 0) encontrado = m[1]; // llamada todavía abierta → nos contiene
    }
    return encontrado;
}

/** Todos los sitios de `pulpo.js` que pasan una opción `env:` a un proceso hijo. */
function enumerarSitiosEnv(lineas = LINEAS, callees = CALLEES_CHILD) {
    const sitios = [];
    lineas.forEach((linea, i) => {
        const m = /\benv:\s*\S/.exec(linea);
        if (!m) return;
        // `processEnv:` / `cleanEnv:` etc. no son la opción `env` de spawn.
        if (/[A-Za-z0-9_]env:\s*\S/.test(linea)) return;
        const callee = calleeDeChild(i, m.index, lineas, callees);
        if (!callee) return; // no es opción de un child: función pura, objeto suelto, etc.
        sitios.push({
            linea: i + 1, texto: linea.trim(), expr: expresionEnv(linea), callee, forma: 'explicita',
        });
    });
    return sitios;
}

/**
 * Igual que `enumerarSitiosEnv`, pero detecta ADEMÁS la forma abreviada de
 * ES6 (`{ args, cwd, env, ... }`). Sin esto, un módulo que delega el env por
 * shorthand — como `agent-launcher.js` — enumera CERO sitios y el guard de
 * cardinalidad queda vacuo justo donde tiene que morder (#5462 H-6).
 */
function enumerarSitiosEnvConShorthand(lineas, callees) {
    const sitios = enumerarSitiosEnv(lineas, callees);
    lineas.forEach((linea, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return;  // comentarios: no son código
        // `env` como propiedad abreviada: precedido por `{` o `,` y seguido por
        // `,` o `}`. El lookbehind excluye `cleanEnv,` / `childEnv,` (identificadores
        // que terminan en "env") y — con el `.` — el `process.env,` que aparece como
        // ARGUMENTO del propio filtro, que no es un sitio de spawn nuevo.
        const m = /(?<![A-Za-z0-9_$.])env\s*(?=[,}])/.exec(linea);
        if (!m) return;
        if (/\benv:/.test(linea)) return;              // ya cubierto por la forma explícita
        const callee = calleeDeChild(i, m.index, lineas, callees);
        if (!callee) return;
        sitios.push({
            linea: i + 1, texto: linea.trim(), expr: 'env', callee, forma: 'shorthand',
        });
    });
    return sitios.sort((a, b) => a.linea - b.linea);
}

// Utilitarios con env explícito: NO son childs de clase agente/provider. Cada
// entrada exige justificación — no agregar sin verificar qué se está spawneando.
const UTILITARIOS = [
    { marca: 'QA_ISSUE', motivo: 'execSync de qa-generate-test-cases.js (script node propio, no agente)' },
    { marca: "PATH: 'C:", motivo: 'relanzador de restart en background (cmd.exe, no agente)' },
    { marca: 'adbEnv', motivo: 'execSync de adb (pull/rm de evidencia QA en el emulador, no agente)' },
];

// Expresiones `env:` esperadas en los sitios de CLASE AGENTE. Cardinalidad = 4.
const AGENTE_ESPERADOS = [
    'rolloutSpawn.env',                                                          // lanzarAgenteClaude (copia filtrada + modelo gated)
    'buildChildEnvLib.stripReservedChildSecrets(summaryBaseEnv, process.env)',   // H-3 summarize
    'attemptEnv',                                                                // H-1 fallback no-Anthropic
    'cleanEnv',                                                                  // H-2 commander legacy
];

test('los sitios de spawn de clase agente estan enumerados y su cardinalidad es exactamente 4', () => {
    const sitios = enumerarSitiosEnv();
    const utilitarios = [];
    const agente = [];

    for (const s of sitios) {
        const util = UTILITARIOS.find((u) => s.texto.includes(u.marca));
        if (util) utilitarios.push({ ...s, motivo: util.motivo });
        else agente.push(s);
    }

    assert.strictEqual(
        agente.length, AGENTE_ESPERADOS.length,
        `Cardinalidad de sitios de spawn de clase agente cambió: esperados ` +
        `${AGENTE_ESPERADOS.length}, encontrados ${agente.length}.\n` +
        `Sitios detectados:\n${agente.map((a) => `  L${a.linea}: ${a.texto}`).join('\n')}\n` +
        `Si agregaste un spawn de agente nuevo: construí su env con build-child-env ` +
        `y sumalo a AGENTE_ESPERADOS conscientemente (#5462).`,
    );

    assert.deepStrictEqual(
        agente.map((a) => a.expr).sort(),
        [...AGENTE_ESPERADOS].sort(),
        'Las expresiones `env:` de los sitios de clase agente no son las esperadas.',
    );

    // Cada utilitario declarado sigue existiendo (si uno desaparece, la allowlist
    // quedó obsoleta y hay que revisarla en vez de arrastrarla).
    for (const u of UTILITARIOS) {
        assert.ok(
            utilitarios.some((s) => s.texto.includes(u.marca)),
            `El utilitario declarado ${JSON.stringify(u.marca)} (${u.motivo}) ya no existe en pulpo.js: ` +
            'depurar la allowlist de este barrido.',
        );
    }
});

test('ningun spawn de clase agente construye su env con spread crudo de process.env', () => {
    const sitios = enumerarSitiosEnv()
        .filter((s) => !UTILITARIOS.some((u) => s.texto.includes(u.marca)));

    for (const s of sitios) {
        assert.ok(
            !/\{\s*\.\.\.process\.env/.test(s.expr),
            `El sitio de clase agente en L${s.linea} pasa un spread crudo de process.env ` +
            `a spawn: ${s.texto}`,
        );
    }

    // Invariante del pre-checklist del issue: el patrón legacy no sobrevive en
    // NINGUNA forma dentro del archivo.
    const crudos = LINEAS
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /\.\.\.process\.env,\s*CLAUDE_PROJECT_DIR/.test(l));
    assert.deepStrictEqual(
        crudos.map(({ n, l }) => `L${n}: ${l.trim()}`), [],
        'Reapareció el patrón legacy `{ ...process.env, CLAUDE_PROJECT_DIR }` en pulpo.js.',
    );
});

test('los 4 sitios de clase agente pasan por build-child-env (buildChildEnv o stripReservedChildSecrets)', () => {
    const strips = LINEAS.filter((l) => l.includes('stripReservedChildSecrets')).length;
    assert.strictEqual(strips, 4,
        `Se esperaban 4 llamadas a stripReservedChildSecrets en pulpo.js (1 preexistente + 3 de #5462), ` +
        `hay ${strips}.`);

    // Cada identificador de env de clase agente termina filtrado antes del spawn.
    assert.ok(
        /childEnv = buildChildEnvLib\.stripReservedChildSecrets\(/.test(FUENTE),
        'lanzarAgenteClaude ya no filtra childEnv con stripReservedChildSecrets.',
    );
    assert.ok(
        /cleanEnv = buildChildEnvLib\.stripReservedChildSecrets\(cleanEnv, process\.env\);/.test(FUENTE),
        'H-2: el env del commander legacy ya no se filtra en el punto de salida.',
    );
    assert.ok(
        /return buildChildEnvLib\.stripReservedChildSecrets\(e, process\.env\);/.test(FUENTE),
        'H-1: buildEnvFor ya no filtra el env del fallback no-Anthropic.',
    );
    // attemptEnv es `preEnv || buildEnvFor(...)`; ambas fuentes quedan cubiertas
    // por los dos asserts anteriores (preEnv === cleanEnv en el único caller).
    assert.ok(
        /attemptEnv = preEnv \|\| buildEnvFor\(/.test(FUENTE),
        'Cambió el origen de attemptEnv: revisar que ambas ramas sigan filtradas.',
    );
});

// -----------------------------------------------------------------------------
// 2. Canarios funcionales sobre el FUENTE REAL de cada sitio
// -----------------------------------------------------------------------------

/** Evalúa el fuente real de `buildEnvFor` (H-1) con el flag de rollout dado. */
function evaluarBuildEnvFor({ aislamiento, provider }) {
    const src = bloqueHastaCierre('const buildEnvFor = (prov) => {');
    const factory = new Function(
        'process', 'ROOT', 'buildChildEnvLib', 'commanderEnvIsolation', 'commanderMP', 'PIPELINE',
        `${src}\nreturn buildEnvFor;`,
    );
    const fn = factory(
        { env: fakeOperatorEnv() },
        ROOT_FAKE,
        buildChildEnvLib,
        aislamiento,
        { COMMANDER_SKILL: 'commander' },
        PIPELINE_DIR,
    );
    return fn(provider);
}

/** Evalúa el fuente real del armado de env del commander legacy (H-2). */
function evaluarCleanEnv({ aislamiento, provider }) {
    const src = bloqueFuente(
        'let cleanEnv;',
        'cleanEnv = buildChildEnvLib.stripReservedChildSecrets(cleanEnv, process.env);',
    );
    const factory = new Function(
        'process', 'ROOT', 'buildChildEnvLib', 'commanderMP', 'PIPELINE', 'resolution',
        'loadConfig', 'log', 'reject',
        `${src}\nreturn cleanEnv;`,
    );
    return factory(
        { env: fakeOperatorEnv() },
        ROOT_FAKE,
        buildChildEnvLib,
        { COMMANDER_SKILL: 'commander' },
        PIPELINE_DIR,
        { provider },
        () => ({ pipeline: { env_isolation_enabled: aislamiento } }),
        () => {},
        (e) => { throw e; },
    );
}

/** Evalúa el fuente real del env del child de resumen del commander (H-3). */
function evaluarSummarizeEnv() {
    const base = bloqueFuente(
        'const summaryBaseEnv = { ...process.env };',
        'summaryBaseEnv.CLAUDE_PROJECT_DIR = ROOT;',
    );
    const expr = expresionEnv(
        LINEAS[lineaUnica('stripReservedChildSecrets(summaryBaseEnv, process.env)')],
    );
    const factory = new Function(
        'process', 'ROOT', 'buildChildEnvLib',
        `${base}\nreturn ${expr};`,
    );
    return factory({ env: fakeOperatorEnv() }, ROOT_FAKE, buildChildEnvLib);
}

// --- H-3: summarizeCommanderOlderTurns -----------------------------------------

for (const aislamiento of [false, true]) {
    test(`H-3 summarizeCommanderOlderTurns filtra el material con aislamiento=${aislamiento}`, () => {
        // Este sitio NO tiene rama condicional por diseño: el filtro es
        // incondicional. El test se parametriza igual para dejar probado que el
        // resultado es independiente del flag de rollout (CA-1b).
        const env = evaluarSummarizeEnv();
        assert.deepStrictEqual(
            detectarFugas(env), [],
            `El child de resumen del commander recibe material reservado (aislamiento=${aislamiento}).`,
        );
        assert.strictEqual(env.CLAUDE_PROJECT_DIR, ROOT_FAKE, 'CLAUDE_PROJECT_DIR debe preservarse.');
        assert.strictEqual(env.TELEGRAM_CHAT_ID, '-1009999999', 'TELEGRAM_CHAT_ID debe preservarse.');
    });
}

// --- H-2: commander singleton ---------------------------------------------------

for (const aislamiento of [false, true]) {
    test(`H-2 el env del commander singleton no contiene el material de firma (aislamiento=${aislamiento})`, () => {
        const env = evaluarCleanEnv({ aislamiento, provider: 'anthropic' });
        assert.deepStrictEqual(
            detectarFugas(env), [],
            `El commander singleton recibe material reservado (aislamiento=${aislamiento}).`,
        );
        assert.ok(!('CLAUDECODE' in env),
            'El delete de CLAUDECODE se perdió: el filtro devuelve un objeto NUEVO y debe aplicarse después del delete.');
        assert.strictEqual(env.CLAUDE_PROJECT_DIR, ROOT_FAKE);
        assert.strictEqual(env.TELEGRAM_CHAT_ID, '-1009999999');
        assert.strictEqual(env.PIPELINE_ISSUE, '5462');
    });
}

// --- H-1: ejecutor de fallback no-Anthropic ------------------------------------

for (const aislamiento of [false, true]) {
    for (const provider of ['cerebras', 'openai-codex']) {
        test(`H-1 el env del fallback ${provider} no contiene el material de firma (aislamiento=${aislamiento})`, () => {
            const env = evaluarBuildEnvFor({ aislamiento, provider });
            assert.deepStrictEqual(
                detectarFugas(env), [],
                `El fallback ${provider} recibe material reservado (aislamiento=${aislamiento}).`,
            );
            assert.ok(!('CLAUDECODE' in env),
                'El delete de CLAUDECODE se perdió tras aplicar el filtro.');
        });
    }
}

// --- Anti-regresión de observabilidad -------------------------------------------

test('el filtro preserva CHAT_ID, PIPELINE_ISSUE y CLAUDE_PROJECT_DIR en los 3 sitios', () => {
    const envs = {
        'H-3 summarize': evaluarSummarizeEnv(),
        'H-2 commander legacy': evaluarCleanEnv({ aislamiento: false, provider: 'anthropic' }),
        'H-2 commander aislado': evaluarCleanEnv({ aislamiento: true, provider: 'anthropic' }),
        'H-1 fallback legacy': evaluarBuildEnvFor({ aislamiento: false, provider: 'cerebras' }),
        'H-1 fallback aislado': evaluarBuildEnvFor({ aislamiento: true, provider: 'cerebras' }),
    };
    for (const [sitio, env] of Object.entries(envs)) {
        assert.strictEqual(env.TELEGRAM_CHAT_ID, '-1009999999', `${sitio}: perdió TELEGRAM_CHAT_ID`);
        assert.strictEqual(env.PIPELINE_ISSUE, '5462', `${sitio}: perdió PIPELINE_ISSUE`);
        assert.strictEqual(env.CLAUDE_PROJECT_DIR, ROOT_FAKE, `${sitio}: perdió CLAUDE_PROJECT_DIR`);
    }
});

// -----------------------------------------------------------------------------
// 3. Barrido de los módulos de `lib/` que spawnean hijos de clase agente/provider
//
// Por qué existe esta sección (#5462 H-6)
// ---------------------------------------
// La sección 1 se ancla en `pulpo.js` y por construcción NO puede ver un spawn que
// viva en `lib/`. La pasada anterior cerró los 3 sitios de `pulpo.js`, la suite dio
// verde y eso sugirió que la clase estaba cerrada — pero `lib/sherlock-verifier.js`
// tenía DOS spawns de clase provider heredando `process.env` entero (H-4 anthropic,
// H-5 openai-codex), alcanzables en la operación normal: ninguno de los dos callers
// reales de `verify()` (`pulpo.js` 15453/15497) pasa `env`, así que corría la rama
// sin filtrar. Un barrido de un solo archivo da una garantía de un solo archivo.
// -----------------------------------------------------------------------------

// En `lib/` el sumidero del env es `handler.buildSpawn({...})` (el spawn real toma
// `spawnDef.spawnOpts`), así que el callee a reconocer es distinto al de `pulpo.js`.
const CALLEES_CHILD_LIB = /\b(spawnSync|spawn|execFileSync|execSync|execFile|exec|fork|buildSpawn|safeBuildSpawn|launchAgent)\s*\(/g;

/**
 * Un sitio de clase agente está contenido si su expresión `env` (a) invoca el
 * filtro directamente, o (b) es un identificador asignado desde el filtro en el
 * mismo archivo. Cubre tanto el filtro inline como el `const _env = strip(...)`.
 */
function envPasaPorFiltro(fuente, expr) {
    if (/stripReservedChildSecrets\s*\(/.test(expr)) return true;
    const id = expr.trim().replace(/[,)]+$/, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(id)) return false;
    return new RegExp(
        `\\b${id}\\s*=\\s*buildChildEnvLib\\.stripReservedChildSecrets\\s*\\(`,
    ).test(fuente);
}

// Módulos de `lib/` que crean hijos de clase agente/provider. Cada sitio se
// clasifica y se le exige cardinalidad, igual que en `pulpo.js`.
//   - `filtrado`: el módulo arma el env él mismo → DEBE pasar por build-child-env.
//   - `delegado`: el env entra como parámetro ya filtrado por el caller. Se
//     documenta el caller responsable; si aparece un sitio nuevo, la cardinalidad
//     falla y fuerza revisar quién lo construye.
const MODULOS_LIB = [
    {
        archivo: 'lib/sherlock-verifier.js',
        sitios: [
            { clase: 'filtrado', motivo: 'H-4 — spawn del fiscal en anthropic (transport=spawn)' },
            { clase: 'filtrado', motivo: 'H-5 — spawn del fiscal en openai-codex (CLI de terceros)' },
        ],
    },
    {
        archivo: 'lib/agent-launcher.js',
        sitios: [
            { clase: 'delegado', motivo: 'buildSpawn determinístico — env recibido por parámetro, filtrado por el caller pulpo.js:lanzarAgenteClaude' },
            { clase: 'delegado', motivo: 'buildSpawn de provider LLM — idem: el env llega ya filtrado desde pulpo.js' },
        ],
    },
];

for (const mod of MODULOS_LIB) {
    test(`barrido lib/: ${mod.archivo} enumera exactamente ${mod.sitios.length} sitios de env de clase agente`, () => {
        const lineas = fs.readFileSync(path.join(PIPELINE_DIR, mod.archivo), 'utf8').split(/\r?\n/);
        const sitios = enumerarSitiosEnvConShorthand(lineas, CALLEES_CHILD_LIB);

        assert.strictEqual(
            sitios.length, mod.sitios.length,
            `Cardinalidad de sitios de env de clase agente cambió en ${mod.archivo}: ` +
            `esperados ${mod.sitios.length}, encontrados ${sitios.length}.\n` +
            `Sitios detectados:\n${sitios.map((s) => `  L${s.linea} [${s.forma}] ${s.texto}`).join('\n')}\n` +
            `Si agregaste un spawn nuevo: construí su env con build-child-env y sumalo ` +
            `a MODULOS_LIB conscientemente (#5462).`,
        );

        const fuente = lineas.join('\n');
        sitios.forEach((s, idx) => {
            const esperado = mod.sitios[idx];
            if (esperado.clase !== 'filtrado') return;
            assert.ok(
                envPasaPorFiltro(fuente, s.expr),
                `${mod.archivo} L${s.linea} (${esperado.motivo}) arma un env que NO pasa por ` +
                `stripReservedChildSecrets: ${s.texto}`,
            );
        });
    });
}

test('barrido lib/: ningun modulo de lib spawnea con spread crudo de process.env sin filtrar', () => {
    for (const mod of MODULOS_LIB) {
        const lineas = fs.readFileSync(path.join(PIPELINE_DIR, mod.archivo), 'utf8').split(/\r?\n/);
        const fuente = lineas.join('\n');
        const sitios = enumerarSitiosEnvConShorthand(lineas, CALLEES_CHILD_LIB);
        for (const s of sitios) {
            const crudo = /\{\s*\.\.\.process\.env/.test(s.expr) || /\benv\s*\|\|\s*process\.env\b/.test(s.expr);
            assert.ok(
                !crudo || envPasaPorFiltro(fuente, s.expr),
                `${mod.archivo} L${s.linea} pasa process.env crudo al child: ${s.texto}`,
            );
        }
    }
});

// --- Canarios FUNCIONALES sobre los handlers reales de Sherlock (H-4 / H-5) ----
//
// Los asserts de arriba miran el fuente; estos ejecutan los spawn helpers REALES y
// capturan el `env` exacto que recibiría el child. El `spawnImpl` es falso (no se
// lanza ningún proceso) pero el armado del env es el de producción.

const sherlockVerifier = require('../lib/sherlock-verifier');

/** Ejecuta un spawn helper real con spawn falso y devuelve el env capturado. */
function capturarEnvDeSpawn(fn, args) {
    let capturado = null;
    const spawnImpl = (cmd, argv, opts) => {
        capturado = (opts && opts.env) || null;
        const EventEmitter = require('node:events');
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() {}, end() {}, on() {} };
        child.kill = () => {};
        return child;
    };
    const envOriginal = process.env;
    process.env = fakeOperatorEnv();
    try {
        // La promesa queda pendiente a propósito: el dato de interés (`spawnOpts.env`)
        // se captura sincrónicamente en el momento del spawn. `timeoutMs: 0` no arma
        // timer, así que no queda ningún handle abierto.
        fn({ ...args, timeoutMs: 0, spawnImpl, cwd: ROOT_FAKE });
    } finally {
        process.env = envOriginal;
    }
    return capturado;
}

test('H-4 el spawn de Sherlock en anthropic no le pasa el material de firma al child', () => {
    const env = capturarEnvDeSpawn(sherlockVerifier._spawnAnthropicComplete, { prompt: 'x' });
    assert.ok(env, 'No se capturó el env del spawn: el handler no llegó a spawnear.');
    assert.deepStrictEqual(
        detectarFugas(env), [],
        'El fiscal Sherlock (anthropic) recibe material reservado en su env.',
    );
    assert.strictEqual(env.TELEGRAM_CHAT_ID, '-1009999999', 'TELEGRAM_CHAT_ID debe preservarse.');
});

test('H-5 el spawn de Sherlock en openai-codex no le pasa el material de firma al CLI de terceros', () => {
    const env = capturarEnvDeSpawn(sherlockVerifier._spawnCodexComplete, { prompt: 'x', model: 'gpt-5.4-mini' });
    assert.ok(env, 'No se capturó el env del spawn: el handler no llegó a spawnear.');
    assert.deepStrictEqual(
        detectarFugas(env), [],
        'El fiscal Sherlock (openai-codex) recibe material reservado en su env.',
    );
    // El filtro va DESPUÉS del merge: los extras del merge deben sobrevivir.
    assert.strictEqual(env.CODEX_MODEL, 'gpt-5.4-mini', 'CODEX_MODEL debe preservarse tras el filtro.');
    assert.strictEqual(env.CLAUDE_PROJECT_DIR, ROOT_FAKE, 'CLAUDE_PROJECT_DIR debe preservarse tras el filtro.');
    assert.strictEqual(env.TELEGRAM_CHAT_ID, '-1009999999', 'TELEGRAM_CHAT_ID debe preservarse.');
});

test('el detector de canario atrapa el alias renombrado (auto-test del método)', () => {
    // Si el detector sólo mirara por nombre, este caso pasaría inadvertido.
    const fugas = detectarFugas({ ALGO_INOCENTE: CANARIO, OTRA: 'ok' });
    assert.deepStrictEqual(fugas, ['ALGO_INOCENTE (por valor == canario)']);

    // Y el patrón legacy SÍ debe fugar (prueba de que el canario no es vacuo).
    const legacy = { ...fakeOperatorEnv(), CLAUDE_PROJECT_DIR: ROOT_FAKE };
    assert.ok(detectarFugas(legacy).length >= 3,
        'El env legacy sin filtrar debería fugar por nombre y por los 2 alias.');
});
