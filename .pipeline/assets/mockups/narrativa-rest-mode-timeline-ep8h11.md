# Narrativa de diseño — Modo descanso · timeline semanal editable · EP8-H11

- **Issue:** [#3964](https://github.com/intrale/platform/issues/3964) — *Descanso → timeline semanal visual con bloques editables*
- **Épica:** EP-8 (#3952)
- **Mockup:** `41-rest-mode-timeline-ep8h11-v3.svg` (1080×1920, kiosk vertical)
- **Fase:** definición / criterios — entregable UX como guía de implementación para el dev
- **Scope técnico:** UI Node.js/SVG del Dashboard V3 (vista `views/dashboard/descanso.js` + cómputo read-only en `GET /api/rest-mode` de `dashboard.js`). **No** toca backend Ktor, app Compose ni AWS. Backend del modo descanso reutilizado 100% (per análisis `guru`/`security`).

Esta narrativa es la **guía visual** que el pipeline-dev usa para implementar.
Todos los colores salen de `.pipeline/assets/design-tokens.css` — **no se introduce
ningún color nuevo**. Sin librería de charting ni de drag&drop: SVG/DOM nativo con
pointer events (cumple REQ-SEC supply-chain A06/A08).

---

## Principio rector

La pantalla pasa de una **grilla de inputs `time`** (precisa pero ciega a la forma
de la semana) a un **timeline semanal legible de un vistazo**: el operador ve dónde
duerme el pipeline, arrastra para ajustar, y confirma. La jerarquía es **ver primero,
editar después, confirmar siempre**:

1. Arriba, el estado actual ("ahora") y el botón de guardado.
2. El centro lo domina el **timeline 7×24** — el objeto de trabajo.
3. Debajo, la **consecuencia** del cambio (próximo descanso + qué agentes pausaría),
   los **bypass** (qué nunca se pausa) y la **auditoría** (qué cambió y cuándo).

El timeline informa; los inputs `time` (fallback de teclado, §G) siguen disponibles
para precisión y accesibilidad. **Ambos editan el mismo `schedule`** — no son dos
fuentes de verdad.

---

## §A — Timeline 7 días × 24 h (CA-1 · CA-2 · CA-3 · CA-4)

**Layout.** 7 columnas (días, Lun→Dom) × eje vertical de 24 h. En el mockup:
gutter de horas a la izquierda (`x 48..104`), 7 columnas de 132 px (`x 104..1028`),
`pxPerHour = 32`, `top y = 360`. Esos números son ilustrativos del kiosk vertical;
en la vista real el alto por hora se deriva del alto disponible del contenedor, pero
**la geometría debe vivir en funciones puras** (`minToY`, `yToMin`, `snapMin`,
`blockRect`, `wouldOverlap`) en el módulo nuevo `rest-timeline-geometry.js`, no
incrustada en el string del `<script>`. Eso es lo unit-testeable (CA tests).

- **Bloques de descanso (CA-1):** cada período de `scheduleState[day]` se dibuja como
  rectángulo posicionado: `top = minToY(startMin)`, `height = minToY(endMin) - minToY(startMin)`.
  Relleno `--rest-mode-bg` con borde `--rest-mode` (`#7C5CFF`); etiqueta `HH:MM–HH:MM`
  en `--rest-mode-fg` (`#C5B7FF`). El cruce de medianoche se parte en dos rectángulos
  (un tramo al final del día, otro al inicio del siguiente) reutilizando `expandPeriod`/
  `crossesMidnight` ya existentes.
- **Crear / mover / redimensionar (CA-2):** pointer events sobre la columna.
  - *Crear:* `pointerdown` en zona vacía + `pointermove` dibuja un **ghost** (patrón
    rayado, `id=ghostHatch` en el mockup) con la duración en vivo; `pointerup` materializa.
  - *Mover:* arrastrar el cuerpo del bloque reposiciona manteniendo duración.
  - *Resize:* **handles** arriba/abajo del bloque seleccionado (las dos barras claras
    en el mockup). La barra visible es fina pero la **zona activa de pointer debe ser
    ≥40 px** (touch target) — extender el hit-area con padding invisible.
  - *Snap:* todo cuantizado a **30 min** (`snapMin(min, 30)`). El indicador del ghost
    muestra siempre valores redondeados (`10:00–12:30`, nunca `10:07`).
  - Durante todo el gesto: llamar `markEditing()` para setear `data-rm-editing="1"`
    y que el fetch periódico (`tickRestMode`, cada 8 s) **no pise** la edición.
    **El arrastre NO dispara POST** — sólo muta `scheduleState` local.
- **Overlap imposible por UX (CA-3):** al soltar, validar con `validateScheduleClient`
  / `wouldOverlap(schedule, day, candidate)`. Si colisiona → **rechazo visual claro**
  (en el mockup: bloque candidato en `--danger` con aspa y "solapa · bloqueado") o
  snap fuera de la zona ocupada. Esto es **sólo UX**: el invariante real sigue en
  `setWindow`/`validateSchedule` server-side — un POST directo con overlap debe seguir
  devolviendo 4xx. No debilitar la revalidación backend por confiar en la grilla.
- **Marcador "ahora" (CA-4):** línea horizontal punteada en `--danger` (`#F85149`)
  con dot en la columna del día actual y pill `ahora HH:MM`. La posición se deriva
  del slice `restMode` del server (`describeRestModeNow`: `isWithinNow`/`currentPeriod`/
  `nextPeriod`) + `window.timezone`. **Prohibido** usar `new Date()` del browser para
  la hora del marcador (evita mismatch de TZ cliente ≠ TZ configurada). El color rojo
  del marcador es deliberadamente distinto del indigo de los bloques para que "ahora"
  no se confunda con un descanso.

**Dual-encoding (accesibilidad):** ningún estado se comunica sólo por color.
Descanso = relleno indigo **+ etiqueta de horario**; ghost = **patrón rayado** +
texto "soltá para crear"; ahora = línea punteada **+ pill con la hora**; overlap =
aspa **+ texto "bloqueado"**. Leyenda permanente arriba del timeline.

---

## §B — Toolbar de guardado (CA-5, parte 1)

Barra superior con tres estados mutuamente informativos:

- **"Guardado ✓ + próximo descanso HH:MM"** — chip `--success` tras un round-trip OK.
- **"cambios sin guardar…"** — chip `--warning` mientras `scheduleState` difiere de lo
  persistido (hay ediciones locales pendientes).
- **Botón "Guardar agenda…"** — `--rest-mode`. Abre el modal de confirmación (§F);
  **nunca** postea directo.

El texto del próximo descanso sale de `describeRestModeNow().nextPeriod` — no se calcula
en el cliente.

---

## §C — Preview: próximo descanso + qué agentes pausaría (CA-6)

Caja read-only (borde `--rest-mode-dim`) que responde "¿qué va a pasar?":

- **Cuándo:** próximo bloque (`hoy 23:00 → mañana 06:00 · en 8 h 40 m`).
- **Qué agentes pausaría:** chips neutros (`--deterministic-bg`) con los skills que
  quedarían pausados durante ese próximo período. **El cómputo es server-side**:
  enriquecer el payload de `GET /api/rest-mode` con un campo `wouldPauseSkills`
  calculado con `restModeWindow.DETERMINISTIC_SKILLS` + `isSkillAllowedNow` sobre los
  skills/issues ya visibles en `/api/dash/header`, **acotado** (sin scan ilimitado).
  **No** mirrorear `DETERMINISTIC_SKILLS` en el cliente (ya hay 4 fuentes + un test de
  coherencia; no agregar una 5ª copia).
- Chip verde "✓ no pausa" para los deterministas/bypass.
- Render **siempre con `textContent`** (títulos de issue / nombres de agente son datos
  no confiables → riesgo A03). Nunca `innerHTML`.

---

## §D — Bypass como chips con tooltip (CA-7)

`renderStatus` hoy hace `bp.textContent = bypassLabels.join(', ')`. Reemplazar por
**un chip por label** (`<span>`), color `--quota-degraded` (ámbar) para diferenciarlo
visualmente del descanso indigo:

- Tooltip que explica el porqué ("Los issues con esta etiqueta siguen corriendo aunque
  el descanso esté activo"). Implementar con atributo `title=` **escapado** o tooltip
  propio con `textContent` — **nunca `innerHTML`**.
- **Read-only:** se hidratan desde `rest_mode.bypass_labels` (config, hoy
  `["priority:critical"]`). **Prohibido** agregar un endpoint para editarlos desde la
  UI (rompería CA-Sec-A04a). Nota visible "Editable sólo desde config.yaml".

---

## §E — Cambios auditados (CA-8)

Lista compacta del audit append-only (`rest-mode-audit.jsonl`): `ts` (cuándo),
diff `prev`/`next` resumido, y badge de `actor`. El **"quién" es best-effort**:
el `actor` distingue **origen** (`api` / `manual` / `cron` / `config-reload`), no
identidad de persona — el dashboard es single-operator loopback sin auth por usuario.
Documentar la limitación visiblemente; **no inventar identidad de usuario falsa**.
Todos los campos del JSONL (`prev`/`next`/`actor`) se renderizan con `textContent`
(datos persistidos → riesgo A03 al mostrarlos).

---

## §F — Modal de confirmación (CA-5, parte 2)

El submit deja de ser `fetch('/api/rest-mode', POST)` crudo y pasa por
`inConfirmPost({ url, body, title, message, preview, confirmLabel })` de
`CONFIRM_MODAL_JS` (ya inyectado). El modal muestra el **próximo descanso** en el
`preview` antes de confirmar. Tras el round-trip OK → "Guardado ✓ + próximo descanso"
(§B). `inConfirmPost` usa `fetchJson`, que adjunta `X-CSRF-Token` automáticamente; el
chequeo loopback del POST es independiente del CSRF. Confirmación explícita = evita
cambios accidentales y reduce ventana de clickjacking/UI-redress.

```js
const j = await inConfirmPost({
  url: '/api/rest-mode',
  body: { active, timezone, schedule: scheduleState, manual: true },
  title: 'Confirmar agenda de descanso',
  message: 'Se aplicara en caliente, sin reiniciar el pipeline.',
  preview: [{ label: 'Proximo descanso', value: nextPeriodText }],
  confirmLabel: 'Guardar',
});
if (j && j.ok) setMsg('Guardado OK - proximo descanso ' + nextPeriodText, 'ok');
```

---

## §G — Fallback editable por teclado (CA-9, no regresión)

La grilla actual de inputs `type=time` **se conserva** bajo el timeline, dentro de un
`<details>` colapsable "Edición precisa por teclado". Sigue siendo navegable y editable
sin mouse. Timeline e inputs comparten el mismo `scheduleState`: editar en uno refleja
en el otro. Esto garantiza no-regresión de accesibilidad para teclado/lectores de
pantalla y mantiene la precisión al minuto que el arrastre con snap no da.

---

## Tokens usados (todos de `design-tokens.css`)

| Uso | Token | Hex |
|-----|-------|-----|
| Bloque de descanso (relleno) | `--rest-mode-bg` | `rgba(124,92,255,0.16)` |
| Bloque/handles/botón (borde·texto) | `--rest-mode` / `--rest-mode-fg` | `#7C5CFF` / `#C5B7FF` |
| Borde hover | `--rest-mode-dim` | `#4B36B8` |
| Marcador "ahora" / overlap bloqueado | `--danger` / `--danger-bg` | `#F85149` |
| Chip bypass | `--quota-degraded` / `--quota-degraded-fg` | `#F0A500` / `#FFE5A8` |
| Chip "no pausa" / guardado ✓ | `--success` | `#3FB950` |
| Chips skills (preview) | `--deterministic-bg` | `rgba(177,186,196,0.10)` |
| Superficies / bordes / texto | `--surface-1..3`, `--border*`, `--text-*` | — |

Tipografía y espaciado de la escala existente (`--fs-*`, `--space-*`, `--radius-*`).

---

## Checklist de aceptación visual (para QA del dashboard)

- [ ] Timeline 7×24 con bloques en la celda/hora correcta (CA-1).
- [ ] Drag crea/mueve/resize con snap 30' y ghost en vivo (CA-2).
- [ ] Overlap rechazado por UI **y** POST directo con overlap → 4xx (CA-3).
- [ ] Marcador "ahora" en posición correcta, derivado del server, no `new Date()` (CA-4).
- [ ] Guardar abre modal; arrastre **no** postea; "Guardado ✓ + próximo descanso" tras OK (CA-5).
- [ ] Preview lista skills que pausaría, computado server-side, `textContent` (CA-6).
- [ ] Bypass como chips con tooltip, read-only, sin `innerHTML` (CA-7).
- [ ] Audit muestra `ts`/origen/diff con campos escapados; "quién" documentado best-effort (CA-8).
- [ ] `<details>` con inputs time editables por teclado, mismo `schedule` (CA-9).
- [ ] `rest-mode.json` resultante compatible; `data-rm-editing` evita flicker (CA-10).
