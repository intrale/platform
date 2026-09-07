#!/usr/bin/env node
/**
 * UX #6144 — genera los clips pregrabados del aviso de cadena de IA caída.
 *
 * Reproducible: lee el copy canónico de `copy.json` y sintetiza con la misma
 * cadena que usa el pipeline en runtime (edge-tts → mp3 → ffmpeg → ogg/opus),
 * con el perfil de voz `need-human` de `.pipeline/tts-config.json`.
 *
 * Se agrega `-map_metadata -1` para no versionar metadatos del entorno de
 * generación (pedido de `security` en el análisis de #6144).
 *
 * Uso: node .pipeline/assets/audio/provider-down/generate-clips.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const COPY = JSON.parse(fs.readFileSync(path.join(HERE, 'copy.json'), 'utf8'));
const TTS = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'tts-config.json'), 'utf8'));
const PROFILE = (TTS.profiles && TTS.profiles['need-human']) || TTS['need-human'];

if (!PROFILE || !PROFILE.edge || !PROFILE.edge.voice) {
    console.error('ERROR: no se pudo resolver el perfil de voz `need-human` en tts-config.json');
    process.exit(1);
}

const EDGE_TTS = process.env.EDGE_TTS_BIN || 'edge-tts';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux6144-'));

let failed = 0;
for (const [cause, text] of Object.entries(COPY.voz_clip)) {
    const mp3 = path.join(tmpDir, `${cause}.mp3`);
    const ogg = path.join(HERE, `${cause}.ogg`);

    const tts = spawnSync(EDGE_TTS, [
        '--voice', PROFILE.edge.voice,
        '--rate', PROFILE.edge.rate || '+0%',
        '--pitch', PROFILE.edge.pitch || '+0Hz',
        '--text', text,
        '--write-media', mp3,
    ], { windowsHide: true, encoding: 'utf8' });

    if (tts.status !== 0 || !fs.existsSync(mp3)) {
        console.error(`FALLO tts ${cause}: exit=${tts.status} ${(tts.stderr || '').slice(0, 200)}`);
        failed++;
        continue;
    }

    // Mismos parámetros que `mp3ToOpus` (.pipeline/multimedia.js) para que el
    // clip sea indistinguible de un voice note generado en runtime.
    const ff = spawnSync(FFMPEG, [
        '-y', '-loglevel', 'error', '-i', mp3,
        '-map_metadata', '-1',
        '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', ogg,
    ], { windowsHide: true, encoding: 'utf8' });

    if (ff.status !== 0 || !fs.existsSync(ogg)) {
        console.error(`FALLO ffmpeg ${cause}: exit=${ff.status} ${(ff.stderr || '').slice(0, 200)}`);
        failed++;
        continue;
    }

    console.log(`OK ${cause}.ogg  ${fs.statSync(ogg).size} bytes  (${text.length} chars)`);
    try { fs.unlinkSync(mp3); } catch {}
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
