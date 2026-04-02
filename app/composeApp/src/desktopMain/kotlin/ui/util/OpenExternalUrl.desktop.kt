package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import java.awt.Desktop
import java.net.URI

private object OpenExternalUrlLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalUrlLogger>()

@Composable
actual fun rememberOpenExternalUrl(): (url: String) -> Boolean {
    return remember {
        { url: String ->
            try {
                val uri = URI(url)
                if (Desktop.isDesktopSupported()) {
                    Desktop.getDesktop().browse(uri)
                    logger.info { "URL abierta en navegador: $url" }
                    true
                } else {
                    logger.warning { "Desktop.browse no soportado" }
                    false
                }
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir URL: $url" }
                false
            }
        }
    }
}
