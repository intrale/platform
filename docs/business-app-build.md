# Build de la app de negocios (APP_TYPE=BUSINESS)

Esta variante reutiliza el mismo código KMP y cambia la configuración de build para identificar la app de administradores de negocios.

## Comando de compilación

Ejecutá la tarea de Gradle específica del flavor `business`:

```bash
./gradlew :app:composeApp:assembleBusinessRelease
```

- La variante `business` fija `APP_TYPE=BUSINESS` por defecto cuando el nombre de la tarea contiene "Business".
- Usa `applicationId` separado (`ar.com.intrale.business` por defecto) y placeholders de ícono/nombre propios ("Intrale Negocios").
- Si necesitás forzar el tipo de app, podés pasar `-PappType=BUSINESS` explícitamente.
