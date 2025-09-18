package ui.th

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.luminance

@Composable
fun rememberIntralePrimaryGradient(): Brush {
    val colorScheme = MaterialTheme.colorScheme
    val isDarkTheme = colorScheme.background.luminance() < 0.5f
    val colors = if (isDarkTheme) {
        listOf(intralePrimaryGradientDarkStart, intralePrimaryGradientDarkEnd)
    } else {
        listOf(intralePrimaryGradientLightStart, intralePrimaryGradientLightEnd)
    }
    return remember(isDarkTheme) {
        Brush.horizontalGradient(colors)
    }
}

@Composable
fun rememberLoginBackgroundGradient(): Brush {
    val colorScheme = MaterialTheme.colorScheme
    val isDarkTheme = colorScheme.background.luminance() < 0.5f
    val colors = if (isDarkTheme) {
        listOf(intraleLoginGradientDarkTop, intraleLoginGradientDarkBottom)
    } else {
        listOf(intraleLoginGradientLightTop, intraleLoginGradientLightBottom)
    }
    return remember(isDarkTheme) {
        Brush.verticalGradient(colors)
    }
}
