# Auditoría de documentación (Issue #285)

Este informe releva los archivos presentes en `docs/` y resume el estado actual de la documentación para los módulos `app`, `backend` y `users`. La columna **Estado** indica si la información sigue alineada con el código ("Vigente") o si requiere ajustes detectados durante la auditoría ("Ajustar").

## Inventario por módulo

### Módulo `app`
| Documento | Ruta | Tipo | Estado |
|-----------|------|------|--------|
| Arquitectura técnica | `docs/arquitectura-app.md` | Arquitectura | Vigente |
| Rediseño de login | `docs/login-redesign.md` | UX/Flujos | Vigente |
| Registro por perfil | `docs/signup-por-perfil.md` | UX/Flujos | Vigente |
| Manejo de errores en clases `Do` | `docs/manejo-errores-do.md` | Operación | Vigente |
| Buenas prácticas de recursos | `docs/buenas-practicas-recursos.md` | Operación | Vigente |
| Normalización de Compose resources | `docs/error-de-compilacion-compose-resources.md` | Operación | Vigente |
| Recuperar íconos en Android | `docs/iconos-android-no-visibles.md` | Operación | Vigente |
| Kit de íconos + botón primario | `docs/kit-iconos-boton-primario.md` | UX/Branding | Vigente |
| Guía de `IntralePrimaryButton` | `docs/ui/intrale-primary-button.md` | UX/Componentes | Vigente |
| Guía de `IntraleTheme` | `docs/ui/intrale-theme.md` | UX/Design System | Vigente |
| Paquete de íconos oficiales | `docs/branding/icons/README.md` | Assets | Vigente |
| Icon pack Base64 | `docs/branding/icon-pack/**` | Assets | Vigente |

### Módulo `backend`
| Documento | Ruta | Tipo | Estado |
|-----------|------|------|--------|
| Arquitectura técnica | `docs/arquitectura-backend.md` | Arquitectura | **Ajustar** |

### Módulo `users`
| Documento | Ruta | Tipo | Estado |
|-----------|------|------|--------|
| Arquitectura técnica | `docs/arquitectura-users.md` | Arquitectura | Vigente |
| Asignación de perfiles | `docs/assign-profile.md` | Endpoint | Vigente |
| Autoaceptación de deliveries | `docs/autoaccept-deliveries.md` | Endpoint | Vigente |
| Cambio de contraseña | `docs/change_password.md` | Endpoint | **Ajustar** |
| Recuperación de contraseña | `docs/password-recovery.md` | Endpoint | **Ajustar** |
| Registro de negocio | `docs/register-business.md` | Flujo mixto (backend/app) | Vigente |
| Registro de vendedores | `docs/register-saler.md` | Endpoint | Vigente |
| Solicitar unión a negocio | `docs/request-join-business.md` | Endpoint | Vigente |
| Revisar unión a negocio | `docs/review-join-business.md` | Endpoint | Vigente |
| Buscar negocios | `docs/search-businesses.md` | Endpoint | **Ajustar** |
| Autenticación en dos pasos | `docs/two_factor_authentication.md` | Endpoint/Flujo | **Ajustar** |

### Documentación transversal
| Documento | Ruta | Tipo | Estado |
|-----------|------|------|--------|
| Variables de entorno | `docs/variables-entorno.md` | Operación | Vigente |
| Refinamiento de tareas | `docs/refinamiento-tareas.md` | Operación | Vigente |
| Reglas Codex para loggers/status | `docs/codex-reglas-loggers-statuscode.md` | Lineamientos de automatización | Vigente |
| Uso de loggers y estructura de respuestas | `docs/loggers-y-statuscode.md` | Lineamientos de desarrollo | **Ajustar** |

## Observaciones adicionales
- El archivo `README.md` en la raíz aún describe la app como "aplicación Android"; debe actualizarse para reflejar el alcance multiplataforma documentado en `docs/arquitectura-app.md`.
- Las guías marcadas como **Ajustar** son las que alimentarán el nuevo issue de seguimiento solicitado en #285.
