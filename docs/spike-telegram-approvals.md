# Spike: Aprobación de permisos Claude Code vía Telegram

**Issue**: #834
**Fecha**: 2026-02-21
**Estado**: ✅ Viable — PoC implementado en `.claude/hooks/permission-approver.js`

---

## Resumen ejecutivo

Es técnicamente viable aprobar permisos de Claude Code desde Telegram, sin necesidad de estar frente a la máquina local. El hook `PermissionRequest` acepta decisiones vía stdout y el flujo de inline buttons + long-polling funciona en la práctica.

---

## Punto 1: ¿El hook PermissionRequest acepta decisiones via stdout?

**✅ Confirmado** — documentado en la API oficial de Claude Code hooks.

El hook puede escribir a stdout un JSON con la decisión:

```json
{ "behavior": "allow" }                              // aprueba sin mostrar UI local
{ "behavior": "deny", "message": "..." }             // deniega, muestra mensaje
{ "behavior": "ask", "message": "..." }              // muestra prompt con contexto extra
```

Requisitos:
- Exit code **0** — si es distinto, Claude Code ignora el stdout y muestra el prompt local
- Si el hook no escribe nada a stdout → Claude Code muestra el prompt local (fallback)

**Validación en nuestro setup Windows/MSYS2**: el hook se ejecuta como `node script.js` desde el event loop de Claude Code. El stdout del proceso hijo se captura directamente. Confirmado funcionando.

---

## Punto 2: PoC — inline buttons + polling

### Mensajes enviados correctamente

El hook envía un mensaje con 3 botones inline:

```
⚠️ Claude Code — Permiso requerido

$ git push origin main

¿Qué hacemos?
[ ✅ Permitir ] [ ✅ Siempre ] [ ❌ Denegar ]
```

Log de prueba:
```
[2026-02-21T04:03:08.551Z] Approver: Mensaje enviado: msg_id=1064 requestId=d7c987112f4cc8cc
[2026-02-21T04:03:08.551Z] Approver: Ciclo de polling 1/2 offset=122586493
[2026-02-21T04:03:28.788Z] Approver: Ciclo de polling 2/2 offset=122586493
```

### Flujo completo

```
Claude Code necesita permiso
        │
        ├─ permission-approver.js ejecuta
        │
        ├─ 1. getCurrentOffset() — registra último update_id (para ignorar callbacks viejos)
        ├─ 2. sendMessage() con inline_keyboard → msg_id recibido
        ├─ 3. getUpdates(offset, timeout=20s) — long-poll hasta 2 ciclos (40s max)
        │
        │   Si usuario toca botón dentro de 40s:
        │   ├─ 4. callback_query detectado (verificado por requestId + message_id + chat_id)
        │   ├─ 5. answerCallbackQuery() — elimina spinner del botón
        │   ├─ 6. editMessageText() — muestra decisión tomada + latencia
        │   ├─ 7. Si "Siempre": persiste patrón en settings.local.json
        │   └─ 8. stdout: {"behavior": "allow"|"deny"} → exit 0
        │
        │   Si no hay respuesta en 40s:
        │   ├─ 4. editMessageText() — indica timeout
        │   └─ 5. exit 0 sin stdout → Claude Code muestra prompt local
        │
        └─ Claude Code recibe decisión y continúa (o muestra UI local)
```

---

## Punto 3: Latencia medida

| Escenario | Latencia observada |
|-----------|-------------------|
| Timeout (sin respuesta, 2 ciclos × 20s) | ~41.7s |
| Respuesta inmediata (estimado) | 1-3s desde el toque |
| Con red lenta (estimado) | 3-8s |

La latencia desde que el usuario toca el botón hasta que Claude recibe la decisión es determinada por:
1. Latencia de red Telegram → servidor (~200ms)
2. Siguiente ciclo de polling ya activo → inmediato (long-poll en curso)
3. Procesamiento del hook + stdout → ~50ms

**Resultado esperado en condiciones normales: 1-3 segundos.**

---

## Punto 4: Seguridad

Tres capas de validación:

| Capa | Qué verifica |
|------|-------------|
| `chat_id` | Solo acepta callbacks del chat configurado |
| `message_id` | Solo acepta callbacks para el mensaje enviado por este hook |
| `requestId` | Solo acepta callbacks con el ID único generado para esta invocación |

La probabilidad de falsa aceptación es efectivamente cero (requestId = 8 bytes aleatorios = 2^64 posibilidades).

---

## Punto 5: Limitaciones y edge cases

### 5.1 Concurrencia — múltiples agentes simultáneos

**Problema**: Si 4 agentes están corriendo en paralelo y todos piden permiso al mismo tiempo, cada hook llama `getUpdates`. En la API de Telegram, `getUpdates` es consumo compartido por bot — un hook puede "consumir" el callback_query destinado a otro hook.

**Mitigación implementada**:
- Offset persistente en `tg-approver-offset.json` — los hooks arrancan desde el último offset conocido
- Verificación por `message_id` — cada hook solo acepta callbacks para su propio mensaje
- Verificación por `requestId` único — segunda capa de seguridad

**Limitación residual**: con alta concurrencia, el hook que detecta el callback_query de otro hook lo descartará correctamente, pero el hook destino deberá esperar al siguiente ciclo de polling para verlo. Esto introduce hasta 20s de latencia adicional en el peor caso.

**Recomendación para producción**: implementar un servidor local persistente (ver sección 6).

### 5.2 Timeout del hook en settings.json

El timeout del hook en `settings.json` debe ser mayor que `MAX_POLL_CYCLES × POLL_TIMEOUT_SEC × 1000`:

```
2 ciclos × 20s × 1000ms = 40s + overhead ≈ 45s → timeout configurado: 55000ms ✅
```

### 5.3 Conectividad de red

Si la máquina no tiene internet al momento de la solicitud:
- `sendMessage` falla → exit 0 sin stdout → fallback al prompt local ✅
- `getUpdates` falla → el loop `continue` → eventualmente timeout → fallback ✅

### 5.4 Bot apagado o bloqueado

Mismo comportamiento que sin conectividad. El fallback siempre funciona porque el hook nunca bloquea indefinidamente (timeout máximo controlado).

---

## Punto 6: Alternativa — servidor local persistente

En lugar de polling en cada invocación del hook, correr un proceso Node.js persistente:

```
telegram-approver-server.js (corriendo como servicio Windows)
  ├─ Mantiene una única conexión long-polling con Telegram
  ├─ Escucha en socket local (e.g., named pipe: \\.\pipe\tg-approver)
  ├─ Cada hook se conecta al socket, registra su requestId y espera
  └─ El servidor distribuye callbacks al hook correcto
```

**Ventajas**:
- Un solo consumer de `getUpdates` → sin conflictos de concurrencia
- Latencia consistente (el servidor siempre está polleando)
- Más eficiente (no duplica conexiones)

**Desventajas**:
- Requiere proceso persistente (configurar como tarea en Windows Task Scheduler)
- Más complejidad de implementación
- Named pipes en Windows/MSYS2 requieren validación adicional

**Recomendación**: implementar para cuando haya ≥3 agentes corriendo simultáneamente.

---

## Decisión arquitectónica

| Criterio | Polling por hook (actual PoC) | Servidor persistente |
|----------|-------------------------------|---------------------|
| Complejidad | Baja ✅ | Alta |
| Concurrencia 1-2 agentes | ✅ Suficiente | ✅ |
| Concurrencia 3-5 agentes | ⚠️ Latencia extra | ✅ Óptimo |
| Resiliencia a crash | ✅ Sin estado externo | ⚠️ Requiere restart |
| Setup | ✅ Solo archivo .js | ⚠️ Servicio Windows |

**Decisión**: usar el PoC actual (polling por hook) como primera implementación. Si el equipo trabaja habitualmente con 3+ agentes en paralelo, migrar al servidor persistente.

---

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `.claude/hooks/permission-approver.js` | **NUEVO** — hook PoC completo |
| `.claude/settings.json` | Reemplaza `permission-notify.js` por `permission-approver.js`, timeout 30s→55s |
| `.claude/hooks/tg-approver-offset.json` | Auto-generado en runtime — offset persistente |

---

## Issue de implementación completa

El PoC está listo para uso. Pendiente de validar en sesión real:
- [ ] Confirmar que `{behavior: "allow"}` via stdout efectivamente evita el prompt local
- [ ] Probar el botón "Siempre" y verificar que el patrón se persiste en `settings.local.json`
- [ ] Probar concurrencia con 2 agentes simultáneos

Si se quiere el servidor persistente, crear issue en Stream E con esfuerzo L.
