// multimedia.js — Preprocesamiento de multimedia para el Commander V2
// Transcribe audio (OpenAI) y describe imágenes (Anthropic Vision)
// Se ejecuta ANTES de pasar el mensaje a Claude

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TG_CONFIG_PATH = path.join(ROOT, '.claude', 'hooks', 'telegram-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(TG_CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [multimedia] ${msg}`);
}

// --- Telegram file download ---

function downloadTelegramFile(fileId, botToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id: fileId });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/getFile`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (!r.ok || !r.result?.file_path) { resolve(null); return; }
          // Download actual file
          https.get(`https://api.telegram.org/file/bot${botToken}/${r.result.file_path}`, (fres) => {
            const chunks = [];
            fres.on('data', c => chunks.push(c));
            fres.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', () => resolve(null));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// --- OpenAI Whisper transcription ---

function transcribeAudio(audioBuffer, filename) {
  const config = loadConfig();
  const apiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.resolve('(audio no soportado — falta openai_api_key)');

  return new Promise((resolve, reject) => {
    const boundary = 'boundary' + Date.now();
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'audio.ogg'}"\r\nContent-Type: audio/ogg\r\n\r\n`);

    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': body.length
      },
      timeout: 60000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.error) { resolve(`(error transcripcion: ${r.error.message})`); return; }
          resolve(r.text || '(sin transcripcion)');
        } catch { resolve('(error parseando respuesta de transcripcion)'); }
      });
    });
    req.on('error', (e) => resolve(`(error transcripcion: ${e.message})`));
    req.on('timeout', () => { req.destroy(); resolve('(timeout transcripcion)'); });
    req.write(body);
    req.end();
  });
}

// --- Anthropic Vision ---

function describeImage(imageBuffer, mediaType) {
  const config = loadConfig();
  const apiKey = config.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sin API key, devolver el base64 para que Claude CLI lo procese
    return Promise.resolve({ type: 'base64', data: imageBuffer.toString('base64'), mediaType });
  }

  return new Promise((resolve, reject) => {
    const base64 = imageBuffer.toString('base64');
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
          { type: 'text', text: 'Describí esta imagen en detalle. Si contiene texto, transcribilo. Si es un screenshot de código o error, analizalo.' }
        ]
      }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.error) { resolve(`(error vision: ${r.error.message})`); return; }
          const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          resolve(text || '(sin descripcion)');
        } catch { resolve('(error parseando respuesta vision)'); }
      });
    });
    req.on('error', (e) => resolve(`(error vision: ${e.message})`));
    req.on('timeout', () => { req.destroy(); resolve('(timeout vision)'); });
    req.write(body);
    req.end();
  });
}

// --- Preprocesar mensaje completo ---

async function preprocessMessage(msg, botToken) {
  const result = { text: msg.text || '', extras: [] };

  // Transcribir audio
  // El listener ya descargó el archivo a voice_path (local) o tenemos file_id en voice
  if (msg.voice || msg.voice_path) {
    let audioBuffer = null;

    if (msg.voice_path && fs.existsSync(msg.voice_path)) {
      // Listener ya descargó — leer del disco
      log(`Leyendo audio local: ${msg.voice_path}`);
      audioBuffer = fs.readFileSync(msg.voice_path);
    } else if (msg.voice) {
      // Fallback: descargar de Telegram
      log(`Descargando audio ${msg.voice}...`);
      audioBuffer = await downloadTelegramFile(msg.voice, botToken);
    }

    if (audioBuffer) {
      log(`Transcribiendo audio (${audioBuffer.length} bytes)...`);
      const transcription = await transcribeAudio(audioBuffer, 'audio.ogg');
      log(`Transcripcion: "${transcription.slice(0, 100)}"`);
      result.text = transcription;
      result.extras.push('(mensaje de voz transcripto)');
    } else {
      log('Audio no disponible');
      result.extras.push('(audio no disponible)');
    }
  }

  // Describir imagen
  // El listener ya descargó a photo_path (local) o tenemos file_id en photo
  if (msg.photo || msg.photo_path) {
    let imgBuffer = null;

    if (msg.photo_path && fs.existsSync(msg.photo_path)) {
      // Listener ya descargó — leer del disco
      log(`Leyendo imagen local: ${msg.photo_path}`);
      imgBuffer = fs.readFileSync(msg.photo_path);
    } else if (msg.photo) {
      // Fallback: descargar de Telegram
      log(`Descargando imagen ${msg.photo}...`);
      imgBuffer = await downloadTelegramFile(msg.photo, botToken);
    }

    if (imgBuffer) {
      log(`Describiendo imagen (${imgBuffer.length} bytes)...`);
      const description = await describeImage(imgBuffer, 'image/jpeg');
      if (typeof description === 'string') {
        log(`Vision: "${description.slice(0, 100)}"`);
        result.extras.push(`[Imagen: ${description}]`);
      } else {
        // base64 sin API key — guardar a disco para que Claude lo lea
        const imgPath = path.join(__dirname, 'logs', 'media', `img-${Date.now()}.jpg`);
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, imgBuffer);
        log(`Imagen guardada (sin API key Vision): ${imgPath}`);
        result.extras.push(`[Imagen guardada en: ${imgPath}]`);
      }
    } else {
      log('Imagen no disponible');
      result.extras.push('(imagen no disponible)');
    }
  }

  return result;
}

// --- OpenAI TTS ---

function textToSpeech(text) {
  const config = loadConfig();
  const apiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const truncated = text.length > 2000 ? text.substring(0, 1950) + '... (respuesta truncada)' : text;

    const body = JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: truncated,
      voice: 'ash',
      instructions: 'Hablas como un porteño de Buenos Aires, con tonada rioplatense. Usas vos en vez de tu, decis dale, che, mira. El ritmo es de charla entre amigos. Sos inteligente pero cero formal.',
      response_format: 'opus'
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode === 200 && buffer.length > 100) {
          log(`TTS generado: ${buffer.length} bytes`);
          resolve(buffer);
        } else {
          log(`TTS error: status=${res.statusCode}, size=${buffer.length}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { log(`TTS error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// --- Enviar audio por Telegram ---

function sendVoiceTelegram(audioBuffer, botToken, chatId) {
  return new Promise((resolve, reject) => {
    const boundary = 'boundary' + Date.now();
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="response.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendVoice`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 30000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          resolve(r.ok);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

module.exports = { preprocessMessage, transcribeAudio, describeImage, downloadTelegramFile, textToSpeech, sendVoiceTelegram };
