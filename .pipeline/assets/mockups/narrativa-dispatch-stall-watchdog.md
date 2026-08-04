# Narrativa visual — watchdog de inactividad de despacho

Referencia visual del issue #5400. Complementa el mockup
`47-dispatch-stall-watchdog.svg` y conserva las decisiones usadas en las
capturas comparativas rev-4.

## Propósito

El banner comunica si el pipeline lleva un tiempo anormal sin despachar y
expone el estado del watchdog. La información nunca depende sólo del color:
cada estado combina texto explícito e iconografía del sprite.

## Estados

- Sano: cola sin trabajo elegible, icono `ic-health-ok` y chip `watchdog activo`.
- Detención esperada: causa concreta, tiempo desde el último despacho e icono
  `ic-dispatch-stalled`.
- Detención grave o escalada: misma estructura con semántica `danger`.
- Watchdog apagado o degradado: icono `ic-watchdog-off`, razón visible y chip
  persistente.

## Sistema visual

El renderer consume `.pipeline/assets/design-tokens.css`: `surface-1`,
`border-subtle`, `text-secondary`, `text-dim`, `success`, `warning`,
`warning-bg`, `danger` y `danger-bg`. Los fallbacks de `var()` preservan una
salida legible durante la carga del CSS y no constituyen una paleta paralela.

La estructura, los estados y la iconografía corresponden al mockup 47. No se
usan emojis como sustituto de iconos y todo texto proveniente del filesystem se
escapa antes de insertarse en HTML.
