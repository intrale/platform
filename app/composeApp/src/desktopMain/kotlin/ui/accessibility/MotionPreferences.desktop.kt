package ui.accessibility

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

@Composable
actual fun rememberMotionPreferences(): MotionPreferences {
    val reduceMotion = remember {
        val systemProperty = System.getProperty("intrale.reduceMotion")?.lowercase()
        val env = System.getenv("INTRALE_REDUCE_MOTION")?.lowercase()
        when {
            systemProperty == "true" || env == "true" -> true
            systemProperty == "false" || env == "false" -> false
            else -> false
        }
    }
    return MotionPreferences(reduceMotion = reduceMotion)
}
