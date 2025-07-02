# Arquitectura Técnica - Módulo `backend`

El proyecto se organiza como un conjunto de módulos Gradle. El módulo `backend` provee la infraestructura común para exponer funciones HTTP o serverless y es utilizado por los módulos de negocio.

## 1. Propósito del módulo

`backend` constituye el núcleo funcional y arquitectónico del sistema. Sirve como base para los demás módulos (por ejemplo, `users`) y está construido en Kotlin con Ktor. Soporta ejecución embebida y en AWS Lambda.

## 2. Tecnologías y frameworks

- **Ktor**: construcción del servidor HTTP y APIs.
- **Kodein DI**: inyección de dependencias para registrar funciones de negocio.
- **Gson**: serialización y deserialización JSON.
- **AWS Cognito**: validación de tokens JWT.
- **AWS Lambda**: ejecución serverless.
- **RateLimiter** (`TokenBucket`): control de peticiones por usuario.

## 3. Componentes principales

- **Application.kt**: inicializa el servidor Netty, instala RateLimiting y configura Kodein. Expone la ruta dinámica `/{business}/{function}` que despacha las funciones registradas en el contenedor DI.
- **Function / SecuredFunction**: interfaces base para implementar nuevas funciones. `SecuredFunction` valida el token JWT antes de ejecutar.
- **LambdaRequestHandler**: permite reutilizar las mismas funciones en AWS Lambda.
- **Request / Response**: clases genéricas para entrada y salida de datos.
- **Excepciones personalizadas**: `RequestValidationException`, `UnauthorizedException`, `ExceptionResponse`.

## 4. Ejecución en ambientes

- **Modo local**: mediante `embeddedServer(Netty)`.
- **Modo AWS Lambda**: ejecuta `LambdaRequestHandler` decodificando el cuerpo Base64 y exponiendo cabeceras CORS.

## 5. Patrón de modularización

`backend` actúa como superclase funcional. Los módulos de negocio importan este módulo y registran sus propias funciones, lo que facilita la reutilización de lógica y la separación de responsabilidades.

