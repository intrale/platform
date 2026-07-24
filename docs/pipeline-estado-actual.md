# Estado actual del Pipeline — Diseñado vs. Implementado vs. Funcionando

> **Última actualización:** 2026-06-25 · **Fuente única de verdad del estado del pipeline.**
> Este documento consolida, por subsistema, qué fue *diseñado*, qué está *implementado* en el repo y qué está *funcionando* en operación. No duplica contenido: cada fila enlaza a la doc autoritativa viva. Si una doc viva y esta tabla discrepan, la doc viva es la autoritativa para el detalle; este documento es la autoritativa para el *estado*.
>
> Originado por el issue [#3945](https://github.com/intrale/platform/issues/3945) (épica EP-6 [#3942](https://github.com/intrale/platform/issues/3942)).

## Leyenda de estado

El estado no depende solo del emoji: cada celda acompaña el símbolo con texto para lectores sin render de emoji.

| Símbolo | Significado |
|---------|-------------|
| ✅ funcionando | Implementado y operando en producción/operación real. |
| 🟡 parcial | Implementado pero con cobertura incompleta, en rollout gradual o con flags. |
| 📐 solo diseñado | Diseño/spec escrito, sin implementación completa en el repo. |
| ⛔ no implementado | No existe o fue descontinuado (ver columna correspondiente). |

## Estado por subsistema

| Subsistema | Diseñado | Implementado | Funcionando | Doc autoritativa |
|------------|----------|--------------|-------------|------------------|
| **Pulpo / orquestación** | ✅ sí — modelo event-driven, filesystem como estado, Kanban continuo | ✅ sí — `.pipeline/pulpo.js`, lifecycle de carpetas `pendiente/trabajando/listo/procesado` | ✅ funcionando | [pipeline-v2-diseno.md](pipeline-v2-diseno.md) · [operacion-pipeline.md](operacion-pipeline.md) |
| **Fases definición + desarrollo** | ✅ sí — `analisis → criterios → sizing → validacion → dev → build → verificacion → linteo → aprobacion → entrega` | ✅ sí — skills por fase, rebote con circuit breaker (máx. 3) | ✅ funcionando | [pipeline-agentes.md](pipeline-agentes.md) · [pipeline-v3-pause-rebote.md](pipeline-v3-pause-rebote.md) |
| **Multi-provider** | ✅ sí — cascada Claude > Codex > Groq > Gemini > Cerebras | 🟡 parcial — orden por agente; Groq descontinuado en [#3353](https://github.com/intrale/platform/issues/3353) | 🟡 parcial — pagos solo Claude + Codex; free tier Gemini/Cerebras | [pipeline/multi-provider.md](pipeline/multi-provider.md) |
| **Watchdog** | ✅ sí — liveness por heartbeat, relanzado por Task Scheduler | ✅ sí — `.pipeline` watchdog + log de heartbeat | ✅ funcionando | [pipeline/watchdog.md](pipeline/watchdog.md) |
| **Dashboard** | ✅ sí — dashboard web V3 (servidor HTTP) | ✅ sí — `dashboard-v2.js` (nombre físico V2, producto V3) | ✅ funcionando — el dashboard de terminal (`.claude/dashboard.js`) fue eliminado (ver [decision-monitor-architecture.md](decision-monitor-architecture.md)) | [dashboard-server.md](dashboard-server.md) · [pipeline/dashboard-v3-inventory.md](pipeline/dashboard-v3-inventory.md) |
| **Handoff cross-agente** | ✅ sí — resumen markdown por issue, inyección por fase | 🟡 parcial — `.pipeline/lib/handoff.js`, rollout gradual (`enabled: false` por default) | 🟡 parcial — activado por config `inject_in_phases` | [pipeline-v3-handoff.md](pipeline-v3-handoff.md) |
| **Brazo de desbloqueo / human-in-the-loop** | ✅ sí — puntos de no retorno + escalado a `needs-human` | ✅ sí — circuit breaker de infra con auto-resume | ✅ funcionando | [pipeline/human-in-the-loop.md](pipeline/human-in-the-loop.md) · [pipeline/circuit-breaker-infra-auto-resume.md](pipeline/circuit-breaker-infra-auto-resume.md) |
| **QA E2E** | ✅ sí — tests E2E contra entorno real con video y reporte | 🟡 parcial — `/qa` E2E con emulador Android + Lambda AWS | 🟡 parcial — gate obligatorio antes de merge (`qa:passed`/`qa:skipped`) | [qa-e2e.md](qa-e2e.md) · [qa-doctrina.md](qa-doctrina.md) |

## Componentes descontinuados

Se listan acá para evitar que aparezcan como vivos en otras docs. Las menciones históricas (con su issue de baja) se conservan por valor de auditoría/trazabilidad.

| Componente | Estado | Issue de baja | Referencia |
|------------|--------|---------------|------------|
| **Groq (provider)** | ⛔ descontinuado | [#3353](https://github.com/intrale/platform/issues/3353) | [pipeline/multi-provider.md](pipeline/multi-provider.md) |
| **`tg-session-store.json`** | ⛔ descontinuado | — | [operaciones-reinicio.md](operaciones-reinicio.md) |
| **Dashboard de terminal (`.claude/dashboard.js`)** | ⛔ eliminado | — | [decision-monitor-architecture.md](decision-monitor-architecture.md) |

## Documentos archivados

Las docs históricas/obsoletas viven en [`_archived/`](_archived/README.md), con banner de obsolescencia y política explícita de no-autoritatividad.
