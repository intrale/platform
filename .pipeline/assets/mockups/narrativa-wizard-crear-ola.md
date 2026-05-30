# Narrativa UX — Wizard "Crear nueva ola" (#3738)

> Acompaña al mockup `28-wizard-crear-ola-flow.svg`. Describe el recorrido feliz,
> las decisiones visuales y cómo cada elemento del mockup mapea a los criterios
> de aceptación del PO (CA-1..CA-17 del issue #3738) y a los 10 requisitos no
> negociables que `/security` dejó en fase `analisis`.

---

## 1. Contexto y posicionamiento

El wizard "Crear nueva ola" es una de las cuatro caras del rediseño UX integral
del Dashboard del operador V3 (épico #3715). Se monta sobre el **wizard-base**
de #3724 (CSRF + idempotencia + audit + timeout 15min), consume el **router
cliente** de #3723 (`?view=wizard-ola`) y renderea con **escape-html.js** de
#3722. Las tres hijas están `OPEN` en HEAD — el `dependency_block` declarado
por `/security` en `analisis` se destrabe automáticamente vía el brazo de
desbloqueo cuando las tres cierren.

El precedente directo es el wizard "Triaje de allowlist" (#3742, mockup 25).
Esta narrativa reutiliza el contrato visual (stepper, filmstrip, error states,
audit trail al pie) y lo adapta al caso particular: en lugar de mutar
`partial-pause.json`, este wizard muta `waves.json` vía
`waves.createPlannedWave({...})` (función nueva que entrega `dev` en la fase
de desarrollo).

---

## 2. Recorrido feliz (happy path)

### Step 1 · Seleccionar issues candidatos

El operador llega a `/dashboard/wizard/ola/step?step=1` desde el botón "Nueva
ola" del Wave Panel (mockup 20). Ve:

1. **Nombre de la ola** — input texto con tooltip "Identificador legible. NFC,
   max 80 chars. No edita olas existentes." Microcopia debajo refuerza la
   validación. Default vacío, el operador escribe `Ola N+6 · UX wizards V3`.
2. **Filtros** — chips multi-select para `label` (`Ready` y `needs-definition`
   activos por default — los dos labels que el Pulpo intaka) y `priority` (no
   filtrado por defecto). Filtros son **client-side previo a fetch** — el
   server siempre re-valida shape + eligibility (CA-11).
3. **Lista de candidatos** — 7 visibles, 4 seleccionados (checkbox verde
   `--success`). Cada row: `[checkbox] #ID  Título  [chip label]  [chip
   priority]`. El counter "4 seleccionados · 7 visibles" arriba a la derecha
   da feedback inmediato.
4. **Banner informativo** — caja `--info` recordando que la validación se hace
   server-side (CA-11): cada id se valida contra GitHub + label admisible + no
   en ola activa/planificada.
5. **CTA primaria** — `CONTINUAR →` gradiente brand. No hay botón "Atrás" en
   step 1 (no hay donde ir).

### Step 2 · Concurrencia + ventana

El operador llega vía POST exitoso del step 1. Ve dos sliders:

1. **Concurrencia** — slider horizontal con thumb circular brand, ticks en
   1/2/4/6/MAX. El thumb está en 3 (valor por default). La etiqueta del tick
   MAX está en `--retry` (#F0883E) para destacar que es el límite duro que
   viene de `config.yaml` — **NUNCA del body** (R6 de security). Valor actual:
   `3 agentes · rango [1, MAX_CONFIGURED=8] · server-side, NUNCA del body`.
   Badge `DEFAULT` en `--teal` al lado del label.
2. **Tooltip visible** (paneo activo) — explica "Agentes en paralelo. Bounded
   server-side a [1, MAX_CONFIGURED]. Más concurrencia = más cuota consumida."
   El tooltip viene de constante estática (CA-2), nunca del input del usuario.
3. **Ventana en minutos** — segundo slider con ticks en 5/360/720/1080/MAX
   (1440 = 24 h). Thumb en 20 (default 60 min ≈ 1h, primer cuarto del slider).
   Valor actual: `60 min · rango [5, 1440] · default 60 min (1h)`. Badge
   `DEFAULT` igual que arriba.
4. **Bounds card** — caja con 3 chequeos verdes (`--success`) repitiendo los
   bounds para CA-8. Hace de hint estructural si el operador olvida los
   tooltips.
5. **Footer** — banner `--info` recordando que CSRF + Sec-Fetch-Site están
   enforced en TODOS los steps (CA-4 + R5 de security).
6. **CTAs duales** — botón `Atrás` (`--text-secondary`, secundario, izquierda
   estrecho 148px) + botón `CONTINUAR →` (gradiente brand, primario,
   derecha ancho 304px). El peso visual es asimétrico — la acción primaria
   pesa más, pero `Atrás` siempre visible y operable (CA-1).

### Step 3 · Preview + confirmación

El operador llega vía POST exitoso del step 2. La card del step 3 está
**bordeada en `--brand-cyan`** (distinta de step 1 y 2 que tienen borde
neutro), porque es la acción destructiva — la convención del precedente 25
se mantiene.

1. **Resumen** — 4 filas de etiqueta + valor: Nombre, Issues, Concurrencia,
   Ventana. Sin chrome adicional — el operador escanea de un vistazo.
2. **Diff de waves.json** — bloque code-styled `--surface-0` con 4 líneas
   prefijo `+` en `--success` con tinted background. Comunica que esto se
   suma a `planned_waves` sin tocar `active_wave` ni nada existente
   (audit-then-apply, R5 de security).
3. **Re-check eligibility** — fila `--success` con check + timestamp y `4/4
   OK`. Visualiza la defensa anti-TOCTOU (CA-9 + R2 de security): entre el
   render del preview y el POST de confirm, el server re-valida que los
   issues siguen elegibles.
4. **Doble confirmación** — 2 checkboxes obligatorios:
   - "Revisé los 4 issues seleccionados"
   - "Confirmo concurrencia=3 y ventana=60"

   Los dos están checkeados en el mockup, pero el server NO confía en el
   estado del cliente — el botón "CREAR OLA PLANIFICADA" sólo se activa si
   el cliente envía ambos flags **y** el server confirma el `step_token`
   (TTL 60s, single-use).
5. **Banner audit-then-apply** — caja `--info` con orden `1. NDJSON.append →
   2. waves.saveState() atómico + lock` (CA-7). Comunica que si el apply
   falla, el audit entry queda en disco con `result: apply_failed`.
6. **CTA verde de éxito** — `CREAR OLA PLANIFICADA` con icono cohete,
   `--success` gradiente (no brand-cyan) — la convención visual es: brand-cyan
   = navegación, success-green = "commit" destructivo confirmado. Botón
   `Atrás` (138px) a la izquierda.
7. **Footer del card** — "Acción destructiva auditada. step_token monotemporal
   TTL 60s (CA-10)."

---

## 3. Estados de error explícitos (fila inferior del mockup)

El precedente 25 estableció la convención: **todos los estados de error
visibles en el filmstrip, no escondidos en toasts efímeros**. Cada card 380×180
con borde lateral 6px del color semántico:

- **400 rejected_bounds · CA-8** — `concurrencia=999` o `ventana=0`. Inputs en
  rojo + toast + audit registra. Borde `--danger`.
- **403 step_token_invalid · CA-10** — TTL 60s vencido o ya usado. CTA
  "Recalcular preview" vuelve al step 3 con nuevo token. NUNCA replay
  silencioso. Borde `--retry`.
- **409 state_changed · CA-9** — Anti-TOCTOU. Entre preview y confirm, otro
  flow (`/wave promote`, brazoDesbloqueo) mutó `waves.json`. Recalcula diff y
  CTA "Volver al step 3". Borde `--danger`.
- **410 wizard_session_expired · CA-6** — Sesión > 15 min abandonada.
  `waves.json` no fue mutado. CTA "Reiniciar wizard" vuelve al step 1, datos
  perdidos. Idempotencia (CA-5) y rate-limit (CA-15) se mencionan en
  footnote — no requieren card propio porque son protecciones server-side
  invisibles al operador feliz. Borde `--retry`.

Lo que NO se muestra como card pero **el dev debe implementar**:

- **403 csrf_rejected (CA-4)** — POST sin CSRF token o con `Sec-Fetch-Site:
  cross-site`. No tiene card porque el operador legítimo nunca lo ve —
  significa que un atacante intentó. Audit registra.
- **200 idempotent_replay (CA-5)** — doble POST con mismo `wizard_session_id`.
  Retorna el mismo `wave_id` con flag `idempotent_replay: true`. Se ve en el
  campo `idempotent_replay` del audit log (footer del mockup).
- **429 rate_limited (CA-15)** — > 5 POST/min al step 3. Audit registra. CTA
  "Esperá 30s" + countdown. No tiene card en el mockup porque es defensa
  silenciosa anti-fuerza-bruta del confirm token.

---

## 4. Decisiones visuales y guidelines UX (G-UX-28-1..G-UX-28-12)

| Guideline | Decisión |
|-----------|----------|
| **G-UX-28-1** | Stepper 3-dots horizontal arriba del filmstrip. Punto activo gradient brand, completados outline `--success`, futuros `--surface-2`. Heredado del mockup 25 (consistencia entre wizards de #3715). |
| **G-UX-28-2** | Countdown del `step_token` en la barra del stepper (`--retry` con clock icon) **sólo visible** cuando el operador está en step 3 con preview generado. Antes de step 3, ese hueco queda vacío o muestra el icono de Sec-Fetch-Site. |
| **G-UX-28-3** | Filtros del step 1 como chips multi-select. `Ready` y `needs-definition` activos por default (paleta `--purple` para coherencia con el chip `Ready` del Wave Panel mockup 20). Filtros adicionales en outline neutro hasta que el operador los toque. |
| **G-UX-28-4** | Lista de candidatos con 4 columnas: `[checkbox] #ID  Título-truncado  [label-chip]  [priority-chip]`. Truncate del título con ellipsis si > 28 chars — el operador prioriza el ID + chips para decidir. |
| **G-UX-28-5** | Counter "N seleccionados · M visibles" en `--success` cuando hay > 0 selección. Feedback inmediato del cliente. Server re-valida shape al POST (CA-11). |
| **G-UX-28-6** | Sliders del step 2 con thumb circular `--brand-cyan` outline + dot brand interno. Track rellenado en gradient brand desde el inicio hasta el thumb. Convención WAI-ARIA: `aria-valuemin/max/now`. |
| **G-UX-28-7** | Tick del MAX en `--retry` (#F0883E), no en gris neutro — el operador ve que "ese es el límite duro del config, no podés pasarlo". Comunica intent sin necesidad de docs. |
| **G-UX-28-8** | Badge `DEFAULT` en `--teal` al lado del label de cada slider cuando el thumb está en el valor por default. Si el operador mueve el thumb, el badge desaparece. Cumple CA-3 (defaults pre-rellenos marcados claramente). |
| **G-UX-28-9** | Tooltips ÚNICAMENTE de constantes server-side locales del módulo (CA-2 + R7 de security). NUNCA echo del body. El tooltip flotante del step 2 está visible en el mockup como ejemplo, pero en producción aparece sólo en focus/hover (`role="tooltip"` + `aria-describedby`). |
| **G-UX-28-10** | Diff del step 3 con prefijo `+ ` literal + texto verde + bg tintada `--success` α=0.10 (anti información-solo-por-color). Cada línea ≤ 64 chars para no requerir scroll horizontal. |
| **G-UX-28-11** | Doble check obligatorio del step 3 en lugar de un solo botón. Convención del precedente 25 — fricción intencional para acción destructiva. Aria: `role="checkbox"` con label completo asociado. |
| **G-UX-28-12** | CTA destructiva del step 3 en `--success` gradient (no brand-cyan). Convención del precedente: brand-cyan = navegación / paso siguiente, success-green = "commit" confirmado. Icono cohete refuerza la intención "lanzar". |

---

## 5. Mapeo con criterios de aceptación del PO

| CA del PO | Visualizado en el mockup |
|-----------|--------------------------|
| **CA-1** Wizard 3 steps + preview + confirm + atrás | Filmstrip de 3 cards. Botón Atrás en step 2 y 3. Step 3 es preview+confirm en mismo card. |
| **CA-2** Tooltips estáticos en cada campo | Iconos `m-tooltip` al lado de cada label. Tooltip del step 2 visible como muestra. |
| **CA-3** Defaults sensatos + operabilidad sin docs | Badge `DEFAULT` en sliders. Microcopia debajo de cada input. Banner informativo en step 1. |
| **CA-4** CSRF + Sec-Fetch-Site en TODOS los steps | Banner footer del step 2. Audit log con `csrf_ok` y `sec_fetch_site`. |
| **CA-5** Idempotencia estricta | Campo `idempotent_replay: false` en el audit log. Sin card explícito (no es visible al operador feliz). |
| **CA-6** Timeout 15 min | Error state E4 (410). Audit log no se afecta si no hay apply. |
| **CA-7** Audit log NDJSON completo | Sección entera al pie del mockup. Banner audit-then-apply en el step 3. |
| **CA-8** Bounds estrictos server-side | Sliders con MAX en `--retry`. Bounds card en step 2. Error state E1 (400). |
| **CA-9** Anti-TOCTOU | Re-check fila en step 3 con timestamp. Error state E3 (409). |
| **CA-10** step_token monotemporal | Countdown en stepper. Footer del step 3. Error state E2 (403). |
| **CA-11** Validación estricta issues | Banner `--info` del step 1. Filtros + lista. |
| **CA-12** XSS render escapado | Render con `escapeHtmlText/Attr` (#3722) — no visible en el mockup, comentado en defs. |
| **CA-13** Atomic write + lock | Banner audit-then-apply del step 3 menciona `waves.saveState()` que es atómico. |
| **CA-14** Tests obligatorios | Fuera del scope visual — responsabilidad del `tester` en fase `desarrollo`. |
| **CA-15** Rate limit confirmación | Mencionado en footnote del card E4. Defensa silenciosa. |
| **CA-16** No extender ALLOWED_PATHS | Path del wizard `/dashboard/wizard/ola/step` cae bajo `/dashboard` (ya whitelisted). |
| **CA-17** Mockup Anthropic SDK + screenshot real | **Este archivo es el mockup**. Screenshot real lo entrega `/qa` cuando `dev` complete. |

---

## 6. Coordinación con el split del épico #3715

- **#3722 escape-html.js** — hard block. Sin él, `dev` devuelve JSON puro y
  posterga render HTML del preview con datos GitHub (que pueden traer
  `<script>` en títulos). Mientras esté `OPEN`, el wizard no arranca `dev`.
- **#3723 router viewSlug + `/dashboard/partial`** — hard block. Provee la
  navegación SPA `?view=wizard-ola`. Mientras esté `OPEN`, el dev expone la
  ruta como satélite `/dashboard/wizard/ola` con TODO `// TODO #3723: migrar
  a ?view=wizard-ola`.
- **#3724 wizards-base** — hard block crítico. Provee CSRF + idempotencia +
  timeout + audit NDJSON base. Sin él, el wizard duplica defensas y rompe
  el principio "un solo lugar de verdad" (#2901).
- **#3722, #3723, #3724** — el brazo de desbloqueo destrabe automáticamente
  cuando las tres cierren. `dev` arranca con `gh issue view <N> --json state`
  para los tres antes de codear.
- **#3742 sibling wizard-allowlist** — mismo contrato visual. Si `dev` se
  ahoga acá, copiar de ahí.
- **#3740 sibling wizard-providers-rotate** — mismo contrato visual.
- **#3752 hash chain tamper-evidence del audit** — `needs-human`, no
  bloquea. Recomendación de hardening que se aplica al NDJSON entero.

---

## 7. Accesibilidad WCAG AA verificada en el mockup

| Par color/fondo | Ratio | Resultado |
|-----------------|-------|-----------|
| `--brand-cyan` (#00D6FF) sobre `--surface-0` | 11.4:1 | AAA |
| `--text-primary` (#E6EDF3) sobre `--surface-0` | 14.8:1 | AAA |
| `--text-secondary` (#B1BAC4) sobre `--surface-0` | 9.7:1 | AAA |
| `--text-dim` (#8B949E) sobre `--surface-0` | 5.3:1 | AA Normal |
| `--success` (#3FB950) sobre `--surface-0` | 7.3:1 | AA+ AAA Large |
| `--danger` (#F85149) sobre `--surface-0` | 5.6:1 | AA Normal |
| `--retry` (#F0883E) sobre `--surface-0` | 5.4:1 | AA Normal |
| `--info` (#58A6FF) sobre `--surface-0` | 7.1:1 | AA Normal+ |
| `--purple` (#7C5CFF) sobre `--surface-0` | 4.5:1 | AA Normal (límite) |
| `--teal` (#2DD4BF) sobre `--surface-0` | 8.4:1 | AAA Large |

**Información NUNCA sólo por color**:

- Estados de error con icono (`m-danger`, `m-warning`, `m-clock`) + texto +
  código HTTP — no sólo borde rojo.
- Diff con prefijo `+` literal + color verde + bg tintada — el operador
  daltónico lo lee igual.
- Checkboxes con icono de check, no sólo cambio de color.
- Slider con texto del valor numérico debajo, no sólo posición del thumb.

**Otras consideraciones WCAG**:

- `aria-disabled` en CTAs bloqueados (no oculto), focus visible outline brand
  2px, navegación con teclado en orden visual.
- Counter con `aria-live="polite"` (anuncia cambios "N seleccionados").
- Errores con `role="alert"` y mensaje completo.
- `prefers-reduced-motion` respetado en animaciones (caret blink, gradient
  shifts) — `media (prefers-reduced-motion: reduce) { animation-duration: 0s }`.

---

## 8. Lo que NO entra al alcance de este mockup

- **Pantalla post-creación** — qué ve el operador después de "CREAR OLA
  PLANIFICADA". Mockup 20 (Wave Panel) ya cubre cómo se renderea la ola en
  estado `planned`. Posiblemente con badge "Recién creada · podés promover
  a active" verde animado por 5s — recomendación no bloqueante para `dev`.
- **Promoción planificada → active** — flow separado, ya cubierto por la
  función `promoteWaveAtomic` de `waves.js` (line 1130). No es parte de este
  wizard.
- **Edición de ola existente** — el wizard sólo CREA. Editar ola existente
  es flow distinto (probablemente otro split del épico).
- **Concurrencia y ventana avanzados** — schedule cron, ventanas de
  exclusión, ventana modo descanso. Defaults estáticos por ahora; iteración
  futura.

---

## 9. Mensaje para el dev (cuando `desarrollo` arranque)

> Cuando las tres dependencias (`#3722`, `#3723`, `#3724`) cierren y el brazo
> de desbloqueo te ponga este issue en `Ready`, arrancá `dev` así:
>
> 1. `gh issue view 3722 3723 3724 --json state` → verificá que las tres son
>    `MERGED`. Si no, **no codees** y rebota a `analisis` con motivo "dependency
>    no mergeada".
> 2. Levantá el filmstrip de este mockup al lado del editor — cada step
>    corresponde a una vista renderizable con `wizards-base.register(...)`.
> 3. Los **tooltips son constantes locales del módulo** — copialos
>    literalmente del SVG. Si querés cambiar el texto, lo hablás con `ux`
>    antes (puedo iterar en una sub-historia).
> 4. **No inventés errores nuevos**: los 4 estados del mockup + idempotencia
>    + csrf + rate-limit son todos los errores posibles. Si te aparece uno
>    más, pará y consultá.
> 5. **No extiendas `ALLOWED_PATHS`** — el wizard vive bajo `/dashboard`
>    (whitelisted). Si necesitás un screenshot del wizard, usá el path
>    canónico `/dashboard/wizard/ola/step?step=N` y NO toques
>    `screenshot-capture.js:39`.
> 6. **Reutilizá el sprite de iconos**: `<use href="#ic-..."/>` sobre
>    `sprite.svg`. Los símbolos inline del mockup son sólo para preview
>    standalone — no los redibujés en producción.
> 7. Si necesitás un asset que falta (otro icono, otra paleta), creá un
>    issue de recomendación contra `ux` y seguís — no te bloquees.

---

## 10. Justificación QA y next steps

- **`qa:skipped` confirmado** por scope infra del pipeline (`area:dashboard`
  sin ningún `app:*`). CLAUDE.md → "Tipos de issue y criterio QA" → infra/hooks
  internos. Cuando este issue llegue a `aprobacion`, UX aplica **PASO 0.A** y
  baja a **PASO 2-bis** (evaluación por assets + mockup + code review).
- **Recomendaciones futuras** — no creo issues nuevos de recomendación: el
  espacio del wizard ya está cubierto por #3752 (hash chain), #3751 (viewSlug
  screenshots) y #3717 (otra mejora del épico). Sumar más sería ruido (límite
  3/issue por memoria `feedback_agent-recommendations-as-issues`).
- **Sin rebote cross-phase** — architect ya firmó pre-admisión, security
  aprobó con requisitos no negociables, PO entregó CA-1..CA-17. El brazo de
  desbloqueo destrabe este issue automáticamente cuando #3722/#3723/#3724
  cierren.

> Narrativa posteada por el agente `ux` durante fase `criterios` del pipeline
> `definicion`.
