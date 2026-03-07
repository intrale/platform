# Optimización de Modelos IA por Agente — Intrale Platform

> Generado en: 2026-03-07 | Issue: #1244
> Objetivo: reducir consumo de tokens sin sacrificar calidad, bajando skills template-driven de Sonnet a Haiku.

---

## Resumen ejecutivo

El proyecto contaba con 17 de 25 agentes usando `claude-sonnet-4-6` por defecto. Tras el análisis del issue #1244, se identificaron 5 skills que ejecutan tareas altamente estructuradas/template-driven donde Sonnet no aporta valor adicional sobre Haiku. La reasignación reduce el costo estimado de esos 5 agentes en ~96% (Haiku ≈ 4% del precio de input de Sonnet).

**Resultado**: 13 skills en Haiku (+5), 12 en Sonnet (-5). Ninguno en Opus.

---

## Referencia de precios relativos

| Modelo | Input (relativo) | Output (relativo) | Ventana de contexto |
|--------|-----------------|-------------------|---------------------|
| `claude-haiku-4-5-20251001` | ~4% | ~8% | 200k tokens |
| `claude-sonnet-4-6` | 100% | 100% | 200k tokens |
| `claude-opus-4-6` | ~300% | ~450% | 200k tokens |

Fórmula de ahorro estimado: `(1 - precio_haiku/precio_sonnet) × 100 ≈ 96%` por token de input.

---

## Tabla de decisiones — todos los 25 skills

| Skill | Modelo anterior | Modelo nuevo | Decisión | Justificación | Ahorro estimado % |
|-------|----------------|--------------|----------|--------------|-------------------|
| `historia` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | **Bajado** | Flujo 100% template-driven: lee contexto → aplica plantilla fija → `gh issue create`. Sin ambigüedad ni síntesis compleja. Alta frecuencia (múltiples por sprint). | ~96% |
| `refinar` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | **Bajado** | Aplica estructura estándar a issues existentes. Operación de formateo y enriquecimiento con criterios fijos. Altamente repetitivo. | ~96% |
| `priorizar` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | **Bajado** | Triaje masivo con reglas fijas de labels y backlogs. No requiere síntesis de múltiples fuentes ni razonamiento abierto. | ~96% |
| `scrum` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | **Bajado** | Consulta board de GitHub, genera métricas con fórmulas predefinidas y sigue metodología Scrum estructurada. Sin razonamiento complejo. | ~96% |
| `doc` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` | **Bajado** | Orquestador de `historia` y `refinar`. Si ambos sub-skills operan bien en Haiku, `doc` también puede bajar. Tarea de routing, no de razonamiento. | ~96% |
| `guru` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Investigación técnica abierta + Context7 + WebSearch. Síntesis de múltiples fuentes de documentación. Contextos grandes. Razonamiento profundo requerido. | — |
| `review` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Análisis de calidad de código con criterios subjetivos y arquitectónicos. Un error tiene alto impacto (permite merge de código defectuoso). | — |
| `qa` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Genera scripts E2E complejos, interpreta errores de UI, toma decisiones de cobertura. Alto costo de fallo. | — |
| `security` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Detección de vulnerabilidades OWASP. Un falso negativo tiene consecuencias de seguridad. No negociable. | — |
| `po` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Razonamiento de negocio con ambigüedad inherente. Lee contexto de business-rules.md + issue + codebase. Síntesis compleja. | — |
| `planner` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Planificación estratégica con múltiples trade-offs. Genera `sprint-plan.json` que dirige todo el pipeline automatizado. Alto impacto de error. | — |
| `android-dev` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Escritura de código real (Compose Android, Kotlin). Calidad crítica. | — |
| `backend-dev` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Escritura de código real (Ktor, DynamoDB, Cognito). Calidad crítica. | — |
| `ios-dev` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Escritura de código real (ComposeUIViewController, framework binaries). Calidad crítica. | — |
| `web-dev` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Escritura de código real (Kotlin/Wasm, PWA). Calidad crítica. | — |
| `desktop-dev` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Escritura de código real (JVM Desktop, Compose, Swing). Calidad crítica. | — |
| `ux` | `claude-sonnet-4-6` | `claude-sonnet-4-6` | **Mantiene** | Benchmark de tendencias + WebSearch + análisis de pantallas. Requiere síntesis. Evaluar en sprint futuro con datos de tokens reales. | — |
| `auth` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Auditoría de permisos con reglas fijas. Correcto. | — |
| `branch` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Gestión de ramas con comandos git predefinidos. Correcto. | — |
| `builder` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Ejecuta `./gradlew` con flags estándar. Correcto. | — |
| `cleanup` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Limpieza de logs y temporales. Correcto. | — |
| `delivery` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Commit + push + PR con convención fija. Correcto. | — |
| `monitor` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Dashboard de lectura, sin escritura de código. Correcto. | — |
| `ops` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Health-check del entorno con comandos conocidos. Correcto. | — |
| `tester` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Sin cambio | Ya en Haiku. Ejecuta `./gradlew check`. Para análisis de fallos complejos, invocar `guru` o `review`. | — |

---

## Distribución final de modelos

| Modelo | Skills |
|--------|--------|
| `claude-haiku-4-5-20251001` (13) | `auth`, `branch`, `builder`, `cleanup`, `delivery`, **`doc`**, **`historia`**, `monitor`, `ops`, **`priorizar`**, **`refinar`**, **`scrum`**, `tester` |
| `claude-sonnet-4-6` (12) | `android-dev`, `backend-dev`, `desktop-dev`, `guru`, `ios-dev`, `planner`, `po`, `qa`, `review`, `security`, `ux`, `web-dev` |
| `claude-opus-4-6` (0) | — |

---

## Ahorro estimado por sprint

Asumiendo métricas de uso típico (sin datos reales disponibles aún — ver sección de tokens):

| Skill | Invocaciones/sprint (est.) | Tokens/invocación (est.) | Costo relativo antes | Costo relativo después | Ahorro % |
|-------|---------------------------|--------------------------|---------------------|------------------------|----------|
| `historia` | 10 | 30,000 | 300,000 unidades | 12,000 unidades | 96% |
| `refinar` | 8 | 25,000 | 200,000 unidades | 8,000 unidades | 96% |
| `priorizar` | 2 | 80,000 | 160,000 unidades | 6,400 unidades | 96% |
| `scrum` | 5 | 40,000 | 200,000 unidades | 8,000 unidades | 96% |
| `doc` | 3 | 35,000 | 105,000 unidades | 4,200 unidades | 96% |
| **Total 5 skills** | — | — | **965,000 unidades** | **38,600 unidades** | **~96%** |

> Nota: "unidades" son relativas al precio de Sonnet input = 1. Los datos son estimaciones; actualizar cuando `agent-metrics.json` tenga datos reales de `tokens_input`/`tokens_output`.

---

## Instrumentación de tokens (#1244)

### Estado actual

Se agregaron los siguientes campos a `agent-metrics.json` por sesión:

```json
{
  "tokens_input": null,
  "tokens_output": null,
  "tokens_total": null
}
```

Los campos están presentes en todas las sesiones a partir de este issue. El valor `null` indica que la API de Claude Code no expuso datos de usage en esa sesión.

### Mecanismo de captura

1. **`activity-logger.js` (PostToolUse hook)**: Lee `data.usage.input_tokens` y `data.usage.output_tokens` de cada evento y los acumula en `session.tokens_input` / `session.tokens_output`.
2. **`stop-notify.js` (Stop hook)**: Lee `data.usage` del evento Stop (si la API lo incluye), agrega al acumulado de la sesión, y persiste `tokens_input`, `tokens_output`, `tokens_total` en `agent-metrics.json` vía `flushMetrics()`.
3. MAX_READ en `stop-notify.js` aumentado de 4,096 a 65,536 bytes para asegurar captura de `usage` después de `last_assistant_message` largo.

### Limitación conocida

La API de Claude Code no garantiza exponer `usage` en los payloads de hooks de la versión actual. Los campos estarán presentes en `agent-metrics.json` pero con valor `null` hasta que la API los exponga. Esta limitación está documentada aquí y no invalida el resto de las optimizaciones (que se basan en análisis cualitativo de complejidad cognitiva).

---

## Candidatos para análisis futuro

### Sub-agentes especializados (evaluación pendiente)

El issue #1244 propone la creación de sub-agentes especializados. Se difiere para un sprint posterior cuando haya datos reales de tokens:

| Propuesta | Runner (Haiku) | Analyzer (Sonnet) | Decisión |
|-----------|----------------|-------------------|----------|
| `tester` → `tester-runner` + `tester-analyzer` | Ejecuta `./gradlew check` | Interpreta fallos complejos | Diferido — tester ya es Haiku |
| `qa` → `qa-runner` + `qa-reporter` | Ejecuta scripts, graba video | Redacta reporte narrativo | Diferido — evaluar con métricas reales |
| `planner` → `planner-data` + `planner-strategy` | Fetch de issues/métricas | Razonamiento estratégico | Diferido — alto riesgo de regresión |

### `ux` — candidato marginal

`ux` usa WebSearch para benchmark de tendencias, lo que puede generar contextos grandes. Se mantiene en Sonnet por precaución. Re-evaluar en sprint 2026-Q2 con datos de `tokens_input` reales.

---

## Criterios de no regresión

Para verificar que los skills bajados a Haiku no degradan en calidad:

| Check | Descripción |
|-------|-------------|
| `/historia "Agregar campo X"` | Debe crear issue con título, body completo (objetivo, contexto, cambios, criterios de aceptación), labels correctos, milestone asignado |
| `/refinar 1244` | Debe aplicar estructura estándar al issue sin perder información del body original |
| `/priorizar` | Debe categorizar issues sin labels y asignar `tipo:*` + `area:*` correctamente |
| `/scrum audit` | Debe generar informe de salud del board con métricas cuantitativas |
| `/doc nueva "descripción"` | Debe delegar correctamente a `/historia` y retornar issue creado |

---

*Documento generado por agente `agent/1244-auditoria-modelos-ia`. Actualizar con métricas reales cuando `agent-metrics.json` registre `tokens_input`/`tokens_output` no-nulos.*
