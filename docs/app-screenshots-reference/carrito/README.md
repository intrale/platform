# Pantalla: `carrito`

## Alcance del flujo

Carrito de compras del usuario. Lista de productos agregados, cantidad,
precio unitario, subtotal, total con impuestos/envío, y CTA "Continuar al
checkout".

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/carrito/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Carrito con 2-3 productos sintéticos, total calculado.                  |
| `empty`    | Sí      | Carrito vacío con copy y CTA "Ir a explorar".                           |
| `loading`  | Sí      | Cuando se recalcula tras cambio de cantidad.                            |
| `error`    | Sí      | Producto sin stock al agregar, error de red en recálculo.               |
| `success`  | No      | El "éxito" es la navegación a `checkout`.                               |

## Diferenciación por flavor

- `client`: **aplica plenamente**. Es el flavor primario del carrito.
- `business`: **NO aplica** — business no compra, vende.
- `delivery`: **NO aplica** — delivery no maneja carrito.

El README declara la ausencia para `business` y `delivery` explícitamente. La
librería solo va a contener PNGs para `carrito-client-*`.

## Accesibilidad esperada

- Cada item de carrito con label completo (nombre + cantidad + precio).
- Botones `+` / `-` de cantidad con touch target ≥ 48dp.
- Total destacado con tamaño de tipografía mayor (≥ 18sp).
- Empty state con icono + copy + CTA primario.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/carrito/`.
- Issues relacionados: pendiente capturar (no hay evidencia previa
  específica de carrito en `qa/evidence/**`).
