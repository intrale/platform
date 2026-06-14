// multimedia.js — Preprocesamiento de multimedia para el Commander V2
// Transcribe audio (whisper local, motor gratuito) y describe imágenes (Anthropic Vision)
// Se ejecuta ANTES de pasar el mensaje a Claude
//
// EP1-H2 (#3917): el STT corre 100% en whisper local — sin llamadas a APIs pagas.
// La cadena de fallback se conserva como arquitectura para futuros motores
// gratuitos, hoy con un solo motor (local).

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TG_CONFIG_PATH = path.join(ROOT, '.claude', 'hooks', 'telegram-config.json');
const { loadTelegramSecrets, loadApiKeys } = require('./lib/telegram-secrets');
const { transcribeLocal: whisperLocal, isAvailable: whisperLocalAvailable } = require('./lib/whisper-local');

// Merge en 3 capas para que TTS/STT/Vision nunca se rompa por la migracion
// del archivo committed a placeholders:
//   - base = archivo committed (configs no-secretas: voice_id, retries, etc.)
//   - bot_token + chat_id desde el helper de secrets criticos (home preferido)
//   - api keys (Anthropic, sólo para Vision) desde loadApiKeys (ENV → home → legacy)
// Cualquier valor del home pisa el placeholder vacio del archivo committed.
// EP1-H2 (#3917): la openai_api_key dejó de leerse — STT/TTS son 100% gratuitos.
function loadConfig() {
  let base = {};
  try { base = JSON.parse(fs.readFileSync(TG_CONFIG_PATH, 'utf8')); } catch {}
  try {
    const sec = loadTelegramSecrets({ legacyConfigPath: TG_CONFIG_PATH });
    base.bot_token = sec.bot_token;
    base.chat_id = sec.chat_id;
  } catch {}
  const keys = loadApiKeys({ legacyConfigPath: TG_CONFIG_PATH });
  if (keys.anthropic_api_key) base.anthropic_api_key = keys.anthropic_api_key;
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

// --- Whisper local transcription (motor primario, gratuito) ---
// EP1-H2 (#3917): el STT corre 100% en whisper local (`lib/whisper-local.js`).
// Ya no hay llamada a APIs pagas: cada audio se transcribe offline sin pagar la
// latencia muerta de un primario caído.
//
// Devuelve siempre {ok, text, source, errorKind, raw} para que el caller degrade
// con gracia. errorKind (cuando ok=false) ∈ los del motor local:
// {'no_binary','no_input','missing_file','spawn_error','timeout','cli_error',
//  'no_output','read_error','unavailable'}.
//
// La firma conserva el shape histórico (audioBuffer, audioPath, filename) y el
// campo `source` para que el resto del pipeline (logs, extras) siga auditando
// qué motor respondió. La arquitectura de fallback se mantiene: si mañana se
// suma otro motor gratuito, este orquestador es el punto de extensión.
async function transcribeAudioWithFallback(audioBuffer, audioPath, filename) { // eslint-disable-line no-unused-vars
  if (!whisperLocalAvailable()) {
    log('whisper local no está disponible (binario ausente)');
    return { ok: false, text: '', source: 'local', errorKind: 'unavailable', raw: 'whisper CLI no encontrado' };
  }

  const localResult = await whisperLocal({ audioPath, audioBuffer, logger: log });
  if (localResult.ok) {
    // #3918: propagamos `confidence` cuando el motor local la expone (whisper
    // local deriva la métrica de los logprobs del JSON). Extensión aditiva: si
    // el motor no la trae, queda undefined → "confianza desconocida".
    const out = { ok: true, text: localResult.text, source: 'local' };
    if (localResult.confidence) out.confidence = localResult.confidence;
    return out;
  }
  return { ...localResult, source: 'local' };
}

// Mensaje human-friendly que va a Telegram cuando whisper local no pudo
// transcribir. Es lo que va a leer Leo, así que tiene que ser breve y accionable.
// El segundo parámetro se mantiene por compat de firma (callers históricos que
// pasaban localErrorKind); hoy el único motor es el local, así que el errorKind
// ya describe el fallo real.
function transcriptionFailureMessage(errorKind, _localErrorKind = null) {
  switch (errorKind) {
    case 'unavailable':
    case 'no_binary':   return '🎤 Audio recibido. El motor de transcripción local (whisper) no está instalado en la máquina — repetímelo por texto cuando puedas. Para habilitarlo: `pip install -U openai-whisper`.';
    case 'cli_error':   return '🎤 Audio recibido. Whisper local crasheó (probable falta de memoria con audio largo) — repetímelo por texto, o reenvialo más cortito. Si persiste: bajar `WHISPER_LOCAL_MODEL` a `small` o reiniciar la máquina.';
    case 'timeout':     return '🎤 Audio recibido. La transcripción local se colgó (timeout) — repetímelo por texto, o reenvialo más cortito.';
    case 'no_output':
    case 'read_error':  return '🎤 Audio recibido pero whisper local no devolvió texto — repetímelo por texto cuando puedas.';
    case 'no_input':
    case 'missing_file':return '🎤 Audio recibido pero no encontré el archivo para transcribir — reintentá o repetímelo por texto.';
    case 'spawn_error': return '🎤 Audio recibido. No pude lanzar whisper local — repetímelo por texto. Revisá que `WHISPER_LOCAL_BIN`/PATH apunten al binario.';
    default:            return '🎤 Audio recibido pero no pude transcribirlo — repetímelo por texto cuando puedas.';
  }
}

// EP1-H4 (#3919): mensajes de degradación TTS — el espejo de salida de
// transcriptionFailureMessage. Cuando la síntesis de voz falla y la respuesta
// sale solo por texto, hoy falla en silencio; este enum CERRADO de mensajes
// curados es lo que ve el usuario.
//
// SEC-1/SEC-2: PROHIBIDO interpolar e.message/raw del motor Edge, paths,
// nombres de archivos temporales, tokens ni API keys. El mensaje se construye
// SOLO a partir de esta tabla de literales — sin variables de runtime. El `raw`
// del motor ya se loguea internamente; al usuario va solo motivo + modo.
// UX (#3919): emoji 🔇 (silencio = "no pude hablarte"), motivo humano y la
// frase "Te respondo solo por texto" SIEMPRE presente (corazón de CA-2).
// SEC-3: sin Markdown — se despacha vía sendTelegramPlain.
const TTS_DEGRADED_MESSAGES = {
  unavailable: '🔇 El motor de voz (Edge TTS) no está disponible ahora mismo. Te respondo solo por texto.',
  no_binary:   '🔇 El motor de voz (Edge TTS) no está disponible ahora mismo. Te respondo solo por texto.',
  timeout:     '🔇 La síntesis de voz se colgó (timeout). Te respondo solo por texto — probá de nuevo en un rato.',
  cli_error:   '🔇 No pude generar el audio de la respuesta. Te respondo solo por texto.',
  spawn_error: '🔇 No pude generar el audio de la respuesta. Te respondo solo por texto.',
  conversion:  '🔇 No pude convertir el audio de la respuesta a un formato reproducible. Te respondo solo por texto.',
  unknown:     '🔇 No pude pasar la respuesta a audio. Te respondo solo por texto.',
};

// errorKind → mensaje canned. `null` de textToSpeechWithMeta no trae kind, así
// que los callers pasan el mejor esfuerzo (típicamente 'unknown'). Cualquier
// kind no listado cae a 'unknown' (defensa: nunca interpola input externo).
function ttsDegradedMessage(errorKind) {
  return TTS_DEGRADED_MESSAGES[errorKind] || TTS_DEGRADED_MESSAGES.unknown;
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
        log(`Transcripcion [whisper local]: "${tx.text.slice(0, 100)}"`);
        result.text = tx.text;
        result.extras.push('(mensaje de voz transcripto · whisper local)');
        // #3918 (CA-1/CA-2/CA-3): además de ok/source, propagamos la
        // transcripción cruda (para el eco, sin el sufijo de `extras`) y la
        // confianza (para el gate de confirmación). `confidence` es null cuando
        // el parseo del JSON local no derivó métricas.
        result.audio = {
          ok: true,
          source: tx.source,
          transcript: tx.text,
          confidence: tx.confidence || null,
        };
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
//
// EP1-H2 (#3917): Edge TTS es el motor oficial y único. La arquitectura de
// fallback se conserva (`fallback` puede apuntar a un futuro motor gratuito),
// hoy con `fallback: null` porque sólo existe un motor.
const DEFAULT_PROFILE = {
  primary: 'edge',
  fallback: null,
  edge: {
    voice: 'es-AR-TomasNeural',
    rate: '+8%',
    pitch: '+4Hz',
    character_name: 'Tommy',
    personality: 'Sos Tommy, un pibe joven que recién arranca en el equipo. Tenés la frescura de la juventud, hablas con energía, onda y entusiasmo. Usas vos, che, dale, mira. Sos piola, curioso, con ganas de aprender. Nunca sos engreído — tenés el respeto del que recién se inicia pero la garra de querer comerse la cancha.'
  }
};

/**
 * Carga un perfil TTS por nombre. Soporta dos shapes de tts-config.json:
 *   - Nuevo: { profiles: { default: {...}, qa: {...}, ... } }
 *   - Viejo: { primary, fallback, providers: { edge }, ... } → interpretado como profiles.default
 * Si el perfil pedido no existe, cae a `default`. Si tampoco hay default, usa DEFAULT_PROFILE hardcoded.
 * Retorna objeto con { primary, fallback, edge, profileName, profileFound }.
 * EP1-H2 (#3917): motor único Edge — ya no se exponen `openai` ni `intros`.
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
      edge: raw.providers?.edge,
    };
  }

  if (!profileRaw) {
    return { ...DEFAULT_PROFILE, profileName: 'default', profileFound: false };
  }

  // Motor único Edge: aunque un perfil legacy declare primary='openai', lo
  // normalizamos a 'edge' para no intentar un motor pago que ya no existe.
  return {
    primary: 'edge',
    fallback: null,
    edge: { ...DEFAULT_PROFILE.edge, ...(profileRaw.edge || {}) },
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

// --- EP1-H4 (#3919): dedup de avisos de degradación multimedia (CA-3 / SEC-4) ---
//
// Mantiene como mucho 1 aviso por ventana para cada (chat_id, tipo) con
// tipo ∈ {'stt','tts'}. SEC-4: el estado guarda SOLO timestamps (jamás el
// contenido del mensaje ni la transcripción), purga entradas vencidas para no
// crecer sin límite frente a chat_id externo (Telegram), tolera archivo
// corrupto sin romper el canal y escribe de forma atómica (write-tmp + rename)
// por ser pipeline event-driven con escrituras concurrentes.
const DEGRADATION_STATE_PATH = path.join(ROOT, '.pipeline', '.degradation-notify-state.json');
// Ventana de partida: 2 min, alineada con el debounce de quotaNotifier.
const DEGRADATION_WINDOW_MS = 2 * 60 * 1000;

function degradationKey(chatId, tipo) {
  return `${chatId}:${tipo}`;
}

function loadDegradationState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEGRADATION_STATE_PATH, 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw;
    return { entries: {} };
  } catch { return { entries: {} }; }
}

function saveDegradationState(state) {
  const safe = (state && typeof state === 'object' && state.entries) ? state : { entries: {} };
  try {
    const tmp = `${DEGRADATION_STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, DEGRADATION_STATE_PATH);
  } catch (e) { log(`Degradation state save error: ${e.message}`); }
}

// Pura (sin I/O): decide si corresponde notificar y devuelve el próximo estado.
// Purga entradas vencidas (cota de crecimiento). windowMs configurable para tests.
// Aislamiento por (chat_id, tipo): un aviso STT no suprime uno TTS, ni un chat
// suprime a otro.
function shouldNotifyDegradation(stateObj, chatId, tipo, nowMs, windowMs = DEGRADATION_WINDOW_MS) {
  const entries = (stateObj && typeof stateObj === 'object' && stateObj.entries && typeof stateObj.entries === 'object')
    ? stateObj.entries
    : {};
  // Purga: conservar solo timestamps numéricos dentro de la ventana.
  const pruned = {};
  for (const [k, ts] of Object.entries(entries)) {
    if (typeof ts === 'number' && (nowMs - ts) < windowMs) pruned[k] = ts;
  }
  const key = degradationKey(chatId, tipo);
  const last = pruned[key];
  const notify = !(typeof last === 'number' && (nowMs - last) < windowMs);
  const nextEntries = { ...pruned };
  if (notify) nextEntries[key] = nowMs;
  return { notify, nextState: { entries: nextEntries } };
}

// Wrapper con I/O: carga estado, decide, persiste (siempre, así la purga acota
// el crecimiento aun en avisos deduplicados) y retorna si hay que notificar.
function notifyDegradationOnce(chatId, tipo, nowMs = Date.now(), windowMs = DEGRADATION_WINDOW_MS) {
  const state = loadDegradationState();
  const { notify, nextState } = shouldNotifyDegradation(state, chatId, tipo, nowMs, windowMs);
  saveDegradationState(nextState);
  return notify;
}

// EP1-H2 (#3917): con un único motor TTS (Edge) ya no hay transiciones de
// personaje (Claudito↔Tommy). Se conserva la firma porque pulpo.js la invoca,
// pero retorna siempre null — no hay intro de cambio de motor que narrar.
function getTransitionIntro(_newProvider, _prevProvider, _profileName = 'default') { // eslint-disable-line no-unused-vars
  return null;
}

// --- (legacy) OpenAI TTS removido en EP1-H2 (#3917) ---
// La función `textToSpeechOpenAI` y su llamada al endpoint pago de OpenAI fueron retiradas:
// Edge es el motor oficial y único. La arquitectura de fallback (textToSpeechWithMeta)
// se conserva para sumar futuros motores gratuitos sin reescribir el orquestador.

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

// #3485: estimación de duración para detectar truncado interno de Edge TTS.
// Para español, ~15 chars/seg es una regla pragmática que aproxima el ritmo
// natural de la voz "es-AR" usada. Útil como leading indicator si el archivo
// generado sale más corto de lo esperado.
function estimateTtsDurationSec(chars) {
  return Math.max(1, Math.round(chars / 15));
}

function formatChunkInfo(chunkInfo) {
  if (!chunkInfo || typeof chunkInfo.index !== 'number' || typeof chunkInfo.total !== 'number') return '';
  return ` chunk=${chunkInfo.index + 1}/${chunkInfo.total} total_parts=${chunkInfo.total}`;
}

function textToSpeechEdge(text, profileName = 'default', chunkInfo = null) {
  const ttsCfg = loadTtsConfig(profileName).edge;
  const tmpDir = path.join(os.tmpdir(), 'intrale-edge-tts');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const mp3Path = path.join(tmpDir, `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  const bin = findEdgeTtsExe();
  const input = text.substring(0, 5000);
  const estimatedSec = estimateTtsDurationSec(input.length);
  const chunkTag = formatChunkInfo(chunkInfo);

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
        log(`TTS[edge] generado: ${opusBuf.length} bytes (voz=${ttsCfg.voice}) chars=${input.length} duracion_est=${estimatedSec}s${chunkTag}`);
        resolve(opusBuf);
      } else {
        log(`TTS[edge] conversion fallida`);
        resolve(null);
      }
    });
  });
}

// --- Sanitizer markdown → texto natural para TTS ---
// Delegado al adaptador dedicado en lib/text-to-speech-adapter.js (issue #2958).
// El adaptador cubre: secretos (JWT/AWS keys/Telegram tokens), modelos IA,
// paths, hashes, URLs reformuladas, markdown, emojis, tablas a frase natural
// y resumen heuristico para inputs > 1500 chars. Idempotente.
const { sanitizeForTts: adapterSanitizeForTts } = require('./lib/text-to-speech-adapter');

function sanitizeForTts(text) {
  if (!text) return text;
  return adapterSanitizeForTts(text);
}

// --- TTS con priorización dinámica + fallback ---

async function textToSpeechByProvider(provider, text, profileName = 'default', chunkInfo = null) {
  const cleaned = sanitizeForTts(text);
  if (provider === 'edge') return textToSpeechEdge(cleaned, profileName, chunkInfo);
  // EP1-H2 (#3917): Edge es el único motor. Cualquier otro provider (incluido el
  // legacy 'openai') se trata como edge para no fallar audios por config vieja.
  log(`TTS: provider '${provider}' no soportado — usando edge (motor único)`);
  return textToSpeechEdge(cleaned, profileName, chunkInfo);
}

/**
 * Retorna { buffer, provider, profile } donde provider es el que efectivamente
 * generó el audio y profile es el nombre del perfil usado. Null si ambos fallaron.
 * @param {string} text
 * @param {{ profile?: string }} [opts]
 */
async function textToSpeechWithMeta(text, opts = {}) {
  const profileName = opts.profile || 'default';
  // #3485: chunkInfo opcional { index, total } para que el log del provider
  // identifique la pieza dentro de la respuesta total y permita detectar
  // truncados a futuro.
  const chunkInfo = opts.chunkInfo || null;
  const cfg = loadTtsConfig(profileName);
  const forced = process.env.TTS_PROVIDER;
  if (forced) {
    log(`TTS[${profileName}] forzado por env: ${forced}`);
    const buf = await textToSpeechByProvider(forced, text, profileName, chunkInfo);
    return buf ? { buffer: buf, provider: forced, profile: profileName } : null;
  }

  const primary = cfg.primary || 'edge';
  log(`TTS[${profileName}]: intentando primary=${primary}`);
  const bufPrimary = await textToSpeechByProvider(primary, text, profileName, chunkInfo);
  if (bufPrimary) return { buffer: bufPrimary, provider: primary, profile: profileName };

  const fallback = cfg.fallback;
  if (!fallback || fallback === primary) {
    log(`TTS[${profileName}]: primary fallo y no hay fallback distinto`);
    return null;
  }
  log(`TTS[${profileName}]: primary fallo, probando fallback=${fallback}`);
  const bufFallback = await textToSpeechByProvider(fallback, text, profileName, chunkInfo);
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

// Partir texto en chunks para TTS respetando límites de oraciones.
// Default 1500 chars: Edge TTS empieza a truncar audios internamente cerca de
// 2500-3000 chars en español; con 1500 más prefijo "Parte X de N. " (≤17 chars)
// el texto efectivo queda muy por debajo del umbral observado (margen ~1000).
// Issue #3485.
function splitTextForTTSChunks(text, maxChars = 1500) {
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
  transcribeAudioWithFallback,
  transcriptionFailureMessage,
  ttsDegradedMessage,
  TTS_DEGRADED_MESSAGES,
  shouldNotifyDegradation,
  notifyDegradationOnce,
  loadDegradationState,
  saveDegradationState,
  DEGRADATION_WINDOW_MS,
  describeImage,
  downloadTelegramFile,
  textToSpeech,
  textToSpeechWithMeta,
  textToSpeechEdge,
  loadTtsConfig,
  loadTtsState,
  saveTtsState,
  getTransitionIntro,
  sendVoiceTelegram,
  splitTextForTTSChunks,
  sanitizeForTts
};
