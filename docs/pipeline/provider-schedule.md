# Horarios de actividad por proveedor (`provider-schedule`)

> Issue **#3871**. Scheduler determinístico que apaga/enciende cada proveedor de
> IA por franja horaria, de forma **independiente** entre proveedores.

## Para qué sirve

Permite definir ventanas horarias en las que un proveedor está **apagado**, sin
afectar a los demás. Caso de uso de Leo: apagar Anthropic y Codex (pagos) de
noche y dejar el free tier (Gemini) activo 24/7 — ahorro de costo + balanceo de
carga.

Es un primo de tres mecanismos ya existentes; conviene no confundirlos:

| Mecanismo | Alcance | Semántica | Archivo |
|-----------|---------|-----------|---------|
| **rest-mode** | Global (todo el pipeline) | "pipeline en reposo" | `.pipeline/rest-mode.json` |
| **provider-disabled** (kill-switch #3811) | Por provider | "caída en runtime" (TTL) | `.pipeline/provider-disabled.json` |
| **provider-schedule** (#3871) | Por provider | "fuera de horario" | `.pipeline/provider-schedule.json` |
| **quota-exhausted** | Por provider | "esperar reset de cuota" | flags de cuota |

### Precedencia

```
rest-mode global  >  provider-schedule  >  provider-disabled (kill-switch)  >  quota
```

El gate global de rest-mode se evalúa primero (si el pipeline está en reposo, no
se spawnea nada). Luego, por candidato, `dispatch-with-fallback` chequea horario,
kill-switch, cuota y health.

## Modelo de datos

`.pipeline/provider-schedule.json`:

```json
{
  "providers": {
    "anthropic": {
      "active": true,
      "schedule": {
        "monday":  [{ "start": "22:00", "end": "08:00" }],
        "tuesday": [{ "start": "22:00", "end": "08:00" }]
      },
      "timezone": "America/Argentina/Buenos_Aires",
      "updated_at": "2026-06-08T12:00:00.000Z"
    }
  }
}
```

- Los `periods` definen las ventanas en las que el provider está **APAGADO**
  (espejo de rest-mode, donde un periodo == "pipeline en reposo"). Fuera de esas
  ventanas el provider está **activo**.
- `active: false` (o ausencia de entrada) ⇒ el provider está activo **24/7** (no
  se gatea).
- Modelo de schedule N-periodos/día idéntico a rest-mode (`{day: [{start, end}]}`),
  con soporte cross-midnight (`start > end`) y "día completo" (`00:00 → 23:59`).
- Hasta 24 periodos por día (cap defensivo).

### Semántica cross-midnight (Gherkin del issue)

Anthropic con periodo `{ "start": "22:00", "end": "08:00" }`:

- lunes **23:30** → dentro de la ventana off → `isProviderActiveNow("anthropic") === false`
- martes **08:30** → fuera de la ventana off → `isProviderActiveNow("anthropic") === true`

## Módulo `lib/provider-schedule.js`

| Función | Descripción |
|---------|-------------|
| `isProviderActiveNow(provider, now?, opts?)` | `boolean`. **Fail-open**: provider inválido / archivo ausente o corrupto / schedule inactivo ⇒ `true`. |
| `setProviderSchedule(provider, payload, opts?)` | `{ ok, filePath, nextTransition }` o `{ ok:false, error, errors? }`. Valida con `rest-mode-window.validatePayload`. |
| `getProviderSchedule(provider, opts?)` | Entry resuelto o default activo-24/7. Provider inválido ⇒ `null`. |
| `listProviderSchedules(opts?)` | `{ [provider]: { active, schedule, timezone, isActiveNow, nextTransition, updated_at } }`. |
| `clearProviderSchedule(provider, opts?)` | Borra la entrada (vuelve a 24/7). |

El módulo **reutiliza** (no reimplementa) los validadores de
`rest-mode-window.js` (`validatePayload`, `validateSchedule`,
`timezoneIsSupported`, `isWithinWindow`, `nextWindowTransition`) y la allowlist
`VALID_PROVIDERS` de `provider-disabled.js`.

`isProviderActiveNow == !isWithinWindow(offWindow)`.

### Fail-open estricto

Cualquier error de IO o JSON corrupto ⇒ el provider se considera **activo**. El
scheduler nunca debe congelar el pipeline por un bug propio. Escape manual:

```bash
rm .pipeline/provider-schedule.json   # restaura todos los providers a 24/7
```

## Integración con `dispatch-with-fallback`

Antes de elegir provider, `resolveSpawnWithFallback` chequea
`isProviderActiveNow(provider)` para el primario y para cada fallback:

- Si el provider está **fuera de horario** → se salta al siguiente eslabón
  (igual que el kill-switch), con audit dedicado:
  - `primary_inactive_by_schedule`
  - `fallback_provider_inactive_by_schedule`
- skip reason: `provider_inactive_by_schedule`.

### Todos inactivos por horario

Si el primario **y** todos los fallbacks quedan gateados **exclusivamente por
horario**, el resultado es:

```js
{ gated: true, reason: 'todos_inactivos_por_horario', allInactiveBySchedule: true }
```

El issue vuelve a `pendiente/` y se emite una **alerta obligatoria por Telegram**
(mitigación del riesgo de DoS lógico: nunca congelar el pipeline en silencio).

Si la cadena queda gateada por una **mezcla** de causas (horario + cuota /
kill-switch / health), el reason es `all_gated` (comportamiento previo) y **no**
se dispara la alerta de horario.

## API HTTP (dashboard)

Montada en `lib/multi-provider/api.js`:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/multi-provider/providers-schedule` | Estado de todos los providers (activo ahora + próxima transición). |
| `POST` | `/api/multi-provider/providers/:name/schedule` | Set `{ active, schedule, timezone }`. |

Reglas de seguridad (espejo de `handleProviderDisable`):

1. **Allowlist** `:name` contra `VALID_PROVIDERS` antes de tocar cualquier path
   (anti path-traversal) → `400 invalid_provider`.
2. **CSRF** obligatorio en el `POST` (`csrf.requireCSRF`).
3. **Autor** derivado server-side (`git config user.email`); sin autor → `403`.
4. `active` debe ser **boolean estricto** → `422 invalid_payload`.
5. Schedule / timezone validados con `validatePayload` → `422 schedule_failed`
   con `errors[]`.

## Dashboard V3

Sección **"Horarios por proveedor"** en el panel Multi-Provider
(`views/dashboard/multi-provider.js`):

- Tabla con una fila por provider: estado actual (ACTIVO / FUERA DE HORARIO),
  gating on/off y próxima transición.
- Botón **"Editar horarios"** → editor inline con: toggle de gating, timezone y
  ventana APAGADO por día (inicio → fin). Guarda vía el endpoint con CSRF.

## Audit log

`.pipeline/logs/provider-schedule-YYYY-MM-DD.log` (append-only, una línea JSON
por evento). Eventos: `provider_schedule_set`, `provider_schedule_cleared`,
`parse_error`. Los campos controlados por el usuario (source, etc.) se sanitizan
(newlines/tabs escapados) antes de appendear — anti log-injection.

## Tests

- `.pipeline/lib/__tests__/provider-schedule.test.js` — gate aislado, cross-midnight,
  corrupción fail-open, validación, allowlist, audit.
- `.pipeline/tests/dispatch-skip-reasons-3823.test.js` — integración con dispatch
  (skip reason, `todos_inactivos_por_horario`, mix de causas).
- `.pipeline/lib/__tests__/multi-provider-api.test.js` — endpoint (CSRF, allowlist,
  payload inválido).

```bash
node --test .pipeline/lib/__tests__/provider-schedule.test.js
```
