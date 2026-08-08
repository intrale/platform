// commander/multimedia-handler.js — Procesamiento multimedia (audio, vision, TTS)
// Responsabilidad: transcripción de audio, análisis de imágenes, text-to-speech
// Un fallo aquí NO debe tirar el poller principal
//
// EP1-H2 (#3917): retiradas las rutas OpenAI pagas (STT/TTS). Este handler es
// código legacy del Commander pre-Pulpo (no lo referencia ningún módulo vivo);
// si llegara a revivir, transcribe con whisper local y narra con Edge TTS —
// ambos motores gratuitos resueltos por `.pipeline/`. Cero `Bearer` de OpenAI.
"use strict";

const https = require("https");
const path = require("path");

// Raíz del pipeline (motores gratuitos viven acá). Desde
// .claude/hooks/commander/ subimos 3 niveles hasta el repo y entramos a .pipeline/.
const PIPELINE_DIR = path.resolve(__dirname, "..", "..", "..", ".pipeline");
function liveMultimedia() { return require(path.join(PIPELINE_DIR, "multimedia.js")); }
function whisperLocalLib() { return require(path.join(PIPELINE_DIR, "lib", "whisper-local.js")); }

// ─── Configuración (inyectada desde el orchestrator) ─────────────────────────
let _config = {
    anthropicApiKey: null,
    visionModel: "claude-haiku-4-5-20251001",
    audioMaxDurationSec: 300,
};

let _log = console.log;
let _tgApi = null;   // referencia a telegram-api.js
let _cmdContext = null; // referencia al contexto de comandos (activeCommands, executeClaudeQueued, etc.)

function init(config, tgApi, cmdContext, logFn) {
    Object.assign(_config, config);
    _tgApi = tgApi;
    _cmdContext = cmdContext;
    if (logFn) _log = logFn;
}

// ─── Anthropic Vision API ────────────────────────────────────────────────────

function callAnthropicVision(base64Image, mediaType, textPrompt) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: _config.visionModel,
            max_tokens: 2048,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mediaType,
                            data: base64Image
                        }
                    },
                    {
                        type: "text",
                        text: textPrompt || "Describí esta imagen en detalle. Si contiene texto, transcribilo."
                    }
                ]
            }]
        });

        const req = https.request({
            hostname: "api.anthropic.com",
            path: "/v1/messages",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": _config.anthropicApiKey,
                "anthropic-version": "2023-06-01",
                "Content-Length": Buffer.byteLength(body)
            },
            timeout: 60000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.error) {
                        reject(new Error("Anthropic API: " + (r.error.message || JSON.stringify(r.error))));
                        return;
                    }
                    const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
                    resolve(text || "(sin respuesta)");
                } catch (e) { reject(new Error("Anthropic parse error: " + e.message)); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Anthropic API timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── Transcripción de audio (whisper local, motor gratuito) ──────────────────
// EP1-H2 (#3917): reemplaza la antigua ruta paga a `api.openai.com`. Transcribe
// 100% offline con whisper local (`.pipeline/lib/whisper-local.js`). Sin Bearer,
// sin cuota muerta, sin latencia previa al fallback. Lanza un Error con motivo
// accionable cuando el motor local no está disponible o falla, para que el
// caller degrade a texto.
async function transcribeAudioLocal(audioBuffer, filename) {
    const whisper = whisperLocalLib();
    if (!whisper.isAvailable()) {
        throw new Error("whisper local no está instalado (pip install -U openai-whisper)");
    }
    const res = await whisper.transcribeLocal({ audioBuffer, logger: _log });
    if (!res || !res.ok) {
        const kind = res ? res.errorKind : "unknown";
        const raw = res && res.raw ? (": " + res.raw) : "";
        throw new Error("whisper local falló (" + kind + ")" + raw);
    }
    return res.text || "(sin transcripción)";
}

// ─── TTS (Edge, motor gratuito) ──────────────────────────────────────────────

// Partir texto en chunks para TTS respetando límites de oraciones
function splitTextForTTS(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > maxChars && current.length > 0) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current = current ? current + ' ' + sentence : sentence;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    // Si algún chunk individual sigue siendo más largo (oración gigante), forzar corte por palabras
    const result = [];
    for (const chunk of chunks) {
        if (chunk.length <= maxChars) { result.push(chunk); continue; }
        const words = chunk.split(/\s+/);
        let part = '';
        for (const word of words) {
            if ((part + ' ' + word).length > maxChars && part.length > 0) {
                result.push(part.trim());
                part = word;
            } else {
                part = part ? part + ' ' + word : word;
            }
        }
        if (part.trim()) result.push(part.trim());
    }
    return result;
}

async function callTTS(text) {
    // EP1-H2 (#3917): narración 100% por Edge TTS (motor oficial y gratuito),
    // delegada a `.pipeline/multimedia.js`. Ese módulo aplica el sanitizador
    // pre-TTS (#2958) que redacta secretos antes de salir al endpoint de
    // Microsoft, así que esta ruta hereda esa protección sin duplicar lógica.
    _log("TTS: usando Edge (motor único)");
    const audioBuffer = await liveMultimedia().textToSpeech(text);
    if (!audioBuffer) {
        throw new Error("Edge TTS no devolvió audio");
    }
    return audioBuffer;
}

// ─── Extracción de respuesta de Claude ───────────────────────────────────────

function extractClaudeResponse(result) {
    if (!result || result.code !== 0) {
        _log("extractClaudeResponse: skip (code=" + (result ? result.code : "null") + ")");
        return null;
    }
    if (!result.stdout) {
        _log("extractClaudeResponse: stdout vacio — Claude no emitio evento result ni texto");
        return null;
    }
    try {
        const json = JSON.parse(result.stdout);
        const text = json.result || json.text || json.content || null;
        if (!text) {
            _log("extractClaudeResponse: JSON parseado pero sin result/text/content: " + result.stdout.substring(0, 200));
        }
        return text;
    } catch (e) {
        // stdout no es JSON — usar como texto plano
        return result.stdout || null;
    }
}

// ─── Detección de imágenes en documentos ─────────────────────────────────────

function isDocumentImage(doc) {
    if (!doc || !doc.mime_type) return false;
    return doc.mime_type.startsWith("image/");
}

// ─── Handlers de alto nivel ──────────────────────────────────────────────────

async function handlePhoto(msg) {
    if (!_config.anthropicApiKey) {
        await _tgApi.sendMessage("📷 Imagen recibida pero <b>multimedia no configurado</b>.\n\nConfigurá <code>anthropic_api_key</code> en telegram-config.json o la variable de entorno <code>ANTHROPIC_API_KEY</code>.");
        return;
    }

    const photos = msg.photo;
    const bestPhoto = photos[photos.length - 1];
    const caption = msg.caption || "";

    await _tgApi.sendMessage("📷 Procesando imagen" + (caption ? " con caption: <code>" + _tgApi.escHtml(caption.substring(0, 80)) + "</code>" : "") + "...");

    try {
        const file = await _tgApi.telegramDownloadFile(bestPhoto.file_id);
        if (!file) throw new Error("No se pudo descargar la imagen");

        const ext = (file.filePath || "").split(".").pop().toLowerCase();
        const mediaTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
        const mediaType = mediaTypes[ext] || "image/jpeg";

        const base64 = file.buffer.toString("base64");
        _log("Imagen descargada: " + file.filePath + " (" + file.buffer.length + " bytes, " + mediaType + ")");

        const prompt = caption
            ? caption
            : "Describí esta imagen en detalle. Si contiene texto, transcribilo. Si es un screenshot de código o error, analizalo.";

        const response = await callAnthropicVision(base64, mediaType, prompt);

        await _tgApi.sendLongMessage("📷 <b>Análisis de imagen</b>\n\n" + _tgApi.escHtml(response));

    } catch (e) {
        _log("Error procesando imagen: " + e.message);
        await _tgApi.sendMessage("❌ Error procesando imagen: <code>" + _tgApi.escHtml(e.message) + "</code>");
    }
}

async function handleVoiceOrAudio(msg) {
    // EP1-H2 (#3917): la transcripción corre en whisper local (motor gratuito);
    // ya no se exige ninguna API key paga. Si el binario local no está instalado
    // avisamos en vez de intentar un motor inexistente.
    if (!whisperLocalLib().isAvailable()) {
        await _tgApi.sendMessage("🎤 Audio recibido pero el <b>motor de transcripción local (whisper) no está instalado</b>.\n\nInstalalo con <code>pip install -U openai-whisper</code> y repetímelo, o mandámelo por texto.");
        return;
    }

    const voice = msg.voice || msg.audio;
    const isVoice = !!msg.voice;
    const duration = voice.duration || 0;

    if (duration > _config.audioMaxDurationSec) {
        await _tgApi.sendMessage("🎤 Audio de <b>" + Math.round(duration / 60) + " min</b> excede el límite de 5 minutos. Enviá un mensaje más corto.");
        return;
    }

    try {
        const file = await _tgApi.telegramDownloadFile(voice.file_id);
        if (!file) throw new Error("No se pudo descargar el audio");

        _log("Audio descargado: " + file.filePath + " (" + file.buffer.length + " bytes, " + duration + "s)");

        const filename = (file.filePath.split("/").pop() || "audio.ogg").replace(/\.oga$/, ".ogg");
        const transcription = await transcribeAudioLocal(file.buffer, filename);

        _log("Transcripción: " + transcription.substring(0, 200));

        // Verificar límite de comandos paralelos
        if (_cmdContext.isCommandBusy()) {
            const { getPendingQuestions } = require("../pending-questions");
            const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
            if (pendingPerms.length > 0) {
                const q = pendingPerms[pendingPerms.length - 1];
                const { matchPermissionKeyword, handleTextPermissionReply } = require("./command-dispatcher");
                const permAction = matchPermissionKeyword(transcription);
                if (permAction) {
                    await handleTextPermissionReply(q, permAction, _tgApi.getChatId());
                    return;
                }
            }
            await _tgApi.sendMessage("⏳ Límite de " + _cmdContext.MAX_PARALLEL_COMMANDS + " comandos paralelos alcanzado. Esperá que termine alguno.\n🎤 <i>" + _tgApi.escHtml(transcription.substring(0, 200)) + "</i>");
            return;
        }

        // Marcar flag de voz ANTES de ejecutar Claude para que stop-notify no envíe imagen
        const voiceFlagFile = require("path").join(
            process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform",
            ".claude", "hooks", "voice-response-active.flag"
        );
        if (isVoice) {
            try { require("fs").writeFileSync(voiceFlagFile, String(Date.now()), "utf8"); } catch (e) {}
        }

        const result = await _cmdContext.executeClaudeQueued(transcription, [], { useSession: true, skill: null });
        const claudeResponse = extractClaudeResponse(result);

        // Si es voice y TTS disponible: responder SOLO con audio (sin eco, sin texto, sin imagen)
        // Asumimos que si el usuario envía audio es porque no puede mirar texto.
        if (isVoice && result.code === 0 && claudeResponse) {
            try {
                const TTS_CHUNK_SIZE = 3800; // Margen holgado por chunk para Edge TTS
                const chunks = splitTextForTTS(claudeResponse, TTS_CHUNK_SIZE);
                _log("Generando TTS para respuesta (" + claudeResponse.length + " chars, " + chunks.length + " parte(s))");

                for (let i = 0; i < chunks.length; i++) {
                    const chunkText = chunks.length > 1
                        ? "Parte " + (i + 1) + " de " + chunks.length + ". " + chunks[i]
                        : chunks[i];
                    const audioBuffer = await callTTS(chunkText);
                    await _tgApi.sendVoiceMessage(audioBuffer);
                    _log("TTS parte " + (i + 1) + "/" + chunks.length + " enviada: " + audioBuffer.length + " bytes");
                }
            } catch (ttsErr) {
                _log("Error generando TTS, fallback a texto: " + ttsErr.message);
                await _cmdContext.sendResult("🎤 Voz", result);
            }
        } else {
            // Sin TTS disponible o error: enviar respuesta como texto
            await _cmdContext.sendResult("🎤 Voz", result);
        }

    } catch (e) {
        _log("Error procesando audio: " + e.message);
        await _tgApi.sendMessage("❌ Error procesando audio: <code>" + _tgApi.escHtml(e.message) + "</code>");
    }
}

module.exports = {
    init,
    callAnthropicVision,
    transcribeAudioLocal,
    callTTS,
    splitTextForTTS,
    extractClaudeResponse,
    isDocumentImage,
    handlePhoto,
    handleVoiceOrAudio,
};
