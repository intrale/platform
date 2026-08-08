# Criterios de planificación — Planner

## Scoring de prioridad

Cada issue recibe un score. Mayor score = más urgente.

### Factor 1: Tipo de impacto (0-40 pts)

| Condición | Puntos |
|-----------|--------|
| Bloquea compilación o CI | +40 |
| Test failure en rama principal | +35 |
| Bug en producción | +30 |
| Otros issues dependen de este | +25 |
| PR abierto esperando merge | +20 |
| Feature con label `Refined` | +15 |
| Feature normal | +5 |

### Factor 2: Estado en Project V2 (0-20 pts)

| Estado | Puntos |
|--------|--------|
| In Progress | +20 |
| Ready | +18 |
| Refined | +15 |
| Backlog (sin refinar) | +5 |
| Sin agregar al proyecto | 0 |

### Factor 3: Etiqueta de delegación (0-10 pts)

| Condición | Puntos |
|-----------|--------|
| Tiene label `codex` (bot puede ejecutarlo) | +10 |
| Sin assignee (libre para tomar) | +5 |
| Asignado a leitolarreta | +3 |

### Factor 4: Tamaño estimado (0-10 pts)

| Tamaño | Puntos | Criterio |
|--------|--------|----------|
| S — 1 día | +10 | Body corto, cambio puntual |
| M — 2-3 días | +7 | Feature completa acotada |
| L — 1 semana | +4 | Feature compleja o refactor |
| XL — 2+ semanas | +1 | Cambio estructural |

> Preferir S/M para wins rápidos y flujo continuo.

---

## Detección de dependencias

### Dependencias explícitas (buscar en body del issue)

Patrones que indican que el issue A depende del issue B:
- "depende de #NNN"
- "requiere #NNN"
- "bloqueado por #NNN"
- "necesita que esté implementado #NNN"
- "Closes #NNN" en PRs (el PR resuelve el issue)

### Dependencias técnicas implícitas (por módulo)

```
:backend → cualquier feature que requiera nuevo endpoint
:users → features de auth, profile, 2FA
autenticación → cualquier pantalla protegida
strings (MessageKey) → cualquier texto nuevo en UI
```

Si un issue en Stream B (App Cliente) menciona un endpoint nuevo, implica dependencia de Stream A (Backend).

### Dependencias por orden lógico

```
Diseño/UX → Implementación → Tests → Deploy
Backend endpoint → App feature → App tests
Strings nuevos → UI que los usa
```

---

## Streams de trabajo

Definición de streams paralelos:

```
Stream A — Backend/Infra
  Módulos: backend/, users/
  Issues típicos: nuevos endpoints, seguridad, AWS, CI
  Independiente de: B, C, D

Stream B — App Cliente
  Módulos: ui/sc/client/, asdo/client/, ext/client/
  Issues típicos: pantallas de cliente, carrito, perfil
  Depende de: A (si necesita nuevos endpoints)

Stream C — App Negocio
  Módulos: ui/sc/business/, asdo/business/, ext/business/
  Issues típicos: catálogo, pedidos, dashboard negocio
  Depende de: A (si necesita nuevos endpoints)

Stream D — App Delivery
  Módulos: ui/sc/delivery/, asdo/delivery/, ext/delivery/
  Issues típicos: perfil repartidor, asignación, disponibilidad
  Depende de: A (si necesita nuevos endpoints)

Stream E — Cross-cutting
  Módulos: strings/, buildSrc/, DIManager, Router
  Issues típicos: migrations de strings, temas, navegación global
  Bloquea: B, C, D (si toca strings o DI compartido)
```

---

## Heurística de esfuerzo

### S — 1 día
- Corrección de import faltante
- Fix de bug con causa clara
- Ajuste de texto o traducción
- Agregar test a código existente

### M — 2-3 días
- Nueva pantalla completa (ViewModel + Screen + tests)
- Nuevo endpoint backend con tests
- Feature en módulo existente (nuevo campo en form)
- Refactor acotado de un archivo

### L — 1 semana
- Nuevo flujo completo (múltiples pantallas)
- Integración con servicio externo nuevo
- Refactor de módulo entero
- Feature con cambios en backend + app

### XL — 2+ semanas
- Nuevo módulo desde cero
- Cambio de arquitectura
- Migración de tecnología

---

## Priorización inter-sprint: Técnico → QA → Negocio

Al cerrar un sprint y planificar el siguiente, se aplica una priorización por fases.
Este orden es **estricto**: primero se llena la cuota de la Fase 1 antes de pasar a la Fase 2.

### Fase 1 — Backlog Técnico (máx 5 issues, preferir S/M)

Issues con alguna de estas características:

| Condición | Labels esperados |
|-----------|-----------------|
| Infra, hooks, pipeline, CI/CD | `backlog-tecnico`, `tipo:infra`, `area:infra` |
| Deuda técnica crítica | `backlog-tecnico`, `enhancement` |
| Bloqueadores (bloquean CI, tests, compilación) | `blocker` |
| Pipeline de agentes / sprint management | `backlog-tecnico` |

**Bonus de scoring:** +30 pts sobre el scoring base para issues técnicos.

**Regla**: Siempre priorizar infra sobre features de producto. Un bug en el pipeline afecta a todos los sprints futuros.

### Fase 2 — QA/E2E Pendiente (máx 3 issues)

Issues con alguna de estas características:

| Condición | Labels esperados |
|-----------|-----------------|
| Issues con status "Ready" pero sin validación QA | `qa-pending` |
| Issues marcados como "needs-qa" | `needs-qa` |
| Features implementadas pero sin cobertura de tests | `testing` |
| Cuerpo del issue menciona "QA E2E" o "validación qa" | (búsqueda en body) |

**Regla**: Un issue que llegó a "Done" sin QA tiene riesgo latente. Priorizarlos antes de agregar más features.

### Fase 3 — Backlog de Negocio (resto del capacity, ~5 issues)

Issues con alguna de estas características:

| Condición | Labels esperados |
|-----------|-----------------|
| Features de app cliente | `app:client` |
| Features de app negocio | `app:business` |
| Features de app delivery | `app:delivery` |
| Mejoras de producto sin clasificar | `enhancement`, `feature` |

**Regla**: Las features de negocio son valiosas pero no deben bloquear la salud del sistema.

### Restricciones de capacidad

| Restricción | Valor |
|------------|-------|
| Máximo issues por sprint | 5 (ajustable con `--max N`) |
| Máximo agentes simultáneos | 2 (tandas de 2+2+1) |
| Issues bloqueados | Excluidos hasta que se resuelva el bloqueador |

### Ejemplo de plan con priorización

```
Sprint 2026-03-15:
  Fase 1 (Técnico, 2 issues): #1267 auto-plan, #1280 ci-fix
  Fase 2 (QA, 1 issue):       #1250 test-coverage-backend
  Fase 3 (Negocio, 2 issues): #1260 orders-screen, #1245 product-catalog

Agentes simultáneos: #1267 + #1280
Cola (tanda 2):      #1250 + #1260
Cola (tanda 3):      #1245
```

---

## Template de Gantt (Mermaid)

```mermaid
gantt
    title Intrale Platform — Plan [FECHA]
    dateFormat YYYY-MM-DD
    excludes weekends

    section 🔴 Bloqueantes
    [issue]    :crit, id, YYYY-MM-DD, Nd

    section Stream E — Cross-cutting
    [issue]    :eN, after prev, Nd

    section Stream A — Backend
    [issue]    :aN, YYYY-MM-DD, Nd

    section Stream B — Cliente
    [issue]    :bN, YYYY-MM-DD, Nd

    section Stream C — Negocio
    [issue]    :cN, YYYY-MM-DD, Nd

    section Stream D — Delivery
    [issue]    :dN, YYYY-MM-DD, Nd
```

Notas para el Gantt:
- `:crit,` marca tareas críticas (bloqueantes) en rojo
- `after prev` encadena tareas dependientes
- Tareas en secciones distintas son paralelas por defecto
- Cada N en la duración representa días hábiles
