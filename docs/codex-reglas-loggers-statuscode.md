# Configuración de Codex para validar loggers y `statusCode`

Este archivo describe las reglas que deben implementar los agentes de Codex para garantizar:

1. Que toda clase incorpore un logger basado en `org.slf4j.Logger`.
2. Que las respuestas de los servicios incluyan un `statusCode` con código numérico y descripción.

Los agentes deben analizar los cambios de código y marcar como inválidos aquellos pull requests que no cumplan con estas convenciones.

Relacionado con #147.
