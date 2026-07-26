package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import java.awt.Desktop
import java.net.URI
import java.net.URLEncoder

private object DialPhoneLogger
private val logger = LoggerFactory.default.newLogger<DialPhoneLogger>()

@Composable
actual fun rememberDialPhone(): (phone: String) -> Boolean = remember {
    { phone ->
        try {
            if (!Desktop.isDesktopSupported()) {
                false
            } else {
                Desktop.getDesktop().browse(URI("tel:${URLEncoder.encode(phone, "UTF-8")}"))
                true
            }
        } catch (e: Exception) {
            logger.error(e) { "No se pudo abrir el marcador" }
            false
        }
    }
}
