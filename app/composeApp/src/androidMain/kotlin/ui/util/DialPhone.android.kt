package ui.util

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object DialPhoneLogger
private val logger = LoggerFactory.default.newLogger<DialPhoneLogger>()

@Composable
actual fun rememberDialPhone(): (phone: String) -> Boolean {
    val context = LocalContext.current
    return remember(context) {
        { phone ->
            try {
                val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(phone)}")).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                true
            } catch (e: ActivityNotFoundException) {
                logger.warning { "No se encontró una app de teléfono" }
                false
            } catch (e: Exception) {
                logger.error(e) { "No se pudo abrir el marcador" }
                false
            }
        }
    }
}
