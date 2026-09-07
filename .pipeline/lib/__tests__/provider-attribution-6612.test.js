// =============================================================================
// provider-attribution-6612.test.js — #6612 (rebote 1, causa raíz)
//
// INCIDENTE QUE REPRODUCE
// -----------------------
// #6612 volvió a `dev` con el motivo "[po] Huérfano tras 3 reintentos — proceso
// muere repetidamente", sintetizado por el Pulpo con `rebote_categoria:
// infra_agent_crash`. El agente `po` nunca emitió un veredicto: su log quedó en
// 88 bytes (sólo el header que escribe el Pulpo) y no hay ningún registro en
// `spawn-exit-*.jsonl` para esa corrida.
//
// La cadena de fallback de `po` fue anthropic → openai-codex → gemini-google →
// cerebras → kimi-moonshot, y el dispatcher eligió `kimi-moonshot`. Kimi es un
// drop-in de Claude Code: `launcher: 'claude'` + `auth_mode: 'api_key'` +
// `credentials_env: ['ANTHROPIC_AUTH_TOKEN']`. Ese token no estaba cargado, así
// que el `claude` spawneado contra el endpoint de Moonshot murió sin emitir un
// solo byte.
//
// Dos defectos encadenados, ambos cubiertos acá:
//
//   1. SELECCIÓN — `validateProviderCredentials` eximía de validar a todo
//      provider con `launcher === 'claude'`, ignorando su `auth_mode`
//      declarado. Kimi pasaba el precheck SIN token y se lo elegía como
//      fallback sano.
//
//   2. ATRIBUCIÓN — la instrumentación de spawn y el consumo del marker en el
//      `brazoHuerfanos` estaban cableados a `openai-codex`. La muerte al
//      spawnear de cualquier OTRO provider no encontraba a quién atribuirse y
//      se le cobraba al ISSUE, hasta rebotarlo como si el código fallara.
//
// Cero red: clasificadores puros + fs inyectado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _validateProviderCredentials } = require('../commander/credentials-precheck');
const sfState = require('../agent-launcher/spawn-failure-state');

// -----------------------------------------------------------------------------
// Definición REAL de kimi-moonshot, leída de agent-models.json para que el test
// se entere si alguien cambia la declaración del provider (y no quede verde
// contra un fixture inventado que ya no representa al repo).
// -----------------------------------------------------------------------------
function readKimiDef() {
    const p = path.join(__dirname, '..', '..', 'agent-models.json');
    const models = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (models.providers || {})['kimi-moonshot'] || null;
}

// =============================================================================
// DEFECTO 1 — Selección: la exención de credencial la decide `auth_mode`.
// =============================================================================

test('#6612 CA-1 · kimi-moonshot SIN ANTHROPIC_AUTH_TOKEN → ok:false (no se elige como fallback sano)', () => {
    const def = { launcher: 'claude', auth_mode: 'api_key', credentials_env: ['ANTHROPIC_AUTH_TOKEN'] };
    const r = _validateProviderCredentials('kimi-moonshot', def, {});
    assert.equal(r.ok, false, 'un provider api_key sin su token NO puede reportarse como sano');
    assert.equal(r.reason, 'env_missing_or_placeholder:ANTHROPIC_AUTH_TOKEN');
});

test('#6612 CA-1b · la def REAL de agent-models.json es la que dispara el caso', () => {
    const def = readKimiDef();
    assert.ok(def, 'kimi-moonshot debe seguir declarado en agent-models.json');
    // Si alguna de estas dos deja de ser cierta, el escenario del incidente
    // cambió y este test debe revisarse en vez de seguir verde por inercia.
    assert.equal(def.launcher, 'claude', 'kimi sigue siendo drop-in del launcher claude');
    assert.equal(def.auth_mode, 'api_key', 'kimi sigue autenticando por API key, no por OAuth');

    const sinToken = _validateProviderCredentials('kimi-moonshot', def, {});
    assert.equal(sinToken.ok, false, 'sin token: degradado');

    const conToken = _validateProviderCredentials('kimi-moonshot', def, {
        ANTHROPIC_AUTH_TOKEN: 'sk-moonshot-valor-de-prueba',
    });
    assert.deepEqual(conToken, { ok: true }, 'con token: sano');
});

test('#6612 CA-1c · un auth_mode explícito no-oauth NUNCA queda exento por su launcher', () => {
    // Fail-closed genérico: la regla no es "kimi es especial", es "auth_mode
    // explícito manda". Cualquier provider futuro drop-in de claude que declare
    // un auth_mode no-oauth debe validarse.
    for (const authMode of ['api_key', 'API_KEY', 'token', 'bearer']) {
        const def = { launcher: 'claude', auth_mode: authMode, credentials_env: ['ALGUNA_KEY'] };
        const r = _validateProviderCredentials('futuro-dropin', def, {});
        assert.equal(r.ok, false, `auth_mode='${authMode}' no puede quedar exento`);
        assert.equal(r.reason, 'env_missing_or_placeholder:ALGUNA_KEY');
    }
});

test('#6612 CA-1d (regresión #4306) · oauth sigue exento y el launcher-claude sin auth_mode también', () => {
    // anthropic real: launcher claude + auth_mode oauth → exento.
    assert.deepEqual(
        _validateProviderCredentials('anthropic', { launcher: 'claude', auth_mode: 'oauth', credentials_env: ['ANTHROPIC_API_KEY'] }, {}),
        { ok: true }
    );
    // codex/gemini: auth_mode oauth con otro launcher → exento.
    assert.deepEqual(
        _validateProviderCredentials('openai-codex', { launcher: 'codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] }, {}),
        { ok: true }
    );
    // Def vieja sin auth_mode + launcher claude → compat, sigue exenta.
    assert.deepEqual(
        _validateProviderCredentials('legacy-claude', { launcher: 'claude', credentials_env: ['ANTHROPIC_API_KEY'] }, {}),
        { ok: true }
    );
    // HTTP puro sin auth_mode → sigue exigiendo key (regresión #4306).
    const cere = _validateProviderCredentials('cerebras', { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] }, {});
    assert.equal(cere.ok, false);
    assert.equal(cere.reason, 'env_missing_or_placeholder:CEREBRAS_API_KEY');
});

test('#6612 CA-1e (SEC) · el reason nunca filtra el VALOR del token', () => {
    const def = { launcher: 'claude', auth_mode: 'api_key', credentials_env: ['ANTHROPIC_AUTH_TOKEN'] };
    const r = _validateProviderCredentials('kimi-moonshot', def, { ANTHROPIC_AUTH_TOKEN: '   ' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^env_missing_or_placeholder:ANTHROPIC_AUTH_TOKEN$/);
});

// =============================================================================
// DEFECTO 2 — Atribución: el marker se consume por (skill, issue), y el
// provider apagado sale del marker.
// =============================================================================

function tmpPipelineDir(nombre) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sf6612-${nombre}-`));
    return dir;
}

test('#6612 CA-2 · un spawn-failure de kimi-moonshot se encuentra sin conocer el provider', () => {
    const dir = tmpPipelineDir('kimi');
    try {
        sfState.recordSpawnFailure({
            pipelineDir: dir,
            provider: 'kimi-moonshot',
            skill: 'po',
            issue: 6612,
            signature: 'early_exit:1@120ms',
            launcherKind: 'native-exe',
        });

        // El camino viejo (provider hardcodeado a codex) NO lo encuentra: ésta
        // es exactamente la ceguera que hizo rebotar #6612.
        const comoAntes = sfState.peekSpawnFailure({
            pipelineDir: dir, provider: 'openai-codex', skill: 'po', issue: 6612,
        });
        assert.equal(comoAntes, null, 'con el provider hardcodeado el marker es invisible');

        // El camino nuevo lo encuentra y dice QUIÉN falló.
        const marker = sfState.consumeSpawnFailureAnyProvider({
            pipelineDir: dir, skill: 'po', issue: 6612,
        });
        assert.ok(marker, 'el marker debe encontrarse por (skill, issue)');
        assert.equal(marker.provider, 'kimi-moonshot', 'el provider a apagar sale del marker');
        assert.equal(marker.signature, 'early_exit:1@120ms');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#6612 CA-2b · el consumo es one-shot (no apaga el provider dos veces)', () => {
    const dir = tmpPipelineDir('oneshot');
    try {
        sfState.recordSpawnFailure({
            pipelineDir: dir, provider: 'gemini-google', skill: 'review', issue: 4242,
            signature: 'error_code:ENOENT',
        });
        const uno = sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'review', issue: 4242 });
        assert.equal(uno && uno.provider, 'gemini-google');
        const dos = sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'review', issue: 4242 });
        assert.equal(dos, null, 'el segundo barrido no debe reencontrar el marker consumido');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#6612 CA-2c · no cruza issues ni skills (no apaga un provider por la muerte de otro agente)', () => {
    const dir = tmpPipelineDir('scope');
    try {
        sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'cerebras', skill: 'po', issue: 6612, signature: 'exit_code:127' });

        assert.equal(
            sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'po', issue: 9999 }),
            null, 'otro issue no debe consumir este marker'
        );
        assert.equal(
            sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'review', issue: 6612 }),
            null, 'otro skill no debe consumir este marker'
        );
        // El legítimo sigue disponible.
        const ok = sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'po', issue: 6612 });
        assert.equal(ok && ok.provider, 'cerebras');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#6612 CA-2d · con dos markers vivos para el mismo agente gana el más reciente', () => {
    const dir = tmpPipelineDir('multi');
    try {
        const t0 = Date.now();
        sfState.recordSpawnFailure({
            pipelineDir: dir, provider: 'cerebras', skill: 'po', issue: 6612,
            signature: 'exit_code:127', now: t0,
        });
        sfState.recordSpawnFailure({
            pipelineDir: dir, provider: 'kimi-moonshot', skill: 'po', issue: 6612,
            signature: 'early_exit:1@90ms', now: t0 + 60_000,
        });
        const marker = sfState.consumeSpawnFailureAnyProvider({
            pipelineDir: dir, skill: 'po', issue: 6612, now: t0 + 61_000,
        });
        assert.equal(marker.provider, 'kimi-moonshot', 'el que explica la muerte que se está mirando es el último');
        // El otro NO se pierde: sigue disponible para el barrido siguiente.
        const resto = sfState.consumeSpawnFailureAnyProvider({
            pipelineDir: dir, skill: 'po', issue: 6612, now: t0 + 62_000,
        });
        assert.equal(resto && resto.provider, 'cerebras');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#6612 CA-2e · un marker vencido por TTL no atribuye nada (fail-closed hacia el camino normal)', () => {
    const dir = tmpPipelineDir('ttl');
    try {
        const t0 = Date.now();
        sfState.recordSpawnFailure({
            pipelineDir: dir, provider: 'kimi-moonshot', skill: 'po', issue: 6612,
            signature: 'early_exit:1@90ms', now: t0, ttlMs: 1000,
        });
        const vencido = sfState.consumeSpawnFailureAnyProvider({
            pipelineDir: dir, skill: 'po', issue: 6612, now: t0 + 5000,
        });
        assert.equal(vencido, null, 'un marker viejo no puede apagar un provider hoy');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#6612 CA-2f · entradas corruptas o sin provider no tumban el barrido', () => {
    const dir = tmpPipelineDir('corrupto');
    try {
        assert.equal(
            sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'po', issue: 6612 }),
            null, 'sin archivo de estado → null, nunca throw'
        );
        fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
        fs.writeFileSync(sfState.stateFile(dir), 'no-es-json{{{');
        assert.equal(
            sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'po', issue: 6612 }),
            null, 'JSON corrupto → null, nunca throw'
        );
        // Argumentos faltantes.
        assert.equal(sfState.consumeSpawnFailureAnyProvider({}), null);
        assert.equal(sfState.consumeSpawnFailureAnyProvider({ pipelineDir: dir, skill: 'po' }), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// =============================================================================
// DEFECTO 2 (cableado) — el gate por provider ya no vive en el código.
// =============================================================================

test('#6612 CA-3 · el launcher instrumenta el spawn de TODO provider LLM, no sólo codex', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent-launcher.js'), 'utf8');

    const llamada = src.indexOf('instrumentProviderSpawn({');
    assert.ok(llamada > 0, 'la instrumentación se invoca con el nombre generalizado');

    // Miramos SOLO la guarda que envuelve la llamada. Un `=== 'openai-codex'`
    // en otra parte del archivo es legítimo (health-probe de Codex) y no debe
    // hacer fallar este test.
    const guarda = src.slice(Math.max(0, llamada - 400), llamada);
    assert.ok(
        !/=== 'openai-codex'/.test(guarda),
        'la instrumentación no puede seguir gateada a openai-codex'
    );
    assert.ok(
        /provider !== 'deterministic'/.test(guarda),
        'los skills determinísticos siguen fuera: su muerte SÍ es atribuible al issue'
    );
    assert.ok(
        !/provider: 'openai-codex'/.test(src),
        'ni onSpawnExit ni recordSpawnFailure pueden seguir con el provider hardcodeado'
    );
});

test('#6612 CA-3b · el brazoHuerfanos consume por (skill, issue) y apaga el provider del marker', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    assert.ok(
        /consumeSpawnFailureAnyProvider\(\{/.test(src),
        'el barrido debe consumir sin exigir el nombre del provider'
    );
    assert.ok(
        !/setProviderDisabled\('openai-codex'/.test(src),
        'apagar un provider hardcodeado apagaría el eslabón equivocado de la cadena'
    );
    assert.ok(
        /setProviderDisabled\(failedProvider/.test(src),
        'el provider apagado sale del marker'
    );
});
