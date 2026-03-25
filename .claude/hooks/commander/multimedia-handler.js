// commander/multimedia-handler.js — Procesamiento multimedia (audio, vision, TTS)
// Responsabilidad: transcripción de audio, análisis de imágenes, text-to-speech
// Un fallo aquí NO debe tirar el poller principal
"use strict";

const https = require("https");

// ─── Configuración (inyectada desde el orchestrator) ─────────────────────────
let _config = {
    anthropicApiKey: null,
    openaiApiKey: null,
    elevenlabsApiKey: null,
    elevenlabsVoiceId: "pNInz6obpgDQGcFmaJgB",
    visionModel: "claude-haiku-4-5-20251001",
    transcriptionModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "ash",
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

// ─── OpenAI Transcription API ────────────────────────────────────────────────

function callOpenAITranscription(audioBuffer, filename) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        const parts = [];

        parts.push("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"model\"\r\n\r\n"
            + _config.transcriptionModel + "\r\n");

        parts.push("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"" + (filename || "audio.ogg") + "\"\r\n"
            + "Content-Type: audio/ogg\r\n\r\n");

        const header = Buffer.from(parts.join(""));
        const footer = Buffer.from("\r\n--" + boundary + "--\r\n");
        const body = Buffer.concat([header, audioBuffer, footer]);

        const req = https.request({
            hostname: "api.openai.com",
            path: "/v1/audio/transcriptions",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Authorization": "Bearer " + _config.openaiApiKey,
                "Content-Length": body.length
            },
            timeout: 60000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.error) {
                        reject(new Error("OpenAI Transcription: " + (r.error.message || JSON.stringify(r.error))));
                        return;
                    }
                    resolve(r.text || "(sin transcripción)");
                } catch (e) { reject(new Error("OpenAI parse error: " + e.message)); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("OpenAI Transcription timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── OpenAI TTS API ──────────────────────────────────────────────────────────

function callOpenAITTS(text) {
    return new Promise((resolve, reject) => {
        const truncated = text.length > 2000
            ? text.substring(0, 1950) + "... (respuesta truncada para audio)"
            : text;

        const body = JSON.stringify({
            model: _config.ttsModel,
            input: truncated,
            voice: _config.ttsVoice,
            instructions: "Hablás como un porteño de Buenos Aires, con tonada rioplatense auténtica. Usás 'vos' en vez de 'tú', decís 'dale', 'che', 'mirá', 'boludo' cuando viene al caso. El ritmo es el de una charla entre amigos en un bar — pausas naturales, énfasis expresivo, te reís si algo es gracioso. Sos inteligente pero cero formal, como un ingeniero argentino joven explicándole algo a un amigo. Nunca sonás como locutor ni como robot — sonás como un pibe real.",
            response_format: "opus"
        });

        const req = https.request({
            hostname: "api.openai.com",
            path: "/v1/audio/speech",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + _config.openaiApiKey,
                "Content-Length": Buffer.byteLength(body)
            },
            timeout: 60000
        }, (res) => {
            if (res.statusCode !== 200) {
                let d = "";
                res.on("data", (c) => d += c);
                res.on("end", () => reject(new Error("OpenAI TTS HTTP " + res.statusCode + ": " + d.substring(0, 200))));
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("OpenAI TTS timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── ElevenLabs TTS API ──────────────────────────────────────────────────────

function callElevenLabsTTS(text) {
    return new Promise((resolve, reject) => {
        const truncated = text.length > 2000
            ? text.substring(0, 1950) + "... (respuesta truncada para audio)"
            : text;

        const body = JSON.stringify({
            text: truncated,
            model_id: "eleven_multilingual_v2",
            output_format: "opus_48000_32"
        });

        const req = https.request({
            hostname: "api.elevenlabs.io",
            path: "/v1/text-to-speech/" + _config.elevenlabsVoiceId,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": _config.elevenlabsApiKey,
                "Content-Length": Buffer.byteLength(body)
            },
            timeout: 60000
        }, (res) => {
            if (res.statusCode !== 200) {
                let d = "";
                res.on("data", (c) => d += c);
                res.on("end", () => reject(new Error("ElevenLabs TTS HTTP " + res.statusCode + ": " + d.substring(0, 200))));
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("ElevenLabs TTS timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── TTS con fallback ────────────────────────────────────────────────────────

async function callTTS(text) {
    if (_config.elevenlabsApiKey) {
        try {
            _log("TTS: usando ElevenLabs (voice_id=" + _config.elevenlabsVoiceId + ")");
            return await callElevenLabsTTS(text);
        } catch (e) {
            _log("ElevenLabs TTS falló (" + e.message + ") — fallback a OpenAI");
            if (!_config.openaiApiKey) throw e;
        }
    }
    _log("TTS: usando OpenAI");
    return await callOpenAITTS(text);
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
    if (!_config.openaiApiKey) {
        await _tgApi.sendMessage("🎤 Audio recibido pero <b>multimedia no configurado</b>.\n\nConfigurá <code>openai_api_key</code> en telegram-config.json o la variable de entorno <code>OPENAI_API_KEY</code>.");
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
        const transcription = await callOpenAITranscription(file.buffer, filename);

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

        const result = await _cmdContext.executeClaudeQueued(transcription, [], { useSession: true, skill: null });
        const claudeResponse = extractClaudeResponse(result);

        // Si es voice y TTS disponible: responder SOLO con audio (sin eco, sin texto, sin imagen)
        // Asumimos que si el usuario envía audio es porque no puede mirar texto.
        if (isVoice && result.code === 0 && claudeResponse && (_config.elevenlabsApiKey || _config.openaiApiKey)) {
            try {
                _log("Generando TTS para respuesta (" + claudeResponse.length + " chars)");
                const audioBuffer = await callTTS(claudeResponse);
                await _tgApi.sendVoiceMessage(audioBuffer);
                _log("TTS enviado: " + audioBuffer.length + " bytes");
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
    callOpenAITranscription,
    callOpenAITTS,
    callElevenLabsTTS,
    callTTS,
    extractClaudeResponse,
    isDocumentImage,
    handlePhoto,
    handleVoiceOrAudio,
};
