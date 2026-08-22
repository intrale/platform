# Narrativa visual — Widget Ghost artifacts (#3638)

> Sistema visual y comportamiento del widget que reporta la salud del filesystem
> operacional del pipeline V3. Para el dev que implementa CA-F-12 + CA-SEC-9 +
> CA-SEC-5 de [#3638](https://github.com/intrale/platform/issues/3638). Soporta
> los criterios PO en el comentario [#issuecomment-4576057136](https://github.com/intrale/platform/issues/3638#issuecomment-4576057136).

## Contexto

El garbage collector `lib/ghost-artifact-cleaner.js` barre cada 6 horas las
carpetas operacionales `.pipeline/definicion/**` y `.pipeline/desarrollo/**`,
detecta artefactos `.md`/`.txt`/`.json` cuyo issue asociado ya fue cerrado y los
**archiva** (nunca elimina) en `.pipeline/archivado/ghost-<timestamp>/`,
registrando cada operacion en `.pipeline/audit/ghost-artifacts-cleanup.jsonl`.

El widget en la solapa **Pipeline** del dashboard V3 sirve dos audiencias:

1. **Operador en patrulla** — necesita ver de un vistazo si el invariant esta
   protegido o si hubo limpieza reciente que pueda explicar un cambio raro en
   listados.
2. **Auditor / dev nuevo** — necesita poder bajar al detalle (que se archivo,
   cuando, con que razon) sin abrir el JSONL a mano.

## Tres estados visuales (cards superiores)

Los tres estados se eligen mirando las **ultimas 7 dias** del JSONL:

| Estado | Condicion | Borde | Acento | Icono |
|--------|-----------|-------|--------|-------|
| **A · Clean** | sin `action=cleanup` ni `action=skip` en 7 dias | `--success-dim` | `--success` | `ic-ghost-clean` |
| **B · Recent cleanup** | al menos 1 `action=cleanup` en 24h | `--warning` | `--warning` | `ic-ghost-cleanup` |
| **C · Warn/Skip** | al menos 1 `action=skip` en 24h sin cleanup OK | `--info` | `--info` | `ic-skip` + `ic-ghost-clean` |

Cuando se cumplen B **y** C en la misma ventana, gana B (cleanup pesa mas que
skip — hubo accion efectiva). El estado A es el "verde tranquilo" del CA-F-12:
"Ghost artifacts: clean".

Los tres estados se renderizan **siempre** como 3 cards lado a lado (no se
ocultan los otros), porque el operador necesita ver tambien "cuantos skips
hubo aun cuando hubo cleanups". El borde y el icono comunican cual es el
estado **dominante** ahora.

### Reglas de iconografia

- `ic-ghost-clean` (escudo + check): el invariant esta protegido. NUNCA aparece
  solo con color verde — siempre acompanado del texto "Ghost artifacts: clean"
  para WCAG.
- `ic-ghost-cleanup` (escoba + chispas): operacion de archivado activa o reciente.
  Acompana texto "Cleanup reciente · hace N min".
- `ic-archive-box` (caja cerrada): destino del archivo movido. Aparece como
  icono auxiliar en el boton "Ver auditoria" y en links al bucket `archivado/`.
- `ic-skip` (circulo con `>><<`): operacion postergada por fail-safe. Acompana
  texto "Cleanup postergado · {razon}".

### Reglas de paleta

Las 3 cards reusan tokens existentes del sistema (`design-tokens.css` seccion 3
SEMANTICOS). **Prohibido inventar colores nuevos** — el sistema ya tiene la
familia completa.

## Tabla inferior — Ultimas 10 operaciones del JSONL

Lectura `tail -n 10` del archivo `.pipeline/audit/ghost-artifacts-cleanup.jsonl`.
Si el archivo tiene menos de 10 lineas, mostrar todas las que haya. Si no existe,
mostrar el estado vacio del card A con mensaje "No hay operaciones registradas".

### Columnas

| Columna | Fuente JSONL | Notas |
|---------|--------------|-------|
| TIMESTAMP (UTC) | `timestamp` | Formato `YYYY-MM-DD HH:MM:SSZ`, monospace. |
| ACTION | `action` ∈ `{cleanup, no-op, skip, error}` | Chip de color (ver leyenda). |
| FILE | `file` | Path relativo a `.pipeline/`. Monospace. |
| REASON | `reason` | Texto libre del operador/sistema. |
| ARCHIVED TO | `archived_to` (opcional) | Truncado con `…` si excede ancho. |

**CA-SEC-9 obligatorio:** TODOS los campos pasan por `escapeHtml(s)` antes de
renderizarse. El mockup muestra paths con caracteres ASCII seguros, pero el dev
DEBE asumir que el reason o el file pueden contener `<`, `>`, `&`, `"`, `'`
(creados por error o por filename pathologico) y escaparlos.

**CA-SEC-5 obligatorio:** cada `JSON.parse(line)` envuelto en try/catch. Si la
linea es invalida, **descartar + log warning + seguir con la siguiente**. Nunca
crashear el widget por una entrada corrupta.

### Chips de action

| Action | Color de fondo | Color de texto | Color de borde |
|--------|----------------|----------------|----------------|
| `cleanup` | `--success-bg` | `--success` | `--success-dim` |
| `no-op` | `--deterministic-bg` | `--text-secondary` | `--border-strong` |
| `skip` | `--info-bg` | `--info` | `--info-dim` |
| `error` | `--danger-bg` | `--danger` | `--danger-dim` |

El chip se renderiza como `<span class="chip chip-action-{action}">cleanup</span>`
y la clase mapea al token correspondiente.

### Highlight de fila

La fila completa recibe un fondo MUY tenue del color del action (alpha 6%) para
permitir scaneo rapido de patrones (3 cleanups seguidos, luego un skip, etc.).
NO usar color saturado en la fila — el chip ya comunica el estado.

## Banner del estado B — "Operacion reciente"

Cuando hay cleanup en 24h, la card B muestra un sub-banner ambar con:

- Titulo: **"Operacion reciente · revisar audit log"**
- Cuerpo: **"N archivos huerfanos archivados sin error. Sin perdida de datos."**
- CTA: **"Ver auditoria"** — boton outline que abre `.pipeline/audit/ghost-artifacts-cleanup.jsonl` (puede ser un `<a href="/api/audit/ghost-artifacts-cleanup.jsonl">` que sirve el contenido en el dashboard, o un `<a download>`).

El texto "Sin perdida de datos" es **importante** — el operador necesita la
tranquilidad de que el GC archiva, no elimina. Es parte del contrato.

## Banner del estado C — "Razon del skip"

Cuando hay skip en 24h, la card C muestra:

- Titulo: **"Razon: {reason del ultimo skip}"** (escapado).
- Cuerpo: **"Reintento automatico al proximo tick. Nunca archivar en duda."**

La razon es informacion **critica de auditoria** — si gh esta down, el operador
necesita saberlo para no confundirlo con un GC roto. El mensaje "Nunca archivar
en duda" refuerza el fail-safe SEC-E.

## Comportamiento responsive

- Desktop (>=1280px): 3 cards lado a lado, tabla full-width.
- Tablet (768-1279px): 3 cards apiladas (1 columna), tabla scroll horizontal.
- Mobile (<768px): widget colapsado a un solo card con el estado dominante y
  CTA "Ver detalle" que abre el JSONL en pantalla completa.

El dashboard V3 hoy es desktop-first (uso operativo desde escritorio), pero el
markup debe usar `flex-wrap` y `min-width` para no romper en viewports
chicos. **Prohibido hardcodear `width: 1440px`.**

## Accesibilidad (WCAG AA)

- Cada `<svg>` con `<use href="#ic-*"/>` lleva `aria-label` descriptivo en el
  `<svg>` padre (ver convencion del sprite).
- Cada chip de action tiene texto visible (`cleanup`, `skip`, etc.) ademas del
  color — anti-info-solo-por-color.
- Foco visible con `--focus-ring` en los botones "Ver auditoria",
  "Filtrar action" y "Descargar JSONL".
- Contraste verificado en design-tokens.css seccion 3: todos los pares
  texto/fondo cumplen `>=4.5:1` para texto normal y `>=3:1` para texto grande.
- `prefers-reduced-motion`: si el dev agrega cualquier animacion de pulso al
  estado B (banner reciente), debe respetar la media query (ya cubierta en
  design-tokens seccion 12).

## Comportamiento de refresh

- Polling cada 30s del endpoint `/api/audit/ghost-artifacts-cleanup/tail?n=10`.
- Diff visual: si llega una linea nueva, la tabla scroll-into-view a la primera
  fila con animacion fade-in de 200ms. Respetar `prefers-reduced-motion`.
- Si el JSONL no se puede leer (permisos, no existe, parse falla en todas las
  lineas), mostrar mensaje neutral "No hay operaciones registradas" con el
  card A en estado clean.

## Ejemplo de entradas JSONL (fixture para tests del widget)

```jsonl
{"timestamp":"2026-05-29T13:39:43Z","action":"cleanup","file":"definicion/criterios/pendiente/3076.po.comment.md","reason":"orphaned (issue #3076 CLOSED, no .work/.build in parent folder)","archived_to":"archivado/ghost-20260529-133929/3076.po.comment.md","context":"Commander cleanup during issue #3638 definition phase"}
{"timestamp":"2026-05-29T14:21:08Z","action":"cleanup","file":"desarrollo/dev/pendiente/3201.guru.comment.md","reason":"orphaned (issue #3201 CLOSED, no .work/.build in parent)","archived_to":"archivado/ghost-20260529-142108/desarrollo/dev/pendiente/3201.guru.comment.md","context":"scheduled tick"}
{"timestamp":"2026-05-29T14:21:08Z","action":"no-op","file":"definicion/criterios/pendiente/3076.po.comment.md","reason":"already archived (bucket ghost-20260529-133929 existe)","archived_to":null,"context":"idempotency check"}
{"timestamp":"2026-05-29T08:15:02Z","action":"skip","file":"desarrollo/dev/pendiente/3555.android-dev.comment.md","reason":"gh unavailable (timeout 10s, exit 1)","archived_to":null,"context":"fail-safe SEC-OPS-2"}
{"timestamp":"2026-05-29T02:00:00Z","action":"skip","file":"definicion/criterios/pendiente/9999.po.comment.md","reason":"symlink rechazado (lstat.isSymbolicLink === true)","archived_to":null,"context":"hardening SEC-2"}
{"timestamp":"2026-05-28T20:00:00Z","action":"skip","file":null,"reason":"lock busy (.pipeline/locks/ghost-cleaner.lock, timeout 5s)","archived_to":null,"context":"concurrency OPS-1"}
```

El dev puede usar estas 6 lineas como fixture en los tests del widget (CA-F-12)
para verificar render de los 4 chips, escape HTML de `reason`, truncado de
`archived_to` y manejo de `null`.

## Lo que el widget NO hace (anti-scope creep)

- **NO** ejecuta el cleaner manualmente. El widget es read-only: muestra lo que
  el GC del pulpo ya hizo. Un boton "Ejecutar cleaner ahora" estaria fuera de
  scope y rompe la separacion de responsabilidades (#3638 entrega el cron
  + comando manual desde terminal).
- **NO** muestra graficos historicos (timeline, sparkline, gauge). El KPI
  "X cleanups · 24h" es suficiente para el alcance de este issue. Las metricas
  agregadas viven en el follow-up [#3646](https://github.com/intrale/platform/issues/3646).
- **NO** rota el JSONL. La rotacion a 10MB esta en el follow-up
  [#3645](https://github.com/intrale/platform/issues/3645).
- **NO** marca entradas como "revisadas" ni mantiene estado del operador. Es
  solo una vista del JSONL.

## Referencias

- Mockup SVG: `.pipeline/assets/mockups/23-ghost-artifacts-widget.svg`
- Sprite icons: `.pipeline/assets/icons/sprite.svg` (ids `ic-ghost-clean`,
  `ic-ghost-cleanup`, `ic-archive-box`).
- Design tokens: `.pipeline/assets/design-tokens.css` secciones 3 y 11.
- Patron similar implementado: widget 22 "Audit trail · Allowlist mutations"
  (#3625, mockup 22) — mismo paradigma de KPI + tabla del JSONL con chips de
  action.
- Doc canonica del invariant (a entregar por el dev): `docs/pipeline/ghost-artifact-invariant.md`.
