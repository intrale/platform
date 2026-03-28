# Evidencia de Testing — Pipeline V2

> Fecha: 2026-03-28
> Ambiente: Windows 11, Node.js, branch fix/pulpo-telegram-retry

## Resumen de tests

| # | Comando | Resultado | Tokens | Latencia |
|---|---------|-----------|--------|----------|
| T1 | `/status` | PASS | 0 (nativo) | <1s |
| T2 | `/pausar` | PASS | 0 (nativo) | <1s |
| T3 | `/reanudar` (estando pausado) | PASS | 0 (nativo) | <1s |
| T4 | `/help` | PASS | 0 (nativo) | <1s |
| T5 | `/actividad` | PASS | 0 (nativo) | <1s |
| T6 | `/costos` | PASS | 0 (nativo) | <1s |

## Test T1: /status

**Input:** `{"from":"Leo","text":"/status"}`
**Output:**
```
📊 *Estado del Pipeline*

*DEFINICION*

*DESARROLLO*

*Agentes activos:* ninguno

*Servicios*
```
**Trazas:**
```
[commander] 1 mensaje(s) pendiente(s)
[commander] Tomado: test-status.json → trabajando/
[commander] Token: OK, ChatId: 6529617704
[commander] Procesando msg de Leo: "/status"
[commander] Preprocesado: "/status"
[commander] Comando detectado: /status args=""
[telegram] Encolado (93 chars) → 1774706831269-cmd.json
```
**Verificacion:** Pipeline vacio (correcto — no hay issues en el sistema).

## Test T2: /pausar

**Input:** `{"from":"Leo","text":"/pausar"}`
**Output:** `⏸️ Pulpo PAUSADO. Usar /reanudar para continuar.`
**Verificacion:** Archivo `.pipeline/.paused` creado con timestamp `2026-03-28T14:15:20.650Z`
**Efecto:** Ciclos posteriores del Pulpo logean `PAUSADO — esperando reanudacion`

## Test T3: /reanudar (critico — estando pausado)

**Input:** `{"from":"Leo","text":"/reanudar"}`
**Output:** `▶️ Pulpo REANUDADO. Procesamiento activo.`
**Verificacion:**
- `.pipeline/.paused` eliminado
- Pulpo retoma operacion normal en el ciclo siguiente
- **BUG previo corregido:** Commander ahora corre fuera del `if (!paused)` para poder procesar `/reanudar`

## Test T4-T6: /help, /actividad, /costos

Todos respondieron con output nativo (sin invocar Claude). Ejemplos:

**/help:**
```
🤖 *Comandos del Pipeline V2*
/status — Tablero completo del pipeline
/actividad [filtro] — Timeline (ej: /actividad 30m, /actividad #732)
...
```

**/actividad:**
```
📋 *Actividad reciente*
12:59 → [Leo] No le diste importancia a mi ultimo audio
14:07 → [Leo] /status
14:09 → [Leo] /help
...
```

**/costos:**
```
💰 *Resumen de actividad (por logs)*
*Total:* 9 logs en .pipeline/logs/
```

## Flujo completo verificado

```
Telegram → Listener → pendiente/ → Pulpo (brazoCommander)
  → parseCommand() detecta /status
  → cmdStatus() lee filesystem directo
  → sendTelegram() encola en servicios/telegram/pendiente/
  → servicio-telegram.js → Telegram API → usuario
```

**Todo el camino funciona sin invocar Claude** para comandos nativos.

## Bug encontrado y corregido durante testing

**Bug:** Cuando el Pulpo estaba pausado, brazoCommander no se ejecutaba, haciendo imposible procesar `/reanudar` via Telegram.

**Fix:** Mover `await brazoCommander(config)` fuera del `if (!paused)` en el main loop.

**Verificacion:** Test T3 confirma que `/reanudar` funciona estando pausado.

## Servicio Telegram — Entrega confirmada

```
[svc-telegram] Servicio Telegram iniciado
[svc-telegram] Enviado: 1774706987774-cmd.json
[svc-telegram] Enviado: 1774706987795-cmd.json
```

Mensajes movidos a `servicios/telegram/listo/` tras envio exitoso.

## Componentes verificados

| Componente | Estado | Evidencia |
|------------|--------|-----------|
| pulpo.js (brazoCommander) | OK | Handlers nativos funcionan |
| pulpo.js (parseCommand) | OK | Extrae comando y args correctamente |
| pulpo.js (pausa/reanudacion) | OK | .paused create/delete + commander independiente |
| servicio-telegram.js | OK | Envia mensajes y los mueve a listo/ |
| commander-history.jsonl | OK | Registra in/out con timestamps |
| commander-session.json | OK | Persiste contexto entre mensajes |
| Trazabilidad | OK | Logs detallados en cada paso |

## Pendiente de testear

- [ ] `/intake` con issue real de GitHub
- [ ] `/proponer` (requiere Claude — consumira tokens)
- [ ] Texto libre (delegado a Claude)
- [ ] Audio (STT/TTS con OpenAI)
- [ ] Imagenes (Vision con Anthropic)
- [ ] Pipeline completo: intake → definicion → desarrollo → entrega
- [ ] Huerfanos con max retries
- [ ] Build timeout
- [ ] Worktree cleanup post-entrega
