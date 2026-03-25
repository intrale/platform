package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import platform.Foundation.NSURL
import platform.UIKit.UIApplication

private object OpenExternalMapLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalMapLogger>()

@Composable
actual fun rememberOpenExternalMap(): (address: String) -> Boolean {
    return remember {
        { address: String ->
            try {
                val encoded = address.replace(" ", "+")
                val urlString = "maps://?q=$encoded"
                val url = NSURL.URLWithString(urlString)
                if (url != null && UIApplication.sharedApplication.canOpenURL(url)) {
                    UIApplication.sharedApplication.openURL(url)
                    logger.info { "Mapa abierto para direccion: $address" }
                    true
                } else {
                    val webUrl = NSURL.URLWithString("https://maps.google.com/maps?q=$encoded")
                    if (webUrl != null) {
                        UIApplication.sharedApplication.openURL(webUrl)
                        logger.info { "Mapa abierto en Safari para direccion: $address" }
                        true
                    } else {
                        logger.warning { "No se pudo abrir mapa para direccion: $address" }
                        false
                    }
                }
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir mapa para direccion: $address" }
                false
            }
        }
    }
}
