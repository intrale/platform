# Clips pregrabados — aviso de cadena de IA caída (#6144)

Entregable de UX para **CA-13 / D8**: el último recurso de audio cuando la
generación TTS en vivo no puede completarse (típicamente porque la caída de la
cadena es por conectividad, y `edge-tts` también necesita red).

## Contenido

| Archivo | Causa dominante | Duración |
|---|---|---|
| `reposo.ogg` | `CAUSE_REPOSO` — pausada por horario | 21.3 s |
| `cuota.ogg` | `CAUSE_CUOTA` — cupo agotado | 23.8 s |
| `transitoria.ogg` | `CAUSE_TRANSITORIA` — caída temporal | 24.2 s |
| `auth.ogg` | `CAUSE_AUTH` — problema de acceso | 22.4 s |
| `generico.ogg` | causa `stale` / desconocida (D6 / CA-19) | 19.2 s |

- `copy.json` — **fuente de verdad del copy**. Texto de Telegram y guion hablado.
- `generate-clips.js` — regenera los 5 `.ogg` desde `copy.json`.
- `validate-copy.js` — valida el copy contra CA-3, CA-4, CA-5, CA-6, CA-7, CA-11.

## Formato

Idéntico al que produce `mp3ToOpus` en runtime (`.pipeline/multimedia.js`), para
que un clip sea indistinguible de un voice note sintetizado en vivo:

```
ogg/opus · 48 kHz · -b:a 48k · -vbr on · sin metadatos (-map_metadata -1)
```

Voz: perfil **`need-human`** de `.pipeline/tts-config.json` (`es-AR-ElenaNeural`,
`+0%`, `+0Hz`) — D5 / CA-10. **No** usar el perfil `default` (voz conversacional):
esto es una alerta de sistema.

## Decisiones de UX que el implementador NO debe alterar

1. **Los clips no llevan hora.** Son estáticos; una hora grabada sería mentira en
   cuanto cambie la ventana. El clip de `reposo` remite explícitamente al texto,
   que sí lleva la hora exacta (CA-3). `validate-copy.js` falla si aparece
   cualquier dígito en un guion de clip.
2. **Encabezado fijo `"Aviso del sistema."`** en los 5 guiones — funciona como
   earcon verbal: el operador reconoce de qué se trata en el primer segundo, sin
   escuchar el resto. Mismo patrón que `buildNeedHumanAudioText`.
3. **El guion hablado no dice `/status`.** Leído en voz alta, "barra status" es
   ruido. El guion dice *"los comandos de estado siguen respondiendo"*; el texto
   sí lista los comandos, que en Telegram son tappables.
4. **Orden de las cuatro partes** (CA-1): qué pasó → qué sigue vivo → qué pasó con
   tu pedido → cuándo vuelve. El "qué sigue vivo" va segundo a propósito: es lo
   que baja la ansiedad del operador antes de contarle que su pedido se perdió.
5. **Sin eufemismos en el descarte** (D3): *"Tu mensaje no quedó encolado"*, no
   *"lo estoy procesando"*.

## Regeneración

```bash
export EDGE_TTS_BIN=".../edge-tts.exe"   # ejecutable real, nunca un .cmd (REQ-SEC-4)
export FFMPEG_BIN=".../ffmpeg.exe"
node .pipeline/assets/audio/provider-down/validate-copy.js   # primero validar el copy
node .pipeline/assets/audio/provider-down/generate-clips.js  # luego sintetizar
```

Si se edita el copy, **regenerar los clips en el mismo commit**: un `copy.json`
desincronizado de los `.ogg` hace que el operador escuche algo distinto de lo que
lee, que es exactamente el problema que #6144 viene a resolver.

## Nota sobre el `/` en el copy (conflicto CA-1(b) ↔ CA-21)

CA-1(b) exige nombrar `/status`, `/listado` y `/lanzar`; CA-21 prohíbe el
carácter `/` en el mensaje. Ambos no pueden cumplirse literalmente a la vez.
Resolución de UX, aplicada en `copy.json` y en `validate-copy.js`:

- **Guion hablado:** cero `/`. CA-21 se cumple de forma estricta.
- **Texto:** `/` permitido **sólo** para la allowlist `/status`, `/listado`,
  `/lanzar`. El test de no-fuga debe contar los slashes y restar los de la
  allowlist, en vez de rechazar cualquier `/`.

Detalle en el comentario de UX del issue #6144.
