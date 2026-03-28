# Informe Ejecutivo: Estado de la Migracion Pipeline V1 → V2

> Fecha: 2026-03-28 | Autor: Claude (analisis automatizado)

## Resumen

El Pipeline V2 tiene su **core funcional** (Pulpo con 5 brazos, filesystem como estado, servicios fire-and-forget), pero presenta **brechas significativas** entre lo disenado en `docs/pipeline-v2-diseno.md` y lo implementado. Las areas mas criticas son: el Commander Telegram opera sin parsing de comandos, el intake funciona pero no alimenta trabajo real, y faltan componentes completos (Drive, cleanup de worktrees, `/costos`).

---

## 1. Telegram Commander — Brechas Criticas

### 1.1 Despacho de comandos: NO EXISTE

**Diseno:** 8 comandos explicitos (`/status`, `/actividad`, `/intake`, `/proponer`, `/pausar`, `/reanudar`, `/costos`, `/help`, `/stop`)

**Realidad:** El Commander **no tiene parser ni handlers**. Todo el procesamiento se delega a Claude via `claude -p`, pasandole el prompt de `roles/commander.md` como system prompt. Claude debe:
- Interpretar si el mensaje es un comando
- Decidir que hacer
- Ejecutar la accion (leer directorios, crear archivos, etc.)

**Impacto:** Los comandos funcionan "a veces" porque dependen de que Claude interprete correctamente y tenga permisos para ejecutar. Errores observados en logs:
```
spawnSync claude ENOENT          → Claude CLI no en PATH
spawnSync cmd.exe ETIMEDOUT      → Timeout ejecutando comandos
```

### 1.2 Persistencia de contexto: INEXISTENTE

| Aspecto | V1 | V2 |
|---------|----|----|
| Sesiones | `tg-session-store.json` | No existe |
| Preguntas pendientes | `pending-questions.json` | No existe |
| Propuestas | `planner-proposals.json` | No existe |
| Contexto conversacional | Session manager con state | Solo ultimas 50 lineas de `commander-history.jsonl` |

Cada invocacion es **completamente stateless**. No hay continuidad entre turnos de conversacion.

### 1.3 Audio (STT/TTS): IMPLEMENTADO pero fragil

- **STT:** OpenAI Whisper — funcional, requiere `openai_api_key` en `telegram-config.json`
- **TTS:** OpenAI `gpt-4o-mini-tts` — funcional, voz "ash" con acento porteno
- **Problema:** Si no hay API key, el fallback es un mensaje placeholder, no un error claro
- **Problema:** El modelo TTS `gpt-4o-mini-tts` podria no existir en OpenAI

### 1.4 Imagenes (Vision): PARCIALMENTE IMPLEMENTADO

- **Recepcion:** Listener descarga fotos a `.pipeline/logs/media/`
- **Descripcion:** Anthropic Vision API (claude-haiku-4-5) — funcional
- **Envio de imagenes de vuelta:** NO implementado
- **Documentos:** Envio stubbeado en `servicio-telegram.js:78` (solo envia texto placeholder)

---

## 2. Intake de GitHub — Funcional pero desconectado

### 2.1 Mecanismo implementado

El Brazo Intake (`pulpo.js:692-760`) **si existe y funciona**:
- Polling cada 5 minutos via `gh issue list`
- Filtra por labels: `needs-definition` → pipeline definicion, `ready` → pipeline desarrollo
- Deduplicacion: verifica que el issue no este ya en el pipeline
- Crea archivos YAML en `pendiente/`

### 2.2 Por que no se alimenta de nada

**El problema no es el codigo sino el ecosistema:**
1. No hay issues en GitHub con label `needs-definition` o `ready` — nadie los esta generando
2. El pipeline de definicion (que produce issues `ready`) tampoco tiene input
3. Es un **circuito abierto**: intake funciona, pero no hay materia prima

### 2.3 Lo que falta respecto al diseno

| Feature disenada | Estado |
|------------------|--------|
| Intake automatico por labels | Implementado |
| Intake manual via `/intake` | Delegado a Claude (sin handler) |
| Conexion definicion → desarrollo | Implementada (via GitHub labels) |
| Backpressure si hay sobrecarga | No implementado |
| Dead-letter queue | No implementado |

---

## 3. Componentes completos vs. incompletos

### Implementado y funcional

| Componente | Archivo | Estado |
|------------|---------|--------|
| Pulpo (motor central) | `pulpo.js` (816 lineas) | 5 brazos operativos |
| Barrido (promocion de fases) | `pulpo.js:126-235` | Completo con rechazos |
| Lanzamiento de agentes | `pulpo.js:261-400` | Worktrees, concurrencia, PIDs |
| Deteccion de huerfanos | `pulpo.js:473-505` | Timeout 10min |
| Intake GitHub | `pulpo.js:692-760` | Polling 5min |
| Listener Telegram | `listener-telegram.js` (215 lineas) | Long-polling, multimedia |
| Servicio Telegram | `servicio-telegram.js` (106 lineas) | Envio de mensajes |
| Servicio GitHub | `servicio-github.js` (88 lineas) | Comentarios, labels |
| Dashboard | `dashboard-v2.js` (254 lineas) | Kanban web en puerto 3200 |
| Multimedia | `multimedia.js` (282 lineas) | STT, Vision, TTS |
| Config | `config.yaml` | Pipelines, fases, concurrencia |
| Roles (prompts) | `roles/*.md` (14 archivos) | Todos los skills definidos |
| Watchdog | `watchdog.ps1` | Resurrect procesos cada 2min |

### Parcialmente implementado

| Componente | Problema |
|------------|----------|
| **Commander** | Sin parser de comandos — todo delegado a Claude sin garantia |
| **Build phase** | `spawn()` no soporta `timeout` option — el timeout de 15min no se aplica realmente |
| **Envio de documentos** | Stubbeado en servicio-telegram (solo texto) |
| **Multimedia response** | Solo responde con audio SI el input fue audio; no puede enviar imagenes |

### NO implementado (gap critico)

| Componente | Diseno dice | Estado |
|------------|-------------|--------|
| **Cleanup de worktrees** | "El Pulpo lo limpia despues de la entrega" | No existe — worktrees se acumulan |
| **Servicio Drive** | Cola fire-and-forget para Google Drive | Stub completo |
| **`/costos`** | Reporte de consumo de tokens | No hay tracking de tokens |
| **Skill `cua`** | Video + evidencia QA | No hay rol `cua.md` |
| **Skill `hotfix`** | Developer urgente | No hay rol `hotfix.md` |
| **Planner: division de historias** | Si sizing = "grande" → dividir en sub-issues | No implementado |
| **Retry con backoff** | Huerfanos deberian tener max retries | Sin limite — retry infinito |
| **Rate limiting GitHub API** | Intake + determinarDevSkill hacen muchas calls | Sin throttling |

---

## 4. Bugs tecnicos detectados

| Bug | Ubicacion | Severidad |
|-----|-----------|-----------|
| `process.kill(pid, 0)` no funciona bien en Windows | `pulpo.js:105` | Alta |
| `spawn()` no acepta `timeout` option | `pulpo.js:421` | Alta |
| Race condition en concurrencia | `pulpo.js:280` | Media |
| `sendTelegramSync` usa `execSync` con subproceso node inline | `pulpo.js:633-669` | Media |

---

## 5. Plan de Accion Recomendado

### Fase A — Hacer funcionar el circuito completo (Prioridad Critica)

| # | Tarea | Esfuerzo | Impacto |
|---|-------|----------|---------|
| A1 | Implementar parser de comandos en Commander | Medio | Commander confiable |
| A2 | Seedear issues con labels para que intake funcione | Simple | Desbloquea pipeline |
| A3 | Implementar cleanup de worktrees en entrega | Simple | Previene acumulacion |
| A4 | Fixear timeout de build con setTimeout + child.kill() | Simple | Previene builds zombie |

### Fase B — Completar funcionalidad core (Prioridad Alta)

| # | Tarea | Esfuerzo | Impacto |
|---|-------|----------|---------|
| B1 | Persistencia de sesiones en Commander | Medio | Conversaciones con continuidad |
| B2 | Handler nativo para `/status` | Simple | Respuesta instantanea |
| B3 | Handler nativo para `/intake` | Simple | Control operativo |
| B4 | Implementar `/pausar` y `/reanudar` nativos | Simple | Control confiable |
| B5 | Max retries en huerfanos | Simple | Evita loops infinitos |
| B6 | Fix deteccion de procesos en Windows | Simple | Huerfanos correctos |

### Fase C — Completar el ecosistema (Prioridad Media)

| # | Tarea | Esfuerzo | Impacto |
|---|-------|----------|---------|
| C1 | Crear rol `hotfix.md` | Simple | Flujo de emergencia |
| C2 | Division de historias en planner | Grande | Definicion completa |
| C3 | Implementar `/costos` con tracking de tokens | Medio | Visibilidad de gasto |
| C4 | Implementar servicio Drive | Medio | QA E2E completo |
| C5 | Rate limiting en GitHub API | Simple | Evita rate limits |
| C6 | Envio de documentos/imagenes en servicio-telegram | Medio | Reportes ricos |

---

## 6. Conclusion

El Pipeline V2 esta **~75% implementado** en su core engine pero tiene un **circuito abierto**: no entra trabajo porque no hay issues etiquetados, y el Commander no puede controlarlo confiablemente porque delega todo a Claude sin handlers nativos.

La accion mas impactante e inmediata es **A1 + A2**: implementar un parser de comandos real en el Commander y seedear issues para que el intake tenga que consumir.
