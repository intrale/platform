# UX — #5113 · Estado operativo en almacenamiento externo

> Addendum de UX a los criterios del PO ([comentario de criterios](https://github.com/intrale/platform/issues/5113#issuecomment-5573893531)).
> **No reemplaza ni contradice** ninguno de los 23 CA ni las 5 decisiones D-1..D-5.
> Suma la dimensión que ese set no cubre: **qué ve el operador mientras el estado
> se muda de host**.

Mockup: [`60-estado-operativo-procedencia.svg`](60-estado-operativo-procedencia.svg)

## El hueco, verificado

Los CA del PO cierran el comportamiento (flag único, fail-closed, CAS, rollback).
La contracara de un buen fail-closed es un mal síntoma: **el pipeline frenado a
propósito se ve exactamente igual que el pipeline frenado por un bug.**

Verificado en `main @ 177ab2bf6`:

```
$ grep -niE "durable|operational_state|namespaced" .pipeline/dashboard.js
(0 líneas)
$ grep -niE "durable|kernelMode|operational_state|namespaced" .pipeline/lib/dashboard-slices.js
(0 líneas)
```

Hoy la procedencia del estado **no existe en la interfaz**. El propio
`docs/pipeline/runbook-cutover-durable.md` lo confirma: su sección "Cómo verificar
que estás parado donde creés" instruye `grep -n "durable:" .pipeline/config.yaml`.
Greppear un YAML es una respuesta válida para un ingeniero con una terminal
abierta; no lo es para el operador que mira el tablero a las 3 AM en medio de una
ventana de cutover con dos hosts vivos.

Segundo hallazgo, más duro — el enum de causas de no-despacho es **cerrado**:

```
$ sed -n '60,66p;235,237p' .pipeline/lib/dispatch-cause.js
    MODO_OLA: 'modo_ola',
    SIN_AGENTES: 'sin_agentes',
    ANOMALIA: 'anomalia_no_determinable',
...
    if (!CAUSAS_VALIDAS.has(obj.causa)) {
        throw new Error(`dispatch-cause: causa fuera del enum cerrado: ...`);
```

Ninguna de las 12 causas describe "el store del estado operativo no responde".
Con CA-A7 cumplido (gate deniega, prohibido degradar a FS), la cola queda ociosa y
el Pulpo cae al fallback `anomalia_no_determinable` → el operador lee
**"⚠ Anomalía: causa no determinable"** justo cuando la causa se conoce con
precisión. Es el peor mensaje posible en el peor momento.

## Criterios de UX propuestos

Verificables, acotados y sin ampliar el alcance funcional. Van al **Bloque C** y
son consistentes con D-3 (`.paused` fuera de alcance) y D-5 (el store no es API
de mutación).

- **CA-UX1 — Procedencia visible.** El header del dashboard muestra un chip con la
  procedencia del estado operativo, con los cuatro estados del mockup 60 y el mapeo
  cerrado de su sección 4. *Evidencia:* screenshot del header en cada uno de los
  cuatro estados, y un `grep` que muestre el slice leyendo el flag efectivo — no
  el valor del YAML, sino el que resolvió el runtime (son cosas distintas cuando
  hay override por env).
- **CA-UX2 — Causa propia, no anomalía.** Se agrega al enum de `dispatch-cause.js`
  una causa para la degradación del estado remoto, con label humano, ubicada en
  `PRECEDENCIA` **por encima de `MODO_OLA`** (si no, un fail-closed real se pinta
  como "modo de ejecución en olas", que es silencioso) y **dentro de
  `CAUSAS_ALERTABLES`**. *Evidencia:* test que simula el store caído y asserta la
  causa publicada; caso negativo que falla si la causa queda como
  `anomalia_no_determinable`.
- **CA-UX3 — Un solo canal para el mismo hecho.** La alerta de degradación reusa
  `kernel-degradation-alert.js` (template fijo, correlation id, rate-limit) en vez
  de inventar un mensaje nuevo. *Evidencia:* el mensaje del ensayo de CA-C5, y
  ausencia de un `sendTelegram` nuevo en el diff para este hecho.
- **CA-UX4 — El rollback se lee, no se estudia.** El runbook de CA-C8 abre con la
  secuencia mínima de rollback (los comandos exactos, sin prosa intercalada) en su
  primera pantalla. *Evidencia:* las primeras 40 líneas del runbook contienen el
  comando de apagado del flag y el de verificación posterior. Es el mismo patrón
  que ya usa `runbook-cutover-durable.md` ("empieza por cómo volver atrás porque
  eso es lo que hace falta cuando el cutover sale mal") — acá sólo se pide
  heredarlo y acotarlo a una pantalla.
- **CA-UX5 — El síntoma nombra la acción.** Todo mensaje de degradación del estado
  operativo (banner y Telegram) dice **qué está frenado**, **por qué** y **cuál es
  el próximo paso del operador**. Prohibido el mensaje que sólo describe el error
  técnico. *Evidencia:* copy revisado contra el mockup 60, sección 2.

## Reglas de diseño (no negociables para el dev)

1. **Ningún estado se codifica sólo por color.** Cada chip lleva símbolo + etiqueta
   textual. Heredado del mockup 49.
2. **Sólo tokens de `.pipeline/assets/design-tokens.css`.** Cero colores
   hardcodeados: `--success` / `--warning` / `--danger` / `--text-*` / `--surface-*`.
   El dashboard ya consume 1051 `var(--…)`; el chip no es la excepción.
3. **El chip informa, no muta.** Es display-only. Coherente con D-5 y con el
   invariante "el adaptador pide, el kernel ejecuta": el dashboard nunca cambia el
   flag de cutover desde la UI.
4. **Iconografía del sprite propio** (`.pipeline/assets/icons/sprite.svg`) cuando
   haya símbolo equivalente. Sin emojis del sistema operativo mezclados.
5. **Contraste AA sobre el fondo REAL**, no sobre `--surface-0` por defecto: los
   fondos `--X-bg` son `rgba(…, 0.14)` compuestos sobre `--surface-1`. Ver la
   seccion de contraste al final, con los ratios ya medidos por par.

## Contraste verificado (regla 5) — validación de desarrollo, 2026-09-08

La regla 5 exige AA. La auditoría se hizo sobre **los pares texto/fondo que el
mockup usa realmente**, incluyendo el compositing de los fondos semitransparentes:
`--success-bg` / `--warning-bg` / `--danger-bg` son `rgba(…, 0.14)` sobre
`--surface-1`, no colores opacos. Medir sólo contra fondos sólidos sobreestima el
ratio y es el error que hay que evitar al re-verificar esto.

### Corregido en el mockup

`#6E7681` (`--text-disabled`, 3,77:1 sobre `#161B22`) se usaba en el subtítulo del
chip "filesystem local" y en dos celdas de la tabla de mapeo — por debajo del
4,5:1 de AA para texto de 11,5–12 px, y además inconsistente con las otras tres
tarjetas, que ya usaban `--text-dim` en esa misma línea. Reemplazado por
`--text-dim` `#8B949E`.

### Ratios reales, peor caso por color

| Color | Token | peor vs fondo opaco | peor vs `--X-bg` compuesto | AA |
|---|---|---|---|---|
| `#E6EDF3` | `--text-primary`   | 13,70 | 11,68 | sí |
| `#B1BAC4` | `--text-secondary` |  8,24 |  7,03 | sí |
| `#8B949E` | `--text-dim`       |  5,26 |  n/a¹ | sí |
| `#3FB950` | `--success`        |  6,37 |  5,43 | sí |
| `#D29922` | `--warning`        |  6,41 |  5,47 | sí |
| `#F85149` | `--danger`         |  4,83 |  **4,41** | **no** ² |

¹ `--text-dim` no se apoya sobre ningún fondo tintado en este mockup.

² **Deuda del sistema de tokens, no de este issue.** `--danger` sobre
`--danger-bg` queda en 4,41:1 en los tres lugares donde el mockup lo usa (el
símbolo `!` del chip "sin respuesta" y los dos titulares de los paneles de la
sección 2). No se corrigió acá **a propósito**: el par es el patrón vigente del
dashboard — 12 usos en `.pipeline/dashboard.js` hoy (`.lc-state-needshuman`,
`.lc-state-architect-rejected`, `.ppa-banner-critical`, `.dss-danger`, …) — y
divergir sólo en este chip produciría un badge de peligro que se ve distinto a
todos los demás del tablero. La recalibración de la familia corresponde a
**#6523**, que ya mide exactamente este par (4,39:1) y está abierta.

### Qué hace el dev con esto

1. **No re-derivar colores.** Usar `var(--danger)` sobre `var(--danger-bg)` como
   el resto del dashboard. Cuando #6523 recalibre la familia, el chip mejora solo.
2. **La legibilidad del estado no puede depender del rojo.** Es la razón por la
   que la regla 1 es no negociable: en el chip "externo — sin respuesta" la
   etiqueta va en `--text-primary` (12,52:1 sobre el fondo tintado) y el rojo
   queda como refuerzo del símbolo `!` y del borde. Un operador que no distingue
   ese rojo del fondo sigue leyendo el estado completo.
3. **Verificar el compositing, no el token.** Si se agrega un texto nuevo sobre
   un fondo `--X-bg`, medirlo contra el color compuesto sobre `--surface-1`.
