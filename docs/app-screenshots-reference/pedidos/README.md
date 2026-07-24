# Pantalla: `pedidos`

## Alcance del flujo

Listado y detalle de pedidos. Cubre filtros por estado (pendiente, en
preparación, en camino, entregado, cancelado), búsqueda por ID/fecha, y
acceso al detalle de cada pedido.

Aplica a los tres flavors con perspectivas distintas:

- `client` — sus propios pedidos como comprador.
- `business` — pedidos recibidos como comercio (gestión + atención).
- `delivery` — envíos asignados / disponibles.

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/pedidos/` (o
equivalente).

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                       |
|------------|---------|-----------------------------------------------------------------------------|
| `default`  | Sí      | Listado con 3-5 pedidos sintéticos en estados variados.                     |
| `empty`    | Sí      | Sin pedidos — copy y CTA específico por flavor.                             |
| `loading`  | Sí      | Skeleton mientras carga.                                                    |
| `error`    | Sí      | Network / auth expirada.                                                    |
| `success`  | Sí      | Confirmación tras acción puntual (cancelar pedido, marcar entregado).       |

Detalle de pedido (sub-pantalla):

- `pedidos-<flavor>-detalle-<fecha>.png` — detalle de un pedido específico.

## Diferenciación por flavor

| Flavor       | Empty state copy                                                  |
|--------------|-------------------------------------------------------------------|
| `client`     | "Aún no hiciste pedidos" + CTA "Explorar comercios".              |
| `business`   | "Sin pedidos entrantes" + indicador de estado del comercio.       |
| `delivery`   | "Sin envíos asignados" + CTA "Ver disponibles".                   |

## Datos sintéticos obligatorios

- ID de pedido: `ORD-000001`, `ORD-000002`… (no IDs productivos).
- Cliente (business/delivery): "Cliente Demo Uno", "Cliente Demo Dos".
- Dirección (delivery/business): "Av. Siempreviva 742, CABA".
- Montos: redondos sintéticos (`$1.000`, `$2.500`).

## Accesibilidad esperada

- Cada item de la lista con label completo (ID + estado + monto + cliente).
- Badge de estado con icono + texto + color (no solo color).
- Filtros con estado seleccionado visible (no solo cambio de color).
- Detalle accesible con click en cualquier zona del item, no solo en una
  chevron pequeña.

## Referencias

- Issues relacionados: [#2505](https://github.com/intrale/platform/issues/2505), [#1924](https://github.com/intrale/platform/issues/1924) (business home con pedidos).
