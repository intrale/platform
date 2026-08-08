# Plantilla de Criterios de Aceptación — BDD

> Usada por `/po acceptance <issue>` para generar scenarios completos.

---

## Categorías obligatorias de scenarios

Todo issue funcional DEBE tener scenarios en estas 7 categorías:

### 1. Happy Path
El flujo principal que el usuario espera. Sin errores, datos válidos, permisos correctos.

```gherkin
Escenario: [Descripción del flujo exitoso]
  Dado que [precondición: usuario autenticado, datos existentes, estado previo]
  Cuando [acción principal del usuario]
  Entonces [resultado esperado visible para el usuario]
  Y [efecto secundario: datos persistidos, estado cambiado, notificación enviada]
```

### 2. Validación de entrada
Datos inválidos, campos vacíos, formatos incorrectos.

```gherkin
Escenario: [Campo X] con valor inválido
  Dado que [precondición]
  Cuando [acción con dato inválido]
  Entonces el sistema muestra error "[mensaje específico]"
  Y NO se modifica el estado previo
```

**Campos a validar siempre:**
- Campos requeridos vacíos
- Campos con formato incorrecto (email, teléfono, fecha)
- Campos con longitud fuera de rango
- Campos numéricos negativos o cero cuando no aplica

### 3. Permisos y autorización
Acceso denegado, roles incorrectos, tokens expirados.

```gherkin
Escenario: Usuario sin perfil [Perfil] intenta [acción]
  Dado que el usuario tiene perfil [otro perfil] en el negocio
  Cuando intenta [acción restringida]
  Entonces el sistema responde 403 Forbidden
  Y NO se ejecuta la acción
```

**Verificar siempre:**
- Sin token (401)
- Token expirado (401)
- Perfil incorrecto para la acción (403)
- Perfil correcto pero en otro negocio (403)
- Perfil PENDING (no APPROVED) (403)

### 4. Estados y transiciones
Transiciones de estado válidas e inválidas.

```gherkin
Escenario: Transición de [Estado A] a [Estado B]
  Dado que [entidad] está en estado [Estado A]
  Cuando [actor] cambia el estado a [Estado B]
  Entonces el estado se actualiza a [Estado B]
  Y [efectos secundarios del cambio]

Escenario: Transición inválida de [Estado A] a [Estado C]
  Dado que [entidad] está en estado [Estado A]
  Cuando [actor] intenta cambiar el estado a [Estado C]
  Entonces el sistema rechaza la transición
  Y el estado permanece en [Estado A]
```

### 5. Edge cases
Situaciones límite, concurrencia, datos duplicados.

```gherkin
Escenario: [Descripción del caso límite]
  Dado que [condición especial o límite]
  Cuando [acción]
  Entonces [comportamiento esperado en el límite]
```

**Casos comunes:**
- Entidad ya existe (duplicado)
- Lista vacía (sin resultados)
- Último elemento eliminado
- Operación concurrente sobre misma entidad
- Valores en el límite (máximo, mínimo)
- Caracteres especiales en campos de texto

### 6. UX y feedback
Mensajes al usuario, loading states, confirmaciones.

```gherkin
Escenario: Feedback visual durante [operación]
  Dado que el usuario está en [pantalla]
  Cuando ejecuta [acción que tarda]
  Entonces se muestra indicador de carga
  Y al completar se muestra [mensaje de éxito / resultado]
  Y el indicador de carga desaparece
```

**Verificar siempre:**
- Loading state durante operaciones de red
- Mensaje de éxito tras acción exitosa
- Mensaje de error claro y accionable
- Botones deshabilitados durante operación (prevenir doble submit)
- Navegación coherente tras completar acción

### 7. Datos y persistencia
Que los datos se guarden correctamente y sobrevivan a reinicios.

```gherkin
Escenario: Datos de [entidad] persisten correctamente
  Dado que el usuario creó/modificó [entidad] con [datos]
  Cuando consulta [entidad] nuevamente
  Entonces los datos mostrados coinciden con los ingresados
  Y los timestamps son correctos
```

---

## Checklist estándar de condiciones de done

Toda implementación debe cumplir TODAS estas condiciones:

### Funcional
- [ ] Happy path funciona end-to-end
- [ ] Todas las validaciones de entrada implementadas con mensajes claros
- [ ] Permisos verificados (401 sin token, 403 sin perfil)
- [ ] Transiciones de estado validadas (solo las permitidas)
- [ ] Edge cases manejados sin crash

### UX
- [ ] Loading states visibles durante operaciones de red
- [ ] Mensajes de error claros y accionables (no errores genéricos)
- [ ] Feedback de éxito tras acciones completadas
- [ ] Navegación coherente (back, forward, deep link)
- [ ] No hay doble submit posible

### Técnico
- [ ] Tests unitarios con cobertura de happy path + error path
- [ ] Logger presente en todas las clases nuevas
- [ ] Patrón Do/Result implementado correctamente
- [ ] Strings via resString (no stringResource directo)
- [ ] StatusCode con valor numérico y descripción en responses

### Datos
- [ ] Datos persisten correctamente en DynamoDB
- [ ] Datos se muestran correctamente al re-consultar
- [ ] No hay data leak entre negocios (aislamiento multi-tenant)
- [ ] Timestamps en ISO-8601

---

## Ejemplo completo

### Issue: "Agregar funcionalidad de cancelar orden como cliente"

```gherkin
# 1. Happy Path
Escenario: Cliente cancela orden en estado PENDING
  Dado que el cliente tiene una orden en estado PENDING
  Cuando presiona "Cancelar orden" y confirma
  Entonces la orden cambia a estado CANCELLED
  Y se muestra mensaje "Orden cancelada exitosamente"
  Y la orden aparece como cancelada en el historial

# 2. Validación de entrada
Escenario: Cancelar orden sin motivo cuando es requerido
  Dado que el negocio requiere motivo de cancelación
  Cuando el cliente intenta cancelar sin escribir motivo
  Entonces se muestra error "Debe ingresar un motivo de cancelación"
  Y la orden permanece en su estado actual

# 3. Permisos y autorización
Escenario: Cliente intenta cancelar orden de otro cliente
  Dado que existe una orden de otro cliente
  Cuando el cliente intenta cancelarla
  Entonces el sistema responde 403
  Y la orden no se modifica

Escenario: Repartidor intenta cancelar orden como cliente
  Dado que el usuario tiene perfil Delivery (no Client)
  Cuando intenta cancelar una orden de cliente
  Entonces el sistema responde 403

# 4. Estados y transiciones
Escenario: Cancelar orden en estado DELIVERING
  Dado que la orden está en estado DELIVERING
  Cuando el cliente intenta cancelarla
  Entonces el sistema rechaza con "No se puede cancelar una orden en reparto"
  Y la orden permanece en DELIVERING

Escenario: Cancelar orden ya entregada
  Dado que la orden está en estado DELIVERED
  Cuando el cliente intenta cancelarla
  Entonces el sistema rechaza con "No se puede cancelar una orden entregada"

# 5. Edge cases
Escenario: Cancelar orden mientras el negocio la está confirmando
  Dado que la orden está en PENDING
  Y el negocio está procesando la confirmación simultáneamente
  Cuando el cliente cancela
  Entonces prevalece la cancelación (last-write-wins o conflicto explícito)

# 6. UX y feedback
Escenario: Diálogo de confirmación antes de cancelar
  Dado que el cliente presiona "Cancelar orden"
  Cuando aparece el diálogo de confirmación
  Entonces muestra "¿Estás seguro de cancelar esta orden?"
  Y ofrece opciones "Sí, cancelar" y "No, volver"

Escenario: Loading state durante cancelación
  Dado que el cliente confirma la cancelación
  Cuando se envía la request al backend
  Entonces se muestra spinner en el botón
  Y el botón se deshabilita (prevenir doble click)

# 7. Datos y persistencia
Escenario: Orden cancelada persiste correctamente
  Dado que el cliente canceló una orden
  Cuando cierra y reabre la app
  Entonces la orden aparece como CANCELLED en el historial
  Y el timestamp de actualización refleja el momento de cancelación
```

### Condiciones de done específicas
- [ ] Endpoint `PUT /{business}/client/orders/{id}/cancel` implementado
- [ ] Solo el cliente dueño de la orden puede cancelar
- [ ] Solo cancelable desde estados: PENDING, CONFIRMED, PREPARING
- [ ] No cancelable desde: READY, DELIVERING, DELIVERED, CANCELLED
- [ ] Diálogo de confirmación en UI
- [ ] Test unitario del Do con happy path y error path
- [ ] Test E2E del endpoint (200, 403, 409)
