# Cambio de contraseña
> Pertenece al módulo `users` dentro de la arquitectura multimódulo del proyecto.

Endpoint que permite a un usuario autenticado modificar su contraseña.

## Endpoint
`/v1/users/change-password`

## Parámetros
- `oldPassword`: Contraseña actual del usuario.
- `newPassword`: Nueva contraseña.

## Respuestas
- **200**: Contraseña modificada correctamente.
- **401**: Token inválido o sin permisos.
- **400**: Error de validación del request.

## Notas técnicas
Esta funcionalidad ahora invoca `changePassword` sin utilizar `use` para evitar
que se cierre el `CognitoIdentityProviderClient`. El ciclo de vida del cliente
es administrado por la inyección de dependencias.
