# Narrativa UX — Wizard "Pausar / despausar issues parciales" (#3741)

> Guion de presentación (~3:30) + decisiones de diseño + reglas de interacción +
> mapping de iconografía + accesibilidad WCAG. Material entregable de la fase
> `definicion/criterios` para el agente `pipeline-dev` que va a implementar el
> handler en `dashboard.js` y el módulo de sesión `lib/wizard-pausa-session.js`.

---

## 1. Contexto narrativo

La pausa parcial del pipeline es la operación más sensible del Pulpo: con
un solo `setPartialPause(...)` Leo puede frenar el avance de cualquier issue
fuera de la allowlist activa. Hasta hoy esa decisión se ejecuta por chat de
Telegram o por CLI — sin preview, sin doble confirmación visual, sin un
camino que muestre las dependencias resueltas recursivamente antes de
aplicar.

El **wizard de pausa parcial** formaliza el flujo destructivo poniendo
3 pantallas obligatorias entre la intención y la mutación:

- **Paso 1** decide la acción (pausar / despausar) y el scope (un issue,
  una lista completa, o pausa total). Crea una sesión firmada HMAC con
  TTL de 15 minutos heredado de la base de wizards (#3724).
- **Paso 2** muestra el preview con dependencias recursivas resueltas vía
  `lib/partial-pause-deps.resolveOpenDeps()` (cache TTL 5min, MAX_DEPTH=3),
  emite un `confirm_token` de un solo uso y guarda un snapshot de
  `getPipelineMode()` para el drift-check del paso 3.
- **Paso 3** re-lee el estado fresh, compara contra el snapshot y, si
  difiere, aborta con `409 DRIFT`. Si coincide, exige doble confirmación
  UI (un checkbox + un botón distintivo) y recién entonces invoca
  `setPartialPause / clearPartialPause` con `authorizedBy` derivado
  server-side de `req.session.user`.

Toda mutación queda registrada en `.pipeline/audit/partial-pause-mutations.jsonl`
con el campo `via: 'wizard-pausa'`, sumado al hash-chain ya existente.

---

## 2. Guion de presentación (~3:30)

> Lectura sugerida en TTS Lili (voz `es-AR-ElenaNeural`, rate 0, pitch +10Hz).
> Cada bloque se mapea a una sección del mockup `35-wizard-pausa-v3.svg`.

### Bloque A — Entrada al wizard (0:00 – 0:25)

Estás mirando el wizard de pausa parcial del dashboard. Es la operación
más sensible del Pulpo: con un solo botón frenás o reanudás el avance del
pipeline. Por eso el flujo es deliberadamente lento — tres pasos, una
sesión firmada con timeout de quince minutos, y un token CSRF visible
arriba a la derecha. Si dejás la pantalla abierta más de quince minutos
sin moverte, la sesión expira y el server pide reiniciar el flujo.

### Bloque B — Paso 1: acción + scope (0:25 – 1:10)

El paso uno te pide dos decisiones simples. Primero la acción: **pausar**
del lado izquierdo, en rojo apagado, es la que está seleccionada. La
opción **despausar**, del lado derecho, tiene una pill chiquita que dice
DESTRUCTIVA — eso es lo que activa la doble confirmación en el paso tres.

Abajo elegís el scope. Tres opciones, mutuamente excluyentes: **issue
específico** para sumar uno solo a la allowlist, **allowlist completa**
para reemplazar el set completo, y **pausa total** que crea el marker
`.paused` y frena todo el pipeline. La segunda está seleccionada en este
mockup; el textarea muestra siete issues separados por coma, y la
leyenda al pie te recuerda que `allowed_skills` se va a preservar — la
memoria `feedback_partial-pause-empty-not-block` queda blindada por
diseño.

Abajo a la izquierda ves siempre el botón Cancelar, en cualquiera de los
tres pasos. Al lado, en gris, una pill con el `wizard_session_id`
firmado HMAC que se acaba de crear. A la derecha, el botón azul
**Siguiente** que te lleva al paso dos.

### Bloque C — Paso 2: preview con dependencias resueltas (1:10 – 2:20)

El paso dos es la pantalla más densa del wizard, y eso es deliberado.
La idea es que **veas el impacto antes de aplicarlo**. En el header, a
la derecha, una pill teal te informa el estado resultante calculado
server-side: en este ejemplo `partial_pause`, con siete issues más los
skills que sobreviven.

Debajo está la tabla. Cuatro filas directas — los issues que escribiste
en el paso uno — más tres filas que aparecieron por dependencia
recursiva (icono de grafo en morado a la izquierda del número). La
resolución de dependencias **no se reimplementa**: viene de
`lib/partial-pause-deps.resolveOpenDeps()`, con cache de cinco minutos y
profundidad máxima tres, exactamente como ya existe en el código.

Una fila de esa tabla muestra algo importante. El issue dos mil
novecientos uno tiene un título malicioso, con un script tag adentro.
Mirá cómo se renderiza: las comillas angulares aparecen como entidades
HTML escapadas, y al lado una pill teal con un escudo y la leyenda
**XSS escapeHtml() OK**. Eso es el contrato de seguridad cubierto por
`lib/escape-html.js` (#3722) — sin ese helper, el wizard no se merge,
y por eso este issue depende de #3722 cerrado en main.

Abajo del listado, dos paneles iguales. El izquierdo muestra el
`confirm_token` que se acaba de emitir — un UUID v4 firmado, de un
solo uso. Si en el paso tres alguien hace doble click muy rápido y
manda dos POST con el mismo token, el segundo va a devolver
`409 TOKEN_REUSED`. El derecho muestra el snapshot del estado actual:
el `mode` que se está leyendo en este momento, el `allowed_issues`
propuesto y el `allowed_skills` preservado. Ese snapshot es lo que el
paso tres va a comparar contra el estado fresh antes de aplicar.

### Bloque D — Paso 3: doble confirmación + audit (2:20 – 3:05)

El paso tres es la última oportunidad de frenar. Arriba el banner
verde te dice **Drift-check OK**: el estado fresh leído ahora coincide
con el snapshot del paso dos. Si no coincidiera — porque otro operador
mutó la allowlist por Telegram entre medio —, el banner sería rojo,
la acción quedaría bloqueada, y la UI te llevaría de vuelta al paso uno
con el estado actualizado. Eso lo ves abajo de todo, en el recuadro de
borde rojo punteado: la variante 409 DRIFT documentada como guideline.

La doble confirmación son dos checkboxes obligatorios. El primero te
hace declarar explícitamente que entendés qué va a pasar — "esto reanuda
el pipeline para los siete issues listados, en partial_pause mode". El
segundo te pide una **justificación textual** que va a quedar
literalmente en el audit log. Ambos arrancan deshabilitados y solo
cuando los dos están marcados se habilita el botón rojo de aplicar.
Para la acción **pausar**, el botón es rojo apagado. Para **despausar**,
sería un rojo más saturado, porque es la dirección destructiva.

Abajo del bloque de confirmación está el preview del audit log. Es el
JSON exacto que va a quedar en `partial-pause-mutations.jsonl`, con
hash-chained vía `lib/audit-log.appendChained`. Mirá los campos: `actor`
es `commander:leo`, derivado server-side de la sesión autenticada —
nunca del body, eso es la diferencia entre seguridad y teatro de
seguridad. El `authorized_by` viene del enum cerrado en
`partial-pause-audit.js:60`. Y el `via: wizard-pausa` permite filtrar
todas las mutaciones que vinieron por esta vía con un solo `jq`.

### Bloque E — Cierre y guidelines (3:05 – 3:30)

Tres pantallas, una sesión firmada, un token de un solo uso, un
drift-check, doble confirmación, audit log con hash chain. Cada
elemento del diseño tiene una contraparte verificable empíricamente en
los criterios de aceptación del PO — los veinte CA del comentario del
issue. Cuando el agente `pipeline-dev` agarre este issue, los tres
mockups y este guion son la única referencia visual que necesita; el
resto está cubierto por la receta técnica del arquitecto y los módulos
ya existentes.

---

## 3. Sistema visual y tokens

| Elemento                          | Token / decisión                                       |
|-----------------------------------|--------------------------------------------------------|
| Fondo body                        | `--surface-0` (#0D1117)                                |
| Panel del wizard                  | gradient `surface-2 → surface-1` (interno al mockup)   |
| Stepper inactivo                  | `--surface-1`, borde `--border` (#30363D)              |
| Stepper activo (línea)            | gradient `--brand-cyan → --brand-blue`                 |
| Acción "pausar" seleccionada      | fondo `--danger-bg`, borde `--danger`                  |
| Acción "despausar"                | indicador `--success`, pill DESTRUCTIVA en `--danger`  |
| Scope seleccionado                | borde `--info` (`#1890FF`), fondo translúcido          |
| Pill CSRF                         | `--teal-bg`, texto `--teal`                            |
| Pill timeout                      | `--surface-2`, texto `--text-secondary`                |
| Pill estado resultante (paso 2)   | `--teal-bg`, borde `--teal-dim`                        |
| `confirm_token` UUID              | fondo `--surface-1`, borde `--teal-dim`, mono font     |
| Drift-check OK                    | `--success-bg`, borde `--success-dim`                  |
| Drift-check FAIL (footer)         | `--danger-bg`, borde `--danger-dim`, dasharray 6 4      |
| Audit log preview                 | `--surface-0`, texto `--text-secondary`, mono font     |
| Botón aplicar pausa               | fondo `--danger`, texto `--surface-0`                  |
| Botón secundario / cancelar       | transparente, borde `--border`                         |

Iconografía: el mockup inlinea un subset del sprite por portabilidad
standalone. En producción, **el dashboard tiene que usar
`<use href="sprite.svg#ic-...">`** — alineado con la convención
establecida por el resto de las ventanas V3 y por el contrato G-UX
heredado del épico #3715.

---

## 4. Reglas inquebrantables de interacción

1. **Tres pasos, en orden, no se saltean**. El server valida que el
   `wizard_session_id` haya pasado por paso 1 antes de aceptar paso 2.
   Saltar al paso 3 sin haber visto el preview del paso 2 = `409`.
2. **`confirm_token` de un solo uso**. Replay = `409 TOKEN_REUSED`.
3. **Drift-check obligatorio en paso 3**. El server re-lee
   `getPipelineMode()` fresh y compara contra el snapshot del paso 2.
   Si difiere = `409 DRIFT`, UI muestra el banner rojo del footer del
   mockup, ofrece reiniciar el wizard con el estado actualizado.
4. **Doble confirmación UI cuando la acción es despausa**. Para la
   acción "pausar", un checkbox + botón es suficiente (es menos
   destructivo). Para "despausar", **dos checkboxes** + botón rojo
   saturado, con justificación textual obligatoria.
5. **`authorizedBy` server-side, nunca del body**. El test
   `CA-8` verifica que un body con `authorizedBy: 'commander:fake'`
   queda igual en el log con `actor: 'commander:<sesión-real>'`.
6. **Mutación exclusiva vía `setPartialPause` / `clearPartialPause`**.
   El handler del paso 3 **no escribe directo** a `.partial-pause.json`
   ni a `.paused`. Va siempre por el gate #3625.
7. **`escapeHtml()` obligatorio para todo título de issue en el preview**.
   Sin excepción. Sin él, el wizard no se merge. La row del mockup que
   muestra `&lt;script&gt;alert(1)&lt;/script&gt;` documenta visualmente
   este contrato.
8. **Audit log con campo `via: 'wizard-pausa'`**. Se logra extendiendo
   `setPartialPause/clearPartialPause` para que acepten `opts.via` y lo
   pasen como `extra` a `appendMutation` (opción A de la receta
   técnica). Nunca invocar `appendMutation` directo desde el handler
   (rompería el orden "audit antes que write").
9. **Cancelar siempre disponible**. En los tres pasos. Invalida la
   sesión y el `confirm_token`. Reintentar con esos tokens = `410`.
10. **`allowed_skills` preservado**. Si el wizard no toca skills, pasa
    `opts.allowedSkills` con el valor actual leído de `getPipelineMode()`
    para que `setPartialPause` no normalice a `[]`.

---

## 5. Microcopy obligatorio (ES-AR)

| Contexto                                  | Texto                                                                   |
|-------------------------------------------|-------------------------------------------------------------------------|
| Título paso 1                             | "Paso 1 · ¿Qué necesitás hacer?"                                        |
| Subtítulo paso 1                          | "Decidí la acción y el alcance. Después vas a ver el impacto antes de aplicar." |
| Pill destructiva                          | "DESTRUCTIVA"                                                           |
| Título paso 2                             | "Paso 2 · ¿Qué va a pasar?"                                             |
| Subtítulo paso 2                          | "Estos issues quedarán habilitados. Las dependencias se resolvieron recursivamente." |
| Pill estado resultante                    | "partial_pause · N issues + skills:[...]"                               |
| Pill drift OK                             | "Drift-check OK"                                                        |
| Pill drift FAIL                           | "Estado cambió, reiniciá el wizard"                                     |
| Checkbox 1 (entender impacto)             | "Entiendo que esto reanuda el pipeline para los N issues listados, en partial_pause mode." |
| Checkbox 2 (justificación)                | "Justificación (queda en audit log):" + textarea                        |
| Botón aplicar — pausar                    | "Aplicar pausa"                                                         |
| Botón aplicar — despausar                 | "Confirmar despausa"                                                    |
| Banner timeout                            | "Sesión expira en MM:SS"                                                |
| Banner sesión expirada (410)              | "La sesión del wizard expiró. Reiniciá el flujo."                       |
| Banner token reusado (409 TOKEN_REUSED)   | "Este wizard ya se aplicó. Si necesitás repetirlo, abrí uno nuevo."     |
| Banner gate rechazado                     | "El gate de #3625 rechazó la mutación: <motivo>"                        |

---

## 6. Accesibilidad — checklist WCAG AA (10 puntos del épico #3715)

- [x] **Contraste**: todos los textos sobre fondos verificados ≥ 4.5:1
      normal, ≥ 3:1 grande. Combinaciones críticas:
      `--text-primary` sobre `--surface-0` = 14.8:1 (AAA),
      `--text-secondary` sobre `--surface-1` = 9.0:1 (AAA),
      `danger-fg` sobre `danger-bg` ≈ 10.5:1 (AAA).
- [x] **Focus visible**: cada elemento interactivo (radios, checkbox,
      botones, links) recibe ring de `--brand-blue` 2px en hover/focus.
- [x] **Touch targets**: 44×44 px mínimo para botones, 48 dp en mobile.
      Los radios y checkboxes del mockup están en 40×40 px de área
      hot-zone (la caja gráfica es 18×18 pero el `<label>` extiende el
      target a toda la fila).
- [x] **aria-labels**: stepper anuncia "Paso 2 de 3, completado el paso 1";
      botones tienen `aria-label` con la acción ("Aplicar pausa parcial");
      icono-only buttons (cancelar, atrás) tienen `aria-label`.
- [x] **Navegación por teclado**: Tab recorre stepper → opciones de acción
      → opciones de scope → cancelar → siguiente. Enter activa botón
      primario. Escape dispara Cancelar.
- [x] **prefers-reduced-motion**: si está activo, el animation del stepper
      (línea que se va llenando) se reemplaza por un cambio de estado
      instantáneo. La pill timeout sigue actualizándose en tiempo real
      pero sin transición.
- [x] **Información no solo por color**: cada estado lleva texto + icono.
      "Drift OK" tiene tilde + texto; "DESTRUCTIVA" tiene pill rojo +
      texto. Nunca depende solo del color.
- [x] **Lectura lineal**: el orden DOM coincide con el orden visual
      (header → stepper → contenido del paso → footer). Sin posicionado
      absoluto que rompa la lectura por screen reader.
- [x] **Tipografía**: escala Material 3 — titleLarge 20, titleMedium 16,
      bodyMedium 14, labelMedium 12, code 12. Sin `font-size`
      arbitrarios.
- [x] **Errores comunicados**: 410, 409 DRIFT, 409 TOKEN_REUSED y
      403 CSRF tienen banner explícito con icono + título + texto +
      acción de recuperación. Nunca un toast efímero solo.

---

## 7. Estado del trabajo de UX para este issue

- **Entregables**:
  - `35-wizard-pausa-v3.svg` (este mockup, 1440×2240, vectorial).
  - `narrativa-wizard-pausa.md` (este archivo, ~3:30 TTS).
- **Pendientes para `dev` / `aprobacion`**:
  - Generar `narrativa-wizard-pausa.mp3` con `edge-tts` y voz
    `es-AR-ElenaNeural` (pitch +10Hz, rate 0). El comando exacto está
    en el README de mockups.
  - Convertir SVG a PNG con `rsvg-convert` para adjuntar al PR de
    desarrollo (CA-19).
  - Video integrado mockup + narración para QA (`logs/media/qa-3741.mp4`).
    Por scope `area:dashboard` sin `app:*`, este issue clasifica como
    infra del pipeline; QA puede ir por path structural si así lo
    decide el agente `qa` en `aprobacion` (CLAUDE.md PASO 0.A).
- **Boundary respetado**: no escribí código Node.js, no aboré el
  `lib/wizard-pausa-session.js` (eso es del dev), no validé empíricamente
  el handler de paso 3 (eso es del tester + QA structural + UX en
  PASO 2-bis de `aprobacion`).
