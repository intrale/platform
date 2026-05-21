# Pantalla: `checkout`

## Alcance del flujo

Confirmación de la compra: resumen de items, dirección de envío, método de
pago, total final, CTA "Confirmar pedido". Incluye también la pantalla de
confirmación post-pago.

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/checkout/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Resumen completo con datos sintéticos (dirección, método, total).       |
| `empty`    | No      | No aplica (llega con carrito).                                          |
| `loading`  | Sí      | Mientras procesa el pago.                                               |
| `error`    | Sí      | Pago rechazado, dirección inválida, stock perdido al confirmar.         |
| `success`  | Sí      | Confirmación post-pago con número de pedido sintético.                  |

## Diferenciación por flavor

- `client`: **aplica plenamente**. Flujo principal.
- `business`: **NO aplica** — business no checkea como comprador.
- `delivery`: **NO aplica** — delivery no maneja checkout.

El README declara la ausencia para `business` y `delivery` explícitamente.

## Datos sintéticos obligatorios

Por sensibilidad PII del checkout, los PNGs canónicos **deben** mostrar:

- Tarjeta de prueba: `**** **** **** 4242` (formato visible enmascarado).
- Dirección: "Av. Siempreviva 742, CABA" (Simpsons-style, sin coordenadas reales).
- Email: `qa@intrale.test`.
- Teléfono: `+54 9 11 0000 0000`.

Cualquier captura con tarjeta real, dirección real o email productivo →
**NO migrar**, registrar como deuda.

## Accesibilidad esperada

- Resumen de items legible con scroll si excede la pantalla.
- Método de pago con icono identificable + texto.
- Total final destacado en card aparte con contraste alto.
- CTA "Confirmar" deshabilitado visiblemente cuando faltan datos requeridos.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/checkout/`.
- Issues relacionados: pendiente capturar.
