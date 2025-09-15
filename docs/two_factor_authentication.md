# Autenticación en dos pasos
> Relacionado con #213

Este flujo permite a los usuarios configurar y validar un segundo factor de autenticación.

## Configuración
La pantalla `TwoFactorSetupScreen` solicita al backend el enlace `otpauth://` mediante el endpoint `/2fasetup`.
Al recibirlo intenta abrir la aplicación autenticadora con `openUri()`.
Si no existe una app compatible o ocurre un error, se muestra un QR generado localmente junto con el texto `issuer:account` y el secreto enmascarado.
Desde esta vista es posible copiar solo el valor de `secret`, copiar el enlace completo, buscar una app autenticadora en la tienda o compartir el enlace.
Si al intentar buscar la aplicación de autenticación no se puede abrir la tienda, se muestra el mensaje "No fue posible abrir la aplicación de autenticación".
Si la acción de compartir falla, se informa al usuario con "No se pudo compartir el enlace" y la pantalla continúa disponible.

## Verificación
`TwoFactorVerifyScreen` permite ingresar el código de seis dígitos y lo valida contra el endpoint `/2faverify`.

## Notas
- Se requiere un usuario autenticado para invocar ambos servicios.
- En caso de error se muestran mensajes mediante *snackbar*.
