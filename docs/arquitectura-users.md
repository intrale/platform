# Arquitectura Técnica - Módulo `users`

Este módulo hereda de `backend` y concentra la lógica de gestión de usuarios y perfiles. Forma parte de la arquitectura multimódulo del proyecto.

## 1. Propósito del módulo

Gestiona el ciclo de vida de los usuarios finales: registro, autenticación y administración de perfiles vinculados a negocios. Integra AWS Cognito y mecanismos de verificación en dos pasos.

## 2. Estructura del proyecto

- **Modelos de dominio**: `User`, `Profile`, `UserBusinessProfile`, `Business`, `BusinessState`.
- **Funciones principales**: `SignUp`, `SignIn`, `SignUpPlatformAdmin`, `RegisterSaler`, `PasswordRecovery`, `ConfirmPasswordRecovery`, `RegisterBusiness`, `ReviewBusinessRegistration`, `TwoFactorSetup`, `TwoFactorVerify`.
- **Clases de solicitud y respuesta**: `SignUpRequest`, `SignInRequest`, `SignInResponse`, `PasswordRecoveryRequest`, `ConfirmPasswordRecoveryRequest`, `RegisterBusinessRequest`, `ReviewBusinessRegistrationRequest`, `TwoFactorSetupResponse`, `TwoFactorVerifyRequest`, `ProfilesResponse`.
- **Infraestructura**: `UsersApplication.kt` para Netty, `UsersRequestHandler.kt` para AWS Lambda, configuración específica en `UsersConfig.kt` y bindings en `Modules.kt`.
- **Utilidades**: helpers de validación y pruebas (por ejemplo `TestDynamoDB.kt`).

## 3. Funcionalidades implementadas

- Registro e inicio de sesión de usuarios mediante Cognito.
- Persistencia de la relación usuario-negocio-perfil en la tabla `userbusinessprofile`.
- Recuperación y confirmación de contraseña.
- Registro y revisión de negocios asociados.
- Configuración y verificación de autenticación en dos pasos.

## 4. Perfiles de usuario

- **Platform Admin**: asignación manual.
- **Business Admin**: asignado por un Platform Admin.
- **Delivery**: registro propio, aprobado por un Business Admin.
- **Saler**: registrado por un Business Admin.
- **Client**: registro autónomo.

## 5. Casos de uso soportados

- Asignación de perfiles y administración de usuarios.
- Registro y aprobación de negocios y miembros de un negocio.

## 6. Seguridad e inyección de dependencias

El módulo utiliza `SecuredFunction` para proteger funciones sensibles y registra sus componentes en Kodein DI, permitiendo su ejecución tanto embebida como en AWS Lambda.
- `RegisterSaler` exige un token válido, verifica que el solicitante posea el perfil `BusinessAdmin` aprobado y actualiza la relación `UserBusinessProfile` del vendedor en estado `APPROVED`.

