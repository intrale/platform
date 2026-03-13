# Metodología Ágil — Intrale Platform

Documento vivo. Actualizable via `/scrum mejoras`.

## Principios

1. **El board es la fuente de verdad** — si no está en el board, no existe para el equipo
2. **Facilitador, no bloqueador** — el Scrum Master sugiere y corrige, no impone
3. **Data-driven** — decisiones basadas en métricas, no en opiniones
4. **Adaptación continua** — la metodología evoluciona con el equipo

## Columnas del Board

| Columna | Significado | Quién mueve aquí |
|---------|------------|-----------------|
| Todo | Pendiente de inicio, priorizado | `/planner`, `/doc refinar`, manual |
| In Progress | Alguien está trabajando activamente | Desarrollador, agente al iniciar |
| Ready | Implementado, esperando review/QA | `/delivery` al crear PR |
| Blocked | Bloqueado por dependencia externa o interna | Desarrollador, `/scrum sync` |
| Done | Completado y cerrado | `post-issue-close.js` hook, `/scrum sync` |

## Transiciones válidas

```
Todo → In Progress      (alguien empieza a trabajar)
Todo → Blocked          (se descubre bloqueo antes de empezar)
In Progress → Ready     (PR creado, esperando review)
In Progress → Blocked   (bloqueo descubierto durante desarrollo)
In Progress → Done      (fix directo sin PR, issue cerrado)
Ready → Done            (PR mergeado, issue cerrado)
Ready → In Progress     (review rechazado, vuelve a desarrollo)
Blocked → Todo          (bloqueo resuelto, vuelve a cola)
Blocked → In Progress   (bloqueo resuelto, se retoma inmediatamente)
```

### Transiciones inválidas (no deberían ocurrir)

```
Done → cualquiera       (reabrir issues es excepcional — hacerlo manual)
Ready → Todo            (si no pasa review, vuelve a In Progress, no a Todo)
Todo → Ready            (no se puede estar listo sin haber trabajado)
Todo → Done             (no se puede completar sin haber trabajado — salvo duplicados)
```

## Umbrales de staleness

| Columna | Umbral | Acción sugerida |
|---------|--------|----------------|
| In Progress | > 7 días sin update | Marcar como stale, alertar en standup |
| Todo | > 14 días sin update | Revisar si sigue siendo relevante |
| Blocked | > 21 días | Escalar: requiere acción urgente de desbloqueo |
| Ready | > 5 días | Revisar si el PR necesita atención |

## WIP Limits

- **In Progress**: máximo 5 issues simultáneamente (límite blando)
  - Si se excede: alertar en auditoría y standup, pero no bloquear
  - Razón: más de 5 issues en progreso indica falta de foco
- **Blocked**: sin límite, pero ratio blocked/in_progress > 50% es alerta

## Métricas de salud

### WIP (Work In Progress)
- Cuenta de items en In Progress
- Objetivo: ≤ 5

### Blocked Ratio
- `blocked / (in_progress + blocked) * 100`
- Objetivo: < 30%

### Throughput
- Issues cerrados por semana (últimos 30 días)
- Sin objetivo fijo — tendencia importa más que valor absoluto

### Cycle Time
- Tiempo promedio desde Todo hasta Done
- Calculado sobre issues cerrados en últimos 30 días
- Aproximación usando `updatedAt` y `closedAt`

## Reglas de higiene

### Automáticas (detectadas por auditoría)

Las siguientes reglas son ejecutadas automáticamente por `/scrum audit` mediante
`scrum-auto-corrections.js`. Las correcciones se aplican sin intervención manual
y se comentan en cada issue con el patrón:
`🔄 Scrum Master: movido de [anterior] → [nuevo]. Razón: [razón]. Detectado: [timestamp]`

#### Reglas de coherencia estado → columna

| # | Condición | Acción | Prioridad |
|---|-----------|--------|-----------|
| 1 | Issue `state: CLOSED` + Status ≠ Done | Mover a **Done** | Alta (1) |
| 2 | Label `in-progress` + Status en Backlog/Todo | Mover a **In Progress** | Media (2) |
| 3 | Label `ready` + Status en Backlog/Todo | Mover a **Ready** | Media (3) |
| 4 | Sin label `blocked` + Status = Blocked | Mover a **Todo** | Media (4) |
| 5 | Label `blocked` + Status ≠ Blocked | ⚠️ Advertencia (no auto-corrige) | — |

**Notas importantes:**
- La regla 1 tiene prioridad sobre todas las demás. Un issue cerrado con label `in-progress`
  se mueve a Done (no a In Progress).
- La regla 5 no se auto-corrige porque el movimiento a Blocked puede requerir contexto humano.
- Rate limit: máx 30 mutations/minuto. Si hay más correcciones, se procesan en batches.
- Columnas consideradas "Backlog": `Todo`, `Refined`, `Backlog Tecnico`, `Backlog CLIENTE`,
  `Backlog NEGOCIO`, `Backlog DELIVERY`.
- Patrón de comentario en el issue: `🔄 Scrum Master: movido de [anterior] → [nuevo]. Razón: [razón]. _Detección automática: [timestamp]_`
- Script de correcciones: `.claude/hooks/scrum-auto-corrections.js`

#### Otras reglas (detectadas, corregidas en modo sync)

6. Issue con PR mergeado → Status debe ser Ready o Done
7. Issue con rama `agent/*` activa y asignado → Status debe ser In Progress
8. Issue abierto no en board → huérfano, agregar al board

### Manuales (sugeridas en standup)

1. Issues stale → revisar si siguen activos
2. WIP excedido → priorizar completar antes de empezar nuevo
3. Blocked largo → buscar alternativas o escalar

## Historial de cambios

| Fecha | Cambio | Razón |
|-------|--------|-------|
| 2026-03-09 | Agregar sección "Reglas de coherencia estado → columna" + alinear con `scrum-auto-corrections.js` | Issue #1301 — auditoría con auto-correcciones |
| 2026-03-02 | Versión inicial | Creación del skill /scrum |
