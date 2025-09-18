package ui.accessibility

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.browser.window
import org.w3c.dom.events.Event

@Composable
actual fun rememberMotionPreferences(): MotionPreferences {
    val mediaQuery = remember {
        runCatching { window.matchMedia("(prefers-reduced-motion: reduce)") }.getOrNull()
    }
    var reduceMotion by remember { mutableStateOf(mediaQuery?.matches == true) }

    DisposableEffect(mediaQuery) {
        if (mediaQuery == null) {
            return@DisposableEffect onDispose {}
        }
        val listener: (Event) -> Unit = {
            reduceMotion = mediaQuery.matches
        }
        mediaQuery.addEventListener("change", listener)
        reduceMotion = mediaQuery.matches
        onDispose {
            mediaQuery.removeEventListener("change", listener)
        }
    }

    return MotionPreferences(reduceMotion = reduceMotion)
}
