# Autenticación en dos pasos
> Relacionado con #213

Este flujo permite a los usuarios configurar y validar un segundo factor de autenticación utilizando códigos TOTP.

## Configuración (`2fasetup`)
- **Endpoint**: `POST /{business}/2fasetup`
- **Headers**: `Authorization` con el token de acceso emitido por Cognito.
- **Respuesta**: `{"statusCode":{"value":200,"description":"OK"},"otpAuthUri":"otpauth://..."}`.

Cuando `TwoFactorSetup` recibe la solicitud:
1. Obtiene el usuario asociado al token mediante `CognitoIdentityProviderClient.getUser`.
2. Genera un secreto aleatorio en Base32 (`generateSecret`).
3. Persiste el secreto en la tabla DynamoDB `userbusinessprofile` a través de `DynamoDbTable<User>`.
4. Devuelve el enlace `otpauth://` con issuer `intrale`, que la app puede abrir o convertir en QR.

Si no se encuentra el correo o hay fallos de persistencia se retorna `ExceptionResponse` con status `500` y el mensaje correspondiente.

## Verificación (`2faverify`)
- **Endpoint**: `POST /{business}/2faverify`
- **Headers**: `Authorization` con token válido.
- **Body**:
  ```json
  {
    "code": "123456"
  }
  ```
  El código debe tener al menos 6 caracteres; de lo contrario se devuelve `400 Bad Request`.
- **Respuesta exitosa**: `{"statusCode":{"value":200,"description":"OK"}}`.

`TwoFactorVerify` busca el secreto almacenado, genera el TOTP esperado con `TimeBasedOneTimePasswordGenerator` y lo compara con el código ingresado. Si difiere o no existe secreto se responde con `ExceptionResponse` y un mensaje descriptivo. Todos los errores de token vuelven como `401 Unauthorized` desde `SecuredFunction`.

## Comportamiento en la app
`TwoFactorSetupScreen` solicita `otpAuthUri` y ofrece abrir la app autenticadora, mostrar un QR y copiar tanto el enlace como el secreto. Luego `TwoFactorVerifyScreen` envía el código a `2faverify`, mostrando *snackbars* ante errores de validación o respuesta del backend.
