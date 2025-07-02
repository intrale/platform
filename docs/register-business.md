# Flujo de Registro de Negocios

Este documento describe el proceso que permite registrar un nuevo negocio dentro de la plataforma.

## Pasos generales

1. El *Business Admin* envía una solicitud de registro mediante el endpoint correspondiente.
2. El sistema valida la información proporcionada y genera un nuevo registro en la base de datos.
3. El *Platform Admin* revisa la solicitud y decide si aprueba o rechaza el negocio.

## Consideraciones

- Este proceso está relacionado con la funcionalidad principal detallada en el issue #13.
- Los detalles de implementación y pruebas se encuentran en la documentación del módulo `users`.


## Revisión y aprobación de registros

Cuando un negocio queda registrado en estado `PENDING`, un usuario con perfil *Platform Admin* debe revisar la solicitud.

1. El administrador recibe una notificación con los datos del negocio.
2. Utiliza la funcionalidad `ReviewBusinessRegistration` para **aprobar** o **rechazar** la solicitud.
3. Si el negocio es aprobado, se asigna automáticamente el perfil `BUSINESS_ADMIN` al usuario solicitante y el estado pasa a `APPROVED`.
4. Si se rechaza la solicitud, el estado cambia a `REJECTED` y se informa al solicitante.

Para más detalles consultar la clase `ReviewBusinessRegistration` en `/workspace/users/src/main/kotlin/ar/com/intrale/ReviewBusinessRegistration.kt`.

Relacionado con #64.
