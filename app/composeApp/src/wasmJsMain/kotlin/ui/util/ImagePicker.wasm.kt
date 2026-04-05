package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private object ImagePickerLogger
private val logger = LoggerFactory.default.newLogger<ImagePickerLogger>()

@Composable
actual fun rememberImagePicker(onImagePicked: (ByteArray?) -> Unit): () -> Unit {
    // TODO: Implementar selector de imagenes web con input[type=file]
    return remember {
        {
            logger.warning { "Selector de imagenes no implementado en Web" }
            onImagePicked(null)
        }
    }
}
