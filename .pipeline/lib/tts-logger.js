// V3 TTS Logger — wrapper alrededor de invocaciones TTS que emite tts:generated
// Contrato definido en issue #2477. No duplica la lógica de multimedia.js — solo instrumenta.
//
// Dos modos de uso:
//
// A) Wrap explícito (recomendado para migraciones nuevas):
//    const { wrapTts } = require('./tts-logger');
//    const audioBuf = await wrapTts({
//        skill: 'qa', issue: 2461, phase: 'qa',
//        provider: 'openai', voice: 'ash', chars: text.length,
//    }, () => multimedia.generateTTS(text));
//
// B) Emit directo (cuando ya se generó el audio por otro path):
//    const { emitTtsGenerated } = require('./tts-logger');
//    emitTtsGenerated({ skill, issue, phase, provider, chars, audio_seconds, voice });

'use strict';

const { appendEvent } = require('./traceability');

// Pricing TTS por provider (USD por unidad).
// Fuente: pricing oficial público. Actualizar si cambian los tarifarios.
const TTS_PRICING = {
    // OpenAI gpt-4o-mini-tts: ~$0.015 por minuto de audio generado = $0.00025/seg
    'openai':   { per_audio_second: 0.00025, per_char: 0 },
    // edge-tts es gratis (Microsoft Edge voices). Guardamos 0 para que no rompa el schema.
    'edge-tts': { per_audio_second: 0, per_char: 0 },
    // fallback desconocido
    'unknown':  { per_audio_second: 0.00025, per_char: 0 },
};

// Estimación conservadora de duración cuando el caller no la provee.
// Español a velocidad TTS normal: ~14 caracteres / segundo.
function estimateAudioSeconds(chars) {
    if (!chars || chars < 0) return 0;
    return Math.round((chars / 14) * 10) / 10;
}

function estimateTtsCost(provider, audioSeconds, chars) {
    const p = TTS_PRICING[provider] || TTS_PRICING.unknown;
    const byDuration = (audioSeconds || 0) * p.per_audio_second;
    const byChars = (chars || 0) * p.per_char;
    return Math.round((byDuration + byChars) * 10000) / 10000;
}

function pick(opts, k, fb) {
    return (opts && opts[k] !== undefined && opts[k] !== null && opts[k] !== '') ? opts[k] : fb;
}

function emitTtsGenerated(opts) {
    opts = opts || {};
    const provider = pick(opts, 'provider', 'openai');
    const chars = Number(pick(opts, 'chars', 0));
    let audio_s = opts.audio_seconds;
    if (audio_s === undefined || audio_s === null) audio_s = estimateAudioSeconds(chars);
    const evt = {
        event: 'tts:generated',
        skill: pick(opts, 'skill', process.env.PIPELINE_SKILL || null),
        issue: pick(opts, 'issue', process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null),
        phase: pick(opts, 'phase', process.env.PIPELINE_FASE || process.env.PIPELINE_PHASE || null),
        provider: provider,
        chars: chars,
        audio_seconds: Number(audio_s),
        voice: pick(opts, 'voice', 'unknown'),
        cost_estimate_usd: estimateTtsCost(provider, Number(audio_s), chars),
        ts: new Date().toISOString(),
    };
    appendEvent(evt);
    return evt;
}

// Intenta derivar duración real desde el buffer si ffprobe está disponible.
// Fallback a estimación por chars si falla o no existe.
function audioSecondsFromBuffer(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    try {
        const { execFileSync } = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tmp = path.join(os.tmpdir(), `tts-probe-${process.pid}-${Date.now()}.opus`);
        fs.writeFileSync(tmp, buffer);
        try {
            const out = execFileSync('ffprobe', [
                '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', tmp,
            ], { timeout: 5000, windowsHide: true }).toString().trim();
            const seconds = parseFloat(out);
            if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 10) / 10;
        } finally {
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
    } catch (_) { /* ffprobe no disponible — caller usa fallback */ }
    return null;
}

async function wrapTts(ctx, generatorFn) {
    const startMs = Date.now();
    const result = await generatorFn();
    const elapsedMs = Date.now() - startMs;

    let audio_s = ctx && ctx.audio_seconds;
    if ((audio_s === undefined || audio_s === null) && Buffer.isBuffer(result)) {
        audio_s = audioSecondsFromBuffer(result);
    }
    if (audio_s === undefined || audio_s === null) {
        audio_s = estimateAudioSeconds(ctx && ctx.chars);
    }

    emitTtsGenerated({
        skill: ctx && ctx.skill,
        issue: ctx && ctx.issue,
        phase: ctx && ctx.phase,
        provider: ctx && ctx.provider,
        voice: ctx && ctx.voice,
        chars: ctx && ctx.chars,
        audio_seconds: audio_s,
    });

    return result;
}

module.exports = {
    emitTtsGenerated,
    wrapTts,
    estimateAudioSeconds,
    estimateTtsCost,
    audioSecondsFromBuffer,
    TTS_PRICING,
};
