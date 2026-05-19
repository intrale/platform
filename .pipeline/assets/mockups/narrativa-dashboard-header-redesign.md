# Narrativa — Rediseño del encabezado del large board principal

**Issue:** [#3356](https://github.com/intrale/platform/issues/3356)
**Mockup:** [`18-dashboard-header-redesign.svg`](18-dashboard-header-redesign.svg)
**Autor:** agente `ux` durante fase `definicion/criterios`
**Contexto técnico previo:** análisis del agente `guru` + criterios del agente `po` (ver comentarios del issue)

---

## Por qué este rediseño

El header actual del dashboard apila cinco bloques visualmente similares:

1. `hdr-bar-v3` — logo + título + status pill + KPIs + reloj
2. `pipeline-ctrl-bar` — status global + ventanas Priority QA/Build + Pausa
3. `renderInfraHealth(state)` — salud de servicios (Pulpo, Listener, etc.)
4. `kpis-row` — 6 KPIs (Definidos, En cola, Ejecución, Entregados 24h, Bloqueados, Necesitan humano)
5. `sys-mini-card` — score de salud + CPU + RAM

El operador ve "una pared", no "cinco grupos de información". Además, el contador "En cola = 7" no dice **qué** hay en la cola — y eso es exactamente lo que el usuario necesita para decidir si interviene manualmente o sigue dejando que el pipeline trabaje.

**Decisión de UX:** mantener toda la información existente, separarla en sub-secciones con tratamientos visuales distintos, y **agregar una nueva sub-sección que liste hasta 10 issues de la cola** con formato `#num · título`.

---

## Sistema visual

### Tokens reutilizados (sin agregar paleta nueva)

| Token | Uso en el rediseño |
|---|---|
| `--surface-1` (#161B22) | Fondo de cada sub-sección |
| `--surface-2` (#1C2128) | Filas pares (zebra) en la lista de la cola |
| `--border` (#30363D) | Borde estándar de cada sub-sección |
| `--border-subtle` (#21262D) | Borde de la brand bar (más sutil) |
| `--radius-md` (8px) | Esquinas redondeadas de cada sub-sección |
| `--space-3` (12px) | Gap vertical entre sub-secciones |
| `--space-4` (16px) | Padding interno horizontal |
| `--fs-xs` / `--fs-sm` / `--fs-md` | Jerarquía tipográfica |
| `--brand-cyan` / `--brand-blue` | Rail decorativo en la control-bar (status global del sistema) |

**Sin colores nuevos, sin fuentes nuevas, sin radios nuevos** — coherencia total con el sistema V3 (`assets/design-tokens.css`).

### Iconografía

Todos los íconos provienen de `assets/icons/sprite.svg`. Reutilización pura:

- `ic-intrale-logo` — squircle navy con triángulo Intrale (brand bar)
- `ic-health-ok` — punto verde del status "Running"
- `ic-agents-count` / `ic-issues-count` / `ic-estado-stale` — KPIs del pipeline
- `ic-fase-criterios` / `ic-fase-dev` / `ic-fase-qa` — chips de fase en la cola

Para los chips de fase de cada item de la cola, usar los colores semánticos por lane (`--lane-definicion` púrpura, `--lane-desarrollo` info-blue, `--lane-qa` teal, `--lane-entrega` success-green) que ya están definidos.

---

## Las 5 sub-secciones

### Sección 1 — Brand bar (64px de alto)

Fila compacta con identidad. Contiene en una sola línea:

- Logo Intrale + título "Intrale Pipeline"
- Sub-título: `DASHBOARD V3 · LOCALHOST:3200`
- Badge `V3` (teal)
- Pill de estado global: `Running` / `Pausado` / `Parcial` / etc.
- Botón compacto `↻ AUTO` (autorefresh)
- Reloj grande a la derecha + fecha en minúscula

**Cambio respecto al actual:** se sacan los KPIs numéricos (agentes / en curso / UP / build) de esta fila. Pasan a la sección 4 donde ya existe el grid de 6 KPIs. Esto baja el ruido visual de la brand bar.

### Sección 2 — Control bar (52px de alto)

Toggles operacionales. Contiene:

- Status global a la izquierda: `4 agentes trabajando · cola con 7 issues · sin stale` (o `Pipeline en pausa · ▶ Reanudar`, o `Ventana QA activa · ✕ Cerrar`, etc. — toda la lógica de `pipeline-ctrl-bar` actual)
- Sección "Priority Windows" a la derecha con los toggles `🔍 QA · OFF` / `🔨 Build · 12m · ON`
- Botón `⏸ Pausar` al extremo derecho

**Detalle de UX:** el rail vertical cyan (3px) en el borde izquierdo da identidad de "barra de control del sistema". Cuando hay alerta (pausa/bloqueo/ventana activa) el rail cambia de color usando los semánticos ya definidos:

| Estado | Rail | Token |
|---|---|---|
| Sano | cyan/blue gradient | `var(--brand-cyan)` → `var(--brand-blue)` |
| Ventana QA activa | teal | `var(--teal)` |
| Ventana Build activa | ámbar | `var(--retry)` |
| Pausa total | gris dim | `var(--text-disabled)` |
| Pausa parcial | warning | `var(--warning)` |
| Recursos al límite | danger | `var(--danger)` |

### Sección 3 — Salud de Infra (64px de alto)

Resumen colapsable horizontal. Contiene:

- Etiqueta `SALUD DE INFRA`
- Lista horizontal de servicios con dot semántico (Pulpo, Dashboard, Listener, Telegram, GitHub, Drive, Emulador) — verde / ámbar / rojo según `state.infraHealth`
- KPIs auxiliares a la derecha: `PROVIDERS 5/5 healthy` · `UPTIME 3d 14h` · `BUILD d-7a3f · p-9e1c`
- Chevron `▼` para colapsar (comportamiento existente de `section-collapsible`)

**Cambio respecto al actual:** se mueve el `pulpoUptime` y `dashboardBuild · pulpoBuild` desde la brand bar a esta sección, porque conceptualmente forman parte de "salud de infra" y no de la identidad de la app.

### Sección 4 — KPIs del pipeline (110px de alto)

Card propia con los 6 KPIs existentes. La **única diferencia** respecto al actual es que el card tiene su propia superficie + borde + título de sección (`KPIs DEL PIPELINE`).

A la derecha de la fila, en una card hermana (332px de ancho), se preserva la `sys-mini-card` actual con Salud (score numérico + tag) + CPU gauge + RAM gauge.

### Sección 5 — Cola detallada (396px de alto — **nueva**)

Esta es la sub-sección que aporta valor de producto. Lista vertical con hasta 10 items. Cada fila tiene:

- `#num` (color `--text-dim`, fuente mono) — 70px de ancho
- `título del issue` (color `--text-primary`) — flex
- chip de fase actual (`criterios` púrpura / `dev` info / `qa` teal / etc.) — 62px
- skill esperado (`ux`, `pipeline-dev`, etc.) en color `--text-dim` — 100px

**Comportamiento responsive:**

- Si la cola tiene `≤10` items: se muestran todos sin scroll
- Si la cola tiene `>10` items: se renderizan los primeros 10 + el contenedor tiene `max-height: 360px` + `overflow-y: auto`
- Si la cola tiene `<10` items: las filas faltantes se rellenan con placeholders en `--text-disabled` para mantener altura estable (evita "saltos" cuando se entrega un issue y queda uno menos)

**Footer de la sección:** `7 mostrados · 0 ocultos` + nota de scroll cuando aplica.

---

## Decisiones cerradas para el dev (pipeline-dev)

1. **NO agregar endpoints HTTP nuevos** — los títulos vienen de `matrixEntries` que ya carga `data.title` en el render server-side (`dashboard.js:1294 pendientesList`).
2. **Escape obligatorio** — el título del issue puede contener HTML. Usar `esc()` o `escapeHtml()` (función existente, ver `dashboard.js` líneas con `<60 puntos de uso). NUNCA interpolar título crudo en template literal con `innerHTML`.
3. **Sin clickeables en la cola** — la sección 5 es solo lectura en este issue. Navegación al detalle del issue va en un issue futuro separado.
4. **Bind loopback intacto** — sin cambios a `127.0.0.1:3200`, sin tocar validación Origin/Referer (`dashboard.js:8603-8617`).
5. **Test obligatorio** — extender `.pipeline/__tests__/dashboard-xss-modal.test.js` con un caso: issue cuyo título contenga `<script>alert(1)</script>` debe aparecer escapado en la sección 5.
6. **Sin Kotlin / sin Gradle / sin app módulos** — el cambio es 100% `.pipeline/dashboard.js`.

---

## Accesibilidad (WCAG AA)

- Todos los pares texto/fondo usados en el mockup están validados en `design-tokens.css` con WebAIM:
  - `--text-primary` sobre `--surface-1`: 14.8:1 ✓ AAA
  - `--text-secondary` sobre `--surface-1`: 9.7:1 ✓ AAA
  - `--text-dim` sobre `--surface-1`: 5.3:1 ✓ AA
- Roles ARIA preservados de la implementación actual (`role="status"`, `aria-live="polite"`, `aria-label` en buttons).
- La sub-sección "Cola" debe declararse como `<section aria-label="Cola del pipeline">` con `role="list"` interno y cada item como `role="listitem"`.
- Soporte de `prefers-reduced-motion` y `prefers-contrast: more` ya garantizado por los tokens globales.

---

## Anti-patrones evitados explícitamente

- ❌ Sumar la cola dentro de `hdr-bar-v3` (fila brand). Eso aplastaría la identidad y rompería el flex existente.
- ❌ Esconder la cola detrás de un toggle colapsable. El punto del issue es exposición directa.
- ❌ Mostrar info que el operador ya tiene en la sección 4 (KPIs). La cola es "qué hay esperando", los KPIs son "cuánto hay en cada estado". Son distintos.
- ❌ Crear paleta nueva o tokens nuevos. El sistema V3 ya cubre todo lo necesario.
- ❌ Cargar títulos vía endpoint nuevo. El render server-side ya tiene la data.

---

## Cómo validar visualmente (para QA estructural)

Como es un cambio puramente visual del dashboard local sin impacto en flujo de usuario final (`area:pipeline`, `tipo:infra` sin labels `app:*`), aplica `qa:skipped` según `CLAUDE.md` → "Tipos de issue y criterio QA".

Aún así, smoke test estructural recomendado:

```bash
# 1. Levantar dashboard
node .pipeline/dashboard.js &
sleep 3

# 2. Verificar render de las 5 sub-secciones
curl -s http://127.0.0.1:3200 | grep -cE "hdr-bar|pipeline-ctrl-bar|infra-health|kpis-row|cola-detallada"
# Esperado: ≥5

# 3. Verificar consumo de tokens
curl -s http://127.0.0.1:3200 | grep -cE "var\(--surface-1\)|var\(--border\)|var\(--radius-md\)"
# Esperado: >0

# 4. Verificar escape de títulos en la cola
# (test unitario nuevo en __tests__/dashboard-xss-modal.test.js)
node --test .pipeline/__tests__/dashboard-xss-modal.test.js

# 5. Verificar bind loopback intacto
grep -E "listen.*3200|127\.0\.0\.1" .pipeline/dashboard.js
```

---

> Narrativa generada automáticamente por el agente `ux` durante la fase `criterios` del pipeline. Los assets visuales (mockup SVG + esta narrativa) viven en `.pipeline/assets/mockups/` y son la fuente única de verdad para el dev que tome el issue.
