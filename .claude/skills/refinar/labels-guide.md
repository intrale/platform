# Guia de labels — intrale/platform

## Labels de app (obligatorio si aplica a una app)

| Label | Cuando usar |
|-------|-------------|
| `app:client` | Funcionalidad del usuario final / consumidor |
| `app:business` | Funcionalidad del comercio / negocio |
| `app:delivery` | Funcionalidad del repartidor |

> Un issue puede tener multiples labels de app si afecta a varias apps.
> Si el issue es solo de backend/infra, no lleva label de app.

## Labels de area (obligatorio, al menos uno)

| Label | Cuando usar |
|-------|-------------|
| `area:asignacion` | Asignacion de repartidores a pedidos |
| `area:carrito` | Carrito de compras |
| `area:checkout` | Proceso de checkout / confirmacion de compra |
| `area:comunicacion` | Chat, contacto entre usuarios |
| `area:configuracion` | Configuracion general del negocio |
| `area:dashboard` | Dashboard / panel principal |
| `area:delivery` | Logica de delivery / envio |
| `area:direcciones` | Gestion de direcciones |
| `area:estado` | Flujo de estados (pedido, entrega) |
| `area:historial` | Historial de pedidos / actividad |
| `area:infra` | Infraestructura, CI/CD, AWS, build |
| `area:marketing` | Promociones, descuentos |
| `area:notificaciones` | Notificaciones push/in-app |
| `area:onboarding` | Registro, primer uso |
| `area:pagos` | Metodos de pago, procesamiento |
| `area:pedidos` | Gestion de pedidos |
| `area:perfil` | Perfil de usuario |
| `area:productos` | Catalogo, CRUD de productos |
| `area:seguridad` | 2FA, autenticacion, permisos |
| `area:ubicacion` | Geolocalizacion, mapas |

## Labels de tipo

| Label | Cuando usar |
|-------|-------------|
| `bug` | Algo no funciona como se espera |
| `enhancement` | Mejora a funcionalidad existente |
| `refactor` | Refactorizacion sin cambio funcional |
| `docs` | Documentacion |
| `strings` | Migracion/ajuste de strings |
| `tipo:infra` | Infraestructura y tooling |
| `KMP` | Relacionado a Kotlin Multiplatform |

## Labels de estado (no asignar manualmente, gestionadas por flujo)

| Label | Descripcion |
|-------|-------------|
| `blocked` | Issue bloqueado |
| `Backlog` | En backlog sin refinar |
| `Refined` | Refinado y listo para priorizar |
| `In Progress` | En desarrollo |
| `Ready` | Listo para verificar |

## Labels especiales

| Label | Descripcion |
|-------|-------------|
| `codex` | Para ejecucion por leitocodexbot |
| `from-intake` | Creado desde backlog intake |
| `good first issue` | Adecuado para contribuidores nuevos |

## Reglas de asignacion

1. Todo issue DEBE tener al menos un label de area
2. Si el issue afecta a una app especifica, agregar el label de app correspondiente
3. Si es un bug, agregar `bug`; si es feature nueva, no se necesita label de tipo (es el default)
4. No agregar labels de estado manualmente — se gestionan via Project V2
5. Usar `codex` solo si el issue sera ejecutado por el bot
