# UX — cuota real por proveedor (#4455)

## Dirección visual

La matriz por proveedor es la única representación de cuota en el home. Se
eliminan las tarjetas agregadas “Cuota sesión 5h” y “Cuota semanal”; el KPI de
PRs puede ocupar el ancho disponible sin dejar huecos.

Asset final de referencia:
`.pipeline/assets/mockups/4455/provider-quota-matrix.svg`.

## Contrato de cada fila

- Proveedores canónicos: Anthropic, Codex / OpenAI, Gemini, Cerebras y NVIDIA NIM.
- Cada celda muestra la ventana real que informa su adapter. No se fuerzan
  columnas “sesión/semanal” cuando no aplican.
- Una magnitud normalizada alimenta texto, barra, color, tooltip y `aria-label`.
  El rótulo visible es `N% disponible`; si la fuente entrega consumo, la
  conversión se hace una sola vez antes del render.
- Dato ausente, inválido o vencido: `sin dato`, sin barra y en texto neutro.
- Límite categórico activo: `TOPE ACTIVO`, icono cuadrado y rojo; no se representa
  como un porcentaje inventado.

## Estados y accesibilidad

- Holgado: verde `#3FB950`, disponibilidad mayor o igual a 50%.
- Atención: ámbar `#D29922`, disponibilidad entre 20% y 49%.
- Crítico: rojo `#F85149`, disponibilidad menor a 20% o tope activo.
- Sin dato: gris `#6E7681`, acompañado por tooltip que explica la ausencia.
- El color nunca es el único indicador. Texto, símbolo y `aria-label` expresan el
  estado. Porcentajes usan números tabulares.
- En mobile cada fila puede apilar sus ventanas; nombre y fuente permanecen
  visibles antes de las métricas. Touch targets interactivos mínimos: 44×44 px.

## Copy

- Título: `Cuota por proveedor`.
- Subtítulo: `Datos reales y frescos · nunca se agregan entre proveedores`.
- Frescura: `Actualizado hace <tiempo>`.
- Ausencia: `sin dato`; el tooltip agrega fuente y causa concreta.
- Evitar `0%` como fallback, “cuota general” y precisión decimal no respaldada.

## Criterios visuales verificables

1. No existen en el home `kpi-quota-session`, `kpi-quota-week`, “Cuota sesión”
   ni “Cuota semanal” agregadas.
2. Las cinco filas aparecen una sola vez y conservan nombre, fuente y ventanas.
3. Un valor real entre 0 y 100 renderiza el mismo valor en texto, ancho de barra,
   clase semántica, tooltip y `aria-label`.
4. `null`, `NaN`, valores fuera de rango, corruptos o stale muestran `sin dato`.
5. La composición es legible a 1440 px y a 360 px sin scroll horizontal.
