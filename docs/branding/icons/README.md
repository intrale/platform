# Paquete de íconos oficiales

Los recursos binarios del isotipo se almacenan como archivos Base64 dentro de `docs/branding/icon-pack`. Para materializarlos en las plataformas (Android, iOS y web) ejecutá la tarea de Gradle:

```bash
./gradlew :app:composeApp:syncBrandingIcons
```

El build de Gradle llama automáticamente a esta tarea antes de compilar, y también se ejecuta desde `init.sh`, por lo que los íconos siempre estarán disponibles sin necesidad de versionar los binarios.
