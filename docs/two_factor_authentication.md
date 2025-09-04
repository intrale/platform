# Autenticación en dos pasos
> Relacionado con #61

Este flujo permite a los usuarios configurar y validar un segundo factor de autenticación.

## Configuración
La pantalla `TwoFactorSetupScreen` solicita al backend el enlace `otpauth://` mediante el endpoint `/2fasetup` y lo muestra para ser escaneado o copiado.

## Verificación
`TwoFactorVerifyScreen` permite ingresar el código de seis dígitos y lo valida contra el endpoint `/2faverify`.

## Notas
- Se requiere un usuario autenticado para invocar ambos servicios.
- En caso de error se muestran mensajes mediante *snackbar*.
