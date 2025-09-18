# Rediseño de Login

Relacionado con #226.

## Resumen
- Se actualizó la pantalla de ingreso para utilizar el botón corporativo `IntralePrimaryButton` con el ícono `ic_login.svg`.
- Se reorganizó el formulario en un contenedor responsivo con campos accesibles, íconos descriptivos y mensajes de error en tiempo real.
- Se incorporó la sección colapsable para cambio obligatorio de contraseña, manteniendo la navegación hacia los flujos secundarios existentes.
- Se reemplazó el fondo por un gradiente accesible definido en `ui/th/Gradients.kt` y se habilitó el soporte para preferencias de movimiento reducidas.

## Accesibilidad
- Los campos muestran `supportingText` con los errores y exponen `semantics { error() }` para lectores de pantalla.
- Se añadieron descripciones de contenido para los íconos y acciones de teclado (`ImeAction`) que facilitan la navegación con hardware y TalkBack.
- El shimmer del botón y las animaciones de rebote se desactivan automáticamente cuando el sistema solicita "Reducir movimiento".

## Validaciones
- El usuario debe ingresar un correo electrónico válido.
- Las contraseñas exigen un mínimo de 8 caracteres y se validan mientras se escribe.
- El requerimiento de cambio de contraseña activa validaciones adicionales para nombre, apellido y nueva clave.

## Navegación
- Se preservaron los accesos a registro, recuperación de contraseña y confirmación de recuperación.
- Al detectar un token previo se dispara la autenticación automática.
