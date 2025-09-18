package ui.accessibility

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable

@Immutable
data class MotionPreferences(
    val reduceMotion: Boolean
)

@Composable
expect fun rememberMotionPreferences(): MotionPreferences
