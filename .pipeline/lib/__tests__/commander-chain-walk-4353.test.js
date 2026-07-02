// =============================================================================
// commander-chain-walk-4353.test.js — #4353 CA-1 / CA-2
//
// Regresión del incidente 2026-07-01: ante el primario (Anthropic) gated y
// varios eslabones de la cadena caídos, la resolución de provider debe RECORRER
// la cadena completa (Codex → Gemini → Cerebras → NVIDIA) y devolver el primer
// provider SANO, en vez de rendirse en el segundo eslabón declarando
// "fallaron todos".
//
// El walk vive en `resolveSpawnWithFallback` (mecanismo que reusan tanto el
// path pre-spawn del Commander como `resolveCommanderProviderExcluding`). Este
// test ejercita ese mecanismo de forma determinística inyectando el resolver
// primario, el resolver de handlers y el quotaModule.
//
// CA-1 — la cadena se agota completa antes de declarar indisponibilidad.
// CA-2 — con al menos un provider sano, la resolución devuelve ese provider
//        (nunca `gated:true` habiendo un candidato libre más abajo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dispatch = require('../agent-launcher/dispatch-with-fallback');

// pipelineDir temporal: skill telegram-commander con la cadena real del issue.
function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain4353-'));
    const models = {
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7', credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex': { launcher: 'codex', model: 'gpt-5-codex', credentials_env: ['OPENAI_API_KEY'] },
            'gemini-google': { launcher: 'gemini', model: 'gemini-2.5-pro', credentials_env: ['GEMINI_API_KEY'] },
            cerebras: { launcher: 'cerebras', model: 'gpt-oss-120b', credentials_env: ['CEREBRAS_API_KEY'] },
            'nvidia-nim': { launcher: 'nvidia', model: 'deepseek-v4', credentials_env: ['NVIDIA_API_KEY'] },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                fallbacks: [
                    { provider: 'openai-codex' },
                    { provider: 'gemini-google' },
                    { provider: 'cerebras' },
                    { provider: 'nvidia-nim' },
                ],
            },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const primaryResolver = () => ({ provider: 'anthropic', model: 'claude-opus-4-7', source: 'primary' });
const providerHandlerResolver = (name) => ({ name, providerDef: { launcher: name } });
const silentNotify = () => {};

// Todas las credenciales presentes en el env del spawn (aislado): la exclusión
// de un provider NO debe deberse a falta de credencial en este escenario.
const fullCredsEnv = {
    OPENAI_API_KEY: 'real-oai-key',
    GEMINI_API_KEY: 'real-gemini-key',
    CEREBRAS_API_KEY: 'real-cerebras-key',
    NVIDIA_API_KEY: 'real-nvidia-key',
};

// quotaModule que gatea un conjunto arbitrario de providers.
function quotaGating(gatedSet) {
    const set = new Set(gatedSet);
    return {
        shouldGateSpawn(_skill, { provider }) { return set.has(provider); },
        sanitizeRawExcerpt: (s) => String(s || ''),
    };
}

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — el escenario exacto del incidente: primario + 3 eslabones
// gated, sólo NVIDIA sano al final de la cadena → se elige NVIDIA.
// -----------------------------------------------------------------------------
test('#4353 CA-1/CA-2 — primario+codex+gemini+cerebras gated, NVIDIA sano → walk llega a NVIDIA', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander',
            issue: 4353,
            pipelineDir: dir,
            quotaModule: quotaGating(['anthropic', 'openai-codex', 'gemini-google', 'cerebras']),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: fullCredsEnv,
        });
        assert.equal(r.gated, false, 'NO debe declarar indisponibilidad total con un provider sano disponible');
        assert.equal(r.source, 'fallback');
        assert.equal(r.provider, 'nvidia-nim', 'debe recorrer toda la cadena hasta el eslabón sano');
        // La cadena evaluada debe incluir TODOS los eslabones intentados, no
        // frenarse en el segundo (openai-codex).
        assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-2 — con el primer eslabón sano, se elige ese (no hace falta agotar la
// cadena). Prueba la cara complementaria: no se salta providers sanos.
// -----------------------------------------------------------------------------
test('#4353 CA-2 — sólo el primario gated, Codex sano → se elige Codex (primer eslabón)', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander',
            issue: 4353,
            pipelineDir: dir,
            quotaModule: quotaGating(['anthropic']),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: fullCredsEnv,
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'openai-codex');
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-1 — SÓLO cuando toda la cadena está gated se declara all-gated. Es el
// límite legítimo: el mensaje de "fallaron todos" recién acá es honesto.
// -----------------------------------------------------------------------------
test('#4353 CA-1 — toda la cadena gated → gated:true con chainTried completo (indisponibilidad honesta)', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander',
            issue: 4353,
            pipelineDir: dir,
            quotaModule: quotaGating(['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: fullCredsEnv,
        });
        assert.equal(r.gated, true, 'con TODA la cadena gated, sí es indisponibilidad total');
        // La traza debe reflejar que se evaluó la cadena entera antes de rendirse.
        assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-3 (scope) — el flag de cuota es single-provider: gatear a Codex NO debe
// excluir a los demás. Un flag pegajoso en un provider no arrastra a la cadena.
// -----------------------------------------------------------------------------
test('#4353 CA-3 — flag scoped a Codex NO gatea al resto → se elige Gemini', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander',
            issue: 4353,
            pipelineDir: dir,
            // Sólo anthropic (primario) y codex gated; gemini/cerebras/nvidia sanos.
            quotaModule: quotaGating(['anthropic', 'openai-codex']),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: fullCredsEnv,
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'gemini-google', 'el gate de codex no debe arrastrar al resto de la cadena');
    } finally { cleanup(dir); }
});
