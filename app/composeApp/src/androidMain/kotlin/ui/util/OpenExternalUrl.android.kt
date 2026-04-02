package ui.util

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object OpenExternalUrlLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalUrlLogger>()

@Composable
actual fun rememberOpenExternalUrl(): (url: String) -> Boolean {
    val context = LocalContext.current
    return remember(context) {
        { url: String ->
            try {
                val uri = Uri.parse(url)
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                logger.info { "URL abierta en navegador: $url" }
                true
            } catch (e: ActivityNotFoundException) {
                logger.warning { "No se encontro navegador para URL: $url" }
                false
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir URL: $url" }
                false
            }
        }
    }
}
