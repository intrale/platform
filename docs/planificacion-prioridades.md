# Planificación por Prioridades — Intrale Platform

**Fecha:** 2026-02-17
**Issues abiertos:** 168 | **PRs abiertos:** 2

---

## Nivel 1 — Estabilidad del build (bloquean todo lo demás)

Mientras el build o los tests estén rotos, ningún otro trabajo se puede validar con confianza.

| # | Título | Módulo | Problema |
|---|--------|--------|----------|
| [#776](https://github.com/intrale/platform/issues/776) | Resolver issues de compilación | `composeApp` | `showSnackbar` fuera de corrutina, `address.zip` vs `postalCode`, MessageKeys faltantes, imports de delivery |
| [#778](https://github.com/intrale/platform/issues/778) | Más issues de compilación | `composeApp` | `Txt()` en contextos no-composable, import faltante de `FilterChip`, `address.line1` inexistente |
| [#780](https://github.com/intrale/platform/issues/780) | Test failure | `backend` | `LambdaRequestHandler` devuelve 500 en vez de 400 cuando falta segmento de negocio |
| [#283](https://github.com/intrale/platform/issues/283) | P0 — Bloqueo de navegación por fallos de recursos Base64 | `composeApp` | Navegación bloqueada por fallos al resolver textos de recursos |
| [#275](https://github.com/intrale/platform/issues/275) | Build roto tras refactor del menú semicircular | `composeApp` | Build roto post-refactor |
| [#302](https://github.com/intrale/platform/issues/302) | scanNonAsciiFallbacks falla por directorio inexistente | `tools` | Verificación automática de strings no funciona |

**Criterio de salida:** `./gradlew clean build` pasa sin errores en todos los módulos.

---

## Nivel 2 — Bugs y bloqueos

| # | Título | Labels |
|---|--------|--------|
| [#70](https://github.com/intrale/platform/issues/70) | Fallo en tests del módulo users | bug, blocked |
| [#449](https://github.com/intrale/platform/issues/449) | Selección de tipografías por componente | bug |
| [#27](https://github.com/intrale/platform/issues/27) | Agregar pruebas de integración para TestDynamoDB | blocked |

**Acción adicional:** Investigar por qué los PRs #797 y #798 tienen 0 check-runs de CI. Puede haber un problema de configuración de GitHub Actions.

---

## Nivel 3 — Deuda técnica con impacto

Estos issues previenen regresiones y mejoran la calidad del código a largo plazo.

| Bloque | Issues | Descripción |
|--------|--------|-------------|
| Migración de strings | ~15 issues (#477–#554) | Migrar pantallas a nueva API `Txt` + `MessageKey` |
| Bloqueo de APIs viejas | [#473](https://github.com/intrale/platform/issues/473) | KSP processor para bloquear usos de APIs legacy en compilación |
| Verificación de strings | [#302](https://github.com/intrale/platform/issues/302) | Reparar `scanNonAsciiFallbacks` |

---

## Nivel 4 — Features nuevas (por stream)

### Stream NEGOCIO (`app:business`) — 14 issues

Es el stream más grande y prerequisito para cliente y delivery: sin productos publicados no hay catálogo ni pedidos.

| # | Título | Área |
|---|--------|------|
| [#610](https://github.com/intrale/platform/issues/610) | Dashboard del negocio | dashboard |
| [#612](https://github.com/intrale/platform/issues/612) | Listado de productos | productos |
| [#613](https://github.com/intrale/platform/issues/613) | Formulario de producto | productos |
| [#671](https://github.com/intrale/platform/issues/671) | Gestión de stock y disponibilidad | productos |
| [#672](https://github.com/intrale/platform/issues/672) | Categorías de productos | productos |
| [#673](https://github.com/intrale/platform/issues/673) | Listado de pedidos recibidos | pedidos |
| [#674](https://github.com/intrale/platform/issues/674) | Detalle de pedido | pedidos |
| [#675](https://github.com/intrale/platform/issues/675) | Asignación de repartidor | delivery |
| [#676](https://github.com/intrale/platform/issues/676) | Configuración de delivery | delivery |
| [#677](https://github.com/intrale/platform/issues/677)–[#680](https://github.com/intrale/platform/issues/680) | Configuración general del negocio | configuración |
| [#681](https://github.com/intrale/platform/issues/681) | Promociones y marketing | marketing |

### Stream CLIENTE (`app:client`) — 10 issues

Depende de que el negocio tenga productos publicados.

| # | Título | Área |
|---|--------|------|
| [#715](https://github.com/intrale/platform/issues/715) | Catálogo de productos | productos |
| [#716](https://github.com/intrale/platform/issues/716) | Detalle de producto | productos |
| [#717](https://github.com/intrale/platform/issues/717) | Carrito de compras | carrito |
| [#718](https://github.com/intrale/platform/issues/718) | Gestión de direcciones | carrito |
| [#720](https://github.com/intrale/platform/issues/720) | Métodos de pago | pagos |
| [#721](https://github.com/intrale/platform/issues/721)–[#723](https://github.com/intrale/platform/issues/723) | Pedidos (crear, listar, detalle) | pedidos |
| [#724](https://github.com/intrale/platform/issues/724) | Notificaciones | notificaciones |
| [#726](https://github.com/intrale/platform/issues/726) | 2FA | seguridad |

### Stream DELIVERY (`app:delivery`) — 10 issues

Depende de que el negocio tenga pedidos.

| # | Título | Área |
|---|--------|------|
| [#731](https://github.com/intrale/platform/issues/731) | Pedidos asignados | pedidos |
| [#732](https://github.com/intrale/platform/issues/732) | Pedidos disponibles | pedidos |
| [#733](https://github.com/intrale/platform/issues/733) | Detalle de pedido | pedidos |
| [#734](https://github.com/intrale/platform/issues/734) | Flujo de estados de entrega | estado |
| [#735](https://github.com/intrale/platform/issues/735) | Ubicación y mapa | ubicación |
| [#736](https://github.com/intrale/platform/issues/736) | Confirmación de entrega | estado |
| [#737](https://github.com/intrale/platform/issues/737) | Historial de pedidos | historial |
| [#740](https://github.com/intrale/platform/issues/740) | Notificaciones | notificaciones |
| [#741](https://github.com/intrale/platform/issues/741) | Contacto con comercio/cliente | comunicación |
| [#742](https://github.com/intrale/platform/issues/742) | 2FA | seguridad |

---

## Nivel 5 — Infraestructura y mejoras de largo plazo

| Bloque | Issues | Descripción |
|--------|--------|-------------|
| Backend branding (H2.x) | ~30 issues (#372–#403) | Sistema completo de branding con DynamoDB |
| CI/CD por marca (H1.3) | 8 issues (#327–#334) | Build matrix por marca, Android, iOS |
| Branding frontend | 6 issues (#447–#452) | Panel de personalización |
| Pantallas pendientes | ~12 issues (#49–#67) | Pantallas para servicios existentes |
| Pruebas de integración | 5 issues (#8–#28) | Tests para funciones del backend |
| Documentación | ~5 issues (#285, #417–#433) | README, badges, docs |

---

## Observaciones

- **73% de los issues (122 de 168) no tienen labels.** Se recomienda hacer una sesión de triaje para categorizarlos.
- **Los PRs #797 y #798 no tienen CI ejecutado.** Investigar la configuración de GitHub Actions.
- **Orden sugerido de streams:** Negocio → Cliente → Delivery (cada uno depende del anterior).
- **Área con más issues:** pedidos (13), distribuidos entre las tres apps.
