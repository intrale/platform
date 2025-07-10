# Variables de entorno requeridas

Este documento enumera las variables de entorno necesarias para ejecutar cada módulo de la plataforma.

## Módulo `users`

Este módulo se apoya en AWS Cognito y DynamoDB. Las variables pueden declararse en el entorno o en el archivo `application.conf`.

| Variable | Descripción |
| --- | --- |
| `AVAILABLE_BUISNESS` | Lista separada por comas con los negocios habilitados. |
| `REGION_VALUE` | Región AWS predeterminada. |
| `ACCESS_KEY_ID` | Clave de acceso para AWS. |
| `SECRET_ACCESS_KEY` | Clave secreta para AWS. |
| `USER_POOL_ID` | Identificador del pool de usuarios en Cognito. |
| `CLIENT_ID` | Identificador de la aplicación en Cognito. |

Estas variables se leen en `Modules.kt` y permiten construir la instancia `UsersConfig`.

## Módulo `backend`

No requiere variables adicionales. Utiliza las que proveen los módulos que lo extienden.

## Módulo `app`

La aplicación móvil no define variables de entorno propias.

Relacionado con #77.
