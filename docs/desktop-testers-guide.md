# Guía para Testers Desktop — Intrale F&F

> Documento de referencia para testers Friends & Family de la app Desktop/JVM.
> Canal de distribución: GitHub Releases (privado).

---

## ¿Cómo descargar la app?

1. Acceder a la página de releases del repositorio:
   `https://github.com/intrale/platform/releases`

2. Buscar el último release con el tag `desktop-ff-N` (donde N es el número de build)

3. En la sección **Assets**, descargar el instalador correspondiente a tu sistema operativo:
   | Plataforma | Archivo a descargar |
   |------------|---------------------|
   | Windows    | `ar.com.intrale-1.0.0.msi` |
   | Linux      | `ar.com.intrale_1.0.0_amd64.deb` |

> **Nota:** Si el repositorio es privado, necesitás una cuenta de GitHub con acceso al repo `intrale/platform`.
> Si no tenés acceso, pedirle a un administrador que te comparta el link directo de descarga.

---

## Instalación

### Windows (MSI)

1. Descargar el archivo `.msi`
2. Doble click en el instalador
3. Seguir el asistente de instalación (permisos de administrador pueden ser necesarios)
4. La app queda instalada como **ar.com.intrale** en el menú Inicio
5. Al finalizar, buscar "intrale" en el menú Inicio y ejecutar

> Si Windows Defender SmartScreen muestra una advertencia ("aplicación de editor desconocido"),
> hacer click en **"Más información"** → **"Ejecutar de todas formas"**.
> Esto es normal para apps que no tienen firma digital de código (F&F no la requiere).

### Linux (Deb — Ubuntu/Debian)

```bash
# Descargar e instalar
sudo dpkg -i ar.com.intrale_1.0.0_amd64.deb

# Si hay dependencias faltantes
sudo apt-get install -f

# Ejecutar la app
ar.com.intrale
```

La app también debería aparecer en el lanzador de aplicaciones del escritorio.

---

## Actualizaciones

La app Desktop **no tiene actualización automática** en la fase F&F.

Para actualizar:
1. Recibir la notificación de Telegram con el link al nuevo release
2. Descargar el nuevo instalador
3. Instalar sobre la versión anterior (en Windows reemplaza automáticamente)

---

## Reportar problemas

Abrir un issue en: `https://github.com/intrale/platform/issues`

Incluir:
- Sistema operativo y versión (ej: Windows 11, Ubuntu 22.04)
- Número de build (visible en el tag del release: `desktop-ff-N`)
- Descripción del problema y pasos para reproducirlo
- Screenshot o grabación de pantalla si aplica

---

## Referencia técnica (para el equipo)

### Comandos de build

```bash
# Windows (en runner windows-latest)
./gradlew :app:composeApp:packageMsi

# Linux (en runner ubuntu-latest)
./gradlew :app:composeApp:packageDeb

# macOS (requiere runner macOS — no incluido en el workflow actual)
./gradlew :app:composeApp:packageDmg
```

### Paths de salida

| Plataforma | Path |
|------------|------|
| MSI        | `app/composeApp/build/compose/binaries/main/msi/*.msi` |
| Deb        | `app/composeApp/build/compose/binaries/main/deb/*.deb` |
| Dmg        | `app/composeApp/build/compose/binaries/main/dmg/*.dmg` |

### Workflow CI/CD

Archivo: `.github/workflows/distribute-desktop.yml`

**Trigger:** Push a `main` o ejecución manual (`workflow_dispatch`)

**Jobs:**
1. `build-msi` — Windows runner → genera MSI → sube como artifact
2. `build-deb` — Linux runner → genera Deb → sube como artifact
3. `create-release` — Descarga ambos artifacts → crea GitHub Release con `prerelease: true`
4. `notify` — Envía notificación Telegram con link al release

**Secrets necesarios:**
| Secret | Descripción |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram (ya configurado en el repo) |
| `TELEGRAM_CHAT_ID` | ID del chat de testers (ya configurado en el repo) |
| `GITHUB_TOKEN` | Nativo de GitHub Actions — no requiere configuración manual |

### Configuración de la app (build.gradle.kts)

```kotlin
compose.desktop {
    application {
        mainClass = "MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "ar.com.intrale"
            packageVersion = "1.0.0"
        }
    }
}
```

### Agregar macOS en el futuro

Para incluir el instalador `.dmg` (macOS):
1. Agregar un job `build-dmg` con `runs-on: macos-latest`
2. Ejecutar `./gradlew :app:composeApp:packageDmg`
3. Subir el `.dmg` como artifact y añadirlo al job `create-release`

Ver `docs/distribution-strategy.md` sección 2.3 para más detalles.
