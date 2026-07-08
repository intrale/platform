# Política de audio TTS por tipo de evento (#4586)

## Problema

Antes del #4586 el audio TTS estaba gobernado por un flag "global"
(`deliverable_notifications.audio_enabled`). Cuando estaba en `true`, **toda**
notificación de entregable de agente (guru, po, ux, tester, dev, build, …)
generaba audio y lo posteaba al mismo chat. El resultado: el audio de cada
agente se mezclaba con la conversación del operador con el Commander (los audios
personalizados que el operador envía y las respuestas), volviéndose difícil
encontrar la respuesta real. El audio de todos los agentes es **log, no algo que
requiera atención**.

## Principio

> **Audio para lo que necesita atención/acción del operador; texto para el
> firehose informativo.**

## Palanca 1 — Audio por tipo de evento

El motor es `.pipeline/lib/audio-policy.js`:

```js
const { EVENT, shouldEmitAudio } = require('./lib/audio-policy');
shouldEmitAudio(config.audio_policy, EVENT.AGENT_DELIVERABLE); // → false por default
```

### Config (`config.yaml → audio_policy`)

```yaml
audio_policy:
  enabled: true          # false → apaga TODA la política
  kill_switch: false     # corte en caliente de TODO el audio
  by_event:
    commander_reply:   true   # respuestas del Commander al operador
    rejection_report:  true   # reportes de rechazo (obligatorio)
    status:            true   # /status y snapshots (obligatorio)
    gate_signature:    true   # firma de gates (épico #4570, futuro)
    agent_deliverable: false  # 🔇 firehose de agentes → texto-only
    cua_stage:         false  # 🔇 stages de comandos CUA → texto-only
```

### Precedencia (`shouldEmitAudio`)

1. `kill_switch === true` → sin audio (corta todo).
2. `enabled === false` → sin audio.
3. `by_event[<evento>]` declarado → gana (`=== true`).
4. Default del módulo (`DEFAULT_BY_EVENT`): atención=ON, firehose=OFF.
5. Evento desconocido → `false` (conservador).

### Wiring

| Evento | Path | Cómo consulta la política |
|--------|------|---------------------------|
| `agent_deliverable` | `deliverable-notify.notify()` (vía pulpo) | `resolveEventAudio(cfg, audioPolicy, AGENT_DELIVERABLE)` |
| `cua_stage` | `deliverable-notify.notifyCua()` (vía commander) | `resolveEventAudio(cfg, audioPolicy, CUA_STAGE)` |
| `commander_reply` | Commander (path propio) | audio conservado |
| `rejection_report` | `rejection-report.js` (path propio) | audio conservado |
| `status` | `commander-deterministic.js` (path propio) | audio conservado |

`resolveEventAudio` tiene **back-compat**: si el caller no pasa `audioPolicy`
(tests/callers legacy), cae al flag histórico `cfg.audio_enabled` +
`cfg.kill_switch_audio` scoped al bloque de config. Por eso los 22 tests previos
del #3539 siguen verdes sin cambios.

## Palanca 2a — Separar el firehose de la conversación (Telegram topics)

Usa `message_thread_id` (forum topics) para aislar dos hilos en el mismo grupo:

- 💬 **Conversación** — operador ↔ Commander (General, sin thread).
- 🏭 **Entregables pipeline** — notis de agentes (thread configurado).

### Config (`deliverable_notifications.telegram_thread_id`)

```yaml
deliverable_notifications:
  telegram_thread_id: null   # id numérico del forum topic; null = sin thread
```

- `deliverable-notify.notify()` inyecta `message_thread_id` en cada dropfile si
  el config declara un id entero positivo (`resolveThreadId`).
- `servicio-telegram.js` forwarda `message_thread_id` en `sendMessage`,
  multipart (document/photo/video/animation) y en el consolidado de burst
  (`normalizeThreadId`). En burst, sólo se aplica si **todos** los archivos del
  grupo comparten el mismo thread; si mezclan o falta, va al General.
- Default `null` → comportamiento de hoy (sin thread). **Rollout gradual**:
  requiere activar "Topics" en el grupo de Telegram y crear el hilo
  "🏭 Entregables pipeline", luego poner su id numérico en el config.

## Rollout / corte en caliente

- Apagar TODO el audio sin reiniciar: `audio_policy.kill_switch: true`.
- Re-habilitar audio de agentes (revertir #4586): `by_event.agent_deliverable: true`.
- El flag legacy `deliverable_notifications.audio_enabled` queda en `false`
  como defensa; la política es la fuente de verdad en producción.
