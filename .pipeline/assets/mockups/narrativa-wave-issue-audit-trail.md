# Narrativa UX — Widget "Audit trail · Olas & Issues" (#4371)

> Acompaña al mockup `39-wave-issue-audit-trail.svg`. Define la experiencia, los
> estados visuales, las microinteracciones, la accesibilidad y las reglas de
> render que el dev (pipeline-dev) debe respetar al implementar la exposición
> operativa del audit trail de olas e issues (CA-10 de #4371).
>
> Esta narrativa **no** reemplaza la spec técnica de los CA del issue (ver
> comentario de PO en GitHub). La complementa con la capa de experiencia.
>
> Precedente directo: `narrativa-allowlist-audit-trail.md` + mockup 22 (#3625).
> Este widget es el hermano gemelo aplicado a olas/issues en vez de a la allowlist.

---

## Audiencia

Único usuario: el **operador del pipeline (Leo)**. No hay UI de usuario final —
este widget vive en `dashboard.js`/`dashboard-v2.js`, solapa "Pipeline", junto al
"Wave panel" (mockup 20) y en paralelo al "Audit trail · Allowlist" (mockup 22).

Objetivo cognitivo: **diagnóstico forense confiable** de movimientos sobre olas e
issues. Hoy reconstruir "quién tocó qué ola" exige diffear backups a mano (gap
detectado por `guru`). El widget debe responder de un vistazo a:

1. ¿Quién agregó/quitó issues de una ola en las últimas 24h?
2. ¿Quién cambió prioridades y de qué a qué?
3. ¿Se promovió/archivó alguna ola y cuál fue el estado previo/posterior?
4. ¿El hash-chain del audit log sigue intacto? ¿Hay alguna mutación sin autoría?

Si nada gatilla atención, el operador cierra la solapa en < 5 s. Si algo lo
requiere (mutación sin autoría, chain roto), se escala con color + icono +
microcopy — **nunca solo con un número**.

---

## Exposición dual (CA-10 permite dashboard **o** comando)

La UX recomienda **ambos** caminos, con el mismo backend (`readAll`/`verifyChain`
de `audit-log.js`):

- **Dashboard** — el widget de este mockup (lectura rápida, últimas 5, KPIs 24h).
- **Comando** — `/wave history [<ola>|<issue>]` en Telegram/CLI, orden cronológico,
  actor, evento, previo→posterior, timestamp legible. Reusa el mismo renderer de
  texto que el pie del widget. El botón "/wave history" del header linkea a esta
  vista extendida.

MVP mínimo aceptable: **al menos uno** de los dos con orden cronológico + actor +
evento + estado previo/posterior + timestamp legible (`es-AR`, HH:MM:SS con
tooltip ISO).

---

## Anatomía del widget

```
Pipeline · Olas · Audit trail                                    ← breadcrumb
Audit trail · Olas & Issues                                      ← H1
Toda mutacion sobre olas e issues queda registrada append-only con hash-chain  ← subtítulo

┌────────────┬────────────┬──────────────────┬────────────┬───────────────────┐
│ MUTAC. 24h │ CON AUTORIA│ CAMBIOS PRIORIDAD │ SIN AUTORIA│ HASH-CHAIN status │  ← 5 KPI cards
│    18      │    17      │        4          │     1      │ verificado (412)  │
└────────────┴────────────┴──────────────────┴────────────┴───────────────────┘

⚠ 1 mutación sin autoría — posible bypass del gate. Alerta enviada al Commander.   ← banner condicional

Últimas mutaciones · mostrando 5 de 412                        [ /wave history ]
┌─────────┬────────┬───────────────┬───────────────┬──────────────────┬────────┐
│ Cuándo  │ Actor  │ Evento        │ Objeto        │ Previo → Poster. │ Nota   │  ← tabla
├─────────┴────────┴───────────────┴───────────────┴──────────────────┴────────┤
│ 5 filas: wave_promoted, issue_added, priority_changed, issue_removed, sin autoría │
└──────────────────────────────────────────────────────────────────────────────┘

LEYENDA  [✓ Humano] [🔒 Subsistema] [⚠ Sin autoría] [↕ Prioridad] [↑ Promoción/archivado]

Eventos auditados (CA-1..CA-4)  +  nota de integridad (appendChained/verifyChain)
```

---

## Los 5 eventos auditados (columna "Evento")

Cada evento tiene **icono + texto**, nunca solo color. Mapa evento → icono:

| Evento | Icono (sprite) | Semántica | CA |
|--------|----------------|-----------|----|
| `issue_added` | `ic-issue-added` (**nuevo**) | issue sumado a una ola | CA-1 |
| `issue_removed` | `ic-remove-circle` (ya existe) | issue quitado de una ola | CA-2 |
| `priority_changed` | `ic-priority-change` (**nuevo**) | cambió `priority:*` de un issue | CA-3 |
| `wave_promoted` | `ic-promote` (ya existe) | ola promovida a activa | CA-4 |
| `wave_archived` | `ic-archive-box` (ya existe) | ola archivada | CA-4 |

Cada fila muestra, además: **Cuándo** (HH:MM:SS local + `title` ISO), **Actor**
(chip por estado), **Objeto** (`#issue → ola` o `ola`), **Previo → Posterior**
(dos valores monospace separados por flecha `ic-*`/`→`), **Nota** (justificación
truncada a ~50 chars con tooltip completo).

---

## Estados visuales (mismo lenguaje que mockup 22 — anti-info-solo-por-color)

### Estado A — Mutación con autoría humana (`commander:leo`)

- **Fila**: fondo neutro `var(--surface-1)`, sin borde lateral.
- **Actor chip**: verde `var(--success)`, icono `ic-architect-approved` (shield-check).
- **Cuándo**: el operador autorizó vía Telegram Commander (add/remove/promote).
  Caso esperado y abundante. Reutiliza el `actor` autenticado del **commander
  audit** (CA-1 / A09), no self-report.

### Estado B — Mutación por subsistema

- **Fila**: fondo neutro, sin borde lateral.
- **Actor chip**: azul `var(--info)`, icono `ic-estado-partial-pause` (shield-lock).
- **Actor text**: identificador del subsistema (`planner-split:auto`,
  `pulpo:cleanup`, `wave-promote`, etc.).
- **Cuándo**: auto-promote de hijos por planner-split, limpieza del pulpo,
  rollback transaccional. **Visualmente igual de tranquilizador que A** — es
  legítimo, solo con autoría de máquina.

### Estado C — Sin autoría / hash-chain roto (ALERTA CRÍTICA)

- **Fila**: fondo rojo tenue `var(--danger-bg)`, **borde izquierdo 4px sólido
  `var(--danger)`**.
- **Actor chip**: rojo `var(--danger)`, icono `ic-health-warn`, texto
  `null · sin autoría`.
- **Microcopy**: "Bypass detectado — revisar urgente" en rojo bold + segunda
  línea con el detalle técnico (ej. "Edición directa de waves.json sin pasar por
  mutación auditada").
- **Cuándo**: aparece una entry con `actor: null` que no es backfill conocido, o
  `verifyChain()` detecta break. **Siempre** dispara alerta Telegram y queda
  visible hasta que el operador la marque como revisada (append de entry `review`,
  nunca borra — append-only inquebrantable, CA-5).

### Estado D — Cambio de prioridad / backfill (atención suave)

- **Fila**: fondo ámbar tenue `var(--warning-bg)`, **borde izquierdo 4px
  `var(--warning)`** cuando el cambio **baja** severidad o es backfill.
- **Actor chip**: según origen (humano verde / subsistema azul).
- **Evento icono**: `ic-priority-change` en `var(--warning)`.
- **Previo → Posterior**: `priority:high` (rojo) → `priority:medium` (ámbar), para
  que el sentido del cambio (sube/baja) se lea sin abrir nada.
- **Cuándo**: repriorización de un issue asociado a una ola. Cambio informativo,
  no bloqueante — se resalta suave para no competir con las alertas rojas.

---

## KPIs de las últimas 24h

Cinco tarjetas, icono + texto + número grande monoespaciado:

| Tarjeta | Color del número | Borde | Regla |
|---------|------------------|-------|-------|
| MUTACIONES 24h | `--text-primary` | neutro | siempre |
| CON AUTORÍA | `--success` | neutro | siempre |
| CAMBIOS PRIORIDAD | `--text-primary` | neutro | siempre |
| SIN AUTORÍA | `--danger` si > 0, `--text-dim` si 0 | **rojo si > 0** | gate visual |
| HASH-CHAIN | `--success` si OK, `--danger` si roto | **verde OK / rojo roto** | crítico |

**Hash-chain card**: botón "verifyChain" on-demand + "última verificación hace N
min" (cron cada 30 min). Si el chain está roto → card rojo "ROTO en entry #N" +
**banner crítico full-width** + tabla con opacidad reducida hasta reparar
(procedimiento `docs/pipeline/audit-recovery.md`).

---

## Banner condicional "sin autoría"

Aparece SOLO si existe alguna mutación con `actor: null` (excluyendo backfill
explícito). Color rojo `var(--danger)`, icono `ic-health-warn`, acción "Marcar
revisada". Copy:

> ⚠ **N mutación(es) sin autoría — posible bypass del gate. Alerta enviada al Commander.**
> Entry #401 · issue_removed #4188 de ola-8.3 · actor=null a las 03:11:07Z. Pendiente de revisión.

Click en "Marcar revisada" → modal → append entry `action: 'review'`,
`actor: 'commander:leo'`, referencia a la entry original. **No borra** la original.

---

## Microinteracciones

- **Hover fila**: aclarar fondo ~6% (`--surface-2`). Cursor `default` salvo chips/links.
- **Click Actor chip**: tooltip con la definición del subsistema (qué es, qué muta).
- **Click fila (zona libre)**: drawer lateral con la entry completa en JSON
  pretty, `hash`, `previous_hash`, link al issue/ola. Cierra con `Esc`.
- **Click "Previo → Posterior"**: tooltip con arrays/estados completos en monospace.
- **Click "Sin autoría"** (KPI): filtra la tabla por esas filas con chip "filtro: X".
- **Botón "/wave history"**: lleva a la vista/ comando extendido; mientras no
  exista la vista full, opacidad 0.6 + tooltip "Vista detallada — próximamente"
  (no removerlo del DOM).

---

## Accesibilidad (WCAG AA mínimo)

- **Contraste**: todos los pares texto/fondo verificados contra `--surface-0`
  (#0D1117) y `--surface-1` (#161B22) ≥ 4.5:1 (texto normal) / ≥ 3:1 (iconos y
  texto grande). Colores tomados del design-system ya validado.
- **Anti-info-solo-por-color** (WCAG 1.4.1): cada estado tiene, además del color,
  icono distintivo + texto explícito (`issue_removed` vs `wave_promoted`) + borde
  izquierdo 4px en C y D.
- **Foco visible**: focus ring 2px `--info` en chips clickeables, botones, filas.
- **Teclado**: `Tab` recorre KPI → banner → tabla → botones; `Enter` abre drawer,
  `Esc` cierra; `↑/↓` mueve foco entre filas.
- **Lectores de pantalla**: cada KPI `aria-label="CAMBIOS PRIORIDAD últimas 24h: 4"`;
  cada fila `aria-label` describe el estado ("issue removido de ola-8.3 sin
  autoría hace 33 min"), no el dibujo. Banner crítico `role="alert"`
  `aria-live="assertive"` la primera vez.
- **Reduced motion**: hover 180ms se elimina con `prefers-reduced-motion: reduce`.

---

## Responsive / breakpoints (dashboard V3 desktop-first, mín. 1280px)

- **< 1280**: KPI cards en grid 3+2. Tabla mantiene columnas, "Nota" se trunca más.
- **< 980**: tabla → tarjetas verticales apiladas (una mutación por card).
- **< 720**: KPI stack vertical; tarjetas full-width con "Previo → Posterior"
  colapsado en una línea y "Ver más" expandible.

---

## Seguridad UX (refuerza CA-5..CA-9 del PO)

Estas reglas visuales/serialización refuerzan los CA de seguridad — no los sustituyen:

- **XSS (CA-8, A03)**: todo dato dinámico (título de issue, `actor`, `nota`,
  estados) pasa por `escapeHtml`/`textContent` antes de `innerHTML`. Precedente de
  XSS confirmado y corregido en este dashboard (#2893, #3960) — **no repetir**.
  El renderer server-side debe seguir el patrón de `audit-trail-renderer.js`.
- **Redacción (CA-7, A02)**: si una `nota`/objeto contiene algo con forma de
  token/JWT/AWS-key/path absoluto, se muestra redactado (`•••`) con `title`
  "valor redactado por seguridad". No volcar secrets en la vista ni en el tooltip.
- **Log injection (CA-6, A09)**: los campos de texto libre (`nota`, `actor`,
  `title`) llegan ya saneados de newlines/control chars desde el emisor; el
  renderer no debe reconstruir HTML con ellos sin escape.
- **Actor no self-report (CA-1, A09)**: el chip de actor refleja el actor
  autenticado del commander audit / identificador de proceso, nunca un string
  editable por el usuario.

---

## Tokens consumidos (resumen)

Variables CSS de `.pipeline/assets/design-tokens.css` que el widget DEBE
referenciar (**NUNCA hardcoded colors**):

```
--surface-0, --surface-1, --surface-2, --border, --border-subtle
--text-primary, --text-secondary, --text-dim
--success, --success-bg   ← Estado A (autoría humana)
--info, --info-bg         ← Estado B (subsistema)
--danger, --danger-bg     ← Estado C (sin autoría / chain roto)
--warning, --warning-bg   ← Estado D (cambio prioridad / backfill)
--purple, --purple-bg     ← acento actor humano (opcional)
--font-sans, monospace    ← tipografías (IDs, timestamps y hashes en monospace)
```

## Iconos del sprite

Referenciados vía `<use href="#ic-*">`. Reutilizar lo que ya existe; sumar solo 2:

| Uso en el widget | ID del sprite | Estado |
|------------------|---------------|--------|
| header ola | `ic-wave` | ✅ existe |
| issue agregado | `ic-issue-added` | 🆕 **proponer** (círculo issue + "+") |
| issue quitado | `ic-remove-circle` | ✅ existe |
| cambio de prioridad | `ic-priority-change` | 🆕 **proponer** (doble flecha ↑↓) |
| ola promovida | `ic-promote` | ✅ existe |
| ola archivada | `ic-archive-box` | ✅ existe |
| autoría humana | `ic-architect-approved` | ✅ existe (shield-check) |
| subsistema | `ic-estado-partial-pause` | ✅ existe (shield-lock) |
| sin autoría / warn | `ic-health-warn` | ✅ existe |
| integridad chain | `ic-shield-lock` | ✅ existe |
| ver historial | `ic-tab-historial` / `ic-transition-history` | ✅ existe |

**Decisión técnica para el dev**: el mockup 39 inlina los iconos como `<symbol
id="m-*">` para preview standalone. Al implementar, sumar los dos "🆕" al sprite
oficial (`.pipeline/assets/icons/sprite.svg`) siguiendo `assets/icons/README.md`.
Son dos iconos con semántica propia y probable reúso (el wave panel y `/wave
history` también los pueden usar) → conviene la opción sprite, no inline.

---

## Lo que NO está en este mockup (fuera de alcance)

- Vista full `/audit-trail` con paginación/filtros avanzados/export CSV-JSONL — futuro.
- Visualización de la hash-chain tipo Merkle — el operador solo necesita
  `verified: true/false`; si se rompe, copy explícito + procedimiento de recovery.
- Editor de olas desde el widget — este widget es **lectura** del audit log, la
  edición vive en el wave panel (mockup 20) y en el Telegram Commander.

---

## Trazabilidad

- **Issue origen**: #4371 — Auditoría de cambios sobre olas e issues asociados (Ola 8.3)
- **Mockup**: `.pipeline/assets/mockups/39-wave-issue-audit-trail.svg`
- **Narrativa**: este archivo
- **Precedente directo**: `22-allowlist-audit-trail.svg` + `narrativa-allowlist-audit-trail.md` (#3625)
- **Renderer de referencia**: `.pipeline/lib/audit-trail-renderer.js`
- **Backend reutilizable**: `.pipeline/lib/audit-log.js`, `waves.js`, `jsonl-rotation.js`
- **Design system**: `docs/pipeline/design-system.md` · tokens `design-tokens.css` · iconos `assets/icons/README.md`

---

— ux, fase `criterios` de #4371
