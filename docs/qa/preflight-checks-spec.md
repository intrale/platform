# Pre-Flight Checks en Pulpo (Capa 2) — Especificacion Tecnica

**Fecha:** 2026-04-09  
**Estado:** Aprobado por Leo  
**Contexto:** Estrategia de 5 Capas — Capa 2  
**Dependencia:** Capa 1 (Ventana de QA Exclusiva)

---

## Problema

El Pulpo lanza agentes QA sin verificar que la infraestructura este lista.
El agente arranca, consume tokens de Claude API, y recien a los 10-15 minutos
descubre que el emulador no esta, que el APK no existe, o que el backend no responde.

**Resultado:** un `qa:failed` que en realidad es un fallo de infraestructura,
no del codigo. Ademas le consume un intento al circuit breaker (maximo 3 rebotes),
penalizando al issue injustamente.

## Solucion

Funcion `preflightQaChecks(issue)` en `pulpo.js` que se ejecuta **ANTES** de lanzar
cualquier agente QA. Si los checks no pasan, el issue no se lanza — se queda en cola
con estado apropiado, sin penalizar al circuit breaker.

## Los 4 checks en orden

### Check 1 — Clasificar el issue (requiere emulador o no)

Leer los labels del issue via `getIssueLabels(issue)` (ya existe en el Pulpo con cache).

| Labels presentes | Requiere APK | Requiere emulador |
|------------------|--------------|--------------------|
| `app:client`     | Si (flavor client)   | Si |
| `app:business`   | Si (flavor business) | Si |
| `app:delivery`   | Si (flavor delivery) | Si |
| Ninguno de los 3 | No           | No |

**Si no requiere emulador:** el issue puede lanzarse directamente sin los checks 2, 3 y 4.
QA-API o validacion estructural no necesitan emulador ni APK.

### Check 2 — APK disponible (solo si requiere emulador)

Buscar el archivo en `qa/artifacts/{issue}-composeApp-{flavor}-debug.apk`.

| Resultado | Accion |
|-----------|--------|
| APK existe | Continuar al check 3 |
| APK no existe | Rechazar con motivo `apk_missing` — re-encolar para build. NO penalizar circuit breaker |

Si el issue tiene multiples labels `app:*`, verificar que exista APK para cada flavor.

### Check 3 — Backend responde (solo si requiere emulador)

Hacer un HTTP POST a la URL del backend de QA:

```
POST https://{qa-backend-url}/intrale/signin
Body: {}
```

| Resultado | Significado | Accion |
|-----------|-------------|--------|
| HTTP 400 (Bad Request) | Backend vivo, respondio que falta data | Check OK |
| HTTP 500 (Server Error) | Backend con problemas | `blocked:infra` — no lanzar |
| Timeout (>5s) | Backend caido o red | `blocked:infra` — no lanzar |
| Connection refused | Backend no levantado | `blocked:infra` — no lanzar |

### Check 4 — Emulador disponible via ADB (solo si requiere emulador)

```bash
adb devices | grep emulator
```

| Resultado | Accion |
|-----------|--------|
| Emulador listado y `device` | Check OK — lanzar agente QA |
| Emulador no encontrado | Senalizar al Pulpo para activar ventana QA (Capa 1). Issue queda en estado `waiting:emulator` |
| Emulador en estado `offline` | Mismo tratamiento que "no encontrado" |

**IMPORTANTE:** El pre-flight NO intenta levantar el emulador. Esa responsabilidad es
exclusiva de la Ventana QA (Capa 1). El pre-flight solo detecta y senaliza.

## Estados resultantes

| Estado | Significado | Penaliza circuit breaker | Accion del Pulpo |
|--------|-------------|--------------------------|-------------------|
| `pass` | Todo OK, lanzar agente | N/A | Lanzar agente QA normalmente |
| `apk_missing` | Falta APK del issue | **No** | Re-encolar para build |
| `blocked:infra` | Backend caido o error de red | **No** | Mantener en cola, reintentar en proximo ciclo |
| `waiting:emulator` | Emulador no esta corriendo | **No** | Senalizar activacion de ventana QA |

## Interaccion con Capa 1 (Ventana QA)

Cuando el pre-flight detecta `waiting:emulator`:

1. El issue se mantiene en `pendiente/` de verificacion (no se mueve a `trabajando/`)
2. Se incrementa un contador de issues esperando emulador
3. Si hay issues esperando emulador → el Pulpo evalua activar la ventana QA via `evaluateQaPriority()`
4. Cuando la ventana activa el emulador → el proximo ciclo del Pulpo re-evalua pre-flight
5. Ahora check 4 pasa → el issue se lanza normalmente

## Integracion en el flujo del Pulpo

### Donde se ejecuta

En `brazoLanzamiento()`, **antes** de mover el archivo a `trabajando/`.

```
Flujo actual (lineas 1684-1697):
  1. Mover a trabajando/
  2. ensureQaEnvironment()  ← solo verifica emulador
  3. Lanzar agente

Flujo nuevo:
  1. preflightQaChecks(issue)  ← NUEVO
     Si no pasa → NO mover a trabajando/, continue al siguiente candidato
  2. Mover a trabajando/
  3. Lanzar agente (sin ensureQaEnvironment — ahora pre-flight lo cubre)
```

### Reemplazo de ensureQaEnvironment

La funcion `ensureQaEnvironment()` actual intentaba levantar el emulador desde el Pulpo
antes de lanzar el agente. Con la nueva arquitectura (Capa 1 + Capa 2):

- El emulador lo levanta la Ventana QA (Capa 1), no `ensureQaEnvironment()`
- Los checks de infraestructura los hace `preflightQaChecks()` (Capa 2)
- `ensureQaEnvironment()` se elimina y su logica se redistribuye

## Logging y notificaciones

Cada ejecucion de pre-flight se loguea en `pulpo.log`:

```
[2026-04-09 12:30:00] [preflight] #2041: check 1 OK (requiere emulador, flavor: delivery)
[2026-04-09 12:30:00] [preflight] #2041: check 2 OK (APK encontrado: 2041-composeApp-delivery-debug.apk)
[2026-04-09 12:30:01] [preflight] #2041: check 3 OK (backend responde HTTP 400)
[2026-04-09 12:30:01] [preflight] #2041: check 4 FAIL (emulador no disponible) → waiting:emulator
```

Notificacion Telegram solo en caso de `blocked:infra` (backend caido es critico y requiere atencion).

## Metricas

Se persisten en `qa-preflight-log.jsonl` para analisis:

```json
{"timestamp":"2026-04-09T12:30:01Z","issue":"2041","checks":{"classify":"ui","apk":"ok","backend":"ok","emulator":"waiting"},"result":"waiting:emulator","duration_ms":1200}
```

## Cadena de responsabilidad de labels de ruteo

Los labels de ruteo (`app:client`, `app:business`, `app:delivery`, `area:backend`, `area:infra`)
son criticos para que el pipeline sepa como clasificar y validar cada issue. La responsabilidad
de asignarlos sigue esta cadena:

| Orden | Responsable | Rol | Momento |
|-------|-------------|-----|---------|
| 1 | **`/doc`** (definicion) | **Responsable primario.** Asigna labels de ruteo al crear o refinar el issue, junto con los criterios de aceptacion. | Etapa de definicion |
| 2 | **`/po`** (validacion) | Valida que los labels sean correctos. Puede corregirlos si `/doc` se equivoco. | Etapa de validacion |
| 3 | **Pre-flight (Capa 2)** | **Red de seguridad.** Si un issue llega sin labels de ruteo, el fallback inteligente (`autoClassifyIssue()` en pulpo.js) infiere el label leyendo titulo y body, y lo asigna en GitHub. | Antes de lanzar QA |

**Regla:** el fallback inteligente es la excepcion, no la regla. Los issues deberian llegar
al pre-flight ya con sus labels asignados por `/doc` y validados por `/po`. El fallback
existe para:
- Issues creados antes de que existiera esta regla
- Issues creados manualmente sin pasar por `/doc`
- Errores humanos de clasificacion

Cuando el fallback actua, notifica por Telegram: "Issue #X auto-clasificado como `{label}`"
para que quede registro de que la definicion fue incompleta.

## Decisiones clave (registro)

- **2026-04-09:** Leo aprueba Capa 2 y ordena implementar y entregar.
- **2026-04-09:** Leo indica que si el pre-flight no encuentra emulador, debe accionar
  para activar la ventana QA, no devolver a la cola en un loop sin sentido.
- **2026-04-09:** La responsabilidad de levantar el emulador es exclusiva de la ventana QA
  (Capa 1), no del pre-flight ni del agente QA.
- **2026-04-09:** Leo confirma que `/doc` es el responsable primario de asignar labels de ruteo,
  `/po` los valida, y el fallback inteligente del pre-flight es la red de seguridad.
  El fallback debe ser lo suficientemente inteligente para asignar el label correcto.
