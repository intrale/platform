package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlinx.browser.window
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object DialPhoneLogger
private val logger = LoggerFactory.default.newLogger<DialPhoneLogger>()

private fun encodeURIComponent(value: String): String =
    js("encodeURIComponent(value)")

@Composable
actual fun rememberDialPhone(): (phone: String) -> Boolean = remember {
    { phone ->
        try {
            window.location.href = "tel:${encodeURIComponent(phone)}"
            true
        } catch (e: Exception) {
            logger.error(e) { "No se pudo abrir el marcador" }
            false
        }
    }
}
