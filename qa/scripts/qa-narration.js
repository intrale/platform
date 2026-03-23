#!/usr/bin/env node
// qa-narration.js — Genera audio TTS narrado con OpenAI gpt-4o-mini-tts y lo mergea con video QA
//
// Uso:
//   node qa/scripts/qa-narration.js \
//     --video qa/recordings/maestro-shard-5554.mp4 \
//     --flows-dir .maestro/flows \
//     --output qa/recordings/maestro-shard-5554-narrated.mp4
//
// Config:
//   - OPENAI_API_KEY env var (obligatorio para narración)
//   - QA_NARRATION=true env var para activar (default: true si hay API key)
//   - Modelo: gpt-4o-mini-tts, voz: ash (misma config que Telegram)
//
// Degradación graceful:
//   - Sin OPENAI_API_KEY → sale con warning, sin error, sin bloquear el pipeline
//   - Sin FFmpeg → genera audio .opus suelto sin merge
//   - Sin archivos .narration.json → sale silenciosamente
//
// Formato audio: opus (mismo que el TTS de Telegram)
// Dependencias: Node.js nativo (https, fs, child_process, os)

"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const os = require("os");

// ─── Constantes TTS ──────────────────────────────────────────────────────────

const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "ash";
const TTS_INSTRUCTIONS = "Narrás un video de prueba de software. Tu tono es claro, profesional pero amigable, como un ingeniero argentino explicando qué está pasando en pantalla. Pausas naturales entre oraciones. Ritmo moderado para que el espectador pueda seguir la acción.";

// ─── Config ──────────────────────────────────────────────────────────────────

const HOOKS_DIR = path.resolve(__dirname, "../../.claude/hooks");
const CONFIG_PATH = path.join(HOOKS_DIR, "telegram-config.json");

function loadOpenAIKey() {
    // Prioridad: env var > telegram-config.json
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return cfg.openai_api_key || cfg.openaiApiKey || null;
    } catch (e) {
        return null;
    }
}

// ─── FFmpeg path discovery ────────────────────────────────────────────────────

function findFFmpeg() {
    try {
        spawnSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 5000 });
        return "ffmpeg";
    } catch (e) { /* not in PATH */ }

    const wingetBase = path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Packages");
    try {
        const dirs = fs.readdirSync(wingetBase).filter(d => d.startsWith("Gyan.FFmpeg"));
        for (const dir of dirs) {
            const binDir = path.join(wingetBase, dir);
            const subDirs = fs.readdirSync(binDir);
            for (const sub of subDirs) {
                const candidate = path.join(binDir, sub, "bin", "ffmpeg.exe");
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    } catch (e) { /* winget dir not found */ }

    return null;
}

function findFFprobe(ffmpegPath) {
    if (!ffmpegPath) return null;
    return ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { video: "", flowsDir: "", output: "" };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--video": result.video = args[++i] || ""; break;
            case "--flows-dir": result.flowsDir = args[++i] || ""; break;
            case "--output": result.output = args[++i] || ""; break;
        }
    }
    return result;
}

// ─── OpenAI TTS API ──────────────────────────────────────────────────────────

function callOpenAITTS(text, apiKey) {
    return new Promise((resolve, reject) => {
        const truncated = text.length > 2000
            ? text.substring(0, 1950) + "... (truncado)"
            : text;

        const body = JSON.stringify({
            model: TTS_MODEL,
            input: truncated,
            voice: TTS_VOICE,
            instructions: TTS_INSTRUCTIONS,
            response_format: "opus"
        });

        const req = https.request({
            hostname: "api.openai.com",
            path: "/v1/audio/speech",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey,
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
        req.on("timeout", () => { req.destroy(); reject(new Error("OpenAI TTS timeout (60s)")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── Video/audio duration via ffprobe ────────────────────────────────────────

function getDuration(filePath, ffprobePath) {
    if (!ffprobePath) return null;
    try {
        const result = spawnSync(ffprobePath, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            filePath
        ], { stdio: "pipe", timeout: 10000 });

        const duration = parseFloat(result.stdout.toString().trim());
        if (!isNaN(duration) && duration > 0) return duration;
    } catch (e) { /* fallback */ }
    return null;
}

// ─── Narration files discovery ────────────────────────────────────────────────

function findNarrationFiles(flowsDir) {
    const narrationFiles = [];
    try {
        const files = fs.readdirSync(flowsDir);
        for (const file of files) {
            if (file.endsWith(".narration.json")) {
                const fullPath = path.join(flowsDir, file);
                try {
                    const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
                    narrationFiles.push({ file: fullPath, data });
                } catch (e) {
                    console.error("[qa-narration] Error parseando " + file + ": " + e.message);
                }
            }
        }
    } catch (e) {
        console.error("[qa-narration] Error leyendo flows dir: " + e.message);
    }
    return narrationFiles;
}

// ─── Generar segmentos de narración a partir de flows ────────────────────────
// Fallback: si no hay .narration.json, generar texto genérico desde los YAML de Maestro

function buildSegmentsFromFlows(flowsDir) {
    const segments = [];
    try {
        const files = fs.readdirSync(flowsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
        files.sort();
        for (let i = 0; i < files.length; i++) {
            const flowName = files[i].replace(/\.(yaml|yml)$/, "").replace(/[-_]/g, " ");
            segments.push({
                text: "Caso " + (i + 1) + ": " + flowName + ".",
                delay_ms: 0
            });
        }
    } catch (e) { /* sin flows, sin narración */ }
    return segments;
}

// ─── Construir pista de audio completa con ffmpeg ────────────────────────────

function buildNarrationTrack(clipFiles, videoDuration, tmpDir, ffmpegPath) {
    if (clipFiles.length === 0) return null;

    const fullTrackPath = path.join(tmpDir, "narration-full.opus");

    // Construir filter_complex con adelay para posicionar cada clip en su timestamp
    // Formato: ffmpeg -i clip1.opus -i clip2.opus ... -filter_complex "[0]adelay=0|0[d0];[1]adelay=5000|5000[d1];...;[d0][d1]...amix=inputs=N[out]" -map [out] out.opus
    const inputs = clipFiles.map(c => ["-i", c.path]).flat();
    const filterParts = [];
    const mixInputs = [];

    for (let i = 0; i < clipFiles.length; i++) {
        const delayMs = Math.round(clipFiles[i].startTime * 1000);
        filterParts.push("[" + i + ":a]adelay=" + delayMs + "|" + delayMs + ",aformat=sample_rates=24000:channel_layouts=mono[d" + i + "]");
        mixInputs.push("[d" + i + "]");
    }

    const fullFilter = filterParts.join(";") + ";" +
        mixInputs.join("") + "amix=inputs=" + clipFiles.length + ":duration=first:dropout_transition=0[out]";

    const result = spawnSync(ffmpegPath, [
        ...inputs,
        "-filter_complex", fullFilter,
        "-map", "[out]",
        "-t", String(videoDuration),
        "-y",
        fullTrackPath
    ], { stdio: "pipe", timeout: 120000 });

    if (result.status === 0 && fs.existsSync(fullTrackPath)) {
        console.log("[qa-narration] Pista de audio construida (" + videoDuration.toFixed(1) + "s)");
        return fullTrackPath;
    }

    const stderr = result.stderr ? result.stderr.toString().slice(-500) : "unknown error";
    console.error("[qa-narration] FFmpeg mix falló: " + stderr);

    // Fallback: concatenar clips secuencialmente con pausa proporcional
    return buildSimpleConcatenation(clipFiles, videoDuration, tmpDir, ffmpegPath);
}

function buildSimpleConcatenation(clipFiles, videoDuration, tmpDir, ffmpegPath) {
    const fullTrackPath = path.join(tmpDir, "narration-simple.opus");

    const totalClipDuration = clipFiles.reduce((sum, c) => sum + (c.duration || 3), 0);
    const totalPause = Math.max(0, videoDuration - totalClipDuration);
    const pausePerGap = clipFiles.length > 1 ? totalPause / (clipFiles.length - 1) : 0;
    const pauseMs = Math.min(Math.round(pausePerGap * 1000), 8000);

    const inputs = clipFiles.map(c => ["-i", c.path]).flat();
    const filterParts = clipFiles.map((_, i) => {
        if (i < clipFiles.length - 1 && pauseMs > 0) {
            return "[" + i + ":a]apad=pad_dur=" + pauseMs + "ms[p" + i + "]";
        }
        return "[" + i + ":a]acopy[p" + i + "]";
    });
    const concatInputs = clipFiles.map((_, i) => "[p" + i + "]").join("");
    const fullFilter = filterParts.join(";") + ";" + concatInputs + "concat=n=" + clipFiles.length + ":v=0:a=1[out]";

    const result = spawnSync(ffmpegPath, [
        ...inputs,
        "-filter_complex", fullFilter,
        "-map", "[out]",
        "-t", String(videoDuration),
        "-y",
        fullTrackPath
    ], { stdio: "pipe", timeout: 120000 });

    if (result.status === 0 && fs.existsSync(fullTrackPath)) {
        console.log("[qa-narration] Audio concatenado (fallback simple con pausas)");
        return fullTrackPath;
    }

    console.error("[qa-narration] Fallback concatenación también falló");
    return null;
}

// ─── Merge video + audio ──────────────────────────────────────────────────────

function mergeVideoAudio(videoPath, audioPath, outputPath, ffmpegPath) {
    console.log("[qa-narration] Mergeando video + audio...");

    const result = spawnSync(ffmpegPath, [
        "-i", videoPath,
        "-i", audioPath,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-map", "0:v",
        "-map", "1:a",
        "-shortest",
        "-y",
        outputPath
    ], { stdio: "pipe", timeout: 120000 });

    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString().slice(-500) : "unknown error";
        throw new Error("FFmpeg merge falló: " + stderr);
    }

    return fs.existsSync(outputPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();

    // Verificar QA_NARRATION env var
    const narrationEnabled = process.env.QA_NARRATION !== "false";
    if (!narrationEnabled) {
        console.log("[qa-narration] QA_NARRATION=false — narración desactivada");
        process.exit(0);
    }

    if (!args.video) {
        console.error("[qa-narration] Uso: node qa-narration.js --video <path> --flows-dir <path> --output <path>");
        process.exit(1);
    }

    if (!fs.existsSync(args.video)) {
        console.error("[qa-narration] Video no encontrado: " + args.video);
        process.exit(1);
    }

    // Verificar API key (graceful degradation)
    const openaiApiKey = loadOpenAIKey();
    if (!openaiApiKey) {
        console.warn("[qa-narration] OPENAI_API_KEY no configurada — saltando narración (solo video mudo)");
        process.exit(0);
    }

    const ffmpegPath = findFFmpeg();
    if (!ffmpegPath) {
        console.warn("[qa-narration] FFmpeg no encontrado — se guardará audio .opus suelto sin merge");
        console.warn("[qa-narration] Instalar: winget install Gyan.FFmpeg");
    } else {
        console.log("[qa-narration] FFmpeg: " + ffmpegPath);
    }

    const ffprobePath = findFFprobe(ffmpegPath);

    console.log("[qa-narration] TTS: " + TTS_MODEL + " (voz: " + TTS_VOICE + ")");

    // Encontrar archivos de narración o generar desde flows
    const flowsDir = args.flowsDir || path.resolve(__dirname, "../../.maestro/flows");
    const narrationFiles = findNarrationFiles(flowsDir);

    let allSegments = [];

    if (narrationFiles.length > 0) {
        for (const nf of narrationFiles) {
            if (nf.data.segments) {
                for (const seg of nf.data.segments) {
                    allSegments.push({ flow: nf.data.flow || "", ...seg });
                }
            }
        }
        console.log("[qa-narration] " + narrationFiles.length + " archivo(s) .narration.json — " + allSegments.length + " segmentos");
    } else {
        // Fallback: generar desde nombres de flows YAML
        allSegments = buildSegmentsFromFlows(flowsDir);
        if (allSegments.length === 0) {
            console.log("[qa-narration] No hay segmentos de narración — saltando");
            process.exit(0);
        }
        console.log("[qa-narration] Narración generada desde " + allSegments.length + " flow(s) YAML");
    }

    // Obtener duración del video
    const videoDuration = getDuration(args.video, ffprobePath) || 60;
    console.log("[qa-narration] Duración del video: " + videoDuration.toFixed(1) + "s");

    // Calcular timestamps: distribuir uniformemente si no hay delay_ms explícito
    const segmentInterval = videoDuration / (allSegments.length + 1);
    const timedSegments = allSegments.map((seg, idx) => ({
        ...seg,
        startTime: typeof seg.start_ms === "number"
            ? seg.start_ms / 1000
            : segmentInterval * (idx + 1) + (seg.delay_ms || 0) / 1000
    }));

    // Crear directorio temporal
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-narration-"));

    try {
        // Generar clips de audio TTS para cada segmento
        console.log("[qa-narration] Generando " + timedSegments.length + " clip(s) TTS con OpenAI...");
        const clipFiles = [];

        for (let i = 0; i < timedSegments.length; i++) {
            const seg = timedSegments[i];
            const clipPath = path.join(tmpDir, "paso_" + (i + 1) + ".opus");
            const progressLabel = "  Paso " + (i + 1) + "/" + timedSegments.length;

            try {
                const audioBuffer = await callOpenAITTS(seg.text, openaiApiKey);
                fs.writeFileSync(clipPath, audioBuffer);
                const clipDuration = getDuration(clipPath, ffprobePath) || 3;
                clipFiles.push({
                    path: clipPath,
                    startTime: seg.startTime,
                    duration: clipDuration
                });
                process.stdout.write(progressLabel + " OK (" + clipDuration.toFixed(1) + "s) → " + seg.text.substring(0, 60) + "\n");
            } catch (e) {
                console.error(progressLabel + " FALLÓ: " + e.message);
                // Continuar con el siguiente clip
            }
        }

        if (clipFiles.length === 0) {
            console.error("[qa-narration] No se pudo generar ningún clip de audio");
            process.exit(0);
        }

        const outputPath = args.output || args.video.replace(/\.mp4$/, "-narrated.mp4");

        if (ffmpegPath) {
            // Construir pista de audio completa
            const audioTrackPath = buildNarrationTrack(clipFiles, videoDuration, tmpDir, ffmpegPath);

            if (audioTrackPath) {
                try {
                    mergeVideoAudio(args.video, audioTrackPath, outputPath, ffmpegPath);
                    const stats = fs.statSync(outputPath);
                    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                    console.log("[qa-narration] ✓ Video narrado: " + outputPath + " (" + sizeMB + "MB)");
                } catch (e) {
                    console.error("[qa-narration] Merge falló: " + e.message);
                    // Guardar audio suelto como fallback
                    const audioFallback = outputPath.replace(/\.mp4$/, "-narration.opus");
                    fs.copyFileSync(audioTrackPath, audioFallback);
                    console.log("[qa-narration] Audio guardado por separado: " + audioFallback);
                }
            }
        } else {
            // Sin FFmpeg: guardar el primer clip como referencia
            if (clipFiles.length > 0) {
                const audioFallback = (args.output || args.video).replace(/\.mp4$/, "-narration.opus");
                fs.copyFileSync(clipFiles[0].path, audioFallback);
                console.warn("[qa-narration] FFmpeg no disponible. Clip de audio guardado: " + audioFallback);
            }
        }

    } finally {
        // Limpiar archivos temporales
        try {
            const tmpFiles = fs.readdirSync(tmpDir);
            for (const f of tmpFiles) fs.unlinkSync(path.join(tmpDir, f));
            fs.rmdirSync(tmpDir);
        } catch (e) { /* cleanup best-effort */ }
    }
}

main().catch(e => {
    console.error("[qa-narration] Error fatal: " + e.message);
    process.exit(0); // salida limpia para no bloquear pipeline
});
