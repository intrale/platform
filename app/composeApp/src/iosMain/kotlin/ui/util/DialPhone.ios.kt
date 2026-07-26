package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import platform.Foundation.NSCharacterSet
import platform.Foundation.NSString
import platform.Foundation.NSURL
import platform.Foundation.URLQueryAllowedCharacterSet
import platform.Foundation.stringByAddingPercentEncodingWithAllowedCharacters
import platform.UIKit.UIApplication

private object DialPhoneLogger
private val logger = LoggerFactory.default.newLogger<DialPhoneLogger>()

@Composable
actual fun rememberDialPhone(): (phone: String) -> Boolean = remember {
    { phone ->
        try {
            val encoded = (phone as NSString).stringByAddingPercentEncodingWithAllowedCharacters(
                NSCharacterSet.URLQueryAllowedCharacterSet
            )
            val url = encoded?.let { NSURL.URLWithString("tel:$it") }
            if (url != null && UIApplication.sharedApplication.canOpenURL(url)) {
                UIApplication.sharedApplication.openURL(url)
                true
            } else {
                false
            }
        } catch (e: Exception) {
            logger.error(e) { "No se pudo abrir el marcador" }
            false
        }
    }
}
