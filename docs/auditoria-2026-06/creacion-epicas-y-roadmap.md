# Creación de Épicas en GitHub — Reporte Final, Análisis de Gaps y Roadmap

**Fecha:** 2026-06-10 · **Repo:** `intrale/platform` · **Fuente:** Auditoría del Modelo Operativo 2026-06-10 (v5)
**Resultado:** 8 épicas + 43 historias = **51 issues creados** (#3915 – #3965), con capturas reales y mockups embebidos en los issues de UI (assets publicados en la rama `docs/auditoria-dashboard-2026-06`).

> Nota operativa: ningún issue lleva labels de intake (`needs-definition`/`ready`), por lo que el Pulpo **no** los tomará automáticamente. Cuando una ola arranque, basta etiquetar sus historias para que entren al pipeline.

---

## 1. Issues creados por épica

| Épica | Issue | Historias (issues) |
|---|---|---|
| EP-1 · Canal de voz 100 % gratuito y confiable | **#3915** | #3916 (faster-whisper), #3917 (stack gratuito oficial), #3918 (eco de transcripción), #3919 (aviso degradación multimedia) |
| EP-2 · Sherlock cross-provider y determinístico | **#3920** | #3921 (chain cross-provider), #3922 (contexto conversacional), #3923 (árbitro canónico ≥7 claims), #3924 (presupuesto evidencia 2-3 s), #3925 (latencia acotada) |
| EP-3 · Entregables parciales multimedia (Fase 2) | **#3926** | #3927 (videos→Drive), #3928 (perfiles+whitelist 6 skills), #3929 (doctrina de productores), #3930 (audio TTS + CUA on), #3931 (roots/formatos), #3932 (métrica % entregables) |
| EP-4 · Memoria conversacional del Commander | **#3933** | #3934 (conversación persistida), #3935 (resumen incremental), #3936 (contexto de proyecto) |
| EP-5 · Robustez del Pulpo | **#3937** | #3938 (tests de brazos), #3939 (TOCTOU claim-by-rename), #3940 (auto-resume breaker), #3941 (schema + fail-fast) |
| EP-6 · Higiene y gobernanza documental | **#3942** | #3943 (worktrees + basura), #3944 (reglas agents/), #3945 (doc estado actual), #3946 (evidencia QA fuera de git + logs) |
| EP-7 · Commander observable y sin errores espurios | **#3947** | #3948 (commander en dashboard), #3949 (logs por petición), #3950 (auto-retry glitch 1M #3506), #3951 (clasificación en Historial) |
| EP-8 · Rediseño integral del dashboard | **#3952** | #3953 (H0 fundamentos), #3954 (Home), #3955 (Equipo), #3956 (Pipeline), #3957 (Bloqueados), #3958 (Issues), #3959 (Matriz), #3960 (Ops), #3961 (KPIs), #3962 (Costos), #3963 (Historial), #3964 (Descanso), #3965 (Multi-provider) |

**Detalle común:** cada épica tiene Objetivo, Contexto y checklist con links a sus historias; cada historia tiene Objetivo, Criterios de aceptación con checkboxes, referencia a la épica y al reporte. Las 13 historias de EP-8 y la EP7-H1 incluyen las imágenes (captura actual + mockup objetivo). Labels usados: `epic`, `area:pipeline`, `area:dashboard`, `area:infra`, `tipo:infra`, `ux`, `docs`, `enhancement`, `bug`, `area:testing`.

---

## 2. Análisis de cobertura: reporte de auditoría vs. issues creados

### 2.1 Cobertura completa (mejora → issue)

| Mejora del reporte | Issue(s) |
|---|---|
| I-V1 stack multimedia gratuito | #3916, #3917 |
| I-V2 eco de transcripción | #3918 |
| I-V3 memoria conversacional | #3934, #3935 |
| I-V4 Sherlock cross-provider | #3921, #3922 |
| I-V5 falso error "1M context" | #3950 |
| I-M1 entregables: Drive + whitelist | #3927, #3928 |
| I-1 tests de brazos del Pulpo | #3938 |
| I-2 condiciones de carrera TOCTOU | #3939 |
| I-3 auto-resume del circuit breaker | #3940 |
| I-4 fail-fast + schema de config | #3941 |
| I-6 worktrees + basura de raíz | #3943 |
| R-V1 árbitro canónico ampliado | #3923 |
| R-V2 latencia de Sherlock | #3925 |
| R-V3 presupuesto de evidencia | #3924 |
| R-V6 Commander en dashboard | #3948, #3949, #3951 |
| R-M1 doctrina de productores + audio/CUA | #3929, #3930 |
| R-3 ambigüedades en reglas agents/ | #3944 |
| R-4 consolidación documental V1/V2/V3 | #3945 |
| R-8 evidencia QA fuera de git | #3946 |
| R-9 rotación de logs JSONL | #3946 |
| D-4 dashboard DORA | #3961 |
| Rediseño dashboard (12 pantallas + fundamentos) | #3953-#3965 |
| Métricas de éxito (voz y entregables) | #3921, #3923, #3932, #3961 |

### 2.2 GAPS — contenido del reporte SIN issue creado

**Gaps accionables (recomiendo agruparlos en una futura EP-9 "Deuda operativa y quick wins"):**

| # | Gap | Origen en el reporte | Severidad |
|---|---|---|---|
| G-1 | Rotar el bot token de Telegram + ACL restrictiva en `~/.claude/secrets/credentials.json` | I-5 | Alta (seguridad; además es acción manual de 10 min, puede no ameritar issue) |
| G-2 | `notify-telegram.js` silenciado: reactivar o eliminar el hook | I-7 | Alta (canal de alertas a medias) |
| G-3 | Unificar el cliente Telegram (3 implementaciones, timeouts dispares) + límite de cola en commander/pendiente + circuit breaker de API | R-2 | Media |
| G-4 | Split inteligente de respuestas largas (>4.000 chars) + fallback MarkdownV2→HTML en el listener | R-V5 | Media |
| G-5 | Aviso proactivo de provider degradado sin tool-use (gate SEC-5 bloquea acciones con respuesta enlatada) — #3919 cubre solo degradación multimedia | R-V4 (parcial) | Media |
| G-6 | Eliminar rutas hardcodeadas (`C:\Workspaces\gh-cli\...` en 7+ scripts y pulpo) | R-5 | Media |
| G-7 | Distinguir timeout vs. crash en muerte prematura de agentes (clasificación por exit code + duración) | R-6 | Media |
| G-8 | Externalizar magic numbers a config.yaml (cooldowns, MAX_EST_MEM, dedup de alertas) | R-7 | Baja |
| G-9 | Modularización completa de pulpo.js/dashboard.js como refactor explícito — #3938 solo extrae la lógica de brazos; el rediseño EP-8 reescribe vistas pero no compromete la separación del monolito | R-1 (parcial) | Media |
| G-10 | Validación de arranque ampliada (credenciales Telegram, gh accesible, espacio en disco) — #3941 cubre solo schema de config | R-10 (parcial) | Baja |

**Gaps deliberados (mejoras "deseadas" de la auditoría, conscientemente fuera del backlog inicial):**

| # | Gap | Origen |
|---|---|---|
| G-11 | SLAs formales por estado/proceso con alertas | D-1 |
| G-12 | Retrospectiva automática de rebotes (análisis semanal de causas raíz → issues de mejora) | D-2 |
| G-13 | Presupuesto de tokens por issue/ola con gate en el lanzamiento (#3962 agrega presupuesto mensual visual, no el gate) | D-3 |
| G-14 | Portabilidad multi-OS (capa platform-utils) | D-5 |
| G-15 | Pool de emuladores persistente para QA | D-6 |
| G-16 | Limpieza de scripts legacy (`patch-dashboard-1765*`, skills frozen) — #3943 cubre worktrees/basura, no scripts | D-7 |
| G-17 | Caché de configuración en hooks (TTL 30 s) | D-8 |

**Conclusión de cobertura:** las 8 épicas cubren **el 100 % de las mejoras imprescindibles salvo dos** (I-5 e I-7, ambas quick-wins que pueden resolverse a mano hoy o entrar en la EP-9), **13 de 17 recomendadas** (4 gaps: G-3..G-8) y **1 de 8 deseadas** (decisión consciente de foco). Ninguna sección del reporte quedó sin representación: voz (EP-1/2/4/7), entregables (EP-3), Pulpo (EP-5), higiene/docs (EP-6) y dashboard (EP-8).

---

## 3. Roadmap de ejecución en olas

Diseñado para el límite real de **3 agentes concurrentes** (≈6 historias por ola, mezclando áreas para no saturar un solo skill), respetando dependencias técnicas. Cada ola es autocontenida: se puede cargar al pipeline etiquetando sus issues.

### Ola 1 — "Recuperar la confianza" (canal de voz + desbloqueos)
*Las 6 son independientes entre sí, de bajo riesgo y alto impacto inmediato.*

| Issue | Historia | Por qué primero |
|---|---|---|
| #3916 | faster-whisper large-v3-turbo | El STT corre degradado HOY; mejora calidad de todo lo que sigue |
| #3917 | Stack gratuito oficial (retirar OpenAI/ElevenLabs) | Elimina latencia y ruido de primarios muertos |
| #3918 | Eco de transcripción | Mínimo costo, máximo impacto en confianza del canal |
| #3950 | Auto-retry glitch 1M (#3506) | Elimina el error espurio que hoy descarta peticiones |
| #3940 | Auto-resume del circuit breaker | Evita el modo de fallo "pipeline muerto para siempre" |
| #3943 | Limpieza worktrees + basura | Recupera ~8 GB; reduce riesgo de disco lleno |

### Ola 2 — "Sherlock confiable + entregables núcleo"
*Depende de Ola 1 solo en lo conceptual (canal estable para medir).*

| Issue | Historia | Dependencias |
|---|---|---|
| #3921 | Chain cross-provider de Sherlock | — |
| #3924 | Presupuesto de evidencia 2-3 s | — |
| #3927 | Videos→Drive + notificación de fallos | — |
| #3928 | Perfiles + whitelist 6 skills | — |
| #3919 | Aviso de degradación multimedia | #3917 |
| #3939 | TOCTOU claim-by-rename | — |

### Ola 3 — "Observabilidad + fundamentos"
| Issue | Historia | Dependencias |
|---|---|---|
| #3948 | Commander como agente en dashboard | — |
| #3949 | Logs del Commander por petición | #3948 |
| #3953 | EP8-H0 fundamentos del design system | — (habilita todas las pantallas) |
| #3941 | Schema de config + fail-fast | — |
| #3929 | Doctrina de productores | #3928 |
| #3923 | Árbitro canónico ≥7 claims | #3924 |

### Ola 4 — "Memoria + dashboard operativo núcleo"
| Issue | Historia | Dependencias |
|---|---|---|
| #3934 | Conversación estructurada persistida | — |
| #3935 | Resumen incremental | #3934 |
| #3936 | Contexto de proyecto en el prompt | — |
| #3954 | Home → mission control | #3953, #3948 (muestra al Commander) |
| #3956 | Pipeline → zoom semántico | #3953 |
| #3957 | Bloqueados → triage queue | #3953 |

### Ola 5 — "Sherlock fino + entregables cierre + dashboard 2"
| Issue | Historia | Dependencias |
|---|---|---|
| #3922 | Contexto conversacional a Sherlock | #3934 (usa la conversación estructurada) |
| #3925 | Latencia de Sherlock acotada | #3921 |
| #3930 | Audio TTS + CUA encendidos | #3927, #3917 (Edge) |
| #3931 | Roots/formatos consistentes | #3928 |
| #3955 | Equipo → acordeón | #3953, #3948 |
| #3960 | Ops → topología | #3953 |
| #3951 | Clasificación del Commander en Historial | #3949 |

### Ola 6 — "Calidad estructural + dashboard analítico"
| Issue | Historia | Dependencias |
|---|---|---|
| #3938 | Tests de brazos (con extracción) | #3939, #3941 (menos riesgo al refactorizar) |
| #3958 | Issues → tabla + panel | #3953 |
| #3959 | Matriz → heat-map interactivo | #3953 |
| #3961 | KPIs → sparklines + métricas voz/entregables | #3953, #3921, #3923 (series ya emitiéndose) |
| #3932 | Métrica % entregables por skill | #3927-#3929 (datos reales) |
| #3944 | Reglas agents/ sin ambigüedades | — |

### Ola 7 — "Cierre y pulido"
| Issue | Historia | Dependencias |
|---|---|---|
| #3962 | Costos → presupuesto + anomalía | #3953 |
| #3963 | Historial → timeline con entregables | #3953, #3932 |
| #3964 | Descanso → timeline semanal | #3953 |
| #3965 | Multi-provider (pantalla nueva) | #3953, #3921 (% cross-provider) |
| #3945 | Doc pipeline-estado-actual | mejor al final: documenta lo ya cambiado |
| #3946 | Evidencia QA fuera de git + rotación logs | — |

**Lectura del roadmap:** 7 olas × ~6 historias. A ritmo histórico del pipeline (1-2 semanas por ola con 3 agentes), el horizonte completo es de **2-3.5 meses**. Las olas 1-2 entregan el 80 % del valor percibido por el operador (voz confiable, Sherlock cross-provider, entregables que llegan); las olas 3-5 construyen observabilidad y memoria; las 6-7 consolidan calidad estructural y completan el rediseño.

**Hitos de control entre olas:** tras Ola 2, medir % same-provider de Sherlock y tasa de transcripciones corregidas; tras Ola 4, validar el Home nuevo en el kiosk real; tras Ola 6, correr la retro de métricas para decidir si la EP-9 (gaps G-1..G-10) entra antes que la Ola 7.

---

*Generado automáticamente al crear las épicas — 2026-06-10. Issues: https://github.com/intrale/platform/issues (filtrar por label `epic`).*
