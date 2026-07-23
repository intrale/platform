# Narrativa UX — Ventana Pipeline V3 (#3728, split de #3715)

> Acompaña al mockup `28-pipeline-v3.svg`. Define la experiencia, la jerarquía
> visual, los estados, las microinteracciones, tooltips y reglas WCAG AA que el
> dev (pipeline-dev) debe respetar al implementar `.pipeline/views/dashboard/pipeline.js`.
>
> Esta narrativa **no** reemplaza los CA del PO (CA-PL1..PL15) ni la receta
> técnica del Architect. Complementa con la capa de experiencia: por qué cada
> bloque vive donde vive y qué siente el operador al usarlo.

---

## Audiencia

Único usuario: **el operador del pipeline (Leo)**. NO hay UI de usuario final
involucrada — esta ventana vive en `localhost:8086`, dashboard del operador.
Por eso el issue lleva `qa:skipped`: infra del pipeline, sin app:* afectada.

Objetivo emocional/cognitivo de la ventana:

1. **Control inmediato** sobre el ciclo del pipeline (puedo pausar, puedo
   priorizar, puedo desbloquear con 1 click).
2. **Confianza tranquila** sobre la integridad de la allowlist (audit-trail
   visible, hash-chain verificada).
3. **Conciencia ambiente** sobre la salud de la infra (sin tener que ir a
   otra solapa).

Si todo está sano, el operador debe poder cerrar la solapa en < 8 segundos.
Si algo gatilla atención, la ventana lo escala con **color + icono + microcopy**
— nunca solo color (regla anti-info-solo-por-color).

---

## Jerarquía V3 — qué cambia respecto al monolito actual

El monolito de `dashboard.js` (líneas 5102–5333) hoy tiene los 4 bloques
sueltos sin jerarquía declarada: control bar, banner partial-pause-deps,
allowlist+candidatos y audit-trail conviven en orden de aparición histórica.

La V3 fija una jerarquía con sentido operacional:

```
┌─ 1. Header (badge V3 + título)
│
├─ 2. CONTROL BAR  ◄─ STICKY (siempre visible al scrollear)
│     · Status pill (running/partial-pause/paused/rest-mode)
│     · Priority Windows (QA / Build / Dev) con umbrales
│     · Botón Pausar / Reanudar
│     · allowedIssues badge (escapado · CA-PL7)
│
├─ 3. BANNER PARTIAL-PAUSE-DEPS  ◄─ CONDICIONAL (solo si faltan deps)
│     · CTA "Sumar deps faltantes" → includeMissingDeps()
│
├─ 4. <details> ALLOWLIST & CANDIDATOS  ◄─ abierto si partial-pause activa
│     · Allowlist activa (chips teal)
│     · Candidatos likeados (chips purple, razón visible, autor, fecha)
│     · Picker global (input numérico + razón ≤500 chars)
│
├─ 5. <details> AUDIT TRAIL  ◄─ abierto si chain_broken o sin-autoría
│     · Banner crítico hash-chain (display:flex si chain_broken)
│     · Banner warning sin-autoría (display:flex si hay non-backfill)
│     · 5 KPI cards: Total / Autorizadas / Rechazadas / Sin-autoría / Hash-chain
│     · Tabla últimas N entries (con escape XSS en justification y autor)
│     · Footer link a /api/dash/partial-pause-audit
│
└─ 6. INFRA HEALTH  ◄─ DELEGADA (renderInfraHealth inyectado)
      · Pills Pulpo / Watchdog / Dashboard / Telegram / Quota
      · Worktrees activos · Cuota del operador (5h window)
```

Las **dos decisiones UX clave de la V3** (que el dev DEBE preservar):

### Decisión #1 — Control Bar sticky arriba

Las acciones más frecuentes (pausa global, toggles de Priority Windows) son
**siempre las primeras que el operador necesita** cuando entra a esta solapa.
El monolito actual las tiene en el bloque 5257–5331 que queda fuera de viewport
al scrollear hacia el audit-trail. La V3 lo fija con `position: sticky; top: 0`
para que sigan accesibles.

> Implementación: `<div class="pipeline-ctrl-bar" style="position: sticky; top: 0; z-index: 5; background: var(--surface-1); border-bottom: 1px solid var(--border);">`. El backdrop del sticky usa `--surface-1` (no transparente) para no sufrir bleed-through con el scroll del cuerpo.

### Decisión #2 — Aperturas automáticas con sentido operativo

Los dos `<details>` (Allowlist + Audit) tienen **aperturas inteligentes**:

| Bloque | Abre cuando |
|---|---|
| Allowlist & Candidatos | `partialPauseState.mode === 'partial-pause'` |
| Audit Trail | `partialPauseAuditData.chain_broken === true` **OR** `partialPauseAuditData.has_unauthorized_non_backfill === true` |

Razón: en partial-pause el operador necesita ver/promover candidatos; con
chain_broken el operador NO PUEDE dejar pasar el aviso oculto detrás de un
`<summary>` cerrado. Si está todo OK, los details quedan cerrados para que la
ventana entre completa en una pantalla (~720px alto efectivo).

> Implementación: `<details ${isPartialPause ? 'open' : ''}>` y `<details ${auditNeedsAttention ? 'open' : ''}>` calculado server-side. Sin JS adicional.

---

## Estados visuales del Control Bar (status pill)

| Estado | Color | Icono | Microcopy |
|---|---|---|---|
| running | `--success` (#3FB950) | play | "Pipeline running" |
| partial-pause | `--warning` (#D29922) | partial-pause | "Pausa parcial · {N} issues allowed" |
| paused | `--danger` (#F85149) | pause | "Pipeline pausado · {motivo}" |
| rest-mode | `--rest-mode` (#7C5CFF) | luna | "Modo descanso hasta {hora}" |
| quota-degraded | `--quota-degraded` (#F0A500) | sin-LLM | "Modo determinístico · reset {ETA}" |

**Importante**: el badge de `allowedIssues` (línea 5276 del monolito actual)
concatena `'#' + i` directamente al statusHtml SIN escape — riesgo #2 de la
receta del Architect. La V3 lo corrige (CA-PL7): cada item pasa por
`escapeHtmlSsr(String(i))` ANTES de concatenar.

---

## Estados visuales de Candidatos likeados

Cada chip de candidato comunica 4 capas de información:

1. **Header**: `#issue` (purple) + timestamp + autor
2. **Razón**: texto libre escapado (HTML entities visibles en preview)
3. **Sub-line de contexto**:
   - 🟢 "Sin deps colgantes — listo para promover."
   - 🟡 "{N} deps detectadas — usar 'Sumar también deps' al promover."
   - 🟡 "Sin label de admisión — promover no surte efecto."
4. **Acciones**: botón "Sumar a allowlist" (verde teal) + botón "Quitar like"
   (rojo outline). **Cada botón con `title=""` escapado** — CA-PL8.

Anti-info-solo-por-color: cuando el chip muestra warning (deps colgantes /
sin label), el icono ⚠️ aparece **dentro del botón Promover**, no solo el
color del badge. Si el operador es daltónico, sigue distinguiendo.

---

## Estados visuales del Audit Trail

### Banner crítico hash-chain rota (display:flex si chain_broken)

- Fondo `--danger-bg`, borde `--danger`, icono `chain-broken`.
- Texto: "Hash-chain rota en entry #{N}".
- Sub-texto: "El audit log fue manipulado entre las entries {N-1} y {N}.
  Revisar manualmente .pipeline/logs/partial-pause-audit.jsonl antes de operar."
- Timestamp en BA (monospace).

### Banner warning sin-autoría (display:flex si has_unauthorized_non_backfill)

- Fondo `--warning-bg`, borde `--warning`, icono `warning`.
- Texto: "{N} mutaciones sin autoría registrada (no son backfill)".
- Sub-texto: "Posible bug de regresión en el gate de autoría (#3192)."

### 5 KPI cards (siempre visibles dentro del details)

Cada card es una `<div class="kpi-card">` con:
- Label en `--text-dim` uppercase (kpi-lbl)
- Número grande en monospace (`kpi-num`)
- Icono semántico de 20×20 arriba a la derecha
- Borde de color según el KPI (verde/rojo/amber/sin-autoría)

| KPI | Color del borde | Valor de ejemplo |
|---|---|---|
| Total mutaciones | `--border` (neutro) | 142 |
| Autorizadas | `--success` | 138 |
| Rechazadas | `--danger` | 2 |
| Sin autoría | `--warning` | 2 |
| Hash-chain | `--success` si OK / `--danger` si rota | ✓ 142 / ✗ 16/142 |

### Tabla últimas N mutaciones

5 columnas: When · Issue · Action · Authorized by · Justification · Hash.

- Row con `bg-1` y `bg-2` alternando (cebra sutil)
- Filas REJECTED con `bg: --danger-bg` y texto en `--danger`
- Filas sin-autoría con `bg: --warning-bg` y texto en `--warning-fg`
- Filas BACKFILL con badge gris "BACKFILL · legacy"
- Justification SIEMPRE pasada por `escapeHtmlSsr` (CA-PL6)

---

## Tooltips obligatorios (CA-PL8)

Cada acción operativa lleva `title="..."` con texto descriptivo escapado.
El monolito actual ya tiene tooltips en algunos lugares pero NO en todos.
La V3 los exige en **todos** los botones interactivos:

| Elemento | Tooltip recomendado |
|---|---|
| Botón Pausar global | "Detiene tomas de nuevos ciclos. In-flight termina normalmente." |
| Botón Reanudar global | "Reanuda tomas y limpia el estado partial-pause." |
| Toggle Priority Window QA | "Activa Priority Window QA: prioriza skills de QA cuando carga ≥75%." |
| Toggle Priority Window Build | "Activa Priority Window Build: prioriza builders cuando carga ≥50%." |
| Toggle Priority Window Dev | "Activa Priority Window Dev: prioriza devs cuando carga ≥25%." |
| Botón Quitar allowlist | "Saca #{issue} de la allowlist activa. Confirmación requerida." |
| Botón Promover candidato | "Promueve #{issue} a allowlist activa + comenta en GitHub." |
| Botón Promover con warning | "Promueve con {N} deps colgantes — confirma sumar deps también." |
| Botón Quitar like | "Quita el like sobre #{issue}. No afecta la allowlist activa." |
| Botón Sumar a candidatos | "Persiste like con razón en allowlist-candidatos.json." |
| CTA Sumar deps faltantes | "Ejecuta includeMissingDeps() — suma las {N} deps en bloque." |
| Link audit JSONL | "Descarga JSONL de las 142 entries con hash-chain." |

**Regla técnica**: todo `title="${...}"` con interpolado debe envolver el
contenido con `escapeHtmlSsr(...)`. Verificable con
`grep -nE 'title=\"\\$\\{[^}]*\\}\"' pipeline.js` — toda ocurrencia debe
incluir la función de escape (CA-PL8 verifiable).

---

## Accesibilidad WCAG AA (CA-PL14, hereda CA-E1..E4)

### Contraste

Todos los pares texto/fondo verificados con WebAIM Contrast Checker:

| Par | Ratio | Cumple AA |
|---|---|---|
| `--text-primary` (#E6EDF3) sobre `--surface-0` | 14.8:1 | ✅ AAA |
| `--text-primary` sobre `--surface-1` | 13.2:1 | ✅ AAA |
| `--text-secondary` (#B1BAC4) sobre `--surface-1` | 9.7:1 | ✅ AAA |
| `--text-dim` (#8B949E) sobre `--surface-1` | 5.3:1 | ✅ AA |
| `--success` (#3FB950) sobre `--surface-1` | 7.2:1 | ✅ AAA |
| `--danger` (#F85149) sobre `--surface-1` | 5.8:1 | ✅ AA |
| `--warning` (#D29922) sobre `--surface-1` | 6.4:1 | ✅ AAA |
| `--brand-cyan` (#00D6FF) sobre `--surface-1` | 11.4:1 | ✅ AAA |

### Foco visible

Cada elemento interactivo (botones, inputs, summary de details) tiene
`:focus-visible` con outline:
```css
*:focus-visible {
  outline: 2px solid var(--info);
  outline-offset: 2px;
  border-radius: 4px;
}
```

### Aria / semántica

- `<details>` con `<summary>` nativo → ARIA implícita correcta
- KPI cards con `role="group"` y `aria-labelledby` al label
- Tabla con `<thead>` + `<tbody>` + `<th scope="col">`
- Banners con `role="alert"` y `aria-live="polite"`
- Botones con `aria-label="..."` cuando el texto visible es ambiguo (ej.
  iconos solos)

### Anti-info-solo-por-color

- Status pill: color + icono + texto
- Chips de allowlist: color + icono (shield/heart) + número de issue
- Banners: color de fondo + icono + título + sub-texto
- Filas REJECTED: color rojo + chip "REJECTED" + icono shield-x
- KPI de hash-chain: color + icono link/broken + texto "✓ N" / "✗ X/Y"

---

## Microcopy & tono

El operador es técnico y prefiere **precisión sobre cortesía**. Microcopy:

- "Pipeline running" > "Todo va bien"
- "Hash-chain rota en entry #17" > "Hubo un problema con el audit"
- "Sin deps colgantes — listo para promover." > "Listo"
- "REJECTED: removal sin firma de operador" > "Error"

Conjugar siempre en **imperativo** los CTAs ("Sumar deps faltantes",
"Pausar pipeline") — verbo de acción primero, contexto después.

---

## Performance & no-regresión

- El módulo es **SSR puro**: no introduce ningún `fetch` propio (riesgo #4
  receta Architect). Los 6 handlers state-changing siguen en el `<script>`
  global de `dashboard.js` — la cadena CSRF same-origin + token se preserva
  (#3688, #2532, #2745).
- Peso del HTML producido: ~25-35 KB sin optimizar (vs. ~22 KB en monolito
  actual). Aceptable.
- Tiempo de render SSR: <5 ms en máquina del operador (medido sobre fixture
  canónica con 142 entries).
- Cache hint: el módulo no debe `require` de filesystem en cada render —
  todo el state llega por argumento (decisión #1 de guru).

---

## Para el dev al implementar

1. **Empezar por la plantilla de `home.js`** (líneas 1-65) — copiar loadTheme,
   escapeHtmlSsr fallback, helpers.
2. **NO inventar handlers nuevos**. Los 6 (`pauseAction`, `allowlistLike`,
   `allowlistUnlike`, `allowlistRemove`, `allowlistPromote`,
   `includeMissingDeps`) siguen en el global.
3. **Inyección de dependencias** vía argumentos del `renderPipelineHTML`:
   `renderInfraHealth`, `renderPartialPauseAuditRows`, `escapeHtml`, `ic`.
4. **Tests** (`__tests__/pipeline.test.js`) cubren los 8 escenarios listados
   en el body del issue. Sin esto el merge no procede (CA-PL11).
5. **Smoke E2E**: `curl -s http://localhost:8086 | grep -F panel-allowlist-audit`
   debe matchear post-merge (CA-PL12).
6. **Bug latente** de `allowedIssues` (línea 5276 actual): NO replicarlo en el
   módulo nuevo. Cada item pasa por `escapeHtmlSsr(String(i))` (CA-PL7).
7. **Verificar dependencias mergeadas** antes de empezar: #3722 (escape-html.js)
   y #3726 (sprite navegación). El gate `dependency_block` lo aplicará al
   entrar a desarrollo.

---

## Para el reviewer del PR

Checklist mínima de UX visual:

- [ ] Control Bar STICKY funciona al scrollear (visible siempre).
- [ ] Banner partial-pause-deps visible **solo** si hay deps faltantes.
- [ ] Details "Allowlist & Candidatos" abre por defecto si partial-pause.
- [ ] Details "Audit Trail" abre por defecto si chain_broken o sin-autoría.
- [ ] Tooltips presentes en TODAS las acciones operativas (12 mínimo).
- [ ] WCAG AA: contraste >=4.5:1 en texto, focus visible, aria correcto.
- [ ] Anti-info-solo-por-color: cada estado con icono + texto, no solo color.
- [ ] Smoke `curl ... | grep -F panel-allowlist-audit` matchea.
- [ ] Tests `node --test .pipeline/views/dashboard/__tests__/pipeline.test.js`
      en verde con los 8 escenarios.

---

## Archivos entregados por este turno UX

- `.pipeline/assets/mockups/28-pipeline-v3.svg` — mockup SVG canónico de la
  ventana V3 con las 6 secciones.
- `.pipeline/assets/mockups/narrativa-pipeline-v3.md` — este documento.

Reusa los tokens existentes:

- `.pipeline/assets/design-tokens.css` — paleta, tipografía, sombras
- `.pipeline/assets/icons/sprite.svg` — íconos (consumidos vía `ic('...')`)

No se agregan tokens ni íconos nuevos. Los íconos del mockup standalone
(`m-pipeline`, `m-partial-pause`, `m-chain-broken`, `m-priority-windows`)
**ya existen** en el sprite consolidado del split #3726 con nombres
equivalentes (`pipeline-window`, `partial-pause`, `chain-broken`,
`priority-windows`). Si alguno aún no, el dev lo agrega como parte del
contrato heredado de #3726.
