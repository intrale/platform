package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import java.awt.Desktop
import java.net.URI
import java.net.URLEncoder

private object OpenExternalMapLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalMapLogger>()

@Composable
actual fun rememberOpenExternalMap(): (address: String) -> Boolean {
    return remember {
        { address: String ->
            try {
                val encoded = URLEncoder.encode(address, "UTF-8")
                val uri = URI("https://maps.google.com/maps?q=$encoded")
                if (Desktop.isDesktopSupported()) {
                    Desktop.getDesktop().browse(uri)
                    logger.info { "Mapa abierto en navegador para direccion: $address" }
                    true
                } else {
                    logger.warning { "Desktop.browse no soportado" }
                    false
                }
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir mapa para direccion: $address" }
                false
            }
        }
    }
}
