package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlinx.browser.window
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object OpenExternalMapLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalMapLogger>()

@Composable
actual fun rememberOpenExternalMap(): (address: String) -> Boolean {
    return remember {
        { address: String ->
            try {
                val encoded = js("encodeURIComponent(address)") as String
                window.open("https://maps.google.com/maps?q=$encoded", "_blank")
                logger.info { "Mapa abierto en navegador para direccion: $address" }
                true
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir mapa para direccion: $address" }
                false
            }
        }
    }
}
