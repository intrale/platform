# Registro de usuario por perfil
Relacionado con #59.

Se añadieron cuatro pantallas en el módulo `app`:
`SignUpScreen`, `SignUpPlatformAdminScreen`, `SignUpDeliveryScreen` y `SignUpSalerScreen`.
Cada una muestra un campo para ingresar el correo electrónico y un botón **"Registrarme"**.

Al presionar el botón se invoca la acción correspondiente del paquete `asdo`,
la cual consume los endpoints expuestos por el módulo `users`.
