# Stack multimedia gratuito del Commander (EP1-H2 · #3917)

> Parte de la épica EP-1 (#3915) — "Formalizar el stack 100% gratuito".
> Estado: STT local primario + Edge TTS motor oficial. OpenAI/ElevenLabs
> retirados de la cadena multimedia (STT/TTS).

## Resumen

La cadena multimedia del Commander (transcripción de audios entrantes + narración
de respuestas por Telegram) corre **100% sobre motores gratuitos**:

| Función | Motor oficial | Implementación |
|---|---|---|
| STT (audio → texto) | **whisper local** (offline) | `.pipeline/lib/whisper-local.js` |
| TTS (texto → voz) | **Edge TTS** (Microsoft, gratis) | `.pipeline/multimedia.js` → `textToSpeechEdge` |
| Vision (imagen → texto) | Anthropic Vision | sin cambios (#3917 no toca Vision) |

Ninguna ruta de STT/TTS llama a `api.openai.com` ni a ElevenLabs. La key paga
ya no se lee en la cadena multimedia.

## STT — whisper local como primario

Antes de #3917, `transcribeAudioWithFallback()` intentaba **OpenAI primero**
(`api.openai.com/v1/audio/transcriptions`) y caía a whisper local solo ante
`quota/auth/network`. Con la cuota de OpenAI muerta (429), cada audio pagaba la
latencia + ruido de error del primario caído antes del fallback.

Ahora `transcribeAudioWithFallback()` invoca **whisper local directamente**. La
firma y el shape de retorno (`{ok, text, source, errorKind, raw}`) se conservan,
y `source` queda fijo en `'local'`. La **arquitectura de fallback se mantiene**
como punto de extensión: si mañana se suma otro motor STT gratuito, el orquestador
es donde se enchufa.

- Patrón seguro conservado (validado por security): `spawn` con array sin shell,
  temp files con nombre random (`crypto.randomBytes`), cleanup de input/output.
- Mensajes de error (`transcriptionFailureMessage()`) reescritos: hablan del
  motor local (`no_binary`, `cli_error`, `timeout`, etc.), sin referencias a
  "cuota OpenAI"/"key OpenAI".
- Requisito de runtime: whisper local instalado (`pip install -U openai-whisper`).
  #3916 (faster-whisper `large-v3-turbo` int8) mejora la calidad del motor
  interno después — cambio aislado a `whisper-local.js`, no afecta este contrato.

## TTS — Edge como motor oficial y único

Los **13 perfiles** de `.pipeline/tts-config.json` tienen `primary: "edge"` y
`fallback: null`. El `DEFAULT_PROFILE` hardcodeado en `multimedia.js` también.

- La **arquitectura de fallback se conserva**: `textToSpeechWithMeta()` sigue
  soportando `fallback` apuntando a un futuro motor gratuito. Hoy `fallback: null`
  porque hay un solo motor. No se eliminó código de orquestación, solo config.
- Se retiró la función `textToSpeechOpenAI` y la ruta al endpoint pago.
- Se retiraron las **intros de cambio de personaje** (Claudito↔Tommy): con motor
  único no hay transición de voz que narrar. `getTransitionIntro()` conserva la
  firma (pulpo.js la invoca) pero retorna siempre `null`.
- **Sanitizador pre-TTS obligatorio**: toda ruta a Edge pasa por
  `lib/text-to-speech-adapter.js` (#2958), que redacta secretos (JWT/AWS keys/
  tokens) antes de salir al endpoint de Microsoft. Esto vale para el flujo vivo
  (`.pipeline/multimedia.js`) y para el handler legacy del Commander
  (`.claude/hooks/commander/multimedia-handler.js`), que ahora delega la narración
  a `.pipeline/multimedia.js` y hereda el sanitizador sin duplicar lógica.

Cada perfil conserva su voz/rate/pitch y personalidad propias (ver
`entregables-multimedia-por-agente.md`).

## Handler legacy del Commander

`.claude/hooks/commander/multimedia-handler.js` es código legacy del Commander
pre-Pulpo (lo referencia solo `callback-handler.js`, también legacy). Se le
**vaciaron las rutas OpenAI pagas**:

- `callOpenAITranscription` → reemplazado por `transcribeAudioLocal` (whisper local).
- `callOpenAITTS` → eliminado; `callTTS` ahora delega a Edge vía `.pipeline/multimedia.js`.
- `handleVoiceOrAudio` ya no exige `openai_api_key`; gatea por disponibilidad del
  binario whisper local.
- El `_config` del handler ya no define `openaiApiKey`/`transcriptionModel`/
  `ttsModel`/`ttsVoice`. Cero `Bearer` de OpenAI en el archivo.

## ElevenLabs — deprecación

ElevenLabs no tiene **ninguna invocación en código activo** (lo retiró #3830 de
`secrets-rw.MANAGED_KEYS`, dashboard y health-cron). Restos retirados en #3917:

- Fixtures stale en tests: `views/dashboard/__tests__/providers.test.js` (ya no
  itera `'elevenlabs'`) y `tests/dashboard/wizard-providers-flow.test.js` (el
  fixture de preservación de campos no-provider usa `_version` en vez de
  `multimedia.elevenlabs_voice_id`).

Retiro de credenciales (paso operativo manual — ver sección siguiente):
`~/.claude/secrets/credentials.json` → bloque `multimedia.{elevenlabs_api_key,
elevenlabs_voice_id}`.

## ⚠️ Credenciales: hallazgo crítico sobre la key de OpenAI

El issue (CA-2) pedía retirar Y **revocar** la `openai_api_key` "multimedia".
La verificación empírica en HEAD descubrió un dato que el análisis previo no
contempló y que **cambia el procedimiento**:

**La `openai_api_key` de `telegram-config.json` es la MISMA key física que
`credentials.json` → `providers.openai.api_key`**, que es la credencial activa
del provider LLM **openai-codex**.

- Cadena verificada: `hydrate-provider-env.js` hidrata `OPENAI_API_KEY` vía
  `loadApiKeys`, cuya precedencia (#3311) es
  `ENV > credentials.json providers.openai.api_key > telegram-config.json openai_api_key`.
  Codex toma la key de `credentials.json` (mayor precedencia); la de
  `telegram-config.json` es una **copia flat duplicada** de menor precedencia.

Consecuencias operativas:

1. **Quitar `openai_api_key` (flat) de `telegram-config.json` es SEGURO**: Codex
   sigue autenticando con `credentials.json providers.openai.api_key`. Esto
   elimina la copia duplicada (reduce exposición residual) sin romper el LLM.
2. **NO se debe revocar la key de OpenAI en el panel**: revocarla mataría
   `openai-codex` (provider LLM activo). El requisito de "revocación" del CA-2
   **no aplica a esta key** mientras Codex la use. El retiro de la cadena
   multimedia se logra a nivel **código** (multimedia ya no la lee) + retiro de
   la copia duplicada de `telegram-config.json`.
3. **NO tocar `credentials.json providers.openai.api_key`** ni `agent-models.json`
   (multi-provider LLM intacto).

### Pasos manuales pendientes para el operador (Leo)

> No los ejecuta el dev: tocan secrets vivos del pipeline en `~/.claude/secrets/`
> y requieren decisión humana. El código de #3917 ya deja la cadena multimedia
> sin leer estas keys, así que estos pasos son hardening, no funcionales.

1. `~/.claude/secrets/telegram-config.json`: retirar el campo flat
   `openai_api_key` (duplicado; Codex usa el de `credentials.json`). Verificar
   después que `credentials-precheck` quede verde y `openai-codex` siga operativo.
2. `~/.claude/secrets/credentials.json`: retirar el bloque `multimedia`
   (`elevenlabs_api_key` vacío + `elevenlabs_voice_id`). NO tocar `providers.*`.
3. ElevenLabs: si alguna vez existió una key real, revocarla en el panel de
   ElevenLabs. La `elevenlabs_api_key` actual está vacía.
4. OpenAI: **no revocar** mientras `openai-codex` use la key (ver punto 2 del
   hallazgo). Si en el futuro se migra Codex a otra credencial, ahí sí se puede
   revocar la vieja.

(Este doc no contiene valores de keys ni `voice_id` reales — requisito de
security #4.)

## Verificación (DoD)

- `grep "api.openai.com" .pipeline/multimedia.js .claude/hooks/commander/` → 0 en
  rutas STT/TTS activas.
- `tts-config.json`: 13 perfiles `primary: edge`, `fallback: null`.
- Tests del pipeline en verde (incluidos los fixtures limpiados).
- `credentials-precheck` verde + boot del Pulpo sin errores (regresión LLM).
