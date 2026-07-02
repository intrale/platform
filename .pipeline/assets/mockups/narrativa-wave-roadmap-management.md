# Narrativa visual — Panel de gestión del roadmap de olas (#4351 — Ola 8.3)

> Documento UX que acompaña al mockup `39-wave-roadmap-management.svg` y al ícono
> nuevo `ic-wave-add` agregado al sprite. Define el sistema visual de la **consola
> de gestión** del roadmap de olas del pipeline V3: crear, asociar/desasociar,
> reordenar, promover y archivar olas sin editar `waves.json` a mano.

## Contexto del feature

El pipeline organiza el trabajo por **olas** (`waves.json`: `active_wave`,
`planned_waves`, `archived_waves`). Hoy la única superficie visual de olas en el
dashboard es el widget read-only "Próximas Olas" (mockup 20 — lookahead 1). Este
issue agrega la pieza que faltaba: una **superficie de gestión** donde el operador
opera el roadmap completo de forma segura y auditable.

El issue es **infra pura** del pipeline (labels `area:pipeline`, `enhancement`,
`priority:high`, `size:large`, sin `app:*`) — no afecta al usuario final del
producto. La única superficie visual es el dashboard interno del equipo Intrale,
que vive en `localhost`. Por eso el gate QA es **structural** (`qa:skipped`
justificado, sin video): la verificación se hace por comandos/tests contra
`waves.json` y por render del dashboard.

## Relación con el mockup 20 (widget "Próximas Olas")

- **Mockup 20** = *lectura* (kiosk vertical, muestra activa + próxima).
- **Mockup 39** = *gestión* (desktop 1440, muestra el roadmap completo y las
  acciones mutantes).

Ambos comparten 100 % el sistema de tokens y la iconografía. El acento de
planificación sigue siendo `--purple` / `--purple-dim` (lane-definición), para
que quien ya conoce el widget de lectura reconozca inmediatamente que está en
"el mismo mundo" de olas.

## Decisiones de diseño

### 1. Reuso integral de `design-tokens.css` (cero tonos nuevos)
- Superficies `--surface-0..3`, bordes `--border`/`--border-subtle`, texto
  `--text-primary/secondary/dim`.
- Acento de **ola activa**: `--purple` (`#BC8CFF`) con borde `--purple-dim`
  (`#8957E5`) y barra lateral de identidad — igual que el mockup 20.
- Acento de **planificadas**: `--purple-dim` en números de orden y botón
  "Promover"; contenedores neutros para no competir con la activa.
- Acento de **archivadas**: `--text-dim` (`#8B949E`) sobre `--surface-0` con
  borde sutil — "cerrado, fuera del flujo pero consultable".

### 2. Tres secciones que responden a CA-4 (consultar roadmap completo)
Layout de columna izquierda, de arriba hacia abajo:
1. **OLA ACTIVA** — una sola card destacada.
2. **PLANIFICADAS** — lista ordenada (orden de procesamiento).
3. **ARCHIVADAS** — lista colapsada por defecto (ic-expand para abrir).

Cada sección muestra los issues de sus olas. El operador ve "qué corre ahora,
qué viene y en qué orden, qué se cerró" de un golpe de vista.

### 3. Crear ola — form/wizard en columna derecha (CA-1)
- Panel persistente a la derecha (no modal bloqueante) con los cinco campos:
  `número`, `nombre`, `objetivo`, `concurrency_max`, `window_minutes`.
- Botón primario **"Crear ola"** (gradiente púrpura) + "Cancelar" neutro.
- Cada campo lleva su **hint de validación** debajo (bounds, unicidad, escape).
- Se ilustra el **estado de error "el número de ola ya existe"** en rojo
  (`--danger-bg` + borde `--danger-dim`) con el copy "se rechaza la creación —
  no se corrompe waves.json" (CA-1 + CA-7).
- Nota fija: *"Se crea en planned_waves. La ola ACTIVA no se altera."*

> El mismo form es reutilizable como **wizard del dashboard**
> (`lib/wizards/ola/`, ya existente) y como referencia visual del subcomando
> `/wave create` del Commander.

### 4. Asociar / desasociar issues — chips (CA-2)
- Los issues se representan como **chips** con el `#id` y, en la ola activa,
  su pill de prioridad + glyph de estado (reuso whitelist del mockup 20).
- En **planificadas**, cada chip lleva un botón `ic-remove-circle`
  (touch target ≥ 32px real) para **desasociar** de forma segura.
- En la **ola activa**, los chips aparecen **bloqueados** con `ic-shield-lock`
  y el texto *"Issues bloqueados en activa (política A04)"*.

> **Política A04 (decisión de diseño, coordinada con security/PO):** desasociar
> sobre la **ola activa** NO se ofrece desde la UI por defecto, porque re-sincroniza
> la allowlist (dependencia #4350) y es la operación de mayor riesgo histórico
> (congelamientos #4030/#4350). La UI comunica el bloqueo explícitamente en vez de
> deshabilitar en silencio. Si el equipo decide habilitarlo, debe ser una acción
> del menú overflow con confirmación destructiva, no un botón inline.

### 5. Reordenar planificadas — drag-handle (CA-3)
- Cada ola planificada tiene un `ic-drag-handle` a la izquierda (affordance de
  arrastre) + un **número de posición** en círculo (1, 2, 3…).
- El número de posición es **orden de procesamiento**, NO la identidad de la ola:
  el `number` de la ola (ej. "Ola 9.0") se muestra en el título y **no cambia**
  al reordenar. Esta distinción visual es deliberada para prevenir el riesgo
  técnico que marcó guru ("reorder no debe alterar `number`").

### 6. Promover / activar — botón destacado + nota de sync (CA-6)
- Solo la **primera** planificada muestra el botón **"Promover"** (`ic-promote`,
  `--purple-bg` + borde `--purple-dim`) — refuerza que se promueve la próxima en
  orden.
- Nota informativa (`ic-info`, `--info`): *"Promover una ola sincroniza la lista
  de habilitados (allowlist / .partial-pause.json) — depende de #4350."*
- Coherente con `promoteWaveAtomic` existente (transaccional, recuperable).

### 7. Archivar — acción explícita (CA-5)
- Botón **"Archivar"** (`ic-archive-box`) en la card de la ola activa (para
  cuando queda cerrada) — es la operación explícita que mueve la ola a
  `archived_waves[]`, distinta del backup automático de `save`.
- La sección ARCHIVADAS conserva los issues de cada ola cerrada (CA-5) y es
  colapsable para no ocupar espacio salvo consulta.

### 8. Integridad y auditoría — banda inferior (CA-7, BLOQUEANTE)
- Banda fija al pie con `ic-shield-lock` en `--teal` (acento de sistema/V3):
  *"Toda operación mutante es transaccional y auditada"* + el detalle
  `file-lock + atomicWriteFile + snapshot/restore + audit NDJSON encadenado` y
  *"Cero escrituras directas a waves.json / .partial-pause.json"*.
- Cuatro pills (`lock`, `atomic`, `snapshot`, `audit`) como recordatorio visual
  del patrón obligatorio para el dev.

### 9. Validación de input y anti-XSS (CA-8, BLOQUEANTE)
- Los hints de cada campo comunican los bounds exactos que pidió security:
  `número` entero/decimal puro y único; `concurrency_max`/`window_minutes` con
  `readWaveMaxConcurrency` y `WAVE_WINDOW_MIN/MAX_MINUTES`; `nombre` length-bound
  (`WAVE_NAME_MAX_LEN`).
- Todo texto proveniente de `waves.json` (nombre de ola, objetivo, título de
  issue) se **escapa al render** (`textContent` / `escapeHtml`) — mismo contrato
  que el mockup 20. Prompt-injection en texto libre se rechaza antes de
  interpolar en templates del Commander o en `views/dashboard/*`.

## Iconografía

| Ícono | Uso | Estado |
|-------|-----|--------|
| `ic-wave` | Cabecera de la sección | ya existía |
| `ic-wave-add` | Crear ola (header + form) | **NUEVO** (este issue) |
| `ic-drag-handle` | Reordenar planificadas | ya existía |
| `ic-remove-circle` | Desasociar issue | ya existía |
| `ic-promote` | Promover/activar ola | ya existía |
| `ic-archive-box` | Archivar ola cerrada | ya existía |
| `ic-shield-lock` | Bloqueo A04 + integridad | ya existía |
| `ic-overflow-more` | Menú de acciones extra por ola | ya existía |
| `ic-expand` | Desplegar archivadas | ya existía |
| `ic-info` | Notas de sync / validación | ya existía |

### `ic-wave-add` (ícono nuevo)
- Mantiene la metáfora de dos ondas de `ic-wave` + un badge circular con "+"
  en la esquina inferior derecha. Outline coherente (stroke `currentColor`,
  `stroke-width` ~1.6-1.75, viewBox 24×24). Sin `<script>`, sin `href` externos.

## Accesibilidad (WCAG AA)

- **Nunca información solo por color**: estado de issue = color + glyph + (texto
  en detalle); prioridad = color + texto; posición de reorden = número + handle;
  bloqueo = ícono candado + texto explícito.
- Contrastes heredados de los tokens verificados (primary 14.8:1, secondary
  9.7:1, dim 5.3:1, danger/teal/purple sobre superficies oscuras ≥ AA Large).
- Touch targets de todas las acciones (crear, promover, archivar, desasociar,
  drag) ≥ 32px en la implementación real.
- El error de validación combina color rojo + ícono + texto, legible en escala
  de grises.

## Entregables de esta pasada UX

- `.pipeline/assets/mockups/39-wave-roadmap-management.svg` — mockup del panel.
- `.pipeline/assets/mockups/narrativa-wave-roadmap-management.md` — este documento.
- `.pipeline/assets/icons/sprite.svg` — símbolo `ic-wave-add` agregado.

El dev-dev (pipeline-dev) toma estos assets como **entrada de diseño** para la
implementación del dashboard (CA-4) y de la superficie de acciones. No debe
inventar iconografía ni paleta: todo está definido acá y en `design-tokens.css`.
