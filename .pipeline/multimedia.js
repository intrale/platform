// multimedia.js — Preprocesamiento de multimedia para el Commander V2
// Transcribe audio (OpenAI) y describe imágenes (Anthropic Vision)
// Se ejecuta ANTES de pasar el mensaje a Claude

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TG_CONFIG_PATH = path.join(ROOT, '.claude', 'hooks', 'telegram-config.json');
const { loadTelegramSecrets, loadApiKeys } = require('./lib/telegram-secrets');
const { transcribeLocal: whisperLocal, isAvailable: whisperLocalAvailable } = require('./lib/whisper-local');

// errorKinds de la API que ameritan probar el fallback local (cuota, auth,
// rate limit, network, timeout). 'parse'/'no_key' tampoco deberían volar la
// transcripción si tenemos whisper local disponible.
const LOCAL_FALLBACK_KINDS = new Set(['quota', 'auth', 'rate_limit', 'network', 'timeout', 'no_key']);

// Merge en 3 capas para que TTS/STT/Vision nunca se rompa por la migracion
// del archivo committed a placeholders:
//   - base = archivo committed (configs no-secretas: voice_id, retries, etc.)
//   - bot_token + chat_id desde el helper de secrets criticos (home preferido)
//   - api keys (OpenAI/Anthropic/ElevenLabs) desde loadApiKeys (ENV → home → legacy)
// Cualquier valor del home pisa el placeholder vacio del archivo committed.
function loadConfig() {
  let base = {};
  try { base = JSON.parse(fs.readFileSync(TG_CONFIG_PATH, 'utf8')); } catch {}
  try {
    const sec = loadTelegramSecrets({ legacyConfigPath: TG_CONFIG_PATH });
    base.bot_token = sec.bot_token;
    base.chat_id = sec.chat_id;
  } catch {}
  const keys = loadApiKeys({ legacyConfigPath: TG_CONFIG_PATH });
  if (keys.openai_api_key) base.openai_api_key = keys.openai_api_key;
  if (keys.anthropic_api_key) base.anthropic_api_key = keys.anthropic_api_key;
  if (keys.elevenlabs_api_key) base.elevenlabs_api_key = keys.elevenlabs_api_key;
  if (keys.elevenlabs_voice_id) base.elevenlabs_voice_id = keys.elevenlabs_voice_id;
  return base;
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
// Devuelve siempre {ok, text, errorKind, raw} para que el caller decida si
// degrada con gracia. errorKind ∈ {'no_key','quota','auth','rate_limit',
// 'network','timeout','parse','api','unknown'}.

function classifyOpenAIError(errObj) {
  if (!errObj) return 'unknown';
  const code = (errObj.code || '').toLowerCase();
  const type = (errObj.type || '').toLowerCase();
  const msg  = (errObj.message || '').toLowerCase();
  if (code === 'insufficient_quota' || type === 'insufficient_quota' || msg.includes('exceeded your current quota')) return 'quota';
  if (code === 'invalid_api_key' || type === 'invalid_request_error' && msg.includes('api key')) return 'auth';
  if (code === 'rate_limit_exceeded' || type === 'rate_limit_error') return 'rate_limit';
  return 'api';
}

function transcribeAudio(audioBuffer, filename) {
  const config = loadConfig();
  const apiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.resolve({ ok: false, text: '', errorKind: 'no_key', raw: 'falta openai_api_key' });

  return new Promise((resolve) => {
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
          if (r.error) {
            resolve({ ok: false, text: '', errorKind: classifyOpenAIError(r.error), raw: r.error.message || JSON.stringify(r.error) });
            return;
          }
          if (r.text) { resolve({ ok: true, text: r.text }); return; }
          resolve({ ok: false, text: '', errorKind: 'parse', raw: 'respuesta sin campo text' });
        } catch (e) {
          resolve({ ok: false, text: '', errorKind: 'parse', raw: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, text: '', errorKind: 'network', raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '', errorKind: 'timeout', raw: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// Orquesta API + fallback local. Devuelve la misma forma {ok,text,errorKind,raw}
// más un campo `source` ∈ {'openai','local'} para que se pueda auditar/loguear
// cuál motor terminó respondiendo.
async function transcribeAudioWithFallback(audioBuffer, audioPath, filename) {
  const apiResult = await transcribeAudio(audioBuffer, filename);
  if (apiResult.ok) return { ...apiResult, source: 'openai' };

  // Sólo intentamos local cuando el motivo de falla es uno que el local puede
  // resolver (cuota agotada, key inválida, network). Errores de parseo o de
  // formato de respuesta no se arreglan re-corriendo en local.
  if (!LOCAL_FALLBACK_KINDS.has(apiResult.errorKind)) {
    return { ...apiResult, source: 'openai' };
  }
  if (!whisperLocalAvailable()) {
    log(`API falló (${apiResult.errorKind}) y whisper local no está disponible`);
    return { ...apiResult, source: 'openai' };
  }

  log(`API falló (${apiResult.errorKind}) — fallback a whisper local`);
  const localResult = await whisperLocal({ audioPath, audioBuffer, logger: log });
  if (localResult.ok) {
    return { ok: true, text: localResult.text, source: 'local', apiErrorKind: apiResult.errorKind };
  }
  // Si el local también falló, devolvemos el error original de la API (es el
  // que tiene contexto más útil para el operador). Anotamos el fallo del local.
  return {
    ...apiResult,
    source: 'openai',
    localErrorKind: localResult.errorKind,
    localRaw: localResult.raw,
  };
}

// Mensaje human-friendly que va a Telegram cuando whisper no pudo transcribir.
// Es lo que va a leer Leo, así que tiene que ser breve y accionable.
// Cuando ambos engines (API + local) fallan, el mensaje refleja eso —
// no podemos echarle la culpa solo a la cuota de OpenAI si el local crasheó.
function transcriptionFailureMessage(errorKind, localErrorKind = null) {
  if (localErrorKind) {
    const apiPart = errorKind === 'quota' ? 'cuota OpenAI agotada'
                  : errorKind === 'auth'  ? 'key OpenAI inválida'
                  : errorKind === 'rate_limit' ? 'rate-limit OpenAI'
                  : errorKind === 'network' ? 'no llegué a OpenAI'
                  : errorKind === 'timeout' ? 'timeout OpenAI'
                  : `OpenAI ${errorKind}`;
    const localHint = localErrorKind === 'cli_error' ? 'crasheó (probable OOM con audio largo)'
                    : localErrorKind === 'timeout'  ? 'tardó demasiado'
                    : localErrorKind === 'no_binary' ? 'no está instalado'
                    : `falló (${localErrorKind})`;
    return `🎤 Audio recibido. Falló API (${apiPart}) y también whisper local — ${localHint}. Repetímelo por texto cuando puedas. Si el local sigue crasheando: bajar \`WHISPER_LOCAL_MODEL\` a \`small\` o reiniciar la máquina.`;
  }
  switch (errorKind) {
    case 'no_key':     return '🎤 Audio recibido. No tengo `openai_api_key` cargada — repetímelo por texto cuando puedas.';
    case 'quota':      return '🎤 Audio recibido. La cuota de OpenAI está agotada (Whisper no responde) — repetímelo por texto cuando puedas. Para volver a habilitar la transcripción: subir cuota o rotar la key en `~/.claude/secrets/telegram-config.json`.';
    case 'auth':       return '🎤 Audio recibido. La `openai_api_key` está inválida — repetímelo por texto y revisá la key en `~/.claude/secrets/telegram-config.json`.';
    case 'rate_limit': return '🎤 Audio recibido. Whisper está rate-limited ahora mismo — esperá unos segundos y reenviá, o repetímelo por texto.';
    case 'timeout':    return '🎤 Audio recibido. La transcripción se colgó (timeout) — repetímelo por texto, o reenvialo más cortito.';
    case 'network':    return '🎤 Audio recibido. No pude llegar a la API de OpenAI (network) — repetímelo por texto.';
    default:           return '🎤 Audio recibido pero no pude transcribirlo — repetímelo por texto cuando puedas.';
  }
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
  const result = { text: msg.text || '', extras: [], audio: null };

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
      const tx = await transcribeAudioWithFallback(audioBuffer, msg.voice_path || null, 'audio.ogg');
      if (tx.ok) {
        const sourceTag = tx.source === 'local' ? ' [whisper local]' : '';
        log(`Transcripcion${sourceTag}: "${tx.text.slice(0, 100)}"`);
        result.text = tx.text;
        const extra = tx.source === 'local'
          ? '(mensaje de voz transcripto · whisper local · API en fallback)'
          : '(mensaje de voz transcripto)';
        result.extras.push(extra);
        result.audio = { ok: true, source: tx.source };
      } else {
        log(`Transcripcion FALLO (${tx.errorKind}): ${tx.raw}${tx.localErrorKind ? ` | local=${tx.localErrorKind}: ${tx.localRaw}` : ''}`);
        // No metemos el error como texto del mensaje — el caller decide qué hacer.
        result.text = '';
        result.audio = { ok: false, errorKind: tx.errorKind, raw: tx.raw, localErrorKind: tx.localErrorKind || null, fallbackMessage: transcriptionFailureMessage(tx.errorKind, tx.localErrorKind || null) };
        result.extras.push(`(audio sin transcribir: ${tx.errorKind})`);
      }
    } else {
      log('Audio no disponible');
      result.extras.push('(audio no disponible)');
      result.audio = { ok: false, errorKind: 'download_failed', raw: 'no se pudo bajar el audio', fallbackMessage: '🎤 Audio recibido pero no pude descargarlo de Telegram — reintentá o repetímelo por texto.' };
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

// --- TTS config (priorización dinámica con perfiles por agente) ---

const TTS_CONFIG_PATH = path.join(ROOT, '.pipeline', 'tts-config.json');

// Perfil default hardcoded como último fallback. Usado si el archivo no existe,
// tiene schema inválido, o se pide un perfil inexistente (queremos audio
// genérico antes que no audio). Cualquier agente del pipeline puede declarar
// su propio perfil en tts-config.json → profiles.<nombre>.
const DEFAULT_PROFILE = {
  primary: 'openai',
  fallback: 'edge',
  openai: {
    model: 'gpt-4o-mini-tts',
    voice: 'ash',
    instructions: 'Hablas como un porteño de Buenos Aires, con tonada rioplatense. Usas vos en vez de tu, decis dale, che, mira. El ritmo es de charla entre amigos. Sos inteligente pero cero formal.',
    response_format: 'opus',
    character_name: 'Claudito'
  },
  edge: {
    voice: 'es-AR-TomasNeural',
    rate: '+8%',
    pitch: '+4Hz',
    character_name: 'Tommy',
    personality: 'Sos Tommy, un pibe joven que recién arranca en el equipo. Tenés la frescura de la juventud, hablas con energía, onda y entusiasmo. Usas vos, che, dale, mira. Sos piola, curioso, con ganas de aprender. Nunca sos engreído — tenés el respeto del que recién se inicia pero la garra de querer comerse la cancha.'
  },
  intros: {
    openai_from_edge: 'Hola Leo, volvió Claudito. Gracias Tommy por cubrirme, te saliste, pibe.',
    edge_from_openai: 'Eeeeh Leo, todo bien. Soy Tommy, recién me sumo al equipo. Claudito se tomó una licencia y me dejó la posta mientras vuelve. La rompo yo hasta que regrese.'
  }
};

/**
 * Carga un perfil TTS por nombre. Soporta dos shapes de tts-config.json:
 *   - Nuevo: { profiles: { default: {...}, qa: {...}, ... } }
 *   - Viejo: { primary, fallback, providers: { openai, edge }, intros } → interpretado como profiles.default
 * Si el perfil pedido no existe, cae a `default`. Si tampoco hay default, usa DEFAULT_PROFILE hardcoded.
 * Retorna objeto con { primary, fallback, openai, edge, intros, profileName, profileFound }.
 */
function loadTtsConfig(profileName = 'default') {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(TTS_CONFIG_PATH, 'utf8'));
  } catch {
    return { ...DEFAULT_PROFILE, profileName: 'default', profileFound: false };
  }

  let profileRaw = null;
  if (raw && raw.profiles && typeof raw.profiles === 'object') {
    profileRaw = raw.profiles[profileName];
    if (!profileRaw && profileName !== 'default') {
      profileRaw = raw.profiles.default;
    }
  } else if (raw) {
    // Shape viejo → interpretarlo como si fuera profiles.default
    profileRaw = {
      primary: raw.primary,
      fallback: raw.fallback,
      openai: raw.providers?.openai,
      edge: raw.providers?.edge,
      intros: raw.intros,
    };
  }

  if (!profileRaw) {
    return { ...DEFAULT_PROFILE, profileName: 'default', profileFound: false };
  }

  return {
    primary: profileRaw.primary || DEFAULT_PROFILE.primary,
    fallback: profileRaw.fallback === null ? null : (profileRaw.fallback || DEFAULT_PROFILE.fallback),
    openai: { ...DEFAULT_PROFILE.openai, ...(profileRaw.openai || {}) },
    edge: { ...DEFAULT_PROFILE.edge, ...(profileRaw.edge || {}) },
    intros: { ...DEFAULT_PROFILE.intros, ...(profileRaw.intros || {}) },
    profileName,
    profileFound: true,
  };
}

// Estado persistente: último provider usado (para detectar transiciones)
const TTS_STATE_PATH = path.join(ROOT, '.pipeline', '.tts-state.json');

function loadTtsState() {
  try { return JSON.parse(fs.readFileSync(TTS_STATE_PATH, 'utf8')); }
  catch { return { lastProvider: null }; }
}

function saveTtsState(state) {
  try { fs.writeFileSync(TTS_STATE_PATH, JSON.stringify(state, null, 2)); }
  catch (e) { log(`TTS state save error: ${e.message}`); }
}

function getTransitionIntro(newProvider, prevProvider, profileName = 'default') {
  if (!prevProvider || prevProvider === newProvider) return null;
  const cfg = loadTtsConfig(profileName);
  if (newProvider === 'openai' && prevProvider === 'edge') return cfg.intros?.openai_from_edge || null;
  if (newProvider === 'edge' && prevProvider === 'openai') return cfg.intros?.edge_from_openai || null;
  return null;
}

// --- OpenAI TTS ---

function textToSpeechOpenAI(text, profileName = 'default') {
  const config = loadConfig();
  const apiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) { log('TTS[openai]: falta openai_api_key'); return Promise.resolve(null); }

  const ttsCfg = loadTtsConfig(profileName).openai;

  return new Promise((resolve) => {
    // OpenAI TTS soporta hasta 4096 chars — NO truncar, los callers manejan chunking
    const body = JSON.stringify({
      model: ttsCfg.model,
      input: text.substring(0, 4096),
      voice: ttsCfg.voice,
      instructions: ttsCfg.instructions,
      response_format: ttsCfg.response_format || 'opus'
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
          log(`TTS[openai] generado: ${buffer.length} bytes`);
          resolve(buffer);
        } else {
          log(`TTS[openai] error: status=${res.statusCode}, size=${buffer.length}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { log(`TTS[openai] error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); log('TTS[openai] timeout'); resolve(null); });
    req.write(body);
    req.end();
  });
}

// --- Edge TTS (Microsoft, gratis) ---

function findEdgeTtsExe() {
  // Permite override por env
  if (process.env.EDGE_TTS_BIN && fs.existsSync(process.env.EDGE_TTS_BIN)) return process.env.EDGE_TTS_BIN;
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const v of ['Python314', 'Python313', 'Python312', 'Python311', 'Python310']) {
      candidates.push(path.join(appData, 'Python', v, 'Scripts', 'edge-tts.exe'));
    }
    candidates.push('C:\\Python314\\Scripts\\edge-tts.exe');
    candidates.push('C:\\Python313\\Scripts\\edge-tts.exe');
    candidates.push('C:\\Python312\\Scripts\\edge-tts.exe');
  } else {
    candidates.push('/usr/local/bin/edge-tts', '/usr/bin/edge-tts');
  }
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'edge-tts'; // último recurso: que lo busque en PATH
}

function findFfmpegExe() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  // En Windows el which puede ser lento, probamos comunes primero
  if (process.platform === 'win32') {
    const wingetBase = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    try {
      if (fs.existsSync(wingetBase)) {
        const entries = fs.readdirSync(wingetBase);
        const ff = entries.find(e => e.toLowerCase().startsWith('gyan.ffmpeg'));
        if (ff) {
          const pkgDir = path.join(wingetBase, ff);
          const sub = fs.readdirSync(pkgDir).find(e => e.toLowerCase().startsWith('ffmpeg-'));
          if (sub) {
            const bin = path.join(pkgDir, sub, 'bin', 'ffmpeg.exe');
            if (fs.existsSync(bin)) return bin;
          }
        }
      }
    } catch {}
  }
  return 'ffmpeg'; // lo busca en PATH
}

function mp3ToOpus(mp3Path) {
  return new Promise((resolve) => {
    const oggPath = mp3Path.replace(/\.mp3$/i, '.ogg');
    const ff = findFfmpegExe();
    const args = ['-y', '-loglevel', 'error', '-i', mp3Path, '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', oggPath];
    const proc = spawn(ff, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { log(`TTS[edge] ffmpeg error: ${e.message}`); resolve(null); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(oggPath)) {
        try { const buf = fs.readFileSync(oggPath); fs.unlinkSync(oggPath); resolve(buf); }
        catch { resolve(null); }
      } else {
        log(`TTS[edge] ffmpeg exit=${code} ${stderr.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

function textToSpeechEdge(text, profileName = 'default') {
  const ttsCfg = loadTtsConfig(profileName).edge;
  const tmpDir = path.join(os.tmpdir(), 'intrale-edge-tts');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const mp3Path = path.join(tmpDir, `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  const bin = findEdgeTtsExe();
  const input = text.substring(0, 5000);

  return new Promise((resolve) => {
    const args = [
      '--voice', ttsCfg.voice,
      '--rate', ttsCfg.rate || '+0%',
      '--pitch', ttsCfg.pitch || '+0Hz',
      '--text', input,
      '--write-media', mp3Path
    ];
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { log(`TTS[edge] error spawn: ${e.message}`); resolve(null); });
    proc.on('close', async (code) => {
      if (code !== 0 || !fs.existsSync(mp3Path)) {
        log(`TTS[edge] exit=${code} ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }
      // Convertir mp3 → opus ogg (Telegram voice message)
      const opusBuf = await mp3ToOpus(mp3Path);
      try { fs.unlinkSync(mp3Path); } catch {}
      if (opusBuf && opusBuf.length > 100) {
        log(`TTS[edge] generado: ${opusBuf.length} bytes (voz=${ttsCfg.voice})`);
        resolve(opusBuf);
      } else {
        log(`TTS[edge] conversion fallida`);
        resolve(null);
      }
    });
  });
}

// --- Sanitizer markdown → texto natural para TTS ---
// El TTS lee literal: "**bold**" se pronuncia "asterisco asterisco bold asterisco
// asterisco". Limpiamos antes de mandarle el chunk al provider.
function sanitizeForTts(text) {
  if (!text) return text;
  let s = String(text);
  // Bloques de código triple-backtick: descartarlos completamente.
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Inline code `xxx` → xxx
  s = s.replace(/`([^`]+)`/g, '$1');
  // Negrita **xxx** y __xxx__
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // Itálicas *xxx* y _xxx_ (cuidando de no romper identificadores con _ dentro)
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*([\s).,:;!?]|$)/g, '$1$2$3');
  s = s.replace(/(^|[\s(])_([^_\n]+)_([\s).,:;!?]|$)/g, '$1$2$3');
  // Links markdown [texto](url) → texto
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Headers (# ## ### al inicio de línea)
  s = s.replace(/^#{1,6}\s+/gm, '');
  // Blockquotes ">"
  s = s.replace(/^\s*>\s?/gm, '');
  // Tablas: separador --- | --- y filas con |
  // OJO: usar [ \t] en lugar de \s para no engullir \n (la clase con \s greedy
  // pegaba las filas adyacentes al separador).
  s = s.replace(/^[ \t|:\-]+$/gm, '');
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, inner) =>
    inner
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(', ')
  );
  // Bullets/numeradas al inicio de línea
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  // Asteriscos sueltos remanentes (énfasis sin cierre, separadores)
  s = s.replace(/\*+/g, '');
  // Backticks remanentes
  s = s.replace(/`+/g, '');
  // Tildes de tachado ~~xxx~~
  s = s.replace(/~~/g, '');
  // Saltos triples → dobles
  s = s.replace(/\n{3,}/g, '\n\n');
  // Espacios múltiples
  s = s.replace(/[ \t]+/g, ' ');
  return s.trim();
}

// --- TTS con priorización dinámica + fallback ---

async function textToSpeechByProvider(provider, text, profileName = 'default') {
  const cleaned = sanitizeForTts(text);
  if (provider === 'openai') return textToSpeechOpenAI(cleaned, profileName);
  if (provider === 'edge') return textToSpeechEdge(cleaned, profileName);
  log(`TTS: provider desconocido '${provider}'`);
  return null;
}

/**
 * Retorna { buffer, provider, profile } donde provider es el que efectivamente
 * generó el audio y profile es el nombre del perfil usado. Null si ambos fallaron.
 * @param {string} text
 * @param {{ profile?: string }} [opts]
 */
async function textToSpeechWithMeta(text, opts = {}) {
  const profileName = opts.profile || 'default';
  const cfg = loadTtsConfig(profileName);
  const forced = process.env.TTS_PROVIDER;
  if (forced) {
    log(`TTS[${profileName}] forzado por env: ${forced}`);
    const buf = await textToSpeechByProvider(forced, text, profileName);
    return buf ? { buffer: buf, provider: forced, profile: profileName } : null;
  }

  const primary = cfg.primary || 'openai';
  log(`TTS[${profileName}]: intentando primary=${primary}`);
  const bufPrimary = await textToSpeechByProvider(primary, text, profileName);
  if (bufPrimary) return { buffer: bufPrimary, provider: primary, profile: profileName };

  const fallback = cfg.fallback;
  if (!fallback || fallback === primary) {
    log(`TTS[${profileName}]: primary fallo y no hay fallback distinto`);
    return null;
  }
  log(`TTS[${profileName}]: primary fallo, probando fallback=${fallback}`);
  const bufFallback = await textToSpeechByProvider(fallback, text, profileName);
  return bufFallback ? { buffer: bufFallback, provider: fallback, profile: profileName } : null;
}

/**
 * Compat: signature histórica que retorna solo el buffer.
 * @param {string} text
 * @param {{ profile?: string }} [opts]
 */
async function textToSpeech(text, opts = {}) {
  const meta = await textToSpeechWithMeta(text, opts);
  return meta ? meta.buffer : null;
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

// Partir texto en chunks para TTS respetando límites de oraciones
function splitTextForTTSChunks(text, maxChars) {
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

module.exports = {
  preprocessMessage,
  transcribeAudio,
  transcribeAudioWithFallback,
  transcriptionFailureMessage,
  describeImage,
  downloadTelegramFile,
  textToSpeech,
  textToSpeechWithMeta,
  textToSpeechOpenAI,
  textToSpeechEdge,
  loadTtsConfig,
  loadTtsState,
  saveTtsState,
  getTransitionIntro,
  sendVoiceTelegram,
  splitTextForTTSChunks,
  sanitizeForTts
};
