# Circuit breaker de infra — auto-resume (#3940 / EP5-H3)

## Contexto

El **circuit breaker (CB) de infra** (`.pipeline/circuit-breaker-infra.js`, #2305) protege al
pipeline frente a cortes de red: tras **3 fallos de red consecutivos** (`ENOTFOUND`,
`ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`) pasa a
estado `open` y `brazoLanzamiento()` deja de lanzar agentes (early-return con `cbInfra.isOpen()`).

**Problema previo:** el único camino de cierre era manual (`node .pipeline/resume.js`). Si nadie lo
ejecutaba, el pipeline quedaba muerto indefinidamente aunque la red ya se hubiera recuperado.

## Qué hace el auto-resume

El Pulpo cierra el CB **automáticamente** cuando la infra demuestra estabilidad sostenida:
tras **N prechecks OK consecutivos reales** (default `N=3`), reusando `cbInfra.resume('auto')`.

- El precheck de conectividad corre en el `mainLoop` **antes** del check del CB, de forma
  incondicional → es el único punto donde se puede observar la recuperación con el CB abierto.
- El contador consumido es el streak **in-memory** `lastPrecheckOkStreak`, alimentado **solo por
  probes reales** (no por hits del cache de 30s, ni por valores externos) — patrón anti-spoofing
  de #2335.
- El auto-resume **solo cierra el CB**. El reencolado de issues bloqueados lo sigue cubriendo el
  camino independiente `connectivity_restored` / `reencolarInfraBloqueados()` — no se duplica.

## Override manual (sigue disponible)

`node .pipeline/resume.js` funciona exactamente igual que antes. La firma de `resume()` cambió a
`resume(origin = 'manual')` con default retrocompatible: el caller manual no requiere cambios.
Un resume manual además **rehabilita** el auto-cierre si había quedado suspendido por flapping.

## Configuración

`.pipeline/config.yaml`:

```yaml
circuit_breaker:
  infra_escalate_threshold: 5
  auto_resume_ok_threshold: 3   # N prechecks OK consecutivos para auto-cerrar
```

- `auto_resume_ok_threshold` debe ser **entero ≥ 1**. Un valor inválido (0, negativo, no
  numérico, ausente) cae al **default 3** con warning en log (SEC-R1). Nunca se acepta un
  threshold que deshabilite el fail-closed.

## Anti-flapping (SEC-R3)

Si el CB **reabre dentro de una ventana corta** (10 min, `AUTO_RESUME_FLAP_WINDOW_MS`) después de
un auto-resume, la red está inestable y el auto-cierre se **suspende** (`auto_resume_suspended:
true`): se escala a humano por Telegram en vez de seguir auto-cerrando en bucle. Solo un resume
manual rehabilita el auto-cierre. El estado persiste `auto_resume_count` y `last_auto_resume_at`.

## Auditoría del cierre (SEC-R4)

Cada cierre del CB persiste en `circuit-breaker-infra.json`:

| Campo | Significado |
|-------|-------------|
| `resumed_by` | `'auto'` o `'manual'` — origen del último cierre |
| `resumed_at` | timestamp ISO del cierre |
| `auto_resume_count` | cantidad de auto-resumes acumulados |
| `last_auto_resume_at` | timestamp del último auto-resume |
| `auto_resume_suspended` | `true` si el auto-cierre está suspendido por flapping |
| `consecutive_ok_prechecks` | observabilidad del progreso (sanitizado al leer, SEC-R2) |

## Mensajes Telegram operador-facing

| Mensaje | Estado | Acción esperada del operador |
|---------|--------|------------------------------|
| 🔴 `Pipeline pausado por infra` / `Pipeline bloqueado por infra` | CB abierto por corte de red | Verificar red; el pipeline intentará auto-reanudar solo |
| 🟢 `Pipeline auto-reanudado (CB infra) tras N prechecks OK consecutivos` | Auto-resume efectivo | Ninguna — recuperación automática |
| 🟢 `Pipeline reanudado` | Resume **manual** (`resume.js`) | Ninguna — cierre forzado por humano |
| ⚠️ `CB infra reabrió a los pocos minutos de un auto-resume — auto-cierre suspendido por flapping` | Flapping detectado | **Intervención manual**: revisar la infra y ejecutar `node .pipeline/resume.js` |

El emoji ⚠️ distingue la situación que **sí** requiere acción humana del bloqueo transitorio (🔴) y
de la recuperación (🟢). Todos los mensajes son estáticos/sanitizados, sin interpolar datos
sensibles.

## Seguridad implementada

- **SEC-R1** — `auto_resume_ok_threshold` validado (entero ≥ 1, fallback 3 + warning).
- **SEC-R2** — `readState()` sanitiza los contadores numéricos persistidos (entero ≥ 0; inválido
  → 0) para que un JSON manipulado/corrupto no dispare un resume inmediato. La decisión real usa
  el streak in-memory alimentado solo por el probe real.
- **SEC-R3** — anti-flapping con escalada a humano (ver arriba).
- **SEC-R4** — auditoría diferenciada `auto`/`manual` con timestamp y mensaje Telegram distinto.

## Tests

`.pipeline/tests/circuit-breaker-auto-resume.test.js` (`node --test`) cubre CA-1..CA-8 y
SEC-R1..SEC-R4: auto-cierre por streak, idempotencia, override manual, threshold inválido,
estado persistido corrupto, flapping/escalada y auditoría del origen.
