# Narrativa UX — Ventana Equipo V3 (#3727, split de #3715)

> Guidelines de diseño vinculantes para la extracción de la ventana **Equipo**
> del monolito `.pipeline/dashboard.js` hacia `.pipeline/views/dashboard/equipo.js`.
> Acompaña al mockup `27-equipo-panel-v3.svg`. Voz de referencia para el MP3:
> `es-AR-ElenaNeural` (generar en fase `dev` si se requiere audio).

---

## 1. Qué es la ventana Equipo

La ventana **Equipo** es el panel del dashboard del operador que responde una
sola pregunta de un vistazo: **¿quién está trabajando ahora y con qué capacidad
cuenta el sistema?** Combina dos planos:

1. **Personas** — los 15 skills/agentes del pipeline, agrupados por las cuatro
   áreas semánticas del proyecto (Producto, Desarrollo, Calidad, Operaciones).
2. **Servicios** — la infraestructura que rodea a los agentes (Telegram, GitHub,
   Pulpo, Outbox, Dashboard, Drive, Emulador), organizada en tres capas de flujo
   (Intake → Processing → Output).

Es una ventana **read-only** salvo por las acciones operativas de Servicios
(`start`/`stop` de un proceso). El operador la usa para diagnosticar de un
golpe de vista la salud del equipo y de la infra.

---

## 2. Identidad visual

- **Rail vertical de 4-5px** sobre el borde izquierdo del panel, con gradient
  `--brand-cyan (#00D6FF) → --purple (#BC8CFF) → --success (#3FB950)`. Es la
  firma del panel Equipo (regla existente `.bar-section.panel-equipo::before`,
  L4256 del `dashboard.js`). El gradient cuenta visualmente la historia del
  panel: personas (cyan/brand) → calidad (purple) → entrega/verde (success).
- **Dark-first**, coherente con el resto del kiosk. Superficies en escalera de
  elevación: `surface-0` (body) → `surface-1` (panel) → `surface-2` (cards de
  área y de servicio) → `surface-3` (chips de persona).
- **Cero colores nuevos.** Todo proviene de `.pipeline/assets/design-tokens.css`.
  Los emojis de `AGENT_PERSONA` se mantienen literales: son parte de la
  identidad de cada agente y NO se reemplazan por íconos del sprite.

---

## 3. Anatomía y jerarquía (orden de lectura top-down)

### 3.1 `eq-head` — cabecera
- Título `🧠 Equipo` con chevron `▼` colapsable (`toggleSection('equipo')`) y
  popout `↗` para abrir la ventana aislada (`/?section=equipo`).
- **Resumen de capacidad** en una línea: `Activos N/M · Utilización X% · Cola K`.
  Es el dato más importante de la ventana — debe leerse primero.
- Divisor inferior `1px solid --border` separando cabecera del cuerpo.

### 3.2 `active-strip` (`eq-active-cards`) — quién corre ahora
- Tira horizontal de tarjetas compactas, una por agente **en ejecución**.
- Cada tarjeta: avatar con color de persona, nombre, issue + acción actual,
  **badge `provider:model`** (claude/codex/gemini/…) y barra de progreso.
- Si no hay nadie corriendo, la tira se omite (no se renderiza una tira vacía).

### 3.3 `eq-areas-grid` 2×2 — capacidad por área
Cuatro `eq-area-card`, una por categoría, en grilla 2×2 que colapsa a 1 columna
en `max-width: 720px`:

| Área | Color (`CATEGORY_META`) | Personas |
|------|-------------------------|----------|
| **Producto** | `#D29922` | PO 📋 · UX 🎨 · Planner 📐 |
| **Desarrollo** | `#3FB950` | BackendDev ⚡ · AndroidDev 📱 · WebDev 🌐 |
| **Calidad** | `#D2A8FF` | Tester 🧪 · QA ✅ · Review 👁 · Security 🔒 |
| **Operaciones** | `#58A6FF` | Guru 🧠 · Perf ⚡ · Builder 🏗 · Delivery 🚀 |

Cada `eq-area-card` tiene:
- **Head**: dot del color de categoría + label + sub-resumen
  `N/M libres · K activos` (los activos en verde `--success`).
- **Chips persona** (`eq-chip`): pill con avatar coloreado + nombre. Los chips
  ocupados llevan borde de color de la persona, **badge `×N`** cuando hay más de
  un issue en ejecución, y un dot de estado. El badge numérico garantiza que el
  estado **no dependa sólo del color** (WCAG).

### 3.4 `eq-svc-section` — servicios en 3 capas
Sección separada por divisor superior, encabezada por `⚙ Servicios`. Grilla de
3 columnas (colapsa a 1 en `max-width: 900px`) organizada por capa de flujo:

- **Intake**: Telegram 📨 (listener, svc-telegram), GitHub 🐙 (svc-github).
- **Processing**: Pulpo 🐙, Outbox 📤 (outbox-drain), Dashboard 📊.
- **Output**: Drive 📁 (svc-drive), Emulador 📱 (svc-emulador).

Cada `svc` card: ícono, nombre, sub-label de procesos, dot de salud
(verde/amarillo/rojo). Las acciones operativas (`ctlAction('<proc>','start'|'stop')`)
llevan tooltip descriptivo + `aria-label`, ambos escapados.

> **Opción A confirmada por PO**: Servicios viaja **junto con** Equipo en esta
> historia. La migración a la ventana **Ops** queda documentada como pendiente
> en el inventario y se ejecuta en el split **#3732**. No perder funcionalidad
> (CA-A1 del padre).

---

## 4. Tabla de contrastes WCAG AA

Verificado contra los tokens de `design-tokens.css` (ratios del propio archivo
de tokens, sección 2-3). Todos cumplen AA (≥4.5:1 texto normal, ≥3:1 texto
grande/iconos).

| Elemento | Color | Fondo | Ratio | Cumple |
|----------|-------|-------|-------|--------|
| Texto principal (nombres, summary) | `#E6EDF3` | `--surface-0` | 14.8:1 | AAA ✓ |
| Texto secundario (sub-labels) | `#B1BAC4` | `--surface-1` | 9.7:1 | AAA ✓ |
| Texto dim (timestamps, runs) | `#8B949E` | `--surface-0` | 5.3:1 | AA ✓ |
| Dot/label Producto | `#D29922` | `--surface-2` | ≥3:1 | AA (icono) ✓ |
| Dot/label Desarrollo | `#3FB950` | `--surface-2` | ≥3:1 | AA (icono) ✓ |
| Dot/label Calidad | `#D2A8FF` | `--surface-2` | ≥4.5:1 | AA ✓ |
| Dot/label Operaciones | `#58A6FF` | `--surface-2` | ≥4.5:1 | AA ✓ |
| Badge `×N` (texto sobre verde) | `#0D1117` | `#3FB950` | ≥7:1 | AAA ✓ |

**Reglas de accesibilidad no negociables:**
- El estado de un agente **nunca** se comunica sólo por color: siempre
  acompañado de icono + badge `×N` + dot + texto en el tooltip.
- Touch targets ≥ 24×24px (chips y acciones de servicio).
- Foco visible con `--border-strong` (#484F58) para navegación por teclado;
  `tabindex` correcto en chips y acciones.
- `aria-label` redundante en iconos sin texto: chevron, popout `↗`, acción `⏯`.

---

## 5. Seguridad — reglas inquebrantables (CA-Equipo-2/3/4)

`#3722` cerró: `lib/escape-html.js` existe en `main` y expone `escapeHtmlBody`
y `escapeHtmlAttr`. **Prohibido replicar `escapeHtmlSsr` local** (viola CA-B3).

1. **CA-2 (XSS body/attr).** Todo dato dinámico interpolado al HTML pasa por
   `escapeHtmlBody()` en cuerpo y `escapeHtmlAttr()` en `title=`, `aria-label=`,
   `data-*=` y `href=` parcial. El `tip.replace(/"/g,'&quot;')` actual (L2607)
   se reemplaza por `escapeHtmlAttr(tip)` — el replace parcial deja pasar
   `';alert(1);//`, `<`, `>`, `&`.
2. **CA-3 (CSS injection).** Cualquier color en `style=` (`--agent-color`,
   `background:`) se valida contra `^#[0-9a-fA-F]{3,8}$|^var\(--[a-z0-9-]+\)$`
   antes de interpolar, o se pasa por `data-color=` + resolución por CSS var.
   `AGENT_PERSONA` permanece **hardcoded** en esta historia (no se vuelve
   dinámico).
3. **CA-4 (href seguro).** Los links de historial (`skillHistoryStrip`) validan
   prefijo whitelist `/logs/view/` + `encodeURIComponent()` del nombre de log.
   Prohibido aceptar `javascript:`, `data:`, `file:`.
4. **No leak de internals.** El SSR y el JSON de refresh NO incluyen
   `process.env`, paths absolutos del FS ni credenciales.
5. **Fallback visible (CA-10).** Si `require('./views/dashboard/equipo')` falla,
   el `catch` loggea `warn` y el template renderiza
   `<span class="empty-label">Equipo no disponible</span>` — nunca `return ''`
   silencioso. El smoke curl (CA-6) detecta si el fallback se activa por error.

**Vectores XSS canónicos para el test SSR (CA-5):**
```
"><img src=x onerror=alert(1)>
javascript:alert(1)
';alert(1);//
</script><script>alert(1)</script>
&#x3C;script&#x3E;
```
Aplicados sobre `agentPersona.name`, `agentPersona.tagline`, `tip` del chip,
`p.color` y `r.logFile`. Assert: el HTML NO contiene `<img src=x` / `<script>` /
`javascript:` activos; SÍ contiene `&lt;img` / `&quot;`.

---

## 6. Microcopy (tono y reglas de texto)

- Resumen de capacidad: `Activos {busy}/{total} · Utilización {pct}% · Cola {n}`.
- Sub-resumen de área con activos: `{libres}/{total} libres · {activos} activo(s)`.
- Sub-resumen sin activos: `{libres} libres`.
- Tooltip de chip ocupado: `{Nombre} — {N} issue(s) en ejecución ({runs} runs)`.
- Tooltip de chip libre: `{Nombre} — libre ({runs} runs)`.
- Meta de persona-card: `✓ {successRate}%` (aprobación histórica) + `📈 {usage}`
  (issues trabajados).
- Empty states: `Sin skills configurados` (grid vacío) · `Equipo no disponible`
  (módulo no carga) · `—` (historial vacío).
- Español neutro, conciso, sin jerga técnica innecesaria en lo visible al
  operador. Los nombres de proceso (`svc-telegram`, `outbox-drain`) sí se
  muestran como sub-label porque son el identificador operativo real.

---

## 7. Mapa a los criterios de aceptación (CA-Equipo-1..12)

| CA | Cómo lo cubre el diseño |
|----|--------------------------|
| CA-1 | `renderEquipoSsr(state)` función pura; `personaCard`/`eqAreaGrid`/servicios helpers privados; registro `try/catch` con fallback visible. |
| CA-2 | escape-html.js obligatorio; `escapeHtmlAttr(tip)` reemplaza el replace parcial. |
| CA-3 | regex de validación de color; `AGENT_PERSONA` hardcoded. |
| CA-4 | href whitelist `/logs/view/` + `encodeURIComponent`. |
| CA-5 | tests `node --test` con 5 vectores XSS, ≥80% líneas. |
| CA-6 | smoke curl `id="equipo"` + `bar-section panel-equipo`. |
| CA-7 | entrada en `docs/pipeline/dashboard-v3-inventory.md` + nota Servicios→Ops (#3732). |
| CA-8 | CSS `.eq-*`/`.persona-*`/`.panel-equipo*` migra a `views/dashboard/theme.css`; tokens permanecen en theme global. |
| CA-9 | tooltips operativos en Servicios start/stop, escapados con `escapeHtmlAttr()`. |
| CA-10 | fallback visible `Equipo no disponible` (no `return ''`). |
| CA-11 | tabla de contrastes §4 (todos ≥AA); navegación teclado + aria-label. |
| CA-12 | este mockup `27-equipo-panel-v3.svg` + narrativa; el dev adjunta screenshot real vs mockup lado a lado al PR. |

---

## 8. Notas de implementación para el dev (no perder en la extracción)

- El layout 2×2 + servicios 3-capas ya existe embebido en `dashboard.js`
  (L2524-2625 personas, L2627-2722 servicios, L5478-5497 template). La
  extracción **reordena y endurece** (escape, fallback, tests), no reinventa la
  UX. Reanclar con `grep -n "personaCard("`, `"eqAreaGridHTML"`, `"panel-equipo"`
  antes de editar.
- `renderEquipoSsr(state)` recibe todos los derivados como input (sin leer FS ni
  globals) para que los tests SSR + XSS sean triviales de montar.
- Sprite: NO se agregan iconos nuevos. Los emojis de persona y de servicio se
  mantienen literales.
- Tokens: si se mueve CSS `eq-*`/`persona-*` a `theme.css`, NO duplicar las
  variables `--ac/--pu/--gn/--rd/--yl` ni los tokens de `design-tokens.css`.

---

_Narrativa producida por el agente `ux` en pipeline V3 — fase `criterios`.
Acompaña al mockup `27-equipo-panel-v3.svg`. Assets commiteados y pusheados a
rama remota para garantizar su persistencia (fix del rebote cross-phase desde
`validacion`)._
