package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlinx.browser.window
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object OpenExternalUrlLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalUrlLogger>()

@Composable
actual fun rememberOpenExternalUrl(): (url: String) -> Boolean {
    return remember {
        { url: String ->
            try {
                window.open(url, "_blank")
                logger.info { "URL abierta en nueva pestana: $url" }
                true
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir URL: $url" }
                false
            }
        }
    }
}
