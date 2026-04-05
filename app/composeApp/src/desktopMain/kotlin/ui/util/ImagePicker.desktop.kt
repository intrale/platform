package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import java.io.File
import javax.swing.JFileChooser
import javax.swing.filechooser.FileNameExtensionFilter

private object ImagePickerLogger
private val logger = LoggerFactory.default.newLogger<ImagePickerLogger>()

@Composable
actual fun rememberImagePicker(onImagePicked: (ByteArray?) -> Unit): () -> Unit {
    return remember {
        {
            try {
                val chooser = JFileChooser().apply {
                    fileFilter = FileNameExtensionFilter("Imagenes", "jpg", "jpeg", "png", "webp")
                    isMultiSelectionEnabled = false
                }
                val result = chooser.showOpenDialog(null)
                if (result == JFileChooser.APPROVE_OPTION) {
                    val file: File = chooser.selectedFile
                    val bytes = file.readBytes()
                    logger.info { "Imagen seleccionada desde escritorio: ${file.name} (${bytes.size} bytes)" }
                    onImagePicked(bytes)
                } else {
                    logger.info { "Seleccion de imagen cancelada en escritorio" }
                    onImagePicked(null)
                }
            } catch (e: Exception) {
                logger.error(e) { "Error al seleccionar imagen en escritorio" }
                onImagePicked(null)
            }
        }
    }
}
