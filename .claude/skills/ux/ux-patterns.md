# Patrones UX — Intrale Platform

> Guia de patrones UX del proyecto. Fuente de verdad para consistencia visual e interactiva.
> Actualizado por el UX Specialist cuando se detectan o establecen nuevos patrones.
> Ultima actualizacion: 2026-03-01.

---

## 1. Tokens de diseño

### Colores semanticos

| Token | Uso | Material3 |
|-------|-----|-----------|
| Primary | Botones principales, FAB, links | `MaterialTheme.colorScheme.primary` |
| Secondary | Chips, badges, elementos secundarios | `MaterialTheme.colorScheme.secondary` |
| Error | Errores, validaciones, destructivos | `MaterialTheme.colorScheme.error` |
| Surface | Fondo de cards, dialogs | `MaterialTheme.colorScheme.surface` |
| Background | Fondo de pantalla | `MaterialTheme.colorScheme.background` |
| OnPrimary | Texto sobre primary | `MaterialTheme.colorScheme.onPrimary` |

**Regla:** NUNCA usar colores hardcodeados. SIEMPRE usar tokens de MaterialTheme.

### Colores de estado

| Estado | Color | Icono complementario |
|--------|-------|---------------------|
| Exito | Green / `Color(0xFF4CAF50)` | check_circle |
| Error | Error token | error |
| Warning | Yellow / `Color(0xFFFFC107)` | warning |
| Info | Primary token | info |
| Pendiente | Gray / `Color(0xFF9E9E9E)` | schedule |
| En progreso | Primary token | sync |

**Regla:** El color NUNCA debe ser el unico indicador. Siempre acompañar con icono y/o texto.

### Tipografia

| Nivel | Style | Uso |
|-------|-------|-----|
| Display | `displayLarge/Medium/Small` | Splash, onboarding hero |
| Headline | `headlineLarge/Medium/Small` | Titulos de pantalla |
| Title | `titleLarge/Medium/Small` | Secciones, cards headers |
| Body | `bodyLarge/Medium/Small` | Contenido, descripciones |
| Label | `labelLarge/Medium/Small` | Botones, chips, captions |

**Regla:** No mas de 3 niveles tipograficos por pantalla. Headline + Body + Label es el combo mas comun.

### Espaciado

| Token | Valor | Uso |
|-------|-------|-----|
| xs | 4.dp | Entre iconos y texto inline |
| sm | 8.dp | Entre elementos del mismo grupo |
| md | 16.dp | Padding horizontal de pantalla, entre secciones |
| lg | 24.dp | Entre grupos de contenido |
| xl | 32.dp | Padding vertical de pantalla, separacion mayor |

**Regla:** Padding horizontal de pantalla = 16.dp. Consistente en todas las pantallas.

---

## 2. Componentes estandar

### Botones

| Tipo | Uso | Componente |
|------|-----|-----------|
| Filled | Accion principal (1 por pantalla) | `Button()` |
| Outlined | Acciones secundarias | `OutlinedButton()` |
| Text | Acciones terciarias, links | `TextButton()` |
| FAB | Accion flotante principal | `FloatingActionButton()` |
| Icon | Acciones en toolbar/appbar | `IconButton()` |

**Reglas:**
- Maximo 1 boton Filled por pantalla
- Botones destructivos: Outlined con color Error, NUNCA Filled
- Botones de submit: full width en mobile, auto-width en desktop
- Deshabilitar durante operaciones async (`enabled = !state.isLoading`)

### Inputs

```
┌─ Label ──────────────────────────┐
│ [icono] Placeholder text         │
│                                  │
└──────────────────────────────────┘
  Helper text o error message
```

| Tipo | Componente | Cuando usar |
|------|-----------|-------------|
| Outlined | `OutlinedTextField()` | Default para formularios |
| Password | `OutlinedTextField()` + toggle visibility | Campos de contraseña |
| Search | `SearchBar()` / custom | Busqueda con icono y clear |
| Multiline | `OutlinedTextField(maxLines=N)` | Descripciones, notas |

**Reglas:**
- SIEMPRE con label (no solo placeholder)
- Error state: borde rojo + mensaje debajo del campo
- Teclado apropiado: `KeyboardType.Email`, `KeyboardType.Number`, `KeyboardType.Password`
- Max width en desktop (no ocupar toda la pantalla)

### Cards

```
┌──────────────────────────────────┐
│ [Imagen o icono]                 │
│ Titulo                     [>]   │
│ Subtitulo / descripcion          │
│                                  │
│ [Accion 1]  [Accion 2]          │
└──────────────────────────────────┘
```

**Reglas:**
- `ElevatedCard` para contenido interactivo (clickable)
- `OutlinedCard` para contenido informativo (read-only)
- Padding interno: 16.dp
- Corner radius: 12.dp (Material3 default)
- Maximo 2 acciones por card

### Dialogs

| Tipo | Uso |
|------|-----|
| Confirm | Acciones destructivas, cambios importantes |
| Info | Mensajes informativos sin accion requerida |
| Input | Solicitar un dato simple |

**Reglas:**
- Titulo claro y corto
- Maximo 2 botones (positivo a la derecha, negativo a la izquierda)
- NUNCA usar dialog para mostrar listas largas — usar pantalla completa
- Boton destructivo con color Error

### Listas

- `LazyColumn` SIEMPRE (nunca `Column` para listas dinamicas)
- Divider entre items (si no usan cards)
- Pull-to-refresh en listas con datos remotos
- Empty state cuando la lista esta vacia
- Loading skeleton (3-5 items placeholder) durante carga

---

## 3. Patrones de estado

### Ciclo de vida de una pantalla

```
[Cargando] → [Contenido] → [Error] → [Reintentar] → [Cargando] → [Contenido]
                              ↓
                         [Vacio/Empty]
```

Toda pantalla debe manejar MINIMO estos 4 estados:

| Estado | UI | Componente |
|--------|-----|-----------|
| Loading | Skeleton o CircularProgressIndicator | `CircularProgressIndicator()` |
| Content | La pantalla completa | Composables del feature |
| Error | Mensaje + boton reintentar | Custom ErrorState composable |
| Empty | Ilustracion + mensaje + CTA | Custom EmptyState composable |

### Patron de UIState en ViewModel

```kotlin
data class FeatureUIState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val data: DataType? = null,
    // Campos especificos del feature
)
```

**En el Screen:**
```kotlin
when {
    state.isLoading -> LoadingState()
    state.error != null -> ErrorState(message = state.error, onRetry = { vm.retry() })
    state.data == null -> EmptyState(message = "...", onAction = { ... })
    else -> ContentState(data = state.data)
}
```

---

## 4. Patrones de navegacion

### Mobile (Android / iOS)

```
┌─────────────────────────┐
│ [←] Titulo        [⋮]  │  ← Top App Bar
├─────────────────────────┤
│                         │
│     Contenido           │  ← Scrollable content
│                         │
├─────────────────────────┤
│ 🏠  📦  🛒  👤        │  ← Bottom Navigation (3-5 items)
└─────────────────────────┘
```

### Desktop / Web

```
┌──────────┬──────────────────────────┐
│          │ Titulo            [👤]  │
│  Nav     ├──────────────────────────┤
│  Rail    │                          │
│          │      Contenido           │
│  🏠     │                          │
│  📦     │                          │
│  🛒     │                          │
│  👤     │                          │
│          │                          │
└──────────┴──────────────────────────┘
```

**Reglas:**
- Bottom nav: solo en mobile, 3-5 items
- Nav rail: solo en desktop/web con pantalla ancha
- Back button: SIEMPRE funcional
- Deep links: cada pantalla debe tener ruta unica

---

## 5. Patrones de feedback

### Snackbar (feedback transitorio)

| Tipo | Duracion | Ejemplo |
|------|----------|---------|
| Exito | 3 seg | "Pedido creado exitosamente" |
| Info | 4 seg | "Se actualizo tu perfil" |
| Error | Indefinido (con dismiss) | "No se pudo conectar. Reintentar" |
| Undo | 5 seg | "Direccion eliminada. Deshacer" |

**Reglas:**
- Maximo 1 snackbar visible a la vez
- Posicion: bottom, sobre el bottom nav
- Acciones: maximo 1 (ej: "Deshacer", "Reintentar")

### Loading feedback

| Operacion | Feedback |
|-----------|----------|
| Carga de pantalla | Skeleton screen |
| Submit de formulario | Boton con spinner + disabled |
| Pull to refresh | SwipeRefresh indicator |
| Paginacion | Loading indicator al final de la lista |
| Operacion larga (>3s) | Progress bar con porcentaje |

### Toast/Haptic (mobile)

- Haptic feedback en: tap de boton, swipe action, error validation
- NO en: scroll, navegacion, typing

---

## 6. Patrones especificos por rol

### Client (comprador)

- **Catalogo:** Grid de productos con imagen, nombre, precio. Filtros accesibles.
- **Carrito:** Persistente, accesible desde cualquier pantalla. Badge con count.
- **Checkout:** Wizard de 3 pasos max (direccion → resumen → confirmar).
- **Tracking:** Mapa + estados del pedido en timeline vertical.

### Delivery (repartidor)

- **Dashboard:** Resumen numerico (pendientes, activas, completadas). Acceso con 1 tap.
- **Lista de ordenes:** Cards grandes con direccion, distancia, monto. Swipe to accept.
- **Navegacion:** Integracion con Google Maps / Waze.
- **Estado de entrega:** Botones grandes para cambiar estado. One-handed operation.

### BusinessAdmin (dueño de negocio)

- **Dashboard:** Metricas del dia (ventas, pedidos, repartidores). Grafico simple.
- **Pedidos entrantes:** Notificacion push + sonido. Lista con prioridad por tiempo.
- **Productos:** CRUD con drag & drop para ordenar. Bulk edit.
- **Reportes:** Tablas con export, filtros por fecha.

### PlatformAdmin

- **Dashboard:** Overview de toda la plataforma. Negocios pendientes de aprobacion.
- **Tablas:** DataTable con sort, filter, pagination. Bulk actions.
- **Aprobaciones:** Workflow claro con 2FA. Status badges.

---

## 7. Anti-patrones (NUNCA hacer)

| Anti-patron | Por que es malo | Que hacer en su lugar |
|------------|-----------------|----------------------|
| Pantalla en blanco durante carga | Usuario cree que la app se colgo | Skeleton screen o spinner |
| "Error" sin detalle | Usuario no sabe que paso ni que hacer | Mensaje especifico + sugerencia |
| Boton que no hace nada visible | Usuario hace tap repetido → doble submit | Deshabilitar + spinner |
| Modal dentro de modal | Confusion de capas, perdida de contexto | Navegar a pantalla nueva |
| Scroll horizontal en mobile | Contenido oculto sin indicador | Redesignar para caber en pantalla |
| Texto gris sobre gris | Ilegible, falla accesibilidad | Minimo 4.5:1 contraste |
| Validar solo al submit | Frustracion por descubrir errores tarde | Validacion inline en blur |
| Pop-ups de permisos sin explicacion | Usuario rechaza por miedo | Explicar antes, pedir despues |
| Redirect inesperado | Desorientacion | Mostrar a donde va antes de navegar |
| Informacion critica en tooltip | No accesible en mobile | Mostrar inline o en seccion expandible |

---

## 8. Checklist de nueva pantalla

Antes de dar por terminada una pantalla nueva, verificar:

### Layout
- [ ] Padding horizontal 16.dp
- [ ] Jerarquia tipografica clara (max 3 niveles)
- [ ] Breathing room entre secciones
- [ ] Funciona en 360dp de ancho
- [ ] Funciona en landscape (o bloquea rotacion justificadamente)

### Estados
- [ ] Loading state con skeleton o spinner
- [ ] Empty state con mensaje y CTA
- [ ] Error state con mensaje y reintentar
- [ ] Success feedback (snackbar o cambio visual)

### Interaccion
- [ ] Botones disabled durante carga
- [ ] Teclado correcto por tipo de campo
- [ ] Validacion inline (no solo al submit)
- [ ] Back button funcional
- [ ] Pull to refresh (si tiene datos remotos)

### Accesibilidad
- [ ] Content descriptions en iconos e imagenes
- [ ] Contraste minimo 4.5:1
- [ ] Tamaño tactil minimo 48dp
- [ ] Texto respeta configuracion de tamaño del sistema
- [ ] Estado comunicado con icono + color (no solo color)

### Consistencia
- [ ] Usa componentes estandar del proyecto
- [ ] Sigue los patrones de navegacion definidos
- [ ] Colores semanticos (no hardcodeados)
- [ ] Mensajes en español
- [ ] Strings via `resString()` (no hardcodeados)
