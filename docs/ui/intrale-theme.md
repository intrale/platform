# IntraleTheme y tokens de diseño compartidos

Relacionado con #228.

## 🎯 Objetivo
Unificar colores, tipografías, formas y espaciados de la app Compose mediante `IntraleTheme`, eliminando "magic numbers" y preparando el soporte para modo oscuro.

## 🧱 Componentes del tema
- **Paleta**: se expone a través de `MaterialTheme.colorScheme`, con variantes claras y oscuras.
- **Tipografía**: `IntraleTypography` utiliza la familia `Inter` (Regular, Medium, SemiBold) empaquetada en `composeResources`.
- **Formas**: `IntraleShapes` define radios base de 18 dp para botones y superficies adaptadas.
- **Espaciados**: `IntraleSpacing` provee tokens en múltiplos de 8 dp (`x0_5`, `x1`, `x1_5`, …).
- **Elevaciones**: `IntraleElevations` centraliza niveles `level0` a `level5`.

Todos los tokens se inyectan mediante `CompositionLocal`, por lo que basta envolver la jerarquía con `IntraleTheme`.

```kotlin
@Composable
fun IntraleApp() {
    IntraleTheme { // Usa isSystemInDarkTheme() por defecto
        App()
    }
}
```

## 📏 Uso de espaciados
`IntraleSpacing` está disponible como extensión de `MaterialTheme`:

```kotlin
Column(
    modifier = Modifier
        .padding(
            horizontal = MaterialTheme.spacing.x3,
            vertical = MaterialTheme.spacing.x4
        ),
    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
) { /* … */ }
```

Tokens disponibles:

| Token | Valor | Uso sugerido |
|-------|-------|--------------|
| `x0_5` | 4 dp | Separaciones finas, espacio entre botones stacked |
| `x1` | 8 dp | Márgenes mínimos, bordes de tarjetas |
| `x1_5` | 12 dp | Separadores en formularios |
| `x2` | 16 dp | Padding interno estándar |
| `x3` | 24 dp | Márgenes principales en pantallas |
| `x4` | 32 dp | Padding horizontal para layouts full width |
| `x5` | 40 dp | Espacios amplios entre bloques |
| `x6` | 48 dp | Offsets verticales grandes |
| `x7` | 56 dp | Alto de botones principales |
| `x8` | 64 dp | Secciones destacadas |

## ✍️ Tipografías
Todos los textos deben usar los estilos de `MaterialTheme.typography`. Ejemplos:

```kotlin
Text(
    text = stringResource(Res.string.login_title),
    style = MaterialTheme.typography.headlineMedium
)

Text(
    text = stringResource(Res.string.login_subtitle),
    style = MaterialTheme.typography.bodyLarge,
    color = MaterialTheme.colorScheme.onSurfaceVariant
)
```

## 🧩 Componentes reutilizables
- **Botones (`Button`, `IntralePrimaryButton`, `IntraleOutlinedButton`, `IntraleGhostButton`)** usan `MaterialTheme.shapes.large`, `spacing` y colores de la paleta.
- **TextField** adopta `MaterialTheme.typography` y `MaterialTheme.shapes.medium`.
- **Tarjetas y filas** deben evitar valores crudos y reutilizar `MaterialTheme.spacing`/`MaterialTheme.elevations`.

## ✅ Buenas prácticas
1. No hardcodear valores `dp`; si falta un token, agregarlo a `IntraleSpacing`.
2. Mantener los estilos dentro de `IntraleTheme`. Para variantes específicas crear funciones helper que sigan usando `MaterialTheme`.
3. Actualizar las vistas de ejemplo (`ButtonsPreviewScreen`, `Login`, etc.) al añadir nuevos tokens para validar modo claro/oscuro.

## 🧪 Verificación
Ejecutar `./gradlew :app:composeApp:check` para validar compilación y reglas de Compose. Para revisar manualmente los cambios visuales, lanzar la app en modo claro y oscuro comprobando que los colores provengan de `MaterialTheme.colorScheme`.
