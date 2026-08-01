# Reglas de Negocio — Intrale Platform

> Este archivo es la base de conocimiento del Product Owner.
> Crece con cada iteración. Última actualización: 2026-02-28.

---

## 1. Roles y Perfiles

| Perfil | Código | Capacidades principales |
|--------|--------|------------------------|
| PlatformAdmin | `PlatformAdmin` | Revisar registros de negocios (requiere 2FA), asignar perfiles, verificar códigos TOTP |
| BusinessAdmin | `BusinessAdmin` | Registrar Salers, configurar autoAcceptDeliveries, gestionar productos y categorías, revisar solicitudes de delivery |
| Saler | `Saler` | CRUD productos, gestionar categorías, ver órdenes del negocio |
| Delivery | `Delivery` | Solicitar unirse a negocio, consultar órdenes disponibles/activas, actualizar estado de entrega |
| Client | `Client` | Crear órdenes, gestionar direcciones, ver historial de pedidos |

**Regla**: Un usuario puede tener múltiples perfiles en diferentes negocios. La combinación `email + business + profile` es única.

**Estados de UserBusinessProfile**: `PENDING` → `APPROVED` / `REJECTED`

---

## 2. Negocios (Business)

### Estados
```
PENDING → APPROVED (por PlatformAdmin con 2FA)
PENDING → REJECTED (por PlatformAdmin con 2FA)
```

### Registro de negocio
- **Quién**: Cualquier usuario autenticado
- **Campos obligatorios**: name (≥7 caracteres), emailAdmin (email válido), description
- **Opcionales**: autoAcceptDeliveries (Boolean, default false)
- **publicId**: Se genera como slug del nombre. Si hay colisión → slug + UUID
- **Estado inicial**: `PENDING`

### Aprobación de negocio
- **Quién**: Solo PlatformAdmin
- **Requisito**: Verificación 2FA (código TOTP 6 dígitos)
- **Si APPROVED**: Se crea usuario BusinessAdmin en Cognito (si no existe) y se asigna perfil
- **Si REJECTED**: Se marca estado como REJECTED, sin efectos adicionales

### Configuración
- `autoAcceptDeliveries`: Si true, repartidores se aprueban automáticamente al solicitar unirse
- Solo modificable por BusinessAdmin del negocio

### Búsqueda de negocios
- Paginada con `lastKey` (nombre del último negocio)
- Filtro por query (insensible a mayúsculas) y por status
- Límite de resultados configurable

---

## 3. Productos

### Estados
- `DRAFT` — Borrador, no visible para clientes
- `PUBLISHED` — Publicado, visible para clientes

### Propiedades
| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| name | String | Sí | — |
| basePrice | Double | Sí | — |
| unit | String | Sí | Unidad de medida |
| categoryId | String | Sí | Referencia a categoría |
| shortDescription | String | No | — |
| status | Enum | No | Default: DRAFT |
| isAvailable | Boolean | No | Default: true |
| stockQuantity | Int? | No | Null = sin control de stock |

### Categorías
- CRUD completo por BusinessAdmin/Saler
- Campos: name (requerido), description (opcional)
- `productCount`: conteo de productos asociados (calculado)

### Permisos
- Solo Saler o BusinessAdmin del negocio pueden gestionar productos

---

## 4. Órdenes de Cliente

### Estados y transiciones
```
PENDING → CONFIRMED → PREPARING → READY → DELIVERING → DELIVERED
                                                      ↘ CANCELLED
(CANCELLED puede ocurrir desde cualquier estado previo a DELIVERED)
```

### Propiedades
| Campo | Tipo | Notas |
|-------|------|-------|
| shortCode | String(6) | Alfanumérico sin vocales ni confundibles (A-Z sin AEIOU, 2-9) |
| publicId | UUID | Identificador público |
| items | List | productId, productName, quantity, unitPrice, subtotal |
| total | Double | Suma de subtotals |
| deliveryAddress | ClientAddressPayload | Dirección de entrega |
| notes | String? | Notas del cliente |
| createdAt / updatedAt | ISO-8601 | Timestamps automáticos |

### Reglas de shortCode
- 6 caracteres
- Alfabeto: `BCDFGHJKLMNPQRSTVWXYZ23456789` (sin A,E,I,O,U,0,1 para evitar confusión)
- Generado aleatoriamente

### Permisos
- Cliente solo ve sus propias órdenes dentro de un negocio específico

---

## 5. Órdenes de Delivery

### Estados
```
pending → in_progress/assigned → picked_up → in_transit → arriving → delivered
```

### Propiedades específicas
| Campo | Tipo | Notas |
|-------|------|-------|
| neighborhood | String | Barrio de entrega |
| promisedAt | ISO-8601 | Hora prometida |
| eta | String | Tiempo estimado de llegada |
| distance | String | Distancia estimada |
| customerName | String | Nombre del cliente |
| customerPhone | String | Teléfono del cliente |
| paymentMethod | String | Método de pago |
| collectOnDelivery | Boolean | Si el repartidor cobra al entregar |
| assignedTo | String? | Email del repartidor asignado |

### Endpoints del repartidor
- `GET /delivery/orders/summary` — Resumen: pending, inProgress, delivered (conteos)
- `GET /delivery/orders/active` — Órdenes asignadas al repartidor (picked_up, in_transit, arriving)
- `GET /delivery/orders/available` — Órdenes sin asignar (pending)
- `GET /delivery/orders/{id}` — Detalle de orden
- `PUT /delivery/orders/{id}/status` — Cambiar status
- `PUT /delivery/orders/{id}/state` — Cambiar estado de entrega

---

## 6. Estado de Entrega (Delivery State)

### Transiciones
```
PENDING → PICKED_UP → IN_TRANSIT → DELIVERED
                                  ↘ CANCELLED
(CANCELLED puede ocurrir desde cualquier estado previo a DELIVERED)
```

### Regla
- No hay restricciones explícitas de transición en el código actual
- **Gap identificado**: Debería haber validación de transiciones (ej: no saltar de PENDING a DELIVERED)

---

## 7. Disponibilidad de Repartidores

### Modos
- `BLOCK` — Bloque predefinido de horas
- `CUSTOM` — Horario personalizado

### Bloques predefinidos
| Bloque | Horario |
|--------|---------|
| MORNING | 06:00 - 12:00 |
| AFTERNOON | 12:00 - 18:00 |
| NIGHT | 18:00 - 23:00 |

### Validaciones
- Mínimo 1 slot activo
- Día válido: lunes a domingo (case-insensitive)
- Si mode=BLOCK: block debe ser MORNING, AFTERNOON o NIGHT
- Si mode=CUSTOM: start y end obligatorios, start < end
- Timezone requerido (no se impone formato específico)

### Perfil del repartidor
- fullName, email, phone (opcional)
- vehicle: type, model, plate (opcional)
- zones: id, name, description (opcional)

---

## 8. Direcciones de Cliente

### Propiedades
| Campo | Tipo | Requerido |
|-------|------|-----------|
| label | String | Sí | (ej: "Casa", "Trabajo") |
| street | String | Sí |
| number | String | Sí |
| reference | String | No | Punto de referencia |
| city | String | Sí |
| state | String | No |
| postalCode | String | No |
| country | String | No |
| isDefault | Boolean | No |

### Reglas
- Un cliente puede tener múltiples direcciones
- Solo UNA puede ser default a la vez
- Si se marcan dos como default, solo la última prevalece
- Si no hay default, se asigna la primera
- Las direcciones están asociadas a un cliente en un negocio específico

---

## 9. Autenticación y Seguridad

### Proveedores
- AWS Cognito (Identity Provider principal)
- JWT local (fallback)

### Flujos

#### Sign In
- Email + contraseña contra Cognito
- Retorna JWT con claims: email, subject
- Si contraseña es temporal (primer login) → requiere cambio inmediato

#### Sign Up (Cliente)
- Perfil: DEFAULT
- Crea usuario en Cognito si no existe
- Estado: APPROVED inmediato

#### Sign Up Delivery
- Perfil: Delivery
- No puede duplicarse (email + business + Delivery debe ser único)
- Estado: PENDING (requiere aprobación)

#### 2FA (Two-Factor Authentication)
- **Setup**: Genera secret Base32 de 20 bytes → URI otpauth://totp
- **Algoritmo**: SHA1, 6 dígitos, período 30 segundos
- **Verify**: Compara código TOTP del usuario vs calculado
- **Uso**: Requerido para operaciones sensibles (aprobación de negocios)

#### Recuperación de contraseña
1. `PasswordRecovery` → Cognito envía código por email
2. `ConfirmPasswordRecovery` → Email + código + nueva contraseña

#### Cambio de contraseña
- `ChangePassword` → Usuario autenticado cambia directamente

### Validación de email
- Patrón: `.+@.+\..+`
- Mensaje: "El campo email debe tener formato de email. Valor actual: '{value}'"

### Tipos de función backend
- `Function` — Pública, sin autenticación
- `SecuredFunction` — Requiere JWT válido de Cognito

### Resolución de identidad
- Desde claim `email` del JWT
- O desde claim `subject`
- O desde header `X-Debug-User` (solo desarrollo)

---

## 10. Flujos de Registro

### Cliente
1. Sign Up con perfil DEFAULT → APPROVED inmediato
2. Puede crear órdenes en cualquier negocio aprobado

### Negocio
1. `RegisterBusiness` (cualquiera) → PENDING
2. `ReviewBusinessRegistration` (PlatformAdmin + 2FA) → APPROVED/REJECTED
3. Si APPROVED: crea BusinessAdmin en Cognito y asigna perfil

### Saler
1. `RegisterSaler` (solo BusinessAdmin)
2. Crea usuario en Cognito si no existe
3. Estado: APPROVED inmediato
4. No puede duplicarse para el mismo negocio

### Delivery (dos caminos)

**Camino 1: Sign Up Delivery**
1. Repartidor se registra → PENDING
2. Espera aprobación de BusinessAdmin

**Camino 2: Request Join Business**
1. Repartidor autenticado solicita unirse
2. Si `autoAcceptDeliveries = true` → APPROVED inmediato
3. Si `autoAcceptDeliveries = false` → PENDING → ReviewJoinBusiness → APPROVED/REJECTED

### Asignación directa
- `AssignProfile` (solo PlatformAdmin)
- Asigna cualquier perfil con estado APPROVED inmediato

---

## Gaps conocidos

> Esta sección documenta vacíos detectados en las reglas de negocio actuales.

1. **Sin validación de transiciones de estado**: Las órdenes no validan que la transición de estado sea legal (ej: de PENDING a DELIVERED directamente)
2. **Sin notificaciones**: No hay sistema de notificaciones push para cambios de estado de órdenes
3. **Sin historial de cambios**: No se guarda log de quién cambió el estado de una orden y cuándo
4. **Sin cancelación con motivo**: CANCELLED no requiere motivo ni tiene ventana de tiempo
5. **Sin stock automático**: stockQuantity existe pero no se decrementa al crear órdenes
6. **Sin horarios de negocio**: No hay modelo de horarios de apertura/cierre
7. **Sin zonas de cobertura**: No hay modelo de áreas geográficas de entrega
8. **Sin tarifas de delivery**: No hay cálculo de costo de envío
9. **Sin calificaciones**: No hay sistema de rating para repartidores ni negocios
10. **Sin métricas de SLA**: No hay tracking de tiempos prometidos vs reales
