package ui.util

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object OpenExternalMapLogger
private val logger = LoggerFactory.default.newLogger<OpenExternalMapLogger>()

@Composable
actual fun rememberOpenExternalMap(): (address: String) -> Boolean {
    val context = LocalContext.current
    return remember(context) {
        { address: String ->
            try {
                val encodedAddress = Uri.encode(address)
                val geoUri = Uri.parse("geo:0,0?q=$encodedAddress")
                val intent = Intent(Intent.ACTION_VIEW, geoUri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                logger.info { "Mapa abierto para direccion: $address" }
                true
            } catch (e: ActivityNotFoundException) {
                logger.warning { "No se encontro app de mapas para direccion: $address" }
                false
            } catch (e: Exception) {
                logger.error(e) { "Error al abrir mapa para direccion: $address" }
                false
            }
        }
    }
}
