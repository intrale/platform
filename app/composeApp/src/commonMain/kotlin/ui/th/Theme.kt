package ui.th

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import ui.session.BusinessColorPalette
import ui.session.LookAndFeelStore
import ui.util.toColorOrNull

private val IntraleLightColorScheme = lightColorScheme(
    primary = primaryLight,
    onPrimary = onPrimaryLight,
    primaryContainer = primaryContainerLight,
    onPrimaryContainer = onPrimaryContainerLight,
    secondary = secondaryLight,
    onSecondary = onSecondaryLight,
    secondaryContainer = secondaryContainerLight,
    onSecondaryContainer = onSecondaryContainerLight,
    tertiary = tertiaryLight,
    onTertiary = onTertiaryLight,
    tertiaryContainer = tertiaryContainerLight,
    onTertiaryContainer = onTertiaryContainerLight,
    error = errorLight,
    onError = onErrorLight,
    errorContainer = errorContainerLight,
    onErrorContainer = onErrorContainerLight,
    background = backgroundLight,
    onBackground = onBackgroundLight,
    surface = surfaceLight,
    onSurface = onSurfaceLight,
    surfaceVariant = surfaceVariantLight,
    onSurfaceVariant = onSurfaceVariantLight,
    outline = outlineLight,
    outlineVariant = outlineVariantLight,
    scrim = scrimLight,
    inverseSurface = inverseSurfaceLight,
    inverseOnSurface = inverseOnSurfaceLight,
    inversePrimary = inversePrimaryLight,
    surfaceDim = surfaceDimLight,
    surfaceBright = surfaceBrightLight,
    surfaceContainerLowest = surfaceContainerLowestLight,
    surfaceContainerLow = surfaceContainerLowLight,
    surfaceContainer = surfaceContainerLight,
    surfaceContainerHigh = surfaceContainerHighLight,
    surfaceContainerHighest = surfaceContainerHighestLight,
)

private val IntraleDarkColorScheme = darkColorScheme(
    primary = primaryDark,
    onPrimary = onPrimaryDark,
    primaryContainer = primaryContainerDark,
    onPrimaryContainer = onPrimaryContainerDark,
    secondary = secondaryDark,
    onSecondary = onSecondaryDark,
    secondaryContainer = secondaryContainerDark,
    onSecondaryContainer = onSecondaryContainerDark,
    tertiary = tertiaryDark,
    onTertiary = onTertiaryDark,
    tertiaryContainer = tertiaryContainerDark,
    onTertiaryContainer = onTertiaryContainerDark,
    error = errorDark,
    onError = onErrorDark,
    errorContainer = errorContainerDark,
    onErrorContainer = onErrorContainerDark,
    background = backgroundDark,
    onBackground = onBackgroundDark,
    surface = surfaceDark,
    onSurface = onSurfaceDark,
    surfaceVariant = surfaceVariantDark,
    onSurfaceVariant = onSurfaceVariantDark,
    outline = outlineDark,
    outlineVariant = outlineVariantDark,
    scrim = scrimDark,
    inverseSurface = inverseSurfaceDark,
    inverseOnSurface = inverseOnSurfaceDark,
    inversePrimary = inversePrimaryDark,
    surfaceDim = surfaceDimDark,
    surfaceBright = surfaceBrightDark,
    surfaceContainerLowest = surfaceContainerLowestDark,
    surfaceContainerLow = surfaceContainerLowDark,
    surfaceContainer = surfaceContainerDark,
    surfaceContainerHigh = surfaceContainerHighDark,
    surfaceContainerHighest = surfaceContainerHighestDark,
)

@Composable
fun IntraleTheme(
    useDarkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val baseScheme = if (useDarkTheme) IntraleDarkColorScheme else IntraleLightColorScheme
    val palette by LookAndFeelStore.palette.collectAsState()
    val colorScheme = remember(useDarkTheme, palette) {
        baseScheme.applyBusinessPalette(palette)
    }
    val spacing = remember { IntraleSpacing() }
    val elevations = remember { IntraleElevations() }

    CompositionLocalProvider(
        LocalSpacing provides spacing,
        LocalElevations provides elevations
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = IntraleTypography(),
            shapes = IntraleShapes,
            content = content
        )
    }
}

internal val lightScheme: ColorScheme = IntraleLightColorScheme

internal val darkScheme: ColorScheme = IntraleDarkColorScheme

private fun ColorScheme.applyBusinessPalette(palette: BusinessColorPalette): ColorScheme {
    val background = palette.backgroundPrimary.toColorOrNull()
    val surface = palette.screenBackground.toColorOrNull()
    val primaryColor = palette.primaryButton.toColorOrNull()
    val secondaryColor = palette.secondaryButton.toColorOrNull()
    val labelColor = palette.labelText.toColorOrNull()
    val headerColor = palette.headerBackground.toColorOrNull()

    return copy(
        background = background ?: background,
        surface = surface ?: surface,
        surfaceVariant = surface ?: surfaceVariant,
        surfaceContainer = surface ?: surfaceContainer,
        surfaceContainerLow = surface ?: surfaceContainerLow,
        surfaceContainerLowest = surface ?: surfaceContainerLowest,
        surfaceContainerHigh = surface ?: surfaceContainerHigh,
        surfaceContainerHighest = surface ?: surfaceContainerHighest,
        surfaceDim = surface ?: surfaceDim,
        surfaceBright = surface ?: surfaceBright,
        primary = primaryColor ?: primary,
        secondary = secondaryColor ?: secondary,
        primaryContainer = headerColor ?: primaryContainer,
        onBackground = labelColor ?: onBackground,
        onSurface = labelColor ?: onSurface,
        onSurfaceVariant = labelColor ?: onSurfaceVariant,
        inverseOnSurface = labelColor ?: inverseOnSurface,
    )
}
