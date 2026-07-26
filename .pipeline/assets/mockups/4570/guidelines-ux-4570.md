# Guidelines UX — Épico #4570 · Gates de firma del operador

> Entregable del agente `ux` en `definicion/criterios`.
> Fija el sistema visual y los criterios UX **verificables** que deben heredar los hijos
> del épico con superficie de operador. Los hijos no diseñan: **ensamblan lo definido acá**.

## 1. Alcance UX

El épico tiene 13 hijos. Estos son los que tocan una superficie que el operador ve:

| Hijo (§8) | Superficie | Assets que consume |
|---|---|---|
| §8.2 GATE 0 · veredicto honesto | badges de estado + reconciliación de labels | `mockup-04`, iconos `ic-gate-0`, `ic-human-only`, `ic-machine-verified` |
| §8.3 Evidencia (puerto `e2e`) | visor de evidencia + metadata de representatividad | `mockup-02` (columna izquierda), `ic-evidence` |
| §8.4 GATE 1 · firma de definición | panel de firma (variante definición) | `mockup-02`, `ic-gate-1`, `ic-gate-sign` |
| §8.5 GATE 2 · firma de aceptación | panel de firma (variante aceptación) | `mockup-02`, `ic-gate-2` |
| §8.6 Índice de confiabilidad | bloque de confianza descompuesta | `mockup-02` (bloque inferior) |
| §8.7 GATE 3 · acciones autónomas | tarjeta de confirmación del kernel | `mockup-01` (tarjeta 4), `ic-gate-3` |
| §8.9 Telegram de un toque | tarjeta de chat + botones inline | `mockup-03` |
| §8.10 Bandeja "Esperando tu firma" | bandeja del dashboard | `mockup-01`, `ic-waiting-operator` |
| §8.13 Métrica de espera + ETA | barra apilada + dos ETAs | `mockup-01` (panel lateral), `mockup-04` |

Los hijos §8.1 (contrato), §8.8 (coherencia de ola), §8.11 (delegación) y §8.12 (doc) **no requieren
assets nuevos**; §8.8 y §8.11 reusan los badges y la bandeja ya definidos.

## 2. Principio rector

> **La firma tiene que ser barata de dar y cara de fingir.**

Todo el diseño se ordena detrás de eso:

1. **Colapsar lo verde.** Lo que la máquina verificó ocupa una fila plegada. La pantalla es
   para lo que la máquina no puede juzgar (§4.1 del diseño).
2. **Sin ✅ global.** Aprobar nace deshabilitado y se habilita sólo con cada criterio
   solo-humano resuelto individualmente. Nunca "aprobar todo" ni selección múltiple.
3. **Fail-closed visible.** El vencimiento del plazo produce *más* ruido (escalado
   `needs-human`, tope de la bandeja), nunca *menos* bloqueo. Ninguna pantalla puede
   sugerir que esperar termina aprobando.
4. **Esperar-humano no es error ni progreso.** Tiene su propio color (violeta `#7C5CFF`),
   distinto de rojo (fallo) y verde (avance).
5. **Una sola verdad multicanal.** Web y Telegram muestran la misma solicitud, el mismo
   conjunto pendiente y la misma autoridad. La UI y el callback **no son autoridad**: la
   decisión se resuelve server-side.
6. **Confianza descompuesta.** Prohibido un score global tipo "ACEPTAR 82%": ancla al
   operador y reintroduce el sello automático que el épico existe para evitar.

## 3. Sistema visual

### 3.1 Tokens nuevos — **ya commiteados** en `.pipeline/assets/design-tokens.css`

El bloque `GATES DE FIRMA DEL OPERADOR (epico #4570)` ya está al final del archivo: los hijos
**consumen** `var(--gate-*)` / `var(--waiting-operator*)`, no los redefinen ni los duplican.

```css
/* --- Gates de firma del operador (#4570) --- */
--gate-0:                #D29922;   /* veredicto honesto  */
--gate-0-bg:             rgba(210, 153, 34, 0.14);
--gate-0-fg:             #FFE099;
--gate-1:                #58A6FF;   /* firma de definición */
--gate-1-bg:             rgba(88, 166, 255, 0.14);
--gate-1-fg:             #CBE0FF;
--gate-2:                #00D6FF;   /* firma de aceptación */
--gate-2-bg:             rgba(0, 214, 255, 0.14);
--gate-2-fg:             #A8ECFF;
--gate-3:                #BC8CFF;   /* gobernanza del kernel */
--gate-3-bg:             rgba(188, 140, 255, 0.14);
--gate-3-fg:             #D9BBFF;

/* Espera humana — NO es error ni progreso */
--waiting-operator:      #7C5CFF;
--waiting-operator-bg:   rgba(124, 92, 255, 0.16);
--waiting-operator-fg:   #C5B7FF;

/* Clasificación de criterios */
--machine-verified:      var(--success);
--machine-verified-bg:   var(--success-bg);
--machine-verified-fg:   #B8F0C0;
--human-only:            var(--warning);
--human-only-bg:         var(--warning-bg);
--human-only-fg:         #FFE099;   /* --warning-fg no existe en el sistema */

/* Evidencia no representativa (stale / viewport / cacheada) */
--evidence-stale:        #D29922;
--evidence-stale-bg:     rgba(210, 153, 34, 0.10);
```

`--waiting-operator` reusa deliberadamente la familia de `--rest-mode` (`#7C5CFF`): ambas son
"el sistema está detenido por decisión, no por fallo". Se mantienen como tokens separados
porque su semántica y su ciclo de vida son distintos.

### 3.2 Iconografía

11 símbolos nuevos, **ya mergeados** en `.pipeline/assets/icons/sprite.svg` (sección `GATES DE
FIRMA DEL OPERADOR`) y disponibles vía `<use href="#ic-…"/>`; `iconos-gates-4570.svg` queda como
hoja de referencia de diseño con los aria-label sugeridos
(`ic-gate-sign`, `ic-gate-0`, `ic-gate-1`, `ic-gate-2`, `ic-gate-3`, `ic-waiting-operator`,
`ic-human-only`, `ic-machine-verified`, `ic-evidence`, `ic-audit-log`, `ic-nonce-expired`).
Convención heredada del sprite: `viewBox` 24×24, `stroke="currentColor"`, `stroke-width="1.75"`,
outline, sin texto interno, legibles a 16px.

**Prohibido usar emojis del sistema operativo como iconografía de gate** en dashboard, PDF de
reportes o mensajes con formato. En Telegram los glifos ✅/❌ se admiten sólo como *label* de
botón inline (limitación de la plataforma), nunca como estado en la UI web.

### 3.3 Contraste verificado (medido, no declarado)

Ratios calculados sobre el chip real (color semántico al 14–16% compuesto sobre `--surface-1`
`#161B22`), fórmula WCAG 2.1 relative luminance:

| Par | Ratio | Veredicto |
|---|---|---|
| `#E6EDF3` texto primario / surface-1 | 14.64 | AA / AAA |
| `#B1BAC4` texto secundario / surface-1 | 8.81 | AA / AAA |
| `#8B949E` texto dim / surface-1 | 5.62 | AA |
| `#FFE099` human-only / chip warning | 10.74 | AA / AAA |
| `#B8F0C0` machine-verified / chip success | 10.70 | AA / AAA |
| `#C5B7FF` waiting-operator / chip violeta | 8.09 | AA / AAA |
| `#FFB4B0` danger / chip danger | 8.70 | AA / AAA |
| `#D9BBFF` gate-3 / chip purple | 8.15 | AA / AAA |
| `#A8ECFF` gate-2 / chip cyan | 9.98 | AA / AAA |
| `#CBE0FF` gate-1 / chip info | 10.26 | AA / AAA |
| `#04222B` sobre CTA `#00D6FF` | 9.51 | AA / AAA |
| `#1B0F33` sobre CTA `#BC8CFF` | 7.17 | AA / AAA |

**Dos reglas derivadas de la medición (obligatorias):**

1. `--waiting-operator` (`#7C5CFF`) **NO se usa como color de texto** sobre superficies oscuras:
   sobre `--surface-1` da **3.98** (no llega a AA). Se usa como borde, relleno de chip y barra;
   el texto va siempre en `--waiting-operator-fg` (`#C5B7FF`, 8.09).
2. `#6E7681` (`--text-disabled`) da **3.77** sobre `--surface-1`: **no se usa para texto de UI real**,
   ni siquiera en controles deshabilitados. El label de un control deshabilitado va en `#8B949E`
   (5.62) — el estado deshabilitado se comunica por el fondo, el borde y el texto de motivo, no
   por bajar el contraste hasta lo ilegible. `#6E7681` queda reservado para anotaciones de los
   propios mockups.

### 3.4 Tipografía y densidad

Se hereda la escala del dashboard V3: título de panel 14–16px/700, cuerpo 11.5–12px,
metadatos 10–11px `#8B949E`. La tarjeta de la bandeja tiene alto fijo (132–152px) para que
el escaneo vertical sea predecible con 8+ pendientes.

## 4. Criterios de aceptación UX

Cada hijo hereda los que le apliquen. Formato del épico: `machine-verifiable` | `human-only`.

### Bandeja (§8.10)

| ID | Criterio | Clase | Verificación |
|---|---|---|---|
| CA-UX-1 | La bandeja es la fuente única de pendientes de firma en web y su contenido coincide exactamente con lo que Telegram lista | machine-verifiable | comparar respuesta del endpoint autoritativo con el set enviado a Telegram |
| CA-UX-2 | Cada tarjeta expone gate, producto (`projectId`), issue, PR/SHA, digest de evidencia, edad de espera y reparto máquina/humano **sin abrir el detalle** | machine-verifiable | `grep`/DOM assert sobre el render de la tarjeta |
| CA-UX-3 | Ninguna acción de la bandeja aprueba sin abrir la evidencia; no existe "aprobar todo" ni selección múltiple de firma | machine-verifiable | ausencia de handler de aprobación en la vista lista |
| CA-UX-4 | Todo control accionable tiene área táctil ≥44×44px y foco visible de 2px | machine-verifiable | medición en DOM / snapshot de estilos |
| CA-UX-5 | El estado de espera se pinta con `--waiting-operator`, distinto de error y de progreso; el escalado por timeout agrega `needs-human` y sube la tarjeta al tope | machine-verifiable | assert de clases/tokens + orden de la lista |
| CA-UX-6 | El estado vacío es positivo ("nada espera tu firma" + última firma), no un error ni una lista en blanco | human-only | inspección visual contra `mockup-01` |
| CA-UX-7 | Cero colores hardcoded: todo sale de `design-tokens.css` | machine-verifiable | `grep -E '#[0-9a-fA-F]{6}'` sobre el código del widget = 0 |

### Panel de firma (§8.4 / §8.5 / §8.6)

| ID | Criterio | Clase | Verificación |
|---|---|---|---|
| CA-UX-8 | Aprobar está deshabilitado (visible, con motivo en texto) mientras exista un criterio `human-only` sin resolver; la habilitación se valida server-side | machine-verifiable | test de la evaluación del gate + assert de DOM |
| CA-UX-9 | Los criterios `machine-verifiable` se muestran colapsados en ≤1 fila; los `human-only` se muestran expandidos con un control propio cada uno (cumple / no cumple / no puedo evaluar) | machine-verifiable | assert de estructura |
| CA-UX-10 | "No puedo evaluar" retiene el issue y solicita mejor evidencia; no aprueba ni rechaza | machine-verifiable | test de transición de estado |
| CA-UX-11 | El panel muestra `criteriaHash`, PR, SHA, `evidenceDigest` y vencimiento del nonce antes de cualquier acción | machine-verifiable | assert de DOM |
| CA-UX-12 | La confianza se presenta por criterio; los `human-only` se declaran explícitamente no evaluables. **Prohibido un score global** | machine-verifiable | ausencia de score agregado en el payload de UI |
| CA-UX-13 | Rechazar exige elegir destino (desarrollo \| redefinición) y motivo escrito | machine-verifiable | test de validación del formulario |
| CA-UX-14 | La evidencia se autodescribe (SHA de origen, viewport, antigüedad, caché) y su invalidez deshabilita la firma en vez de permitir firmar en frío | machine-verifiable | test del puerto `e2e` + assert de UI |
| CA-UX-15 | Con la evidencia servida, un operador puede decidir el match visual vs mockup sin abrir el repo | human-only | firma real del operador sobre un caso |

### Telegram (§8.9)

| ID | Criterio | Clase | Verificación |
|---|---|---|---|
| CA-UX-16 | La tarjeta muestra gate, issue, producto, PR/SHA, reparto máquina/humano y vencimiento antes de los botones | machine-verifiable | snapshot del mensaje generado |
| CA-UX-17 | Firmar en un canal actualiza el otro: nunca dos verdades simultáneas | machine-verifiable | test de idempotencia multicanal |
| CA-UX-18 | Solicitud invalidada (SHA cambiado / nonce usado / expirada) muestra el motivo y deja los botones deshabilitados, no desaparecidos | machine-verifiable | snapshot por estado |
| CA-UX-19 | El mensaje de timeout dice explícitamente que **no** se aprobó y que el issue sigue bloqueado | machine-verifiable | assert de copy |

### Estados y métrica (§8.2 / §8.13)

| ID | Criterio | Clase | Verificación |
|---|---|---|---|
| CA-UX-20 | `waiting-operator-def`, `waiting-operator-acc`, `requires-operator`, `needs-human` y "confirmación GATE 3" tienen badge propio con color + ícono + texto (el color nunca es el único portador de significado) | machine-verifiable | assert de render de badges |
| CA-UX-21 | La tarjeta de issue distingue visualmente tres cosas distintas: ejecutando, esperando humano, fallado | human-only | inspección visual contra `mockup-04` |
| CA-UX-22 | El ETA se muestra descompuesto (agente / cola / espera-de-operador) y con dos totales: pipeline-bound y con latencia de firma | machine-verifiable | assert de datos del widget |
| CA-UX-23 | Contraste ≥4.5:1 en todo texto de estos componentes | machine-verifiable | cálculo de contraste sobre los pares token-fg / token-bg |

## 5. Antipatrones (rechazo automático en `aprobacion`)

- ✕ Botón "aprobar todo", firma masiva o selección múltiple con veredicto.
- ✕ Score global de confianza ("ACEPTAR 82%").
- ✕ Ocultar controles en vez de deshabilitarlos con motivo visible.
- ✕ Pintar la espera humana de rojo (error) o verde (progreso).
- ✕ Copy que sugiera que el vencimiento aprueba, o que la firma es un trámite.
- ✕ Emojis del SO como iconografía de gate en la UI web / PDF.
- ✕ Colores hardcoded fuera de `design-tokens.css`.
- ✕ Contador de pendientes que no coincide entre web y Telegram.

## 6. Cómo se verifica esto en `desarrollo/aprobacion`

Los hijos de este épico son `area:pipeline` sin `app:*`: por política de `CLAUDE.md` no exigen
video de QA de producto. La evaluación UX se hace por **assets + mockups + código** (PASO 2-bis
del rol `ux`):

1. Los assets de `.pipeline/assets/mockups/4570/` siguen en HEAD y son la referencia de comparación.
2. El render real del widget se compara contra el mockup correspondiente (memoria
   `feedback_visual-qa-for-mockup-issues`: con mockup acordado, el QA estructural **no alcanza**;
   hace falta comparación visual render vs mockup).
3. Se verifica consumo de tokens (`var(--gate-*)`, `var(--waiting-operator*)`) y del sprite
   (`href="#ic-gate-*"`) en el código tocado, y ausencia de hex hardcoded.
4. Se verifican los CA-UX `machine-verifiable` con asserts; los `human-only` quedan, por
   construcción, para la firma del operador — que es justamente lo que este épico introduce.

---

*Producido por el agente `ux` durante `definicion/criterios` del issue #4570.*
