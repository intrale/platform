#!/usr/bin/env node
// =============================================================================
// runners/nvidia-nim-runner.js — Runner REST del provider NVIDIA NIM (#3791)
//
// A diferencia de Codex y Gemini (que exponen un CLI propio), NVIDIA NIM es una
// API REST drop-in OpenAI-compatible (`https://integrate.api.nvidia.com/v1`).
// No hay binario que spawnear, así que este runner ES el "CLI": el adapter
// `providers/nvidia-nim.js` lo invoca con `node nvidia-nim-runner.js <args>`,
// hace la llamada HTTP y emite a stdout UN ÚNICO objeto JSON (mismo patrón que
// Gemini con `-o json`), que `parseTokensFromLog`/`detectQuotaExhausted` del
// adapter leen del log.
//
// Contrato de argv (lo arma `buildSpawn` del adapter, traduciendo los args
// estilo Claude del pulpo):
//   --model <id>            modelo NVIDIA (ej: deepseek-ai/deepseek-v4-pro)
//   --system-file <path>    archivo con el system prompt (opcional)
//   --prompt <text>         prompt del usuario
//   --max-tokens <n>        cap de salida (opcional, default 4096)
//
// Auth: API key free-tier en env `NVIDIA_NIM_API_KEY` (la hidrata
// `lib/credentials.js` desde ~/.claude/secrets/credentials.json al boot del
// pulpo y se propaga por el env del spawn). Fallback: si no está en env, el
// runner intenta cargarla con el loader canónico (robustez en ejecución suelta).
//
// Salida stdout (éxito): objeto OpenAI chat-completion tal cual lo devuelve
// NVIDIA (`{ id, model, choices:[...], usage:{...} }`) — el adapter parsea
// `usage` para los tokens.
// Salida stdout (error): `{ error: { status, code, type, message } }` y exit 1
// — el adapter matchea el shape estructural contra la allowlist de cuota.
//
// Seguridad: la API key NUNCA se imprime. El endpoint es fijo (sin override por
// argv) para no abrir SSRF. Sin shell, sin require dinámico.
// =============================================================================
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT_HOST = 'integrate.api.nvidia.com';
const ENDPOINT_PATH = '/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-pro';
const DEFAULT_MAX_TOKENS = 4096;

// -----------------------------------------------------------------------------
// parseArgv — parser minimalista del contrato de argv (sin dependencias).
// -----------------------------------------------------------------------------
function parseArgv(argv) {
    const out = { model: null, systemFile: null, prompt: null, maxTokens: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--model') { out.model = argv[++i]; }
        else if (a === '--system-file') { out.systemFile = argv[++i]; }
        else if (a === '--prompt') { out.prompt = argv[++i]; }
        else if (a === '--max-tokens') { out.maxTokens = parseInt(argv[++i], 10); }
    }
    return out;
}

// -----------------------------------------------------------------------------
// resolveApiKey — env primero (lo hidrata el pulpo); fallback al loader canónico.
// -----------------------------------------------------------------------------
function resolveApiKey() {
    if (process.env.NVIDIA_NIM_API_KEY && process.env.NVIDIA_NIM_API_KEY.trim()) {
        return process.env.NVIDIA_NIM_API_KEY.trim();
    }
    // Fallback: cargar credentials.json directo (ejecución suelta / smoke local).
    try {
        const cred = require(path.join(__dirname, '..', '..', 'credentials.js'));
        cred.loadIntoEnv({ logger: () => {} });
        if (process.env.NVIDIA_NIM_API_KEY && process.env.NVIDIA_NIM_API_KEY.trim()) {
            return process.env.NVIDIA_NIM_API_KEY.trim();
        }
    } catch { /* no-op: reportamos abajo */ }
    return null;
}

// -----------------------------------------------------------------------------
// buildMessages — arma el array de mensajes OpenAI a partir del system file y
// el prompt del usuario. NVIDIA SÍ soporta rol `system` nativo (a diferencia de
// Gemini), así que no hace falta foldear el system al prompt.
// -----------------------------------------------------------------------------
function buildMessages(parsed) {
    const messages = [];
    if (parsed.systemFile) {
        let systemText = null;
        try { systemText = fs.readFileSync(parsed.systemFile, 'utf8'); } catch { systemText = null; }
        if (systemText && systemText.trim()) {
            messages.push({ role: 'system', content: systemText.trim() });
        }
    }
    messages.push({ role: 'user', content: typeof parsed.prompt === 'string' ? parsed.prompt : '' });
    return messages;
}

// -----------------------------------------------------------------------------
// callNvidia — POST al endpoint chat/completions. Resuelve con { status, json }.
// No streaming: queremos el `usage` consolidado en una sola respuesta (igual que
// el JSON único de Gemini). El timeout protege contra cuelgues de red.
// -----------------------------------------------------------------------------
function callNvidia({ apiKey, model, messages, maxTokens }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
            stream: false,
        });
        const req = https.request({
            host: ENDPOINT_HOST,
            path: ENDPOINT_PATH,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 120000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { json = { _raw: data.slice(0, 2000) }; }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('NVIDIA NIM request timeout (120s)')); });
        req.write(payload);
        req.end();
    });
}

// -----------------------------------------------------------------------------
// normalizeError — homogeneiza el shape de error de NVIDIA a campos
// estructurales que el detector de cuota del adapter sabe matchear. NVIDIA
// puede responder `{ error: {...} }`, `{ detail: "..." }`, o un body crudo.
// -----------------------------------------------------------------------------
function normalizeError(status, json) {
    const base = { status };
    if (json && typeof json === 'object') {
        if (json.error && typeof json.error === 'object') {
            return Object.assign(base, json.error);
        }
        if (typeof json.detail === 'string') {
            base.message = json.detail;
        } else if (json._raw) {
            base.message = json._raw;
        }
    }
    // Mapear el HTTP code a un `code`/`type` canónico cuando NVIDIA no lo da.
    if (status === 429 && !base.code) { base.code = 'rate_limit_exceeded'; }
    if (status === 402 && !base.code) { base.code = 'insufficient_quota'; }
    if (status === 401 && !base.code) { base.code = 'unauthorized'; }
    return base;
}

async function main() {
    const parsed = parseArgv(process.argv.slice(2));
    const apiKey = resolveApiKey();
    if (!apiKey) {
        process.stdout.write(JSON.stringify({
            error: { status: 0, code: 'no_credentials', message: 'NVIDIA_NIM_API_KEY ausente (env y credentials.json)' },
        }));
        process.exit(1);
        return;
    }

    const model = parsed.model || process.env.NVIDIA_NIM_MODEL || DEFAULT_MODEL;
    const messages = buildMessages(parsed);

    try {
        const { status, json } = await callNvidia({ apiKey, model, messages, maxTokens: parsed.maxTokens });
        if (status >= 200 && status < 300) {
            // Éxito: emitimos la respuesta OpenAI tal cual (el adapter parsea `usage`).
            process.stdout.write(JSON.stringify(json));
            process.exit(0);
            return;
        }
        // Error HTTP: shape de error normalizado para el detector de cuota.
        process.stdout.write(JSON.stringify({ error: normalizeError(status, json) }));
        process.exit(1);
    } catch (e) {
        process.stdout.write(JSON.stringify({
            error: { status: 0, code: 'network_error', message: e && e.message ? e.message : String(e) },
        }));
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { parseArgv, buildMessages, normalizeError, resolveApiKey };
