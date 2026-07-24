# Pantalla: `home`

## Alcance del flujo

Pantalla principal post-login. **Es la pantalla con mayor diferenciación
entre flavors** del producto:

- `client` — catálogo de productos / comercios cercanos, búsqueda destacada.
- `business` — panel de operación (pedidos entrantes, métricas, gestión).
- `delivery` — listado de envíos asignados / disponibles, mapa.

Por la diferencia estructural entre flavors, esta pantalla **requiere PNG
canónico independiente por cada flavor**.

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/home/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                       |
|------------|---------|-----------------------------------------------------------------------------|
| `default`  | Sí      | Home con datos sintéticos representativos.                                  |
| `empty`    | Sí      | Para `business` (sin pedidos), `delivery` (sin envíos), `client` (sin nada).|
| `loading`  | Sí      | Spinner del fetch inicial post-login.                                       |
| `error`    | Sí      | Error de red o de auth expirada.                                            |
| `success`  | No      | No aplica (no es flujo de acción puntual).                                  |

## Diferenciación por flavor (detalle)

| Flavor       | Layout principal                                                  |
|--------------|-------------------------------------------------------------------|
| `client`     | Header de búsqueda + carrusel de comercios + grid de productos.   |
| `business`   | Cards de KPIs + listado de pedidos entrantes + acciones rápidas.  |
| `delivery`   | Mapa + listado de envíos + filtro por estado.                     |

Cada flavor debe tener su propio README de pantalla específico si la
divergencia visual crece — por ahora coexisten en este README.

## Accesibilidad esperada

- Cards con `contentDescription` que resuma el contenido (no solo nombres
  visuales).
- Cards interactivos con ripple visible al tap.
- Loading state con texto + spinner (no solo spinner sin contexto).
- Empty state con CTA claro hacia la acción de remediación.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/home/`.
- Issues relacionados: [#1093](https://github.com/intrale/platform/issues/1093), [#1924](https://github.com/intrale/platform/issues/1924), [#1957](https://github.com/intrale/platform/issues/1957), [#2332](https://github.com/intrale/platform/issues/2332), [#2505](https://github.com/intrale/platform/issues/2505).
