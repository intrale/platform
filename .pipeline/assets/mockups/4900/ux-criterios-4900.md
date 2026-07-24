# UX — criterios visuales para #4900

El dashboard conserva la matriz proveedor × ventana y su densidad actual. Codex
con lectura fresca pasa del badge informativo `sin límite` al gauge porcentual
existente, sin sumar componentes, iconos ni cambios de layout.

## Estados

- `50..100`: token `--in-ok` (`#3fb950`), barra y texto con el mismo entero.
- `20..49`: token `--in-warn` (`#d29922`), barra y texto con el mismo entero.
- `0..19`: token `--in-bad` (`#f85149`), barra y texto con el mismo entero.
- Ausente, no finito, fuera de rango, futuro o stale: `sin dato`, sin barra
  coloreada y con token `--in-fg-soft`.
- `eventState === exhausted`: `tope activo` con semántica crítica y precedencia
  sobre cualquier porcentaje residual.
- `eventState === nodata`: `sin dato` con precedencia sobre cualquier porcentaje.

## Accesibilidad y comportamiento

- Texto visible, ancho de barra, clase cromática, `title` y `aria-label` derivan
  de una única magnitud entera normalizada.
- El porcentaje/estado escrito permite comprender el dato sin depender del color.
- El texto dinámico se asigna mediante `textContent`; no se interpreta HTML.
- Se mantienen los identificadores DOM, tipografía tabular, transición de 400 ms
  y dimensiones existentes.
- Copia accesible recomendada: `Codex <ventana>: <N>% disponible`,
  `Codex <ventana>: sin dato` o `Codex <ventana>: tope activo`.

Referencia visual final: `codex-quota-states.svg`.
