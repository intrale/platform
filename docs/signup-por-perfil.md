# Registro de usuario por perfil
Relacionado con #59.

Se añadieron tres pantallas principales en el módulo `app`:
`SignUpScreen`, `SignUpPlatformAdminScreen` y `SignUpDeliveryScreen`.
Cada una muestra un campo para ingresar el correo electrónico y un botón **"Registrarme"**.

Al presionar el botón se invoca la acción correspondiente del paquete `asdo`,
la cual consume los endpoints expuestos por el módulo `users`.
Cada acción utiliza un servicio HTTP específico:
`ClientSignUpPlatformAdminService` y `ClientSignUpDeliveryService` según el perfil seleccionado.
El alta de vendedores (`RegisterSalerScreen`) se ejecuta desde `DashboardScreen` (menú interno post-login) y usa `ClientRegisterSalerService`,
que adjunta el token en el header `Authorization`.

## Flujo de selección de perfil

Relacionado con #75.

Se agregó la pantalla `SelectSignUpProfileScreen` que permite elegir el tipo de registro antes de mostrar la pantalla específica.
Desde `Login` ahora aparece el botón **"Registrarme"** que navega a dicha pantalla y, tras autenticarse, el usuario aterriza en `DashboardScreen` para continuar con la gestión interna.
Cada opción lleva a `SignUpPlatformAdminScreen` o `SignUpDeliveryScreen` según corresponda. El registro de vendedores dejó de ser
público y ahora se realiza desde `RegisterSalerScreen`, accesible únicamente para Business Admin autenticados.

### Manejo de respuestas
Ahora cada pantalla de registro utiliza `callService` para mostrar mensajes de éxito o error.
Los `ViewModel` devuelven `Result<DoSignUpResult>` permitiendo feedback consistente con el login.

## Registro de Delivery por negocio

Relacionado con #137.

El formulario de `SignUpDeliveryScreen` ahora incluye un campo adicional para seleccionar el negocio. Este campo posee búsqueda dinámica y sugiere en tiempo real los negocios disponibles mediante el servicio `searchBusinesses` del módulo `users`.

Al enviar el registro se valida que el correo no esté ya registrado como Delivery para el negocio elegido. Si existe, se informa un mensaje de error. De lo contrario, el usuario queda en estado `PENDING` hasta que el Business Admin apruebe su solicitud.
