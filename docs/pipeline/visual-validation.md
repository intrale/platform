# Validación visual post-construcción — Guidelines UX

> **Issue origen**: #3383 (gate + rejection report side-by-side) · #3381 (workflow UX en definición).
> **Estado**: criterios entregados por UX en fase de definición.
> **Stack visual**: tokens en `.pipeline/assets/design-tokens.css`, iconografía en `.pipeline/assets/icons/sprite.svg`, mockup de referencia en `.pipeline/assets/mockups/19-rejection-visual-comparison.svg`.

Este documento define **cómo se ve y se siente** la validación visual post-construcción
en el pipeline V3. Es la fuente UX para que `pipeline-dev` implemente el gate y el
bloque comparativo del rejection report sin tener que inventar paleta, jerarquía,
ni tono de los mensajes. **El dev ubica, vos no diseñás**.

Las decisiones de gate, feature flag, backfill y tests viven en los CA del issue
#3383 (consolidados por PO). Acá vivimos los criterios **visuales y de copy** que
todavía no están especificados.

## 1. Protocolo end-to-end (vista UX)

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Definición  │───▶│  Desarrollo │───▶│     QA      │───▶│  Validación │
│             │    │             │    │             │    │      PO     │
│ UX adjunta  │    │ dev imple-  │    │ captura     │    │ aprueba o   │
│  mockup     │    │  menta      │    │ entrega +   │    │ rebota con  │
│  esperado   │    │  contra el  │    │ compara vs  │    │ rejection   │
│  (#3381)    │    │   mockup    │    │   mockup    │    │  report     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
       │                                      │                  │
       │  gate hasVisualReference             │  side-by-side    │
       └──────────────────────────────────────┴──────────────────┘
                       evidencia visual obligatoria
```

Tres superficies UX deben quedar resueltas:

| Superficie | Responsable de la spec | Consumido por |
|---|---|---|
| **Sección "Screenshots & Mockups" en issue body** | UX (§2 de este doc) | gate `hasVisualReference` |
| **Comment de bloqueo en GitHub cuando el gate rechaza** | UX (§3 de este doc) | `pulpo.js` al promover |
| **Bloque side-by-side en rejection report PDF** | UX (§4 de este doc + mockup 19) | `rejection-report.js` |

## 2. Spec de la sección `Screenshots & Mockups`

### 2.1 Plantilla obligatoria

UX adjunta esta sección en el body del issue durante refinamiento. El gate
valida presencia + 2 imágenes mínimas (CA-1 del issue #3383).

```markdown
## Screenshots & Mockups

### Mockup esperado

![Mockup esperado — paso N](https://user-attachments.githubusercontent.com/.../mockup-paso-N.png)

> **Fuente**: Claude Design (claude.ai/design) · sesión 2026-MM-DD · v1.
> **Pantalla cubierta**: <nombre de la pantalla> · flavor <client|business|delivery>.
> **Tokens aplicados**: `--brand-cyan`, `--brand-blue`, `--text-primary`, `--surface-1`.
> **Baseline declarado**: sí · cambios futuros requieren re-confirmación UX (CA-15).

### Entrega esperada vs casos borde

![Estado vacío](https://user-attachments.githubusercontent.com/.../estado-vacio.png)
![Estado con datos largos](https://user-attachments.githubusercontent.com/.../datos-largos.png)

> Casos cubiertos: feliz, vacío, error, carga, datos largos (texto > 60 chars).
```

### 2.2 Reglas del adjunto

- **Mínimo 2 imágenes** dentro de la sección (CA-1). Si la pantalla tiene 4 estados
  visuales (feliz, vacío, error, carga), adjuntar las 4 — no asumir que el dev
  inferirá los estados que faltan.
- **Formato**: PNG o SVG. Prohibido JPG con artefactos por compresión, gifs.
- **Tamaño máximo por imagen**: 2 MB (límite de GitHub).
- **Resolución mínima**: 720×1280 para pantallas mobile, 1280×720 para tablet/desktop.
- **Densidad declarada**: si el flavor tiene assets en múltiples densidades, declarar
  cuál se está mostrando (`xhdpi`, `xxhdpi`, etc.).
- **Sin marcadores temporales**: el mockup no debe tener texto tipo "draft v3",
  "WIP", "DOC-12". Si el mockup no está cerrado, NO va al issue todavía.

### 2.3 Política de invalidación (CA-15 del issue #3383)

Cuando un issue se rebota desde cualquier fase a definición, el mockup **se
considera stale automáticamente**. UX debe re-confirmar antes de que el issue
salga otra vez:

- Re-confirmación sin cambios: agregar comment `✓ mockup re-confirmado YYYY-MM-DD`.
- Regeneración con cambios: agregar comment `⟳ mockup regenerado YYYY-MM-DD` +
  reemplazar las imágenes en la sección.

El gate NO valida la frescura — depende del juicio de UX en el rebote. La trazabilidad
queda en los comments.

### 2.4 Bypass legítimo

Issues marcados con `qa:skipped` (infra pura, docs, refactor sin UI) **bypassan el
gate por whitelist explícita** (CA-3). UX no necesita adjuntar mockups en esos casos.
Si dudás si tu issue es `qa:skipped`, lee `CLAUDE.md → "Tipos de issue y criterio QA"`.

## 3. Spec del comment de bloqueo del gate

Cuando `hasVisualReference` retorna `ok: false`, el pulpo postea un comment en el
issue. La copy es **clave UX**: el dev/UX que lo lea debe entender qué falta y
cómo desbloquear en menos de 30 segundos.

### 3.1 Comment exacto (case-sensitive con emoji)

```
❌ Validación visual bloqueada — falta evidencia en la definición

Este issue tiene labels `app:*` o toca superficies con UI, pero el body no
incluye la sección **Screenshots & Mockups** con al menos 2 imágenes adjuntas.

QA no puede comparar la entrega contra una referencia que no existe, así que
el pipeline lo devuelve a definición.

**Cómo desbloquear**:
1. Volver a refinamiento con `/doc refinar #<issue>` o `/ux #<issue>`.
2. UX adjunta mockup esperado + estados borde siguiendo
   [`docs/pipeline/visual-validation.md §2`](../../docs/pipeline/visual-validation.md#2-spec-de-la-sección-screenshots--mockups).
3. Volver a someter (el label `needs:visual-baseline` se quita automáticamente
   cuando el gate verifica que ya hay sección + 2 imágenes).

Si este issue NO necesita validación visual (infra pura, docs, refactor sin UI),
agregá label `qa:skipped` con justificación escrita en un comment.

> _Bloqueado por_ `PIPELINE_VISUAL_GATE_ENABLED=1` · gate `hasVisualReference` · `.pipeline/lib/qa-evidence-gate.js`.
```

### 3.2 Reglas de copy

- **Tono**: directo, sin pasivo-agresivo. "Falta evidencia" — no "te olvidaste".
- **Acción primero, justificación después**: el "cómo desbloquear" va antes de la
  letra chica del feature flag.
- **Sin emojis decorativos en medio del texto**: solo el `❌` del título como
  semáforo. El resto es texto liso para que sea legible si Telegram lo replica.
- **Markdown válido**: bullets, negritas y link al doc. NO usar tablas (Telegram
  las rompe).
- **Idempotencia**: si el gate vuelve a fallar dos veces seguidas, el bot debe
  detectar duplicado y NO postear el mismo comment dos veces (sino el issue se
  contamina). Edición del comment existente con timestamp en lugar de duplicar.

### 3.3 Labels que el gate aplica

- `needs:visual-baseline` (amarillo) — falta sección, esperando UX/dev.
- `bloqueado-humano` (rojo) — se mantiene hasta que el gate vuelve a pasar.

Cuando el gate vuelve a verificar y pasa, ambos labels se remueven en la misma
operación API (CA-2 + atomicidad sugerida por security).

## 4. Spec del bloque side-by-side en el rejection report PDF

Implementación visual del bloque comparativo dentro de `rejection-report.js`
cuando QA detecta visual mismatch. Referencia visual completa en
`.pipeline/assets/mockups/19-rejection-visual-comparison.svg`.

### 4.1 Layout

| Zona | Posición | Notas |
|---|---|---|
| Header del reporte | Top — full width 120px alto | Logo + identidad + veredicto "VISUAL MISMATCH" en danger |
| Issue title + meta | Bajo el header, padding 48px | Badges: fase, provider/model, app:*, timestamp |
| Bloque comparativo | Dos columnas 50/50 con gap 24px | Altura igualada, sin scroll interno |
| Diferencias narradas | Full width, lista vertical | 3-5 items con badge numerado |
| Acciones sugeridas | Full width, fondo `--success-bg` | A quién rebota + cómo arreglar |
| Footer | Bottom 1px border | Sanitización confirmada + checksum |

### 4.2 Tokens aplicados (consumir desde `design-tokens.css` ya existente)

```
Header
  background: linear-gradient(180deg, --brand-navy → --brand-navy-deep)
  border-bottom: 1px solid --border

Veredicto VISUAL MISMATCH (top-right)
  background: rgba(248, 81, 73, 0.14)   /* --danger-bg */
  border: 1px solid --danger-dim
  text-color: --semantic-danger          /* #F85149 */
  font-weight: 700 · font-size: 14px

Columna izquierda (mockup esperado)
  background: --surface-1
  border: 1px solid --border
  header-background: --surface-2
  header-icon: circle 6px --info        /* #58A6FF */

Columna derecha (entrega actual — la que difiere)
  background: --surface-1
  border: 1px solid --danger-dim         /* MARCA distintiva: borde rojo */
  header-background: rgba(248, 81, 73, 0.14)
  header-icon: circle 6px --danger

Diff markers (números 1, 2, 3 sobre la entrega)
  circle radius 14px (ó 8px en overlay denso)
  fill: --semantic-danger
  text: --surface-0 (alto contraste sobre rojo)
  border: 1.5px solid --surface-0 para que se separen del fondo
```

### 4.3 Etiquetas obligatorias

- Columna izquierda: `MOCKUP ESPERADO` (uppercase, letter-spacing 1px, weight 700)
  + subtítulo `adjunto en definición · UX · YYYY-MM-DD`.
- Columna derecha: `ENTREGA ACTUAL` + subtítulo `captura QA (emulador|playwright) · YYYY-MM-DD HH:MM`.
- Badge en cada columna a la derecha del header:
  - Izquierda verde: `baseline · v<N>`.
  - Derecha roja: `no matchea`.

**Nunca** usar solo el color para diferenciar las columnas — la etiqueta textual y
el icono de status son obligatorios (criterio de accesibilidad: información no
debe codificarse solo por color, ver design-system.md §1.3).

### 4.4 Altura del bloque comparativo

- Altura fija calculada: el contenido de cada columna debe **rellenar exactamente
  la misma altura** para que el ojo compare 1:1.
- Si el mockup esperado tiene aspect-ratio distinto del screenshot capturado
  (común: mockup 9:16 mobile vs screenshot 16:9 dashboard), se renderiza dentro de
  un frame de proporción fija con `object-fit: contain` + fondo `--surface-2` para
  el padding. Sin estirar, sin recortar.
- Si una columna no tiene imagen (ej. mockup falta o screenshot falló), reemplazar
  por placeholder pattern (ver mockup 19 — pattern diagonal sobre `--surface-2`) y
  banda roja explicativa: `⚠ <columna> no disponible: <motivo>`.

### 4.5 Diferencias narradas

Lista vertical, máximo 5 items por reporte (si hay más, agrupar). Cada item:

```
┌────────────────────────────────────────────────────────────────────┐
│ ⓞ  Título breve del defecto (max 70 chars · weight 700 · 14px)    │
│    Descripción objetivable (medible o referenciable a tokens · 12px)│
│    Impacto · <bajo|medio|alto> · efecto sobre el usuario · 11px    │
└────────────────────────────────────────────────────────────────────┘
```

- **Título**: empieza con el componente afectado, no con la corrección. Ej:
  bien — *"CTA Continuar sin gradiente de marca"*; mal — *"Cambiar el CTA"*.
- **Descripción**: cita números concretos o tokens. Ej: *"radius 22 (pill) → la
  entrega usa 6"*. Prohibido *"se ve mal"*, *"queda raro"*, *"medio feo"*.
- **Impacto**: clasificar en `bajo`/`medio`/`alto` para que el dev priorice.
  El criterio:
  - `alto`: bloquea o degrada la acción principal del usuario.
  - `medio`: afecta jerarquía/legibilidad sin bloquear.
  - `bajo`: cosmético (ej. shadow ligeramente distinta).

### 4.6 Acciones sugeridas

Bloque verde `--success-bg` al pie del reporte. Estructura:

```
→ Rebote a <skill>

Re-implementar <descripción acotada> respetando: <tokens|patrones|referencia>.
Referencia bloqueante: mockup esperado (<fecha>, <baseline vN>).

Después de re-implementar:
1. QA captura nuevo screenshot.
2. Re-corre comparación contra el mismo mockup.
3. Si el dev modifica el mockup esperado en vez de la entrega, UX debe
   re-confirmar (CA-15).
4. Si el dev cree que la entrega es la versión correcta, abre comment en el
   issue antes de tocar y dispute con UX.
```

La acción sugerida es **no normativa** — es una pista. El veredicto final lo
toma PO. Pero ahorra 5-10 minutos al dev que recibe el rebote.

## 5. Checklist UX para QA durante la captura

QA, cuando captura el screenshot para comparar:

- [ ] **Misma resolución** que el mockup esperado (o aspect-ratio compatible).
- [ ] **Mismo estado del flujo** que el mockup muestra (no comparar pantalla feliz
      vs estado vacío del mockup — si el mockup muestra estado feliz, capturar el
      mismo estado feliz).
- [ ] **Sin overlays de debug** activos (no DevTools, no Compose layout inspector,
      no debug strokes).
- [ ] **Sin datos sensibles visibles**: JWT en headers, tokens en debug overlay,
      emails reales del usuario QA. Si aparecen, sanitizar con `redact()` ANTES
      de adjuntar al rejection report (CA-9 del issue #3383).
- [ ] **Densidad declarada** en el filename: `screenshot-xxhdpi-2026-05-20.png`.
- [ ] **Capturar nativo** (no recortar a mano): `adb exec-out screencap` para
      Android, Playwright `page.screenshot()` para dashboard. Sin tijeras
      manuales que rompen el aspect ratio.

## 6. Checklist UX para PO durante validación visual

PO, cuando aprueba o rebota el visual:

- [ ] **Los 3-5 hallazgos narrados son objetivables** (cita tokens / números /
      patrones). Si son *"no me gusta"*, escalar a UX antes de aprobar el rebote
      al dev — no rebotamos al dev con feedback subjetivo.
- [ ] **El veredicto matchea con el impacto** declarado: si todos los hallazgos
      son `bajo`, el visual probablemente es aceptable y la decisión es WONTFIX
      en lugar de rebote.
- [ ] **El mockup sigue vigente** (no fue invalidado en un rebote anterior). Si
      hubo rebote sin re-confirmación de UX, primero pedir re-confirmación.
- [ ] **No hay duplicados con rebotes anteriores**: si el mismo defecto fue
      reportado en el rebote previo y "arreglado", evaluar si el dev no entendió
      o si el mockup es ambiguo. En ese caso UX aclara antes del próximo rebote.
- [ ] **Audio narrado adjunto** al rejection report PDF (memoria
      `feedback_rejection-report-audio.md` + CA-14 del issue).

## 7. Criterios de aceptación adicionales que UX adiciona (no duplican PO)

Estos son **suplementarios** a los 20 CA del comment de PO en el issue. No los
duplican — los profundizan en la dimensión UX. El dev que implemente debe
satisfacerlos para que UX apruebe en fase de `validacion`.

- [ ] **CA-UX-1** — El bloque side-by-side en el PDF usa tokens del archivo
      `.pipeline/assets/design-tokens.css` (NO redefine paleta inline). Aceptar
      que `rejection-report.js` hoy usa CSS inline propio — esta es la oportunidad
      de migrar los bloques nuevos a tokens. Bloques viejos del reporte que ya
      están con inline no es responsabilidad de #3383.
- [ ] **CA-UX-2** — El comment de bloqueo se postea como **edición** del comment
      previo cuando el gate vuelve a fallar (no como nuevo). Marker en el body
      `<!-- visual-gate-block -->` para identificar.
- [ ] **CA-UX-3** — La sección `Screenshots & Mockups` se valida con regex
      **case-insensitive** del título (`/^##\s+screenshots\s*[&y]\s*mockups/im`)
      y la regex acepta variantes `Screenshots y Mockups`, `Screenshots & Mockups`.
- [ ] **CA-UX-4** — Cuando el mockup falta en una columna del PDF (ej. el dev
      eliminó la imagen original del issue), reemplazar por placeholder pattern
      diagonal (ver mockup 19) + banda explicativa. NO dejar columna en blanco
      ni columna a mitad de altura.
- [ ] **CA-UX-5** — El audio narrado del rejection report (memoria
      `feedback_rejection-report-audio.md`) debe leer las **diferencias** y la
      **acción sugerida**, no el rejection report entero. Mantener < 60s.
- [ ] **CA-UX-6** — Mockup 19 (`.pipeline/assets/mockups/19-rejection-visual-comparison.svg`)
      es la **referencia visual obligatoria** para implementar el bloque. El dev
      no inventa proporciones, padding ni colores — sigue el mockup o pregunta a
      UX si encuentra ambigüedad.

## 8. Anti-patrones a evitar

- **Diff visual automatizado en MVP**: ya argumentado por guru (#3403 lo cubre
  como fase 2). El mockup viene de Chromium-render, la entrega de Compose-render
  — el sub-pixel/AA/kerning generaría 30%+ de falsos rebotes. Empezamos con
  revisión humana.
- **Mockups en JPG con compresión**: pierde bordes finos, anti-alias, colores
  exactos. Prohibido en la sección obligatoria.
- **Mockups generados por el mismo dev que implementa**: conflicto de interés —
  el dev "ve" el mockup como ya implementado. La memoria
  `feedback_ux-claude-design-obligatorio.md` exige Claude Design (claude.ai/design)
  para mockups, no placeholders simples.
- **Rebotar con "no se ve bien"**: cualquier rebote visual sin 3-5 hallazgos
  objetivables (con tokens / números) es válido para que el dev escale a UX +
  PO + Leo. UX no acepta rebotes basados en gusto sin justificación.
- **Validar contra un mockup invalidado**: si UX no re-confirmó después del último
  rebote, el mockup está stale (CA-15). PO debe pedir re-confirmación antes de
  rebotar.
- **Capturas con datos del usuario QA reales**: el screenshot pasa por GitHub
  attachments y Telegram. JWT visible, emails reales o números de tarjeta de
  prueba quedarían públicos. Siempre `redact()` antes de persistir.

## 9. Referencias cruzadas

- `.pipeline/assets/design-tokens.css` — fuente de verdad de paleta + tipografía.
- `.pipeline/assets/icons/sprite.svg` — iconografía del pipeline (mismo sprite
  para dashboard, PDF y Telegram-via-PNG).
- `.pipeline/assets/mockups/19-rejection-visual-comparison.svg` — referencia
  visual obligatoria del bloque side-by-side de este feature.
- `docs/pipeline/design-system.md` — guidelines completas del sistema visual
  (paleta, contraste, tipografía, espaciados, iconos).
- `.pipeline/lib/qa-evidence-gate.js` — módulo donde el dev incorpora
  `hasVisualReference` (CA-1 del issue #3383).
- `.pipeline/rejection-report.js` — módulo donde el dev incorpora el bloque
  side-by-side (CA-12 del issue #3383).
- `CLAUDE.md → "Tipos de issue y criterio QA"` — whitelist para bypass por
  `qa:skipped`.
- Memorias relacionadas:
  - `feedback_ux-claude-design-obligatorio.md` — mockups SIEMPRE con Claude Design.
  - `feedback_rejection-report-audio.md` — audio narrado obligatorio.
  - `feedback_rejection-reports-detail.md` — detalle no-técnico, contexto del
    feature, clasificación de causa.
- Issues recomendación (NO bloquean #3383, aprobación humana):
  - #3403 — Diff visual automatizado (pixelmatch + tolerancia) como fase 2.
  - #3404 — Telemetría de fallos visuales por skill.
  - #3405 — Galería histórica de mockups aprobados como baseline cross-screen.

## 10. Operación del gate — activación, rollback, backfill

### 10.1 Feature flag (CA-4, CA-5)

El gate vive detrás de `PIPELINE_VISUAL_GATE_ENABLED`. Default **OFF** mientras
#3381 no esté mergeado a `main`. Una vez en main:

- **Activar** (PowerShell del host del pulpo):
  ```powershell
  $env:PIPELINE_VISUAL_GATE_ENABLED = '1'
  node .pipeline/restart.js
  ```
- **Desactivar** (kill-switch sin redeploy):
  ```powershell
  $env:PIPELINE_VISUAL_GATE_ENABLED = '0'
  node .pipeline/restart.js
  ```

El restart del pulpo es no destructivo: los archivos en
`desarrollo/build/listo/` siguen ahí y se re-evalúan con el nuevo valor del flag
en el siguiente barrido. Los labels `needs:visual-baseline` ya aplicados NO se
limpian automáticamente al desactivar (mantienen el contexto del rebote).

### 10.2 Backfill pre-activación (CA-6)

Antes de mover el flag a `1` por primera vez, correr:

```bash
node .pipeline/scripts/backfill-visual-baseline.js          # dry-run
node .pipeline/scripts/backfill-visual-baseline.js --apply  # ejecuta
```

El script lista todos los issues OPEN con label `app:*` cuyo body no tiene
sección `## Screenshots & Mockups` con 2+ imágenes y les aplica los labels
`needs:visual-baseline` + `bloqueado-humano`. Es idempotente: si el issue ya
tiene la sección o el label, no hace nada.

Reporte de auditoría: `.pipeline/logs/backfill-visual-baseline-<ts>.json`.

### 10.3 Criterios de rollback

Activar el kill-switch si:
- Tasa de falsos rebotes > 30% en una ventana de 50 validaciones (medible vía
  `#3404` cuando esté implementado, o manualmente).
- Bug del gate bloquea promoción de issues legítimos (sección y mockups
  presentes pero gate retorna `ok: false`).
- Bloqueo cascada por dependencia rota con #3381.
