# Fix Modelo V2 — Tracking de Avance

> Ultima actualizacion: 2026-03-28T23:55

## Estado general

Branch: `fix/pulpo-telegram-retry`
Informe de gaps: `docs/informe-migracion-v1-v2.md`
Pendientes detallados: `docs/pendingsmodelov2.md`

## Resumen de sesion 2026-03-28

### Completado

**Pipeline core:**
- [x] Commander con 8 handlers nativos (/status, /help, /actividad, /intake, /pausar, /reanudar, /costos, /proponer)
- [x] Deteccion de intencion por lenguaje natural (para audio transcripto)
- [x] Sesion conversacional persistente (commander-session.json)
- [x] Historial con ventana de 24hs + rotacion automatica
- [x] Commander corre fuera del if(!paused) para /reanudar
- [x] Build timeout real con setTimeout + child.kill()
- [x] Max 3 retries en huerfanos, luego rechazo
- [x] Rate limiting GitHub API (2s entre calls)
- [x] Cleanup de worktrees al completar entrega
- [x] sendTelegram migrado a encolado fire-and-forget
- [x] Rol hotfix.md + config

**Multimedia (audio/imagen):**
- [x] STT Whisper funcional (transcripcion en 2-3s)
- [x] TTS OpenAI funcional (respuesta por audio)
- [x] Vision Anthropic (sin API key usa fallback a disco)
- [x] preprocessMessage usa paths locales del listener (no re-descarga)
- [x] Deduplicacion de mensajes por message_id en listener
- [x] await en enqueueMessage del listener (fix mensajes perdidos)

**Invocacion de Claude (critico):**
- [x] spawn async con stdin pipe + stream-json (patron V1)
- [x] --verbose requerido para stream-json
- [x] --permission-mode bypassPermissions para tools
- [x] Sin timeout — Claude trabaja todo lo que necesite
- [x] Mensajes de progreso cada 45s con contexto dinamico (8 templates unicos)
- [x] Siempre responder al usuario (nunca null)
- [x] Texto siempre encolado como backup del TTS

**Gestion de procesos:**
- [x] singleton.js basado en wmic (no PID file)
- [x] restart.js: kill all + relaunch + verify (node .pipeline/restart.js)
- [x] taskkill /F /T para tree kill
- [x] Recuperacion de mensajes trabados en trabajando/

### Evidencia de funcionamiento

- Audio STT + TTS: funciona (transcripcion 2-3s, TTS 5-8s)
- Handlers nativos: /status, /help, /pausar, /reanudar verificados
- Claude con tools: 60 tools ejecutadas en 629s, merge de PR exitoso
- Mensajes de progreso: cada 45s con contexto de la tool actual
- Dashboard verificado por audio command

### Pendiente

1. **Intake de issues**: crear issues con labels needs-definition/ready para probar circuito E2E
2. **Division de historias en planner**: sizing "grande" -> sub-issues
3. **Tracking real de tokens**: parsear usage del JSON de claude
4. **Servicio Drive**: requiere Google credentials
5. **Imagenes**: probar envio de foto por Telegram (sin Anthropic API key usa fallback)
6. **Dashboard**: no muestra actividad del commander ni servicios procesados
