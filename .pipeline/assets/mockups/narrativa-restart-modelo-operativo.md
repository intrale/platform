# Narrativa UX — Reiniciar modelo operativo (#4460)

> Sistema visual del banner condicional que avisa al operador que hay cambios
> del **modelo operativo** entregados a `main` pero **sin correr** en el runtime
> vivo, y le ofrece aplicarlos con un reinicio selectivo y seguro.
>
> Mockup: `41-restart-modelo-operativo-4460.svg`. Ícono nuevo: `ic-restart-operativo`.
> Token: `--restart-pending` (alias de `--info`). Fase: criterios (definición).

## 1. Decisión de ubicación: BANNER contextual (no ícono suelto)

El body del issue y el Arquitecto pedían a /ux confirmar: **ícono en el encabezado
de la ola** vs **banner/franja contextual** sobre el área de issues.

**Decisión: banner contextual sobre el área de issues de la ola.** Razones:

1. **Discoverability.** Un ícono que a veces aparece y a veces no en el header es
   fácil de pasar por alto y ambiguo ("¿por qué apareció este ícono?"). Un banner
   ocupa el ancho del área y se lee como un aviso accionable inequívoco.
2. **Comunicar el "por qué" sin depender de hover.** El CA-4 exige enumerar los
   issues + el componente tocado. Un tooltip sobre un ícono esconde información
   **esencial** tras hover (no funciona en touch y viola pautas de accesibilidad).
   El banner muestra los motivos inline.
3. **Proporción a la acción.** El click dispara un reinicio (acción de peso). El
   banner da espacio para el botón con label explícito + confirmación, en vez de
   un target diminuto.
4. **No es un error.** El banner usa la familia `--info` (azul accionable neutro),
   nunca `--danger`. Es un estado operativo normal ("tenés entregas por aplicar"),
   no una falla.

El banner se ancla **arriba del listado de issues de la ola**, debajo del
encabezado (número + nombre + avance). Es parte del flujo de lectura natural del
operador cuando abre la pantalla principal.

## 2. Estados (uno por panel del mockup)

- **A · Visible (CA-1/CA-4).** `items.length >= 1`. Banner `--restart-pending`
  con: ícono `ic-restart-operativo`, título con el conteo, subtítulo explicativo,
  lista de motivos (issue# monospace + chip de componente + motivo corto) y el
  botón "Reiniciar modelo".
- **B · Confirmación (CA-5/CA-6).** Modal previo mostrando qué se va a reiniciar
  (dashboard + pulpo, selectivo), qué cambios se aplican (issues + componente) y
  la nota de que la señal desaparece sola. Foco inicial en "Cancelar" (acción
  segura). "Reiniciar" es el botón primario.
- **C · Desconocido (CA-8).** `unknown:true` (marker ausente/corrupto). Banner
  `--warning` + `ic-health-warn`: NO afirma "sin pendientes" ni ofrece reinicio a
  ciegas; ofrece "Refrescar estado". Nunca crashea.
- **D · Ausente (CA-2/CA-7).** Sin drift → el banner **no se emite al DOM** (no
  "disabled", no `display:none`). Tras un reinicio exitoso el `bootSHA` avanza,
  el rango operativo queda vacío y el banner desaparece en el siguiente poll.

## 3. Iconografía

`ic-restart-operativo` (nuevo en `sprite.svg`): flecha circular de reinicio
(comparte la metáfora de `ic-restart`) **envolviendo un cubo/paquete** = "el
modelo operativo que se re-aplica". Deliberadamente distinto de:

- `ic-restart` → anillo vacío, "restart por nodo" en la topología Ops (#3960).
- `ic-fase-build` → cubo isométrico, "build" del producto.

viewBox 24×24, `stroke="currentColor"`, outline, linecaps redondeados — coherente
con todo el sprite. Se tinta vía CSS con `var(--restart-pending)`.

## 4. Color y tokens

- **`--restart-pending`** = alias de `--info` (azul accionable). Familia `-dim`,
  `-bg`, `-fg` (`#CFE3FF`, ~12:1 sobre `-bg`). No infla la paleta ni grita como
  `--danger`/`--warning`.
- **Estado desconocido** NO usa este token: usa `--warning` + `ic-health-warn`.
- **Regla dual-encoding** (heredada del sistema): color + ícono + texto siempre;
  el color por sí solo nunca comunica el estado.

## 5. Accesibilidad (WCAG AA)

- Botón **icon + label** (nunca icon-only): los motivos son esenciales.
- `role="region"` + `aria-label="Cambios del modelo operativo sin aplicar"` en el
  banner; `role="img"` + `aria-label` de **estado** en cada ícono.
- Modal: focus trap, foco inicial en "Cancelar", `Escape` cierra y devuelve el
  foco al botón disparador.
- Contraste verificado: `--info` 6.6:1, `--warning` 7.0:1, textos ≥ 9:1 sobre
  `surface-0`. Chips de componente con texto ≥ 4.5:1.
- `prefers-reduced-motion`: sin pulso/animación en el banner.

## 6. Copy (es-AR, tono operativo directo)

- Título (plural): `"{N} cambios del modelo operativo entregados y sin aplicar"`
  / singular: `"1 cambio del modelo operativo entregado y sin aplicar"`.
- Subtítulo: `"El runtime vivo corre una versión anterior. Reinicia dashboard + pulpo para aplicarlos."`
- Botón: `"Reiniciar modelo"` (label corto) + hint `"selectivo · sin matar agentes"`.
- Modal título: `"Reiniciar el modelo operativo"`; primario `"Reiniciar"`, secundario `"Cancelar"`.
- Desconocido: `"No se puede determinar si el runtime está al día"` + `"Refrescar estado"`.

## 7. Handoff a pipeline-dev

- Ícono ya en `sprite.svg` (`ic-restart-operativo`) → referenciar con
  `<svg role="img" aria-label="reiniciar modelo operativo"><use href="#ic-restart-operativo"/></svg>`.
- Token ya en `design-tokens.css` (`--restart-pending`). No hardcodear `#58A6FF`.
- El slice `restartPendienteSlice` debe devolver `{items:[{issue, componente, motivo}], unknown}`.
  El render condiciona el banner a `items.length >= 1`; `unknown:true` → variante C.
- Escapar (`escapeHtml`) todo `motivo`/`componente` y no inyectar en `title`/`innerHTML` crudo.
