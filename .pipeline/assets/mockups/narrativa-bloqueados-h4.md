# Narrativa de diseño — Bloqueados → Triage Queue (EP8-H4 · #3957)

**Épica**: EP-8 (#3952) · **Historia**: EP8-H4 (#3957)
**Mockup**: `.pipeline/assets/mockups/36-bloqueados-triage-v3.svg` (kiosk vertical 1080×1920).
**Boundary técnico**: evolución del módulo `.pipeline/views/dashboard/bloqueados.js` (#3729) +
nuevo `.pipeline/lib/bloqueados-stats.js`. Es **dashboard Node.js** (puerto 3200, SSR + DOM
morphing). Cero impacto en `backend/users/app` Kotlin/Compose.

> Este documento es un **addendum** sobre `narrativa-bloqueados-v3.md` (#3729). Hereda sus
> decisiones congeladas (D1-D11) — severidad dual-encoded, escape por contexto, sprite-only,
> WCAG AA — y sólo define los 5 elementos visuales **nuevos** de H4. Donde H4 contradice a V3
> (ej. el orden de filas pasa de "edad desc" a "severidad×edad"), prevalece este addendum.

---

## 1. Contexto del rediseño

La ventana extraída en #3729 ya muestra los incidentes con jerarquía de severidad, pero:

- las filas están en orden plano de `age_hours` desc (no priorizan severidad);
- los motivos JSON estructurados (#3167, `dependency_block`, `rebote_categoria`) se ven **crudos**;
- no hay forma de filtrar/buscar cuando la cola crece;
- las mini-stats (SLA, resueltos hoy) sólo viven en el empty-state → con incidentes presentes el
  operador nunca las ve;
- cada fila ofrece dos botones genéricos (Reactivar/Desestimar) sin un **verbo primario** que diga
  qué se espera del humano.

H4 convierte el panel en una **bandeja de triage**: priorizada, legible, filtrable, con un CTA
explícito por fila y un header que comunica salud operativa. La identidad visual no cambia — se
reutiliza el sistema de tokens (`design-tokens.css`) y el sprite (`icons/sprite.svg`) sin agregar
tokens ni símbolos nuevos (disciplina heredada de D11).

## 2. Decisiones congeladas de H4 (no se discuten en desarrollo)

| # | Decisión | Justificación / referencia |
|---|---|---|
| H4-D1 | **Orden severidad×edad**: rank `danger(3) > warning(2) > info(1)` por `severityOf(age_hours)`; tie-break `age_hours` desc. Implementa `sortBySeverityAge(list)`. | CA-1 + receta del arquitecto. Reemplaza el sort plano de V3. |
| H4-D2 | **Barra de filtros + búsqueda client-side**, sobre filas ya escapadas server-side (match por `dataset`/`textContent`). Nunca reconstruir `innerHTML` desde el query. | CA-1 + security A03 (DOM injection). |
| H4-D3 | **`prettyReason(raw)`**: JSON estructurado → texto legible en español; texto plano → tal cual (recortado a `REASON_MAX`). Todo value parseado pasa por `escapeHtmlText`. | CA-2 + security A03 (XSS / prototype pollution). |
| H4-D4 | **Deep-link Telegram "cuando aplica"** = sólo si existe `telegram.bot_username` público válido (`^[A-Za-z0-9_]{5,32}$`). Sin username → no se renderiza el link (queda sólo GitHub). | CA-3 + PO + security A01/A02 (no leak de `bot_token`). |
| H4-D5 | **Header stats permanentes**: SLA promedio de desbloqueo + resueltos hoy. Se mueven del empty-state al header del panel (siguen también en el empty-state). | CA-4 + D5 de V3. |
| H4-D6 | **Un CTA primario por fila** (Aprobar / Reintentar / Responder) determinado por un clasificador determinístico (ver §5). Las acciones secundarias Reactivar/Desestimar se mantienen. | CA-5 (cerrado por PO) + bonus del mockup. |
| H4-D7 | **Sin tokens nuevos. Sin íconos nuevos.** Reusar `--danger/--warning/--info/--success` + sus `*-bg/*-dim`, y símbolos existentes del sprite. | Continuidad de D11. |
| H4-D8 | Filtros/búsqueda **no persisten** entre recargas en esta historia (estado en memoria del cliente). Persistencia por operador es follow-up suave (ver §9). | Acotar scope; evita acoplar a localStorage. |

## 3. Mapa visual (referencia al mockup 36)

```
┌─ <main id="view-content" data-slug="bloqueados"> ──────────────────────────┐
│                                                                            │
│ ┌─[!] Necesitan intervención humana  [3]      ⏱ SLA 4h 12m · ✓ 7 hoy  ⇕ ↗ │ ← bloqueados-header
│ │                                              └─ renderHeaderStatsSsr ───┘ │
│ ├─ 🔎 [buscar…]  [Severidad ▾] [Skill ▾] [Fase ▾]        [✕ limpiar]       │ ← bloqueados-filterbar
│ │                                                                          │
│ │ ┌█─ ⓤx · validacion   #2891  Título…              ⏱ hace 29h  (danger) │ ← bloqueados-row-2891
│ │ │   Motivo: Rebote (build): falló compilación módulo users               │   prettyReason()
│ │ │   [▶ Reintentar]  · Reactivar · Desestimar · ↗ GitHub · ✈ Telegram     │   CTA primario + secundarias
│ │ │                                                                        │
│ │ ┌▓─ guru · analisis    #3681  Título…              ⏱ hace 12h  (warning)│ ← bloqueados-row-3681
│ │ │   Motivo: Aprobación pendiente: recomendación lista para go/no-go      │
│ │ │   [✓ Aprobar]  · Reactivar · Desestimar · ↗ GitHub                     │
│ │ │                                                                        │
│ │ ┌▒─ architect · validacion  #3754  Título…         ⏱ hace 47m  (info)   │ ← bloqueados-row-3754
│ │ │   Motivo: ¿Confirmás el alcance del refactor antes de seguir?          │
│ │ │   [✉ Responder]  · Reactivar · Desestimar · ↗ GitHub · ✈ Telegram     │
│ │                                                                          │
│ ├─ Leyenda: ⏱<4h info · 4–24h warning · ≥24h danger    │ CTA: ✓Aprobar ↻Reintentar ✉Responder
│                                                                            │
│ —— empty-state (state.bloqueados.length === 0) ——                         │
│ ┌─ [✓] Nada esperando que alguien decida                                   │
│ │     SLA promedio 2h 14m · Resueltos hoy 7                                │
└────────────────────────────────────────────────────────────────────────────┘
```

## 4. Elementos visuales nuevos — guidelines detalladas

### 4.1 Barra de filtros + búsqueda (`bloqueados-filterbar`) — CA-1

- **Ubicación**: franja propia bajo el header, dentro del panel (línea 245-250 de `bloqueados.js`).
  Fondo `--surface-2`, borde inferior `1px #30363D`, padding `--space-3`.
- **Composición** (izq → der): input de búsqueda con `ic-search` como adorno interno; luego tres
  `<select>` nativos estilizados (Severidad / Skill / Fase); a la derecha un botón texto
  "✕ Limpiar filtros" que sólo aparece cuando hay algún filtro activo.
- **Buscador**: `placeholder="Buscar issue, skill, motivo…"`, `--fs-sm`, alto 32px, radio
  `--radius-2`, fondo `--surface-1`, foco con `outline:2px solid var(--brand-cyan)`.
- **Selects**: cada opción de severidad lleva su color de token como punto/pill a la izquierda del
  texto (danger/warning/info), reforzando el dual-encoding también en el filtro.
- **Comportamiento visual de filtrado**: las filas que no matchean se ocultan (`display:none`), no
  se reordenan ni se reescriben. El contador del header se mantiene sobre el total real (no sobre el
  filtrado) y se agrega un sufijo `· N visibles` cuando hay filtro activo.
- **Empty filtrado**: si ningún match, mostrar bloque `bloqueados-filter-empty` con texto
  (`textContent`, nunca `innerHTML` con el query): "Sin incidentes que coincidan con los filtros" +
  botón "Limpiar filtros". Ícono `ic-search` atenuado (`opacity:0.4`).
- **Accesibilidad**: cada control con `aria-label` ("Buscar incidentes", "Filtrar por severidad",
  etc.); el contador de resultados se anuncia con `aria-live="polite"`.

### 4.2 Motivo pretty-print (`prettyReason`) — CA-2

- **Intención visual**: el operador nunca debe leer `{"dependency_block":3953}`. El motivo se
  presenta como **una frase en español**, prefijada por la etiqueta `Motivo:` en `--text-dim`.
- **Mapeo de formas conocidas → texto** (alineado con la receta del arquitecto):
  - `dependency_block: N` → "Bloqueado por dependencia: #N"
  - `rebote_categoria: X (+ motivo)` → "Rebote (X): &lt;motivo&gt;"
  - rebote estructurado #3167 → "Rebote &lt;fase&gt; → &lt;skill&gt;: &lt;motivo&gt;"
  - genérico (objeto plano) → `clave: valor · clave: valor` con `Object.keys()`
  - texto plano / JSON inválido → el texto tal cual, recortado a `REASON_MAX`, con `…` si se cortó.
- **Tipografía**: `--fs-sm`, `--text-secondary`, máximo 2 líneas con `-webkit-line-clamp:2` y
  tooltip `title=` (attr-context, `escapeHtmlAttr`) con el texto completo legible.
- **Seguridad (bloqueante, refleja CA-2 del PO)**: todo value extraído del JSON pasa por
  `escapeHtmlText`; prohibido `innerHTML`; iterar con `Object.keys()` (sin `__proto__`); acotar
  bytes+profundidad antes de recorrer. Un `reason` con `<script>` se renderiza escapado, sin tags
  vivos.

### 4.3 Deep-link a Telegram (`✈`) — CA-3

- **Affordance**: link inline en la fila de acciones, con el símbolo **`ic-chat-send`** del sprite
  (glifo tipo paper-plane ya existente) + label textual "Telegram". **No se introduce un glifo de
  marca Telegram nuevo** — se respeta D7/D11 (sin íconos nuevos) y se comunica honestamente "responder
  por chat". El paper-plane de `ic-chat-send` es semánticamente correcto para "enviar/abrir conversación".
- **Color**: familia `--chat-operator` (`--brand-cyan`) — es input del humano, coherente con la
  semántica de chat-operador del sistema (ver `design-tokens.css`).
- **"Cuando aplica"** (cerrado por PO, H4-D4): el link sólo se renderiza si `telegram.bot_username`
  está configurado y es válido. Sin él, la fila muestra únicamente el deep-link a GitHub (`ic-link-out`).
- **Construcción** (refleja security): `https://t.me/<username>?start=unblock_<issue>`, payload
  URL-encoded y restringido a `[A-Za-z0-9_-]`, `rel="noopener noreferrer"`, `target="_blank"`.
  **Nunca** se interpola `telegram.bot_token`.
- **Propósito**: abrir el bot para responder/destrabar ese incidente desde Telegram (prellenado del
  `?start=`); es un atajo, no ejecuta comandos arbitrarios.

### 4.4 Header con SLA + resueltos hoy (`renderHeaderStatsSsr`) — CA-4

- **Ubicación**: a la derecha del título del header, antes del chevron/popout (línea 236-244).
- **Composición**: dos chips compactos separados por `·`:
  - **SLA promedio**: `ic-retry-clock` + valor formateado legible (`4h 12m`, `47m`, `2d 3h`).
    Color neutro `--text-secondary`. Tooltip: "Tiempo promedio entre bloqueo y desbloqueo".
  - **Resueltos hoy**: `ic-cell-pass` (verde `--success`) + número. Tooltip: "Bloqueos resueltos hoy
    (reactivados + desestimados)".
- **Estado sin datos**: cada chip muestra `—` sin romper (no crashea). Mismo patrón que hoy en el
  empty-state.
- **Performance/seguridad (bloqueante)**: el header consume **sólo agregados numéricos** de
  `computeBloqueadosStats()`; jamás líneas crudas del `activity-log.jsonl`. Lectura acotada (tail /
  últimos N días), path constante.

### 4.5 CTA primario explícito — CA-5 (taxonomía cerrada por PO)

Cada fila expone **exactamente un** CTA primario (botón con relleno, alto contraste) + las acciones
secundarias actuales como links/botones ghost (Reactivar · Desestimar · GitHub · Telegram). El CTA
primario es el verbo que resume "qué decisión espera el sistema del humano".

| CTA primario | Ícono (sprite) | Color de relleno | Cuándo (clasificador determinístico — ver §5) |
|--------------|----------------|------------------|------------------------------------------------|
| **Aprobar** | `ic-allowlist-check` | `--success` sobre `--success-bg` | Issue con `tipo:recomendacion`/`recommendation` pendiente, o `reason` = gate de aprobación (review/PO acceptance esperando go/no-go). |
| **Reintentar** | `ic-estado-retrying` | `--info` sobre `--info-bg` | `reason` = fallo recuperable: circuit breaker, `rebote_categoria`/rebote #3167, `dependency_block`, infra, build, quota/stale. |
| **Responder** | `ic-chat-operator` | `--brand-cyan` sobre `rgba(0,214,255,0.14)` | Default: el `question` requiere decisión/orientación textual del humano. |

- **Jerarquía visual**: el CTA primario es el único botón "sólido" de la fila (relleno + texto de alto
  contraste, peso `--fw-semibold`). Reactivar/Desestimar quedan como botones ghost (sólo borde/texto)
  para no competir. Esto guía el ojo del operador al verbo correcto sin esconder las otras acciones.
- **Regla de unicidad**: nunca dos primarios; si ninguna condición de Aprobar/Reintentar matchea →
  default **Responder** (fallback seguro, nunca queda sin CTA). Un `reason` desconocido cae a Responder.
- **Consistencia con secundarias**: "Reintentar" y "Reactivar" disparan la **misma** acción server-side
  (resetear el bloqueo y re-encolar). "Reintentar" es la presentación primaria cuando el clasificador
  detecta fallo recuperable; "Reactivar" permanece como secundaria genérica siempre disponible. No es
  redundancia funcional: es jerarquía de affordance.
- **Seguridad (bloqueante)**: todo CTA state-changing reusa `nhCsrfHeaders()` + modal de confirmación
  + `safeIssueNumber()`. Si "Responder" envía texto a Telegram/`gh` server-side, el texto va por **array
  de args**, nunca `exec(string)`.

## 5. Clasificador de CTA (determinístico, sin campo `kind`)

El marker de `human-block` **no** tiene un campo `kind`/`category` (sólo `reason` + `question`). El CTA
se deriva del **contenido de `reason`** (formas JSON conocidas) + **labels del issue**. Orden de prioridad
(primer match gana):

1. **Aprobar** — si el issue tiene label `tipo:recomendacion` o `recommendation`, **o** `reason` indica
   gate de aprobación (contiene/parse a `aprobacion`, `approval`, `go/no-go`, `review pending`).
2. **Reintentar** — si `reason` clasifica como fallo recuperable: `circuit_breaker`/`circuit breaker`,
   `rebote_categoria`, rebote estructurado #3167, `dependency_block`, `blocked:infra`/infra, `build`,
   `quota`/`stale`.
3. **Responder** — default. Cualquier otro `question` (decisión/orientación textual) o `reason` desconocido.

> Esta clasificación es **presentacional**: cambia el verbo/ícono/color del botón primario, no la
> autorización ni el endpoint. La acción real sigue mapeando a reactivate/dismiss/approve del backend de
> `needs-human`, con el mismo authz y CSRF para todas.

## 6. Iconografía (sprite.svg — sin símbolos nuevos)

| Posición | Símbolo | Sema |
|---|---|---|
| Header — estado panel | `ic-estado-needs-human` | Estado global del panel (heredado de V3). |
| Header — SLA chip | `ic-retry-clock` | Tiempo de desbloqueo. |
| Header — resueltos hoy chip | `ic-cell-pass` | Conteo de resueltos (verde success). |
| Filterbar — buscador | `ic-search` | Campo de búsqueda. |
| Fila — CTA Aprobar | `ic-allowlist-check` | Aprobación one-click. |
| Fila — CTA Reintentar | `ic-estado-retrying` | Re-encolar fallo recuperable. |
| Fila — CTA Responder | `ic-chat-operator` | Decisión textual del operador. |
| Fila — deep-link Telegram | `ic-chat-send` | Abrir conversación/bot (paper-plane). |
| Fila — deep-link GitHub | `ic-link-out` | Abrir issue (heredado de V3). |
| Fila — Reactivar (secundaria) | `ic-play` | Heredado de V3. |
| Fila — Desestimar (secundaria) | `ic-remove-circle` | Heredado de V3. |
| Fila — badge edad | `ic-retry-clock` | Antigüedad (heredado de V3). |

## 7. Accesibilidad (WCAG AA — checklist H4)

| Punto | Cumplimiento |
|---|---|
| CTA primario distinguible no sólo por color | Relleno sólido + ícono + verbo textual (Aprobar/Reintentar/Responder) — triple encoding. |
| Contraste CTA Aprobar | Texto `--text-primary` sobre `--success-bg` con borde `--success-dim`; el verbo y el ícono garantizan lectura sin color. |
| Contraste chips header ≥ 4.5:1 | `--text-secondary` (#B1BAC4, 9.7:1 sobre surface) ✓ |
| Filtros operables por teclado | `<select>`/`<input>` nativos, foco visible `outline:2px var(--brand-cyan)`. |
| Resultado de filtrado anunciado | `aria-live="polite"` sobre el contador "N visibles". |
| `aria-label` en cada CTA | `aria-label="Aprobar issue #${issue}"` / `"Reintentar…"` / `"Responder…"`. |
| Deep-link Telegram accesible | `<a>` con texto "Telegram" visible (no sólo ícono) + `aria-label="Responder #${issue} por Telegram"`. |
| Severidad nunca sólo por color | Rail + pill + ícono + texto de edad (heredado D1-D2). |
| `prefers-reduced-motion` | Sin animaciones nuevas; respeta el media query heredado. |

## 8. Boundary explícito — qué NO toca H4

- **NO** crear tokens nuevos en `design-tokens.css` (H4-D7).
- **NO** crear símbolos nuevos en `sprite.svg` — el deep-link Telegram reusa `ic-chat-send` (H4-D7).
- **NO** persistir filtros entre recargas (follow-up suave, §9).
- **NO** cambiar el shape del marker `human-block` ni inventar campo `kind` — el CTA se deriva de
  `reason` + labels (§5).
- **NO** exponer `telegram.bot_token` en ningún punto del HTML (H4-D4).
- **NO** borrar las clases `.needs-human-*` del monolito (heredado D8 de V3).

## 9. Recomendaciones pendientes de aprobación humana

Durante este análisis se identificaron oportunidades de mejora no bloqueantes. Se gestionan como issues
independientes con label `tipo:recomendacion + needs-human` (cap #2653), fuera del pipeline automático.
Ver el comentario del agente `ux` en el issue #3957 y la sección `notas` del resultado para los números
asignados.

- **Persistencia de filtros por operador** (localStorage), alineado con #3719/#3720 (densidad/sidebar).
- **Agrupar la cola por severidad con headers de sección** ("3 críticos · 2 en atención") cuando supere
  N filas, para reforzar el triage visual sin saturar.

## 10. Validación visual contra los criterios (CA-1..CA-5)

| CA | Cómo lo cubre este diseño |
|---|---|
| CA-1 (orden severidad×edad + filtros + búsqueda) | §2 H4-D1/D2 + §4.1 + mockup 36 (filterbar + orden de filas). |
| CA-2 (motivo pretty-print) | §4.2 + mapeo de formas conocidas + disciplina de escape. |
| CA-3 (deep-link Telegram cuando aplica) | §4.3 + H4-D4 (gating por `bot_username`, sin `bot_token`). |
| CA-4 (header SLA + resueltos hoy) | §4.4 + H4-D5 (chips permanentes en header). |
| CA-5 (CTA primario explícito) | §4.5 + §5 (taxonomía + clasificador determinístico cerrado por PO). |
