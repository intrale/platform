# Narrativa UX — Multi-Provider Dashboard (#3177)

> Guion de presentacion (~3:30) + decisiones de diseno + reglas de interaccion +
> mapping de iconografia + accesibilidad WCAG. Material entregable de la fase
> `definicion/criterios` para el agente de desarrollo (`pipeline-dev`).

---

## 1. Contexto narrativo

Hasta hoy, configurar el pipeline multi-provider (rotar API keys, cambiar el
default de un agente, agregar fallbacks, conceder overrides al fail-CLOSED)
exige editar `agent-models.json` a mano, exportar env vars y reiniciar el
pulpo. Operativo, pero hostil: hay que conocer la estructura del JSON, y
cualquier typo lo descubris cuando el boot del pulpo crashea con un error
de schema.

El nuevo tab **Multi-Provider** centraliza todo eso en una UI grafica que
respeta la postura de seguridad del pipeline (fail-CLOSED, audit trail
inmutable, capabilities server-side). El usuario objetivo es Leo y el equipo
operativo: gente que sabe lo que hace y que necesita herramientas rapidas
para reaccionar en incidente, no formularios de wizard para principiantes.

---

## 2. Guion de presentacion (~3:30)

> Lectura sugerida en TTS Lili (voz default del pipeline) o equivalente.
> Cada parrafo se mapea a una seccion del mockup 11/12/13.

### Apertura (0:00–0:25)

"Bienvenidos al tab Multi-Provider del dashboard interno de Intrale.
Aca centralizamos toda la configuracion del pipeline cuando opera con
mas de un proveedor de IA: que proveedor es el default, que modelos
puede usar cada agente, en que orden caen los fallbacks si el principal
se queda sin cuota, y que excepciones temporales hay vigentes al modelo
de capabilities que protege a los skills criticos."

### Seccion 1 — Proveedores (0:25–1:10)

"El primer bloque lista los proveedores soportados. Hoy son tres:
Anthropic en cobre, OpenAI en esmeralda claro y OpenAI Codex en esmeralda
profundo. Cada card muestra el estado de
conexion en vivo: un anillo concentrico verde si el ping es valido, un
triangulo amarillo si la cuota esta baja, una cruz roja si la key no
sirve. La key se muestra siempre enmascarada con los primeros seis y los
ultimos cuatro caracteres; para revelarla hace falta un click explicito
en el ojo, y para copiarla hay que tocar el boton de copy. Nunca se
expone la key completa en el DOM."

"Anthropic tiene una particularidad: como Claude Code usa OAuth de la
suscripcion Max, la key no se edita desde la UI. El campo aparece en gris
con un tooltip explicativo, y el boton Rotar tambien queda deshabilitado.
Eso evita que un cambio accidental rompa la sesion OAuth en el child
process."

### Seccion 2 — Fallbacks globales (1:10–1:35)

"Debajo de las cards hay una fila con los fallbacks globales: el orden en
que el pipeline intenta otros proveedores si el default falla. Se
reordenan arrastrando los chips, con un handle de seis puntitos a la
izquierda. Para agregar un fallback nuevo, el chip punteado al final
abre un dropdown con los proveedores aun no incluidos."

### Seccion 3 — Grilla por agente (1:35–2:15)

"La grilla central es el corazon de la pagina. Una fila por cada skill
del pipeline, con el provider default, el modelo actual, los fallbacks
especificos del skill, y el estado de capabilities. Los skills no
degradables — security, review, builder, tester y backend-dev — tienen
una barra roja en el lateral izquierdo, el badge NON-DEGRADABLE en la
columna de permissions y el boton de override en gris al 40 por ciento
de opacidad. No se ocultan: queremos que el operador vea que existe la
proteccion, no que la descubra cuando intente romperla."

"Cuando un agente tiene un permission override vigente, su fila gana una
franja naranja a la izquierda, y al lado del nombre del skill aparece el
badge `override 18h` con el icono de escudo-reloj. El operador entiende
en una mirada que ese agente esta corriendo bajo excepcion y cuanto le
queda."

### Seccion 4 — Persistencia (2:15–2:35)

"Al pie de la pagina hay tres botones: Ver diff, Reload pipeline y
Guardar cambios. Ver diff abre un modal con la comparacion lado a lado
entre la config actual en disco y la propuesta. Aplicar pasa por un
segundo paso de confirmacion, dispara un backup automatico con timestamp
ISO en `audit/agent-models-backups/`, y libera el file lock cuando termina
de escribir."

### Seccion 5 — Permission Overrides (2:35–3:15)

"El tab interno Permission Overrides muestra los overrides activos con
TTL en vivo. El countdown se renderiza con un anillo temporal que se
animanormalmente, y cae a texto plano si el sistema operativo declara
prefers-reduced-motion. El formulario para crear un override tiene
dropdown de skill — excluyendo automaticamente los NON-DEGRADABLE —,
dropdown de provider, checkboxes de capabilities a omitir poblados desde
`CAPABILITY_MATRIX`, un slider de TTL entre una hora y siete dias con
default de veinticuatro horas, y un textarea de justificacion con minimo
treinta caracteres. La validacion es doble: client-side para feedback
inmediato y server-side para no dejar la decision en manos del cliente."

"Revocar un override es siempre una accion de dos pasos: hay que tipear
el par `skill:provider` para habilitar el boton. No se borra el entry
del JSONL — se agrega uno nuevo de tipo `permission_override_revocation`
con el hash de la entrada original como `target_hash`. El audit trail
queda intacto, y se puede reconstruir el estado en cualquier momento
recorriendo el log."

### Cierre (3:15–3:30)

"Todo el sistema visual reusa la paleta `--provider-*` y los sprites
`ic-provider-*` que ya entregamos en el issue 3086. Los mockups
acompanan en el path `.pipeline/assets/mockups/` con sufijos
`11-multi-provider-dashboard`, `12-permission-overrides-panel` y
`13-multi-provider-modals`."

---

## 3. Decisiones de diseno

### 3.1 Por que Node + HTML/JS y no Compose

El issue lo aclara explicitamente, y la memoria
`project_stack-kotlin-compose-unico.md` confirma la regla: Kotlin+Compose
es obligatorio para el **producto de usuario**. Este dashboard es
herramienta interna del equipo Intrale, ya vive en Node con HTML/JS,
y mezclar stacks nos dejaria una superficie inconsistente para mantener.
Decision: extender el stack actual.

### 3.2 Tab nuevo, no seccion dentro de un tab existente

El alcance funcional (proveedores + agentes + catalogo + overrides +
persistencia) no entra digno en un panel lateral. Tab dedicado da
escalabilidad para el catalogo de modelos (Seccion 4 del issue) sin
canibalizar el espacio del Board.

### 3.3 Sub-tabs internas para escalabilidad

Dentro del tab Multi-Provider hay cuatro sub-tabs: Proveedores · Por
agente · Catalogo de modelos · Permission Overrides. Mismo patron de
nav que el Board del dashboard, familiar para el operador.

### 3.4 Colores

- **Override activo · `--retry` (#F59E0B)**: ambar diferenciado de
  `--warning` (#D29922, stale generico) y `--danger` (#F85149, fallo
  duro). Comunica "atencion: excepcion temporal" sin gritar "error".
- **NON-DEGRADABLE · `--danger` (#F85149)**: rojo de "no toques". La
  barra lateral roja en la fila refuerza la limitacion sin esconder el
  boton (queremos visibilidad informativa, no sorpresa al click).
- **Tab activo · `--teal` (#2DD4BF)**: misma convencion que el badge V3
  del dashboard. Distingue el tab Multi-Provider de los otros sin
  introducir un color nuevo.
- **Boton primario "Guardar" · `--info-dim` (#1F6FEB)**: azul info para
  acciones constructivas; reserva `--danger` para revocar y `--retry`
  para rotar.

### 3.5 Confirmacion 2-step para acciones destructivas

Rotar key, revocar override, aplicar cambios → todas piden re-typear
el nombre del recurso afectado (estilo GitHub delete repo). El boton
confirm queda disabled hasta que el textfield matchee exacto. Esto
filtra el 99% de clicks accidentales sin agregar un wizard largo.

### 3.6 Diff visible antes de aplicar

CA-18 lo pide, pero ademas es buena practica: el operador ve
exactamente que va a cambiar. La librery sugerida es `fast-json-patch`
(transversal y sin dep de UI). El render es lado a lado, con + verde
y - rojo, monoespaciado en `var(--font-mono)`. Si hay > 30 lineas de
diff se hace virtual scroll.

### 3.7 TTL countdown como anillo + texto

El anillo temporal (`ic-ttl-countdown`) comunica "tiempo corriendo"
visualmente, pero siempre va acompanado del texto en monoespaciado
(ej. `18h 04m`) para satisfacer "informacion no solo por color" y
accesibilidad.

### 3.8 Hot-reload o boton explicito (CA-19)

La recomendacion #3188 plantea implementar hot-reload via `fs.watch`.
Si no esta lista, el dev debe entregar el boton "Reload pipeline"
con icono `ic-reset-default`. Cuando #3188 cierre, el boton sigue
existiendo (util para forzar reload manual) pero el comportamiento
"on-save" pasa a ser hot-reload automatico.

---

## 4. Mapping de iconografia

Iconos NUEVOS agregados al sprite (`.pipeline/assets/icons/sprite.svg`)
para este issue. Todos respetan la convencion: viewBox 24x24,
stroke 1.75, `currentColor`. Listado:

| Icono | Uso | Donde aparece |
|---|---|---|
| `ic-key` | Representa API key (secret material) | Junto al input enmascarado en card de provider |
| `ic-key-rotate` | Accion rotar key | Boton "Rotar" en card de provider y en modal A |
| `ic-eye-on` / `ic-eye-off` | Toggle de masking | Lado derecho del input de API key |
| `ic-conn-ok` | Estado live "valid · ping OK" | Card de provider, junto al texto de estado |
| `ic-conn-warn` | Estado live "cuota baja" | Card de provider en warning |
| `ic-conn-err` | Estado live "key invalida / ping fail" | Card de provider en danger |
| `ic-override-active` | Badge "override · 18h" | Fila con override en grilla + lista de overrides vigentes |
| `ic-revoke` | Accion revocar override | Boton "Revocar" en lista de overrides + Modal C |
| `ic-renew` | Accion renovar TTL | Boton "Renovar" en lista de overrides |
| `ic-drag-handle` | Drag-and-drop handle | Extremo izq de chips reordenables (fallbacks) |
| `ic-shield-lock` | Endpoint server-side enforced | Banner global + columna "Permissions" en grilla |
| `ic-diff` | Accion "ver diff antes de aplicar" | Boton "Ver diff" + columna "Editar" en grilla |
| `ic-fallback-chain` | Lista de fallbacks (concepto) | Header de seccion fallbacks (reservado) |
| `ic-ttl-countdown` | TTL en vivo (anillo temporal) | Lista de overrides vigentes |
| `ic-copy` | Copy-to-clipboard | Lado derecho del input de API key en modo "revelado" |
| `ic-test-ping` | Live-ping al provider | Boton "Probar" en card de provider (futuro) |
| `ic-reset-default` | Reset to default por agente | Columna "Acciones" en grilla |
| `ic-multi-provider` | Icono del tab "Multi-Provider" | Nav principal del dashboard + favicon |

Iconos REUSADOS del #3086:

| Icono | Uso |
|---|---|
| `ic-provider-anthropic` | Card Anthropic + columna Provider en grilla |
| `ic-provider-openai` | Card OpenAI + columna Provider |
| `ic-provider-openai-codex` | Card Codex + columna Provider |
| `ic-provider-deterministic` | Filas de skills determinist  (build, lint, delivery, tester) |
| `ic-provider-unknown` | Reservado para futuro (provider fuera de allowlist) |

---

## 5. Reglas de interaccion

### 5.1 Confirmacion 2-step

Aplicable a: rotar API key, revocar override, aplicar cambios (save).
Patron:

1. Click en boton accionador → abre modal.
2. Modal muestra contexto + impacto + textfield "tipea X para habilitar".
3. Boton confirm `disabled` hasta que `input.value === expectedValue` (case-sensitive).
4. ENTER confirma; ESC cierra sin commit.

### 5.2 Masking de keys (CA-29)

- Display: `<prefijo[6]>···············<sufijo[4]>` (siempre 6+4).
- GET `/api/multi-provider/config` devuelve solo metadata + masked.
- Toggle `ic-eye-off` → `ic-eye-on` revela en pantalla por max 10s, despues vuelve a masked automaticamente.
- Copy-to-clipboard: requiere click en `ic-copy`; usa `navigator.clipboard.writeText(realKey)` (la real esta en memoria efimera, no en el DOM).

### 5.3 Drag-and-drop de fallbacks (CA-8, CA-10)

- Handle `ic-drag-handle` a la izquierda del chip.
- HTML5 drag-and-drop nativo (no libs externas — minimizar superficie).
- Indicador visual de drop-zone durante el drag (chip target con borde brand-cyan).
- Reorder respeta `prefers-reduced-motion` (sin animacion de transicion si el usuario opto out).

### 5.4 TTL countdown en vivo

- Refresh cada 30s (intervalo, no polling al server — calculo client-side desde el `expires_at` del audit entry).
- Cambio de color cuando TTL < 1h → `--warning` (D29922).
- Cuando TTL < 5min → `--danger` (F85149) + glow sutil (respeta `prefers-reduced-motion`).
- Cuando expira: refresh full de la lista, el override pasa al historial con label `EXPIRED`.

### 5.5 Live-ping al provider (CA-4)

- Trigger: load inicial del tab + cada 30s + on-demand via boton `ic-test-ping`.
- Server-side: allowlist hardcoded de URLs por provider (#3189 / CA-34 OWASP A10).
- Timeout 5s; si falla → estado `not-configured` o `key-invalid` segun el error.
- Nunca devolver la key ni la URL en la respuesta JSON (CA-29).

---

## 6. Accesibilidad (WCAG AA)

### 6.1 Contraste

Todos los pares texto/fondo verificados con WebAIM Contrast Checker:

| Token | vs surface-0 (#0D1117) | WCAG |
|---|---|---|
| `--retry` (#F59E0B) | 8.9:1 | AA Normal + AAA Large |
| `--danger` (#F85149) | 5.6:1 | AA Normal |
| `--success` (#3FB950) | 7.3:1 | AA Normal + AAA Large |
| `--info` (#58A6FF) | 7.1:1 | AA Normal + AAA Large |
| `--teal` (#2DD4BF) | 10.4:1 | AAA |
| `--warning` (#D29922) | 7.0:1 | AA Normal |
| `--text-primary` (#E6EDF3) | 14.8:1 | AAA |
| `--text-secondary` (#B1BAC4) | 9.7:1 | AAA |

### 6.2 Touch targets

- Botones principales: min 36x36px.
- Iconos clickables (eye, copy, drag handle): min 32x32px de hit area (aunque el icono visual sea menor).
- Espacio entre clickables: min 8px.

### 6.3 Teclado

- Focus-ring visible (`var(--focus-ring)` — 2px brand-cyan).
- Tab order logico: header → tabs → sub-tabs → contenido (top-to-bottom, left-to-right).
- ESC cierra modal/dropdown abierto.
- Enter confirma en modales 2-step (cuando matchea).
- Arrow keys reordenan fallbacks como alternativa al drag-and-drop (UP/DOWN).

### 6.4 Lectores de pantalla

- Cada `<svg>` decorativo: `aria-hidden="true"`.
- Cada accion (boton): `aria-label` descriptivo (ej. "Rotar API key de OpenAI").
- TTL countdown: `aria-live="polite"` para que cambios anuncien sin interrumpir.
- Modales: `role="dialog"` + `aria-modal="true"` + focus trap.

### 6.5 prefers-reduced-motion

Si `@media (prefers-reduced-motion: reduce)` matchea:

- Anillo TTL deja de animarse; solo se actualiza el numero.
- Drag-and-drop sin transicion suave.
- Modales aparecen sin fade-in.

---

## 7. Mapping con criterios de aceptacion del PO

Cada mockup/asset cubre los siguientes CAs del comment del PO en el issue:

| Mockup | CAs cubiertos |
|---|---|
| `11-multi-provider-dashboard.svg` | CA-1 (tab accesible), CA-2 (paleta + sprites), CA-3..CA-8 (Seccion 1), CA-9..CA-13 (Seccion 2), CA-19 (boton Reload), CA-27 (banner server-side) |
| `12-permission-overrides-panel.svg` | CA-20 (panel + lista), CA-21 (formulario crear), CA-22 (audit-log entry), CA-25 (historial), CA-26 (notif Telegram) |
| `13-multi-provider-modals.svg` | CA-5 (modal rotar 2-step), CA-18 (modal diff), CA-23 (modal revocar 2-step), CA-29..CA-30 (masking + escape HTML) |
| Sprite agregado al `icons/sprite.svg` | Toda la iconografia necesaria para los CAs anteriores |

---

## 8. Tareas pendientes para el dev (`pipeline-dev`)

El UX dejo cerrados los siguientes items; el dev consume y no rehace:

- Paleta provider (heredada del #3086) en `design-tokens.css` §3.c.
- Iconografia provider + iconografia nueva del tab en `icons/sprite.svg`.
- 3 mockups SVG con layout, estados y modales (este path).
- Esta narrativa con guidelines, mapping de CAs y reglas de interaccion.

Lo que SI tiene que producir el dev:

- Backend: endpoints `/api/multi-provider/*` (config, ping, overrides) con
  validacion Ajv + audit-log + file lock + CSRF.
- Frontend: el tab HTML + JS vanilla coherente con el resto del dashboard
  (mismo patron que `dashboard.js` actual — no introducir framework).
- Tests: paridad con los CAs criticos (CA-27 bind, CA-31 NON_DEGRADABLE,
  CA-33 autor server-side).

Si durante el dev surge ambigüedad visual no cubierta por los mockups,
el dev puede pedir rebote cross-phase a `definicion/criterios/ux`. La
narrativa esta pensada como contrato del que se puede iterar, no como
prescripcion rigida.

---

## 9. Cambios futuros (post-aprobacion del issue)

Las siguientes ideas quedaron OUT del scope actual y se documentan aca
para futura referencia (no crear issues — guru ya genero #3188/#3189/
#3190 y security #3191/#3192):

- **Vista diff de overrides historicos**: que el operador pueda comparar
  dos overrides expirados lado a lado para entender drift.
- **Profile de "config saved"**: snapshots nombrados de la configuracion
  (ej. "config dev-only", "config qa-rush") con switch rapido.
- **Dark theme refinement**: este mockup asume el dark-only actual; si
  algun dia se agrega light theme, los tokens `--provider-*` necesitan
  variantes (todos calculados desde el HSL base).
- **Voz narrada del estado**: similar a `status-audio.md`, generar un
  audio TTS cuando el operador entra al tab que describa el estado
  actual ("3 proveedores activos, dos overrides vigentes, ux con
  override expirando en 18h").

---

> **Validez**: estos assets representan la intencion de UX al cierre de
> la fase de criterios. El dev tiene autoridad para ajustar detalles
> visuales menores durante la implementacion, pero NO para cambiar
> decisiones estructurales (paleta, jerarquia de modales, confirmacion
> 2-step, masking de keys) sin rebote a `definicion/criterios/ux`.
