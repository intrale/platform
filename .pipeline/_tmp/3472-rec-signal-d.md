## Contexto técnico

El issue #3472 (wire-up in-flight fallback) y el complemento técnico de Leo del 2026-05-26 (Ola N+10) definen un **detector multi-señal** A-E para clasificar caídas de provider:

| Señal | Qué mide | Estado |
|---|---|---|
| **A** — exit codes muerte prematura <15s repetida | 3+ exits code≠0 en 60s | Cubierto por #3563 (parser plain-text) |
| **B** — HTTP status 401/402/429/5xx | Capturado en stderr o exit code mapeado | Parcial via #3486 |
| **C** — output structural (respuesta vacía / sin tokens) | `first_byte_timer` agota sin bytes | Cubierto por wire-up #3472 |
| **D** — **telemetría burst >70% fallos en ventana 5min** | Auto-quarantine + Telegram alert | **NO cubierto** |
| **E** — mini-clasificador LLM (texto libre stderr/stdout) | Llamada barata a secundario solo para clasificar | Cubierto por #3564 (sanitization) |

La **señal D es la única que opera fuera del per-turn wire-up**: en vez de mirar el output de UN spawn, agrega histórico cross-turn para detectar degradación sistémica de un provider antes de que afecte a muchos usuarios.

Hoy el commander toma decisiones turn-por-turn sin awareness del histórico reciente. Un provider que falla el 80% de las veces sigue siendo intentado como primario hasta que cada caso individual dispare su fallback in-flight — desperdiciando latencia y cuota.

## Beneficio esperado

- Auto-quarantine proactivo de un provider degradado **antes** de que muchos usuarios disparen wire-ups in-flight.
- Reducir latencia promedio: si Anthropic está al 75% de fallos en 5min, todos los siguientes turns saltan directo al fallback sin esperar el first-byte timer de 15s.
- Alerta Telegram a Leo cuando se dispara el quarantine, con evidencia (señales agregadas, ventana, provider).
- Defensa en profundidad sobre el per-turn wire-up: incluso si el wire-up funciona perfecto, evitar el costo agregado de N retries innecesarios.

## Acciones sugeridas

- Implementar aggregator que lee `.pipeline/logs/commander-dispatch-YYYY-MM-DD.jsonl` (audit log existente) y calcula `failure_rate` por provider en ventana móvil de 5 minutos.
- Diseñar el umbral configurable (default 70%) con mínimo de muestras (ej: ≥10 turns en la ventana, para evitar disparar con 1/1 o 2/2 fallos).
- Persistir el quarantine en `.pipeline/state/provider-quarantine.jsonl` (mismo shape sugerido en el comentario de seguridad de #3472), con campos `{ts, provider, signals_triggered, evidence_excerpt, until_ts, source: 'inflight'|'precheck'|'burst'}`.
- Tiempo de cuarentena configurable (default 10min), con re-evaluación automática al expirar.
- Integrar con `quotaExhausted.setFlag` existente para que el dispatcher pre-spawn YA conozca el quarantine como gate adicional (sin reinventar el mecanismo).
- Telegram alert template: `🔥 Provider {X} en cuarentena por burst: {rate}% fallos en últimos 5min ({hits}/{total}). Auto-recovery en {N}min.`
- Métrica nueva: `signal_match_breakdown` por provider — cuál señal activó cada quarantine (A/B/C/D/E) para tuning.

## Referencia

> Propuesto automáticamente por el agente `guru` durante el análisis del issue #3472.
> **Es una recomendación pendiente de aprobación humana** — no entra al pipeline automático hasta que un humano remueva el label `needs-human` y agregue `recommendation:approved` (o cierre con `recommendation:rejected`).
> **No depende ni bloquea a #3472** — es defensa en profundidad cross-turn complementaria al per-turn wire-up.
