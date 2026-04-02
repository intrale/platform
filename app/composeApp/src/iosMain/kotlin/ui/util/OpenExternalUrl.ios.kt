package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import platform.Foundation.NSURL
import platform.UIKit.UIApplication

private object OpenExternalUrlLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalUrlLogger>()

@Composable
actual fun rememberOpenExternalUrl(): (url: String) -> Boolean {
    return remember {
        { url: String ->
            try {
                val nsUrl = NSURL.URLWithString(url)
                if (nsUrl != null && UIApplication.sharedApplication.canOpenURL(nsUrl)) {
                    UIApplication.sharedApplication.openURL(nsUrl)
                    logger.info { "URL abierta en Safari: $url" }
                    true
                } else {
                    logger.warning { "No se pudo abrir URL: $url" }
                    false
                }
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir URL: $url" }
                false
            }
        }
    }
}
