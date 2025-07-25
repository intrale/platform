# Registro de usuario por perfil
Relacionado con #59.

Se añadieron cuatro pantallas en el módulo `app`:
`SignUpScreen`, `SignUpPlatformAdminScreen`, `SignUpDeliveryScreen` y `SignUpSalerScreen`.
Cada una muestra un campo para ingresar el correo electrónico y un botón **"Registrarme"**.

Al presionar el botón se invoca la acción correspondiente del paquete `asdo`,
la cual consume los endpoints expuestos por el módulo `users`.
Cada acción utiliza un servicio HTTP específico:
`ClientSignUpPlatformAdminService`, `ClientSignUpDeliveryService` y
`ClientSignUpSalerService` según el perfil seleccionado.

## Flujo de selección de perfil

Relacionado con #75.

Se agregó la pantalla `SelectSignUpProfileScreen` que permite elegir el tipo de registro antes de mostrar la pantalla específica.
Desde `Login` ahora aparece el botón **"Registrarme"** que navega a dicha pantalla.
Cada opción lleva a `SignUpPlatformAdminScreen`, `SignUpDeliveryScreen` o `SignUpSalerScreen` según corresponda.

### Manejo de respuestas
Ahora cada pantalla de registro utiliza `callService` para mostrar mensajes de éxito o error.
Los `ViewModel` devuelven `Result<DoSignUpResult>` permitiendo feedback consistente con el login.
