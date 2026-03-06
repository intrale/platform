#!/usr/bin/env node
// qa-narration.js — Genera audio TTS narrado y lo mergea con video de evidencia QA
//
// Uso:
//   node qa/scripts/qa-narration.js \
//     --video qa/recordings/maestro-shard-5554.mp4 \
//     --flows-dir .maestro/flows \
//     --output qa/recordings/maestro-shard-5554-narrated.mp4
//
// Dependencias externas:
//   - Python edge-tts: pip install edge-tts (TTS gratuito via Microsoft Edge)
//   - FFmpeg: winget install Gyan.FFmpeg (merge video + audio)
//
// Si FFmpeg no esta disponible, genera el audio MP3 suelto y loguea warning.
// Si edge-tts no esta disponible, sale con warning sin bloquear el pipeline.
//
// Config TTS: lee de .claude/hooks/telegram-config.json campo "tts"

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const os = require("os");

// --- Config ---

const HOOKS_DIR = path.resolve(__dirname, "../../.claude/hooks");
const CONFIG_PATH = path.join(HOOKS_DIR, "telegram-config.json");

const DEFAULT_VOICE = "es-AR-TomasNeural";
const DEFAULT_RATE = "+0%";
const DEFAULT_VOLUME = "+0%";

let TTS_CONFIG = { voice: DEFAULT_VOICE, rate: DEFAULT_RATE, volume: DEFAULT_VOLUME };
try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.tts) {
        TTS_CONFIG.voice = cfg.tts.voice || DEFAULT_VOICE;
        TTS_CONFIG.rate = cfg.tts.rate || DEFAULT_RATE;
        TTS_CONFIG.volume = cfg.tts.volume || DEFAULT_VOLUME;
    }
} catch (e) {
    // Config no disponible, usar defaults
}

// --- FFmpeg path discovery ---

function findFFmpeg() {
    // Intentar ffmpeg en PATH
    try {
        execSync("ffmpeg -version", { stdio: "pipe", timeout: 5000 });
        return "ffmpeg";
    } catch (e) { /* not in PATH */ }

    // Buscar en ubicaciones conocidas de winget
    const wingetBase = path.join(
        os.homedir(),
        "AppData/Local/Microsoft/WinGet/Packages"
    );
    try {
        const dirs = fs.readdirSync(wingetBase).filter(d => d.startsWith("Gyan.FFmpeg"));
        for (const dir of dirs) {
            const binDir = path.join(wingetBase, dir);
            // Buscar recursivamente el bin/ffmpeg.exe
            const subDirs = fs.readdirSync(binDir);
            for (const sub of subDirs) {
                const candidate = path.join(binDir, sub, "bin", "ffmpeg.exe");
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    } catch (e) { /* winget dir not found */ }

    return null;
}

// --- Argument parsing ---

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

// --- Video duration via FFmpeg (ffprobe) ---

function getVideoDuration(videoPath, ffmpegPath) {
    if (!ffmpegPath) return 60; // default 60s si no hay ffmpeg

    // ffprobe esta junto a ffmpeg
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
    try {
        const result = spawnSync(ffprobePath, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            videoPath
        ], { stdio: "pipe", timeout: 10000 });

        const duration = parseFloat(result.stdout.toString().trim());
        if (!isNaN(duration) && duration > 0) return duration;
    } catch (e) { /* fallback */ }

    return 60;
}

// --- Find narration files matching flows in the video ---

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
        console.error("[qa-narration] Error leyendo directorio de flows: " + e.message);
    }
    return narrationFiles;
}

// --- Generate TTS audio for a single text segment ---

function generateTTSSegment(text, outputPath) {
    const result = spawnSync("python", [
        "-m", "edge_tts",
        "--voice", TTS_CONFIG.voice,
        "--rate", TTS_CONFIG.rate,
        "--volume", TTS_CONFIG.volume,
        "--text", text,
        "--write-media", outputPath
    ], { stdio: "pipe", timeout: 30000 });

    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString() : "unknown error";
        throw new Error("edge-tts fallo: " + stderr);
    }

    return fs.existsSync(outputPath);
}

// --- Get audio duration via ffprobe ---

function getAudioDuration(audioPath, ffmpegPath) {
    if (!ffmpegPath) return 3; // estimate 3s per segment

    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
    try {
        const result = spawnSync(ffprobePath, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audioPath
        ], { stdio: "pipe", timeout: 5000 });

        const duration = parseFloat(result.stdout.toString().trim());
        if (!isNaN(duration) && duration > 0) return duration;
    } catch (e) { /* fallback */ }

    return 3;
}

// --- Build full narration audio track with silence gaps ---

function buildNarrationTrack(segments, videoDuration, tmpDir, ffmpegPath) {
    if (segments.length === 0) return null;

    // Calcular timing: distribuir segmentos uniformemente a lo largo del video
    const totalSegments = segments.length;
    const segmentInterval = videoDuration / (totalSegments + 1);

    const timedSegments = segments.map((seg, idx) => ({
        ...seg,
        startTime: segmentInterval * (idx + 1) + (seg.delay_ms || 0) / 1000
    }));

    // Generar cada clip de audio TTS
    console.log("[qa-narration] Generando " + totalSegments + " clips de audio TTS...");
    const clipFiles = [];
    for (let i = 0; i < timedSegments.length; i++) {
        const seg = timedSegments[i];
        const clipPath = path.join(tmpDir, "segment_" + i + ".mp3");

        try {
            generateTTSSegment(seg.text, clipPath);
            const clipDuration = getAudioDuration(clipPath, ffmpegPath);
            clipFiles.push({
                path: clipPath,
                startTime: seg.startTime,
                duration: clipDuration
            });
            process.stdout.write("  Clip " + (i + 1) + "/" + totalSegments + " OK (" + clipDuration.toFixed(1) + "s)\n");
        } catch (e) {
            console.error("  Clip " + (i + 1) + "/" + totalSegments + " FALLO: " + e.message);
        }
    }

    if (clipFiles.length === 0) return null;

    // Usar FFmpeg para construir el audio track completo con delays
    if (!ffmpegPath) {
        // Sin FFmpeg: concatenar clips secuencialmente (sin silencios)
        const concatPath = path.join(tmpDir, "narration-concat.mp3");
        const concatList = path.join(tmpDir, "concat.txt");
        const listContent = clipFiles.map(c => "file '" + c.path.replace(/\\/g, "/") + "'").join("\n");
        fs.writeFileSync(concatList, listContent);

        // Intentar con ffmpeg de nuevo por si acaso
        return { clips: clipFiles, fullTrack: null };
    }

    // Construir filter_complex para posicionar cada clip en su timestamp correcto
    // Estrategia: generar silencio base + overlay cada clip en su posicion
    const fullTrackPath = path.join(tmpDir, "narration-full.mp3");

    // Construir el comando FFmpeg con adelay filter
    const inputs = clipFiles.map(c => ["-i", c.path]).flat();
    const filterParts = [];
    const overlayParts = [];

    // Generar silencio base de la duracion del video
    filterParts.push("anullsrc=r=24000:cl=mono[silence]");

    for (let i = 0; i < clipFiles.length; i++) {
        const delayMs = Math.round(clipFiles[i].startTime * 1000);
        filterParts.push("[" + i + ":a]adelay=" + delayMs + "|" + delayMs + ",aformat=sample_rates=24000:channel_layouts=mono[d" + i + "]");
        overlayParts.push("[d" + i + "]");
    }

    // Mezclar todos los clips con el silencio base
    const mixInputs = "[silence]" + overlayParts.join("");
    const mixFilter = mixInputs + "amix=inputs=" + (clipFiles.length + 1) + ":duration=first:dropout_transition=0[out]";

    const fullFilter = filterParts.join(";") + ";" + mixFilter;

    const ffmpegArgs = [
        "-f", "lavfi", "-t", String(videoDuration), "-i", "anullsrc=r=24000:cl=mono",
        ...inputs,
        "-filter_complex", fullFilter.replace("anullsrc=r=24000:cl=mono[silence];", "[0:a]acopy[silence];"),
        "-map", "[out]",
        "-t", String(videoDuration),
        "-y",
        fullTrackPath
    ];

    console.log("[qa-narration] Construyendo pista de audio completa (" + videoDuration.toFixed(1) + "s)...");

    const result = spawnSync(ffmpegPath, ffmpegArgs, {
        stdio: "pipe",
        timeout: 120000
    });

    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString().slice(-500) : "unknown error";
        console.error("[qa-narration] FFmpeg mix fallo: " + stderr);

        // Fallback: concatenar sin posicionamiento temporal
        return buildSimpleConcatenation(clipFiles, tmpDir, ffmpegPath, videoDuration);
    }

    if (fs.existsSync(fullTrackPath)) {
        return { clips: clipFiles, fullTrack: fullTrackPath };
    }

    return buildSimpleConcatenation(clipFiles, tmpDir, ffmpegPath, videoDuration);
}

// --- Fallback: simple concatenation with pauses ---

function buildSimpleConcatenation(clipFiles, tmpDir, ffmpegPath, videoDuration) {
    const fullTrackPath = path.join(tmpDir, "narration-simple.mp3");

    // Calcular pausa entre clips
    const totalClipDuration = clipFiles.reduce((sum, c) => sum + c.duration, 0);
    const totalPause = Math.max(0, videoDuration - totalClipDuration);
    const pausePerGap = clipFiles.length > 1 ? totalPause / (clipFiles.length - 1) : 0;
    const pauseMs = Math.min(Math.round(pausePerGap * 1000), 5000); // max 5s pause

    // Construir filter con apad entre clips
    const inputs = clipFiles.map(c => ["-i", c.path]).flat();
    const filterInputs = clipFiles.map((_, i) => {
        if (i < clipFiles.length - 1 && pauseMs > 0) {
            return "[" + i + ":a]apad=pad_dur=" + pauseMs + "ms[p" + i + "]";
        }
        return "[" + i + ":a]acopy[p" + i + "]";
    });
    const concatInputs = clipFiles.map((_, i) => "[p" + i + "]").join("");
    const fullFilter = filterInputs.join(";") + ";" + concatInputs + "concat=n=" + clipFiles.length + ":v=0:a=1[out]";

    const result = spawnSync(ffmpegPath, [
        ...inputs,
        "-filter_complex", fullFilter,
        "-map", "[out]",
        "-t", String(videoDuration),
        "-y",
        fullTrackPath
    ], { stdio: "pipe", timeout: 120000 });

    if (result.status === 0 && fs.existsSync(fullTrackPath)) {
        console.log("[qa-narration] Audio generado (concatenacion simple con pausas)");
        return { clips: clipFiles, fullTrack: fullTrackPath };
    }

    console.error("[qa-narration] Fallback concatenacion tambien fallo");
    return { clips: clipFiles, fullTrack: null };
}

// --- Merge video + audio ---

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
        throw new Error("FFmpeg merge fallo: " + stderr);
    }

    return fs.existsSync(outputPath);
}

// --- Main ---

function main() {
    const args = parseArgs();

    if (!args.video) {
        console.error("[qa-narration] Uso: node qa-narration.js --video <path> --flows-dir <path> --output <path>");
        process.exit(1);
    }

    if (!fs.existsSync(args.video)) {
        console.error("[qa-narration] Video no encontrado: " + args.video);
        process.exit(1);
    }

    // Verificar edge-tts
    const edgeTtsCheck = spawnSync("python", ["-m", "edge_tts", "--version"], { stdio: "pipe", timeout: 10000 });
    if (edgeTtsCheck.status !== 0) {
        console.error("[qa-narration] edge-tts no disponible. Instalar: pip install edge-tts");
        console.error("[qa-narration] Continuando sin narracion de audio.");
        process.exit(0);
    }

    const ffmpegPath = findFFmpeg();
    if (!ffmpegPath) {
        console.warn("[qa-narration] FFmpeg no encontrado. Se generara audio MP3 suelto.");
        console.warn("[qa-narration] Instalar: winget install Gyan.FFmpeg");
    } else {
        console.log("[qa-narration] FFmpeg: " + ffmpegPath);
    }

    console.log("[qa-narration] Voz TTS: " + TTS_CONFIG.voice);

    // Encontrar archivos de narracion
    const flowsDir = args.flowsDir || path.resolve(__dirname, "../../.maestro/flows");
    const narrationFiles = findNarrationFiles(flowsDir);

    if (narrationFiles.length === 0) {
        console.log("[qa-narration] No se encontraron archivos .narration.json en " + flowsDir);
        process.exit(0);
    }

    // Combinar todos los segmentos de todos los flows (el video contiene todos los flows del shard)
    const allSegments = [];
    for (const nf of narrationFiles) {
        if (nf.data.segments) {
            for (const seg of nf.data.segments) {
                allSegments.push({
                    flow: nf.data.flow,
                    ...seg
                });
            }
        }
    }

    console.log("[qa-narration] " + narrationFiles.length + " flows con narracion, " + allSegments.length + " segmentos totales");

    // Obtener duracion del video
    const videoDuration = getVideoDuration(args.video, ffmpegPath);
    console.log("[qa-narration] Duracion del video: " + videoDuration.toFixed(1) + "s");

    // Crear directorio temporal
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-narration-"));

    try {
        // Generar pista de audio
        const result = buildNarrationTrack(allSegments, videoDuration, tmpDir, ffmpegPath);

        if (!result || result.clips.length === 0) {
            console.error("[qa-narration] No se pudo generar ningun clip de audio");
            process.exit(0);
        }

        const outputPath = args.output || args.video.replace(".mp4", "-narrated.mp4");

        if (result.fullTrack && ffmpegPath) {
            // Merge video + audio
            try {
                mergeVideoAudio(args.video, result.fullTrack, outputPath, ffmpegPath);
                const stats = fs.statSync(outputPath);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                console.log("[qa-narration] Video narrado: " + outputPath + " (" + sizeMB + "MB)");
            } catch (e) {
                console.error("[qa-narration] Merge fallo: " + e.message);
                // Guardar audio suelto como fallback
                const audioOutput = outputPath.replace(".mp4", ".mp3");
                fs.copyFileSync(result.fullTrack, audioOutput);
                console.log("[qa-narration] Audio guardado por separado: " + audioOutput);
            }
        } else {
            // Sin FFmpeg: guardar audio suelto
            if (result.clips.length > 0) {
                const audioOutput = (args.output || args.video).replace(".mp4", "-narration.mp3");
                // Copiar primer clip como referencia (mejor que nada)
                fs.copyFileSync(result.clips[0].path, audioOutput);
                console.warn("[qa-narration] FFmpeg no disponible. Audio parcial guardado: " + audioOutput);
            }
        }
    } finally {
        // Limpiar temporales
        try {
            const tmpFiles = fs.readdirSync(tmpDir);
            for (const f of tmpFiles) {
                fs.unlinkSync(path.join(tmpDir, f));
            }
            fs.rmdirSync(tmpDir);
        } catch (e) { /* cleanup best-effort */ }
    }
}

main();
