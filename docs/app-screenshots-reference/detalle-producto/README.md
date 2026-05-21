# Pantalla: `detalle-producto`

## Alcance del flujo

Vista detalle de un producto del catálogo. Cubre foto principal, descripción,
precio, variantes (si aplican), CTA principal "Agregar al carrito" (client) o
"Editar" (business).

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/detalle/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Producto con datos sintéticos completos.                                |
| `empty`    | No      | No aplica (siempre se llega con un producto cargado).                   |
| `loading`  | Sí      | Skeleton mientras carga la imagen + descripción.                        |
| `error`    | Sí      | Producto no encontrado / sin stock / network.                           |
| `success`  | Sí      | Confirmación visual tras "Agregar al carrito" (snackbar / badge).       |

## Diferenciación por flavor

- `client`: foto + descripción + CTA "Agregar al carrito" + selector de cantidad.
- `business`: misma estructura pero CTA "Editar" + indicadores de stock/visibilidad.
- `delivery`: **NO aplica** — el flavor delivery no maneja catálogo de productos.

El README de la pantalla declara la ausencia para `delivery` explícitamente.

## Accesibilidad esperada

- Imagen principal con `contentDescription` informativo (ej. "Foto del producto:
  Manzana Roja, color rojo, fondo blanco").
- Precio en texto visible (no solo en imagen), formato con separadores
  argentinos (`$1.000,50`).
- CTA principal con touch target ≥ 48dp y contraste alto.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/detalle/`.
- Issues relacionados: pendiente capturar en próximas iteraciones (no hay
  evidencia previa específica del detalle en `qa/evidence/**`).
