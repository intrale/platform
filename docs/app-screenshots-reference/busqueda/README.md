# Pantalla: `busqueda`

## Alcance del flujo

Búsqueda dentro de la app. El objeto buscado depende del flavor:

- `client` — productos y comercios.
- `business` — pedidos propios, productos del propio catálogo, clientes.
- `delivery` — envíos por estado, dirección o ID.

Cubre el input de búsqueda + resultados + sugerencias en typeahead (cuando
aplica).

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/busqueda/` (o
equivalente — ver código actual).

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                       |
|------------|---------|-----------------------------------------------------------------------------|
| `default`  | Sí      | Input vacío + sugerencias / categorías destacadas.                          |
| `empty`    | Sí      | Búsqueda con cero resultados — copy "No encontramos…".                      |
| `loading`  | Sí      | Skeleton o spinner mientras llega la lista.                                 |
| `error`    | Sí      | Error de red / timeout.                                                     |
| `success`  | Sí      | Resultados visibles (es un estado distinto de `default`).                   |

## Diferenciación por flavor

- `client`: cards visuales con foto del producto/comercio.
- `business`: filas tabulares con metadata (estado, monto, fecha).
- `delivery`: items con badge de estado + dirección.

## Accesibilidad esperada

- Input con `placeholder` + label ARIA equivalente.
- Sugerencias navegables con teclado físico (relevante en delivery con
  bluetooth keyboard).
- Estados empty/error con icono + texto + CTA de "Reintentar" o "Limpiar".

## Referencias

- Issues relacionados: [#2505](https://github.com/intrale/platform/issues/2505) (drawer search), [#2333](https://github.com/intrale/platform/issues/2333), [#2334](https://github.com/intrale/platform/issues/2334).
