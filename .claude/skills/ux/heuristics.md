# Heuristicas de Evaluacion UX — Intrale Platform

> Base de conocimiento del UX Specialist.
> Fundamentadas en: Jakob Nielsen (heuristicas de usabilidad), Don Norman (affordances y diseño emocional),
> Luke Wroblewski (mobile first y diseño de formularios).
> Estandar duro: WCAG 2.2 AA. Estandares operativos: Material Design 3 + Apple HIG.
> Ultima actualizacion: 2026-04-04.

---

## Las 15 Heuristicas de Intrale

### 1. Visibilidad del estado del sistema
El usuario siempre debe saber que esta pasando.

**Evaluar:**
- ¿Hay indicador de carga durante operaciones de red?
- ¿Los botones cambian estado al presionarse (pressed, disabled)?
- ¿El progreso de operaciones largas es visible (barra, porcentaje)?
- ¿El usuario sabe en que paso esta de un flujo multi-paso?
- ¿Los estados de conexion/desconexion son visibles?

**En Intrale:** Loading states en cada pantalla que hace request HTTP. Progress bar en flujos como checkout. Badge de notificaciones actualizado.

---

### 2. Correspondencia sistema-mundo real
El sistema debe hablar el idioma del usuario, no del programador.

**Evaluar:**
- ¿Los terminos son los que usa el usuario cotidianamente?
- ¿Los iconos son reconocibles sin texto?
- ¿Las metaforas son apropiadas para el contexto argentino?
- ¿Las unidades son las correctas (ARS, kg, km)?
- ¿Los formatos de fecha/hora son locales?

**En Intrale:** "Pedido" (no "Order"), "Repartidor" (no "Delivery driver"), precios en $ ARS, direcciones con formato argentino.

---

### 3. Control y libertad del usuario
El usuario debe poder deshacer, cancelar y navegar sin sentirse atrapado.

**Evaluar:**
- ¿Se puede volver atras en cada paso?
- ¿Hay opcion de cancelar operaciones en progreso?
- ¿Los cambios criticos tienen confirmacion?
- ¿El usuario puede modificar lo que ya envio (dentro de lo razonable)?
- ¿Los gestos de navegacion funcionan (swipe back, pull to refresh)?

**En Intrale:** Back button funcional en todo momento. Cancelar pedido antes de confirmacion. Editar perfil sin perder datos.

---

### 4. Consistencia y estandares
Los mismos patrones, siempre, en toda la app.

**Evaluar:**
- ¿Los botones primarios se ven iguales en todas las pantallas?
- ¿Los formularios siguen el mismo layout (label arriba, hint dentro)?
- ¿Los mensajes de error tienen el mismo formato?
- ¿Los colores de estado son consistentes (rojo=error, verde=exito)?
- ¿La navegacion sigue el mismo patron en todos los flujos?
- ¿Los iconos significan lo mismo en todas partes?

**En Intrale:** Botones Material3 estandar. Input fields con OutlinedTextField. Snackbar para feedback. AppBar con titulo y back arrow.

---

### 5. Prevencion de errores
Es mejor prevenir que curar.

**Evaluar:**
- ¿Los inputs tienen mascara o formato automatico? (email, telefono)
- ¿Los campos numericos solo aceptan numeros?
- ¿Los botones destructivos estan separados de los constructivos?
- ¿Los formularios deshabilitan submit hasta que son validos?
- ¿Las acciones irreversibles tienen confirmacion explicita?
- ¿Los valores por defecto son razonables?

**En Intrale:** Teclado email para campos de email. Validacion inline con Konform. Confirmacion antes de cancelar pedido. Default `autoAcceptDeliveries = false`.

---

### 6. Reconocimiento antes que recuerdo
Minimizar la carga de memoria del usuario.

**Evaluar:**
- ¿Las opciones estan visibles o hay que recordarlas?
- ¿Los ultimos valores usados se sugieren?
- ¿El contexto (negocio, perfil activo) esta siempre visible?
- ¿Los formularios pre-llenan datos conocidos?
- ¿La busqueda muestra sugerencias?

**En Intrale:** Negocio activo en el header. Direccion default pre-seleccionada. Historial de pedidos accesible. Autocompletado de campos repetidos.

---

### 7. Flexibilidad y eficiencia de uso
Que el novato pueda y el experto vuele.

**Evaluar:**
- ¿Los flujos frecuentes tienen atajos? (re-pedido, direccion favorita)
- ¿Los usuarios avanzados pueden saltear pasos de onboarding?
- ¿Las acciones masivas son posibles? (marcar varios, seleccionar todos)
- ¿Los teclados son los correctos para cada campo?
- ¿El pull-to-refresh funciona en listas?

**En Intrale:** Repetir ultimo pedido. Direcciones guardadas. Filtros y busqueda en catalogo. Bulk actions para BusinessAdmin.

---

### 8. Diseño estetico y minimalista
Menos ruido, mas señal.

**Evaluar:**
- ¿Cada elemento tiene un proposito?
- ¿La jerarquia visual guia la atencion? (titulos > subtitulos > body)
- ¿Hay suficiente espacio en blanco (breathing room)?
- ¿Los colores se usan con intencion, no decoracion?
- ¿La pantalla se siente "limpia" al primer vistazo?

**En Intrale:** Material3 surfaces. Tipografia con jerarquia clara. Padding consistente (16dp horizontal, 8dp entre elementos). Cards para agrupar contenido relacionado.

---

### 9. Ayuda al usuario para reconocer, diagnosticar y recuperarse de errores
Los errores deben ser utiles, no intimidantes.

**Evaluar:**
- ¿Los mensajes de error explican QUE paso? (no "Error 500")
- ¿Los mensajes sugieren COMO resolverlo?
- ¿Los errores de formulario señalan el campo especifico?
- ¿Los errores de red sugieren reintentar?
- ¿Los errores de autenticacion redirigen a login?

**En Intrale:** "El email ya esta registrado. ¿Queres iniciar sesion?" en lugar de "Email duplicado". Mensajes de validacion bajo cada campo. Boton "Reintentar" en errores de red.

---

### 10. Ayuda y documentacion
Idealmente innecesaria, pero disponible cuando hace falta.

**Evaluar:**
- ¿Los campos complejos tienen tooltips o texto de ayuda?
- ¿Los flujos de onboarding explican la app?
- ¿Hay FAQ o seccion de ayuda accesible?
- ¿Los estados vacios guian al usuario? ("Aun no tenes pedidos. Explora el catalogo")

**En Intrale:** Empty states con call-to-action. Helper text en campos del formulario de registro. Onboarding con carrusel explicativo.

---

### 11. Responsividad y adaptabilidad (extendida)
La app debe funcionar igual de bien en un Moto G que en un iPad.

**Evaluar:**
- ¿Los layouts se adaptan a pantallas chicas (<360dp)?
- ¿Los textos no se cortan ni superponen?
- ¿Los elementos tactiles tienen minimo 48dp?
- ¿La app funciona en modo horizontal?
- ¿Desktop y Web aprovechan el espacio extra?

**En Intrale:** Compose responsive con WindowSizeClass. Padding adaptativo. Web con sidebar, mobile con bottom nav.

---

### 12. Velocidad percibida
La app debe sentirse rapida, aunque no lo sea.

**Evaluar:**
- ¿Hay skeleton screens durante carga?
- ¿Las transiciones son animadas (no saltos)?
- ¿Los datos en cache se muestran mientras se actualiza?
- ¿Las acciones tienen respuesta haptica inmediata?
- ¿Las listas usan paginacion lazy?

**En Intrale:** Optimistic updates donde sea seguro. Placeholders durante carga. Animaciones de transicion con Compose. LazyColumn para listas.

---

### 13. Accesibilidad (WCAG 2.2 AA — estandar duro)
La app debe ser usable por todos. WCAG 2.2 AA es el piso obligatorio, no una aspiracion.

**Evaluar — criterios WCAG 2.2:**
- ¿El contraste cumple 4.5:1 texto normal, 3:1 texto grande y componentes UI? (1.4.3 + 1.4.11)
- ¿Los elementos tienen `contentDescription` para TalkBack/VoiceOver? (1.1.1)
- ¿Los tamaños de texto respetan la configuracion del sistema? (1.4.4)
- ¿Los colores no son el unico indicador de estado? (1.4.1)
- ¿La app funciona sin animaciones? (2.3.3 reduce motion)
- ¿Los targets tactiles cumplen minimo 24x24 CSS px? (2.5.8 — nuevo en WCAG 2.2)
- ¿Las funciones de drag tienen alternativa single-pointer? (2.5.7 — nuevo en WCAG 2.2)
- ¿El focus es visible y consistente? (2.4.7 + 2.4.11 focus not obscured — nuevo en WCAG 2.2)
- ¿Los inputs redundantes se autocompletan? (3.3.7 — nuevo en WCAG 2.2)
- ¿La ayuda contextual esta disponible de forma consistente? (3.2.6 — nuevo en WCAG 2.2)
- ¿La autenticacion no depende de funciones cognitivas? (3.3.8 — nuevo en WCAG 2.2)

**Incumplimiento = defecto critico.** No es una "mejora pendiente" ni un "nice to have".

**En Intrale:** `semantics { contentDescription = ... }` en iconos y botones. Material3 theming respeta dynamic text size. Colores + iconos para estados. Target size 48dp (supera WCAG 2.2 minimo de 24px).

---

### 14. Contexto de uso por rol
Cada rol usa la app en un contexto fisico distinto.

| Rol | Contexto | Prioridades UX |
|-----|----------|---------------|
| Client | En casa/trabajo, sentado, con calma | Descubrimiento, informacion detallada, confianza |
| Delivery | En la calle, una mano, con prisa | Velocidad, botones grandes, minimo texto, geolocalizacion |
| BusinessAdmin | En la cocina/local, interrupciones frecuentes | Dashboard rapido, notificaciones de pedidos, gestion batch |
| Saler | En el local, multitarea | Eficiencia en carga de productos, atajos |
| PlatformAdmin | En oficina, desktop | Tablas, filtros, acciones bulk, reportes |

**En Intrale:** UI del Delivery con botones extra grandes, minimo scroll. BusinessAdmin con dashboard de resumen. PlatformAdmin optimizado para desktop.

---

### 15. Confianza y transparencia
El usuario debe sentir que la app es segura y honesta.

**Evaluar:**
- ¿Los precios incluyen todos los costos? (sin sorpresas)
- ¿Los tiempos estimados son realistas?
- ¿La app explica por que pide permisos? (ubicacion, notificaciones)
- ¿Los datos sensibles estan enmascarados? (contraseña, tarjeta)
- ¿Hay indicadores de seguridad en operaciones sensibles? (2FA, candado)

**En Intrale:** Icono de candado en 2FA. Passwords ocultos por defecto. Desglose de precio en resumen de pedido. Explicacion de permisos antes de pedirlos.

---

## Escala de evaluacion

| Score | Significado | Accion |
|-------|------------|--------|
| ✅ (3) | Cumple la heuristica | Mantener |
| ⚠️ (2) | Cumple parcialmente | Mejorar cuando sea posible |
| ❌ (1) | Viola la heuristica | Corregir con prioridad |
| ⬛ (0) | No aplica | N/A |

**Score total = Suma de scores / (Heuristicas aplicables * 3) * 100**

| Rango | Clasificacion |
|-------|--------------|
| 90-100 | Excelente |
| 75-89 | Bueno |
| 60-74 | Aceptable |
| 40-59 | Necesita mejoras |
| 0-39 | Critico |
