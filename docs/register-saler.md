# Registro de vendedores (`registerSaler`)
Relacionado con #12.

## Resumen funcional
El alta de vendedores quedó restringida a usuarios con perfil `BusinessAdmin`. El endpoint protegido `POST /{business}/registerSaler`
recibe el correo electrónico del vendedor, valida el token del solicitante y aprueba la relación `UserBusinessProfile` con estado
`APPROVED`.

## Backend
- Implementación principal: `/workspace/platform/users/src/main/kotlin/ar/com/intrale/RegisterSaler.kt`.
- Valida el cuerpo usando Konform (`RegisterSalerRequest`).
- Obtiene el email del Business Admin autenticado mediante `cognito.getUser` y verifica que exista una relación aprobada en la
tabla `userbusinessprofile` con perfil `BusinessAdmin`.
- Invoca `adminCreateUser` en Cognito reutilizando el manejo de `UsernameExistsException`.
- Persiste o actualiza la relación vendedor-negocio con `UserBusinessProfileUtils.upsertUserBusinessProfile` en estado
  `APPROVED` y perfil `Saler`.
- Escenarios de error:
  - `400 Bad Request` cuando el email es inválido o falta el cuerpo.
  - `401 Unauthorized` si falta el token o el solicitante no posee perfil `BusinessAdmin` aprobado para el negocio.
  - `409 Conflict` cuando ya existe una relación `APPROVED` para el mismo vendedor y negocio.

## Aplicación Compose
- Pantalla interna: `/workspace/platform/app/composeApp/src/commonMain/kotlin/ui/sc/RegisterSalerScreen.kt`.
  - Disponible desde el Home de Business Admin y reutiliza `callService` para mostrar feedback.
  - Al completar el registro limpia el formulario y muestra un `Snackbar` de confirmación.
- ViewModel: `/workspace/platform/app/composeApp/src/commonMain/kotlin/ui/sc/RegisterSalerViewModel.kt` con validación de correo.
- Caso de uso: `/workspace/platform/app/composeApp/src/commonMain/kotlin/asdo/DoRegisterSaler.kt`, que toma el token guardado en
  `CommKeyValueStorage` y delega en el servicio HTTP.
- Servicio HTTP: `/workspace/platform/app/composeApp/src/commonMain/kotlin/ext/ClientRegisterSalerService.kt`, que invoca el
  endpoint con el header `Authorization` y traduce las respuestas a `RegisterSalerResponse` o `ExceptionResponse`.

## Contrato HTTP
```json
POST /{business}/registerSaler
Content-Type: application/json
Authorization: <access_token>

{
  "email": "saler@example.com"
}
```

- **Respuesta exitosa:** `200 OK` sin cuerpo adicional.
- **Errores controlados:**
  - `400` para formato de correo inválido.
  - `401` si el token es inválido o el usuario carece del perfil requerido.
  - `409` cuando el vendedor ya está aprobado para ese negocio.
