# Narrativa UX — Widget "Audit trail · Allowlist mutations" (#3625)

> Acompaña al mockup `22-allowlist-audit-trail.svg`. Define la experiencia, los
> estados visuales, las microinteracciones, las alertas Telegram y las reglas de
> accesibilidad que el dev (pipeline-dev) debe respetar al implementar el widget
> del CA-5 de #3625.
>
> Esta narrativa **no** reemplaza la spec técnica de los CA del issue (ver
> comentario de PO en GitHub). La complementa con la capa de experiencia.

---

## Audiencia

Único usuario del widget: el **operador del pipeline (Leo)**. No hay UI de
usuario final involucrada — este widget vive en `dashboard.js`/`dashboard-v2.js`,
solapa "Pipeline", debajo de la sección "Allowlist activa & Candidatos" (mockup
14, ya en producción).

Su objetivo emocional/cognitivo: **confianza tranquila** sobre la trazabilidad
del archivo `.partial-pause.json`. El widget debe responder de un vistazo a:

1. ¿Hubo alguna mutación sospechosa en las últimas 24h?
2. ¿El hash-chain del audit log sigue intacto?
3. ¿Hay alguna mutación pendiente de revisión humana?

Si las tres respuestas son tranquilizadoras, el operador debe poder cerrar la
solapa en < 5 segundos. Si alguna gatilla atención, el widget debe escalarla con
color + icono + microcopy claros — nunca solo con un número.

---

## Anatomía del widget

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Pipeline · Allowlist · Audit trail                                          │  ← breadcrumb
│                                                                             │
│ Audit trail · Mutaciones de la allowlist                                    │  ← H1
│ Toda escritura sobre .partial-pause.json queda registrada con hash-chain   │  ← subtítulo
│                                                                             │
│ ┌──────────┬─────────────┬─────────────┬─────────────┬───────────────────┐ │
│ │ KPI · 24h│ Autorizadas │ Rejected    │ Sin autoría │ Hash-chain status │ │  ← 5 KPI cards
│ │   12     │     9       │     2       │     1       │ verificado (247)  │ │
│ └──────────┴─────────────┴─────────────┴─────────────┴───────────────────┘ │
│                                                                             │
│ ⚠ 1 mutación sin autoría detectada — alerta enviada al Commander           │  ← banner condicional
│                                                                             │
│ Últimas mutaciones · mostrando 3 de 247          [ Ver historial ]         │
│ ┌──────────┬─────────────┬────────┬──────────────┬──────────────┬────────┐│
│ │ Cuándo   │ Source      │ Acción │ Diff         │ Autorizado   │ Just.  ││  ← tabla
│ ├──────────┼─────────────┼────────┼──────────────┼──────────────┼────────┤│
│ │ ... 4 filas con estados A/B/C/D ...                                     ││
│ └──────────┴─────────────┴────────┴──────────────┴──────────────┴────────┘│
│                                                                             │
│ LEYENDA  [✓ Humano] [🔒 Subsistema] [✗ REJECTED] [⚠ Sin autoría/Backfill] │
│                                                                             │
│ ℹ Datos consumidos por dashboard-slices.js · partialPauseAuditSlice         │  ← pie técnico
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Estados visuales (los cuatro casos del mockup)

El dev DEBE implementar exactamente estos cuatro estados con sus colores e
iconos asociados. La identificación por color SIEMPRE va acompañada de icono +
texto + posición estable (regla anti-info-solo-por-color).

### Estado A — Mutación OK por humano (`commander:leo`)

- **Fila**: fondo neutro `var(--surface-1)`, sin borde lateral
- **Source pill**: morado `var(--purple)`, icono `m-user` (silueta)
- **Authorized chip**: verde `var(--success)`, icono `m-shield-check`
- **Diff**: `+ [#N]` en verde para adds, `- [#N]` en gris para removes
- **Microcopy**: "Autoriza issue de ..." — primer 50 chars de la justification

**Cuándo**: el operador autorizó vía Telegram Commander un add/remove a la
allowlist. Es el caso esperado y abundante (el más frecuente).

### Estado B — Mutación OK por subsistema

- **Fila**: fondo neutro `var(--surface-1)`, sin borde lateral
- **Source pill**: azul `var(--info)`, icono `m-machine` (cara de procesador)
- **Authorized chip**: azul `var(--info)`, icono `m-shield-lock`
- **Authorized text**: nombre del subsistema (`planner-split:auto`,
  `wave-promote`, `wave-rollback`, `restart:rollback`, `resume:operator`,
  `pulpo:cleanup`, `recursive-deps:from-N`)
- **Microcopy**: explica por qué el subsistema mutó. Si hay TTL (caso
  `recursive-deps:from-N`), mostrar "TTL 48h · expira DD/MM HH:MMZ" en una
  segunda línea más pequeña

**Cuándo**: rollback transaccional de waves, /resume del operador, limpieza
programada, auto-promote de hijos por planner-split. **Visualmente igual de
tranquilizador que el Estado A** — son operaciones legítimas, solo con autoría
de máquina en lugar de humana.

### Estado C — REJECTED por el gate

- **Fila**: fondo rojo tenue `var(--danger-bg)`, **borde izquierdo de 4px sólido
  `var(--danger)`**
- **Source pill**: ámbar `var(--quota-degraded)` con icono `m-machine`
  (típicamente `unknown:script` o un caller no en enum)
- **Action chip**: rojo `var(--danger)`, icono `m-shield-x`, texto `reject`
- **Diff**: en rojo, sufijo "propuesto, no aplicado" en gris (refuerza que **no
  ocurrió** la mutación)
- **Authorized chip**: rojo `var(--danger)`, icono `m-warning`, texto
  `null — gate REJECTED`
- **Microcopy**: `REJECTED: <razón>` en rojo bold, una segunda línea con detalle
  técnico ("authorizedBy fuera de enum cerrado", "removal sin autoría", etc.)

**Cuándo**: el gate de CA-2 rechazó la mutación. Esto **siempre** dispara
alerta Telegram inmediata (ver "Alertas Telegram" abajo). En el widget debe
quedar visible hasta que el operador marque la fila como revisada.

### Estado D — Sin autoría / Backfill

- **Fila**: fondo amarillo tenue `var(--warning-bg)`, **borde izquierdo de 4px
  sólido `var(--warning)`**
- **Source pill**: amarillo `var(--warning)`, icono `m-backfill` (flecha hacia
  el pasado)
- **Action chip**: amarillo, texto `backfill` o `write`
- **Authorized chip**: amarillo, icono `m-warning`, texto
  `null · BACKFILL` (si `_backfill: true`) o `null` a secas (caso legacy
  pre-gate, raro post-implementación)
- **Microcopy**: contextualiza el backfill (ej. "Recuperación incidente 09:39
  BA (#3625)")

**Cuándo**: única entry sin autoría aceptable en el sistema es el backfill del
incidente Ola N+11 (primera entry del audit log, escrita ANTES de habilitar el
gate runtime). Cualquier otra entry sin autoría es una alerta crítica equivalente
al Estado C.

---

## KPIs de las últimas 24h (CA-5 metric)

Cinco tarjetas en fila, ancho fijo, con icono + texto + número grande monoespaciado.

| Tarjeta | Color del número | Borde | Cuándo destacar |
|---------|------------------|-------|-----------------|
| MUTACIONES 24h | `--text-primary` | neutro | siempre, no destacar |
| AUTORIZADAS | `--success` | neutro | siempre |
| REJECTED | `--danger` si > 0, `--text-dim` si 0 | neutro | siempre |
| SIN AUTORÍA | `--warning` si > 0, `--text-dim` si 0 | **amarillo si > 0** | gate visual: amarillo solo si > 0 |
| HASH-CHAIN | `--success` si OK, `--danger` si broken | **rojo si broken, verde si OK** | crítico si broken |

**Hash-chain card** lleva botón pequeño "verifyChain" que ejecuta `verifyChain()`
en demanda y refresca el card. Ejecución también ocurre automática vía cron (30
min) — el card muestra "última verificación hace N min" para que el operador
sepa la frescura.

**Si `verifyChain()` falla** (hash-chain roto):
1. Card hash-chain pasa a rojo con texto "ROTO en entry #N"
2. **Banner crítico full-width** arriba de todo el widget con copy:
   > "Hash-chain del audit log roto en entry #N. Escrituras nuevas bloqueadas
   > hasta intervención humana. Telegram notificado a HH:MM. Ver
   > `docs/pipeline/audit-recovery.md` para procedimiento de recovery."
3. Toda la tabla de mutaciones se renderiza con opacidad reducida (estado
   `disabled`) hasta que el chain se repare.

---

## Banner condicional "sin autoría"

Aparece SOLO si existe alguna mutación con `authorized_by: null` (excluyendo
backfill explícito). Color amarillo `var(--warning)`, icono campana `m-bell`,
acción "Marcar como revisada".

Copy del banner (texto + subcopy técnico):

> ⚠ **N mutación(es) sin autoría detectada(s) — alerta enviada al Commander**
> Entry del 2026-05-29 12:39:00Z con authorized_by=null. Telegram notificado a
> HH:MM BA. Pendiente revisión del operador.

Al hacer click en "Marcar como revisada" → modal de confirmación → escribe entry
nueva en el audit log con `authorized_by: 'commander:leo'`, `action: 'review'`,
referencia a la entry original. **No borra** la entry original (append-only
inquebrantable).

---

## Microinteracciones y feedback

### Filas de la tabla

- **Hover**: aclarar fondo ~6% (`var(--surface-2)` en lugar de `var(--surface-1)`).
  Cursor `default` (no `pointer`) salvo en chips/links específicos.
- **Click sobre Source / AuthorizedBy chip**: tooltip con definición del enum
  (qué subsistema es, qué acciones puede ejecutar). Es decir, el catálogo
  cerrado de PO es educable inline.
- **Click sobre fila** (zona libre): abre drawer lateral con la entry completa
  en JSON pretty-printed, hash, previous hash, link al PR/issue origen si lo
  hay. Drawer se cierra con Esc.
- **Click sobre "Diff"**: tooltip con `previous` vs `current` arrays completos
  en monospace.

### KPI cards

- **Hover en cualquier card**: tooltip con desglose por hora de las últimas 24h
  (ej. sparkline pequeño embedded). Opcional para MVP.
- **Click en "Rejected" o "Sin autoría"**: filtra la tabla por esas filas
  (la tabla pasa de "últimas 3" a "últimas 10 con filtro X"). Se ve siempre
  con un chip "filtro: X" arriba de la tabla con botón "limpiar".

### Botón "Ver historial"

- Lleva a vista full `/audit-trail` (ruta futura — no parte del MVP de #3625).
- Mientras no exista: el botón muestra tooltip "Vista detallada — próximamente"
  y queda visualmente con opacidad 0.6, **no removerlo del DOM** (placeholder
  intencional para no inducir confusión al usuario).

---

## Alertas Telegram (CA-5 + CA-6)

Cada uno de estos eventos dispara mensaje inmediato al Commander. El widget del
dashboard NO sustituye a las alertas Telegram — son complementarios.

### Alerta 1 — Mutación REJECTED

**Trigger**: el gate de CA-2 rechazó una escritura.

**Copy** (es-AR, tono natural — ver memoria `feedback_telegram-messages-natural.md`):

> 🚨 Mutación rechazada en `.partial-pause.json`
>
> Origen: `unknown:script` (PID 1234)
> Acción propuesta: `remove [#3559, #3605]`
> Motivo del rechazo: removal sin `authorizedBy`
>
> No se modificó la allowlist. Audit log registró el intento (entry #248).
> Revisalo en `/audit-trail` o respondé `/quien:1234` para que te diga qué
> proceso intentó.

**No se cierra automáticamente** — el operador la marca como revisada desde el
widget o respondiendo `/revisado N` en Telegram.

### Alerta 2 — Mutación con `authorized_by: null` (no backfill)

**Trigger**: aparece una entry en el audit log con `authorized_by: null` que
**no** tiene `_backfill: true`. Esto NO debería ocurrir después de la
implementación de #3625; si ocurre, es indicador de bypass del gate.

**Copy**:

> ⚠ Detecté una mutación en la allowlist sin autoría registrada — y no es un
> backfill conocido.
>
> Entry #N del audit log, escrita a HH:MM:SSZ por PID 5678.
> Diff aplicado: `+ [#3617] - [#3559, #3605]`
>
> Esto puede ser un bypass del gate. Revisá la lista de procesos vivos con
> `/agents` y verificá si alguno coincide con ese PID. Si no se identifica,
> escalá a `needs-human` y abrí issue.

### Alerta 3 — `verifyChain()` falló

**Trigger**: el cron de 30 min o un trigger manual detectó break en el hash-chain.

**Copy**:

> 🛑 Hash-chain del audit log ROTO en entry #N de 247.
>
> Bloqueé escrituras nuevas en `partial-pause-mutations.jsonl` para no
> corromper más. Las mutaciones del runtime quedan **pausadas** hasta que se
> repare.
>
> Procedimiento: `docs/pipeline/audit-recovery.md`.
> Si no estás cerca del repo, respondé `/snooze 1h` y lo retomo en 1h.

### Alerta 4 — TTL de autorización heredada expirado

**Trigger**: cron 1h del Pulpo detecta `recursive-deps:from-N` con
`autorizacion_expira_at < now`.

**Copy**:

> ⏰ Expiró la autorización heredada de #N+1 (hijo de #N, split de hace 48h)
>
> El padre #N fue autorizado por vos el DD/MM, pero el hijo #N+1 nunca se
> procesó. Lo saco de la allowlist (audit log con `authorizedBy: pulpo:cleanup`).
>
> Si todavía querés que entre, respondé `/allowlist add #N+1 "razón"` y vuelvo
> a sumarlo.

---

## Accesibilidad (WCAG AA mínimo)

- **Contraste**: verificado con WebAIM contra `surface-0` (#0D1117) y
  `surface-1` (#161B22). Todos los pares texto/fondo del mockup cumplen ≥ 4.5:1
  (texto normal) o ≥ 3:1 (texto grande / iconos).
- **Foco visible**: focus ring de 2px con color `--info` en todos los chips
  clickeables, botones, filas.
- **Navegación por teclado**:
  - `Tab` recorre KPI cards → banner → tabla → botones del pie en ese orden.
  - `Enter` sobre fila abre el drawer; `Esc` lo cierra.
  - `↑/↓` dentro de la tabla mueve foco entre filas (cuando hay > 3).
- **Lectores de pantalla**:
  - Cada KPI card: `aria-label="MUTACIONES últimas 24h: 12"`.
  - Cada fila: `aria-label` describe el ESTADO ("mutación rechazada hace 26 min,
    sin autoría, origen unknown:script") no el dibujo.
  - Banner crítico: `role="alert"` con `aria-live="assertive"` la primera vez
    que aparece.
- **Anti-info-solo-por-color**: las cuatro filas de la tabla tienen además del
  color: icono distintivo, texto explícito (`reject` vs `write`), borde
  izquierdo de 4px en estados C y D. Cumple con `WCAG 1.4.1 Use of Color`.
- **Reduced motion**: la transición de hover (180ms ease-out de fondo) se
  elimina si `prefers-reduced-motion: reduce`.

---

## Responsive / breakpoints

El dashboard V3 es desktop-first (mínimo 1280px). En anchos menores el dev DEBE:

- **< 1280**: collapsar KPI cards en grid 2x2 + 1 (la quinta en fila única).
- **< 980**: tabla pasa a "tarjetas verticales" — cada mutación es un card
  apilado, no fila. Source/Action/Authorized/Diff/Just. se reorganizan en
  dos columnas internas.
- **< 720**: KPI cards stack vertical, tarjetas de mutación full-width con
  diff truncado y "Ver más" expandible.

---

## Tokens consumidos (resumen)

Variables CSS de `.pipeline/assets/design-tokens.css` que el widget DEBE
referenciar (NUNCA hardcoded colors):

```
--surface-0, --surface-1, --surface-2
--text-primary, --text-secondary, --text-dim
--border, --border-subtle
--success, --success-bg     ← Estado A (authorized humano)
--info, --info-bg           ← Estado B (subsistema)
--danger, --danger-bg       ← Estado C (REJECTED)
--warning, --warning-bg     ← Estado D (sin autoría / backfill)
--purple, --purple-bg       ← Source pill humano (commander:leo)
--quota-degraded            ← Source pill unknown:script (estado C)
--font-sans, monospace      ← tipografías
```

Iconos del sprite (`.pipeline/assets/icons/sprite.svg`) que el widget DEBE
referenciar vía `<use href="#ic-*">`:

| Icono usado en mockup | ID del sprite |
|----------------------|---------------|
| `m-audit-log` | **nuevo · proponer `ic-audit-log`** |
| `m-shield-check` | `ic-architect-approved` (ya existe) — verificar viewBox |
| `m-shield-x` | **nuevo · proponer `ic-mutation-rejected`** |
| `m-shield-lock` | `ic-estado-partial-pause` (ya existe) — reusable |
| `m-warning` | `ic-health-warn` (ya existe) — reusable |
| `m-backfill` | **nuevo · proponer `ic-backfill`** |
| `m-bell` | **nuevo · proponer `ic-notification`** |
| `m-chain-broken` | **nuevo · proponer `ic-chain-broken`** |
| `m-link` | (genérico, puede inlinearse) |
| `m-clock` | (ya disponible inline en mockups) |
| `m-info` | (genérico) |
| `m-user` | (genérico) |
| `m-machine` | (genérico) |

**Decisión técnica para el dev**: el mockup 22 los inline para preview
standalone. Al implementar en `dashboard.js`, el dev puede (a) inlinearlos
directamente en el HTML del widget, o (b) sumar los marcados como "nuevo" al
sprite oficial (`.pipeline/assets/icons/sprite.svg`) siguiendo el patrón
documentado en `assets/icons/README.md`.

**Recomendación UX**: opción (b) si la lista de mockups que necesite estos
iconos llega a 2+. Si solo lo usa este widget, opción (a) es razonable. La
decisión la toma pipeline-dev en función del esfuerzo de la opción (b).

---

## Lo que NO está en este mockup (fuera de alcance)

- Vista completa `/audit-trail` con paginación, filtros avanzados y export
  (CSV/JSONL). Es trabajo futuro — el widget MVP solo muestra las últimas 3.
- Visualización de la **hash-chain** propiamente dicha (gráfico de bloques tipo
  Merkle). Estética sería interesante pero el operador no necesita verla — solo
  necesita saber `verified: true/false`. Si el chain se rompe, copy explícito y
  procedimiento de recovery.
- Editor inline para modificar la allowlist desde el widget. Eso vive en el
  mockup 14 (allowlist-candidatos.svg). Este widget es **lectura del audit log**,
  no edición de la allowlist.
- Configuración del catálogo de `authorizedBy` (enum cerrado). Fuente única en
  código (`lib/partial-pause.js`), no editable desde UI — riesgo de seguridad
  alto si fuera editable runtime.

---

## Trazabilidad

- **Issue origen**: #3625 — Allowlist tampering sin auditoría
- **Mockup**: `.pipeline/assets/mockups/22-allowlist-audit-trail.svg`
- **Narrativa**: este archivo
- **Mockup precedente relacionado**: `14-allowlist-candidatos.svg` — UI de
  gestión de la allowlist activa
- **Design system**: `docs/pipeline/design-system.md`
- **Iconografía**: `.pipeline/assets/icons/README.md`
- **Diseño tokens**: `.pipeline/assets/design-tokens.css`

---

— ux, fase `criterios` de #3625
