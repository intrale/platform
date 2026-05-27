## Contexto técnico

Durante el análisis del issue #3472 (wire-up in-flight fallback en `pulpo.js#ejecutarClaude`) detecté que la **rama non-Anthropic** de `ejecutarClaude` (`pulpo.js:7713-7781`) hoy spawna providers fallback (openai-codex, cerebras, etc.) con sólo un **timeout de 90s** y un canned response como única salida:

```js
const HARD_NON_ANTH_MS = 90 * 1000; // SR-5 — budget 90s para providers no-stream-json
const timer = setTimeout(() => {
  try { proc.kill('SIGTERM'); } catch {}
  log('commander', `Provider ${resolution.provider} timeout 90s — abortando`);
}, HARD_NON_ANTH_MS);
```

Si el provider fallback (ya activo porque Anthropic estaba gateado pre-spawn) **también cae mid-flight** (503, EOF prematuro, stream gap), el usuario recibe el canned `cannedFallbackUnavailableResponse` sin segundo intento — pese a que la chain `agent-models.json::telegram-commander.fallbacks[]` típicamente declara 3+ providers.

El wire-up que se implementa en #3472 cubre **sólo la rama Anthropic** (readline stream-json). Esta es la asimetría: el "primario" tiene 2 chances (sí mismo + fallback in-flight), un "ya-fallback" sólo tiene 1.

## Beneficio esperado

- Cerrar la asimetría de cobertura entre rama Anthropic y rama non-Anthropic del Commander.
- Permitir que si openai-codex cae mid-flight, el wire-up dispare a cerebras (o el siguiente en chain) usando la misma primitiva `decideInflightFallback()` (que ya soporta `excludedProvider` arbitrario).
- Robustez extra en escenarios de **doble caída** (Anthropic gateado pre-spawn + fallback transient mid-flight) — improbable pero no imposible.

## Acciones sugeridas

- Reusar la misma orquestación de timers (first-byte 15s + stream-gap 30s + cap=1 + budget 90s) que #3472 entrega para la rama Anthropic.
- Refactor recomendado: encapsular el detector de errorClass + invocación del wire-up en un módulo nuevo `lib/commander/inflight-wire.js` que se invoque desde **ambas ramas** de `ejecutarClaude`, reduciendo duplicación.
- Adaptar el detector de errorClass al output del handler non-stream-json (stdout crudo en vez de stream-json line-by-line) — el `firstByteTimer` aplica igual, el `streamGapTimer` se vuelve "ningún chunk en 30s".
- Considerar que el cap=1 sigue aplicando: si el primario era Anthropic-gateado y openai-codex falla, el wire-up de la rama non-Anthropic NO debe contar como "3er intento" — el contador `attemptIndex` es por turn, no por rama.

## Referencia

> Propuesto automáticamente por el agente `guru` durante el análisis del issue #3472.
> **Es una recomendación pendiente de aprobación humana** — no entra al pipeline automático hasta que un humano remueva el label `needs-human` y agregue `recommendation:approved` (o cierre con `recommendation:rejected`).
> **No depende ni bloquea a #3472** — extiende el wire-up a una rama complementaria del mismo flow.
