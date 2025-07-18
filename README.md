# platform

Plataforma base de Intrale que reúne los módulos principales para el backend y la aplicación móvil.

## Introducción
Este proyecto incluye una arquitectura modular en Kotlin. Se compone de servicios de backend con Ktor y de una aplicación Android basada en Jetpack Compose.

## Inicio rápido
1. Clonar el repositorio:
   ```bash
   git clone https://github.com/intrale/platform.git
   cd platform
   ```
2. Ejecutar el módulo `backend` en modo embebido:
   ```bash
   ./gradlew :backend:run
   ```
3. Construir e instalar la aplicación `app`:
   ```bash
   ./gradlew :app:installDebug
   ```

## Estructura de carpetas
- `backend/` - infraestructura y lógica común del servidor.
- `users/` - extensiones para gestión de usuarios y perfiles.
- `app/` - aplicación móvil escrita en Compose.
- `docs/` - documentación técnica de la plataforma.
- `gradle/` y archivos `*.gradle.kts` - configuración de construcción.
