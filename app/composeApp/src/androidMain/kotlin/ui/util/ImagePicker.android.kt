package ui.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import java.io.ByteArrayOutputStream

private object ImagePickerLogger
private val logger = LoggerFactory.default.newLogger<ImagePickerLogger>()

private const val MAX_IMAGE_DIMENSION = 1280
private const val JPEG_QUALITY = 80

@Composable
actual fun rememberImagePicker(onImagePicked: (ByteArray?) -> Unit): () -> Unit {
    val context = LocalContext.current

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri == null) {
            logger.info { "Seleccion de imagen cancelada" }
            onImagePicked(null)
            return@rememberLauncherForActivityResult
        }
        try {
            val inputStream = context.contentResolver.openInputStream(uri)
            val originalBytes = inputStream?.readBytes()
            inputStream?.close()

            if (originalBytes == null) {
                logger.warning { "No se pudieron leer los bytes de la imagen seleccionada" }
                onImagePicked(null)
                return@rememberLauncherForActivityResult
            }

            // Comprimir y redimensionar para no enviar imagenes enormes
            val compressed = compressImage(originalBytes)
            logger.info { "Imagen seleccionada: ${originalBytes.size} bytes -> ${compressed.size} bytes comprimidos" }
            onImagePicked(compressed)
        } catch (e: Exception) {
            logger.error(e) { "Error al procesar imagen seleccionada" }
            onImagePicked(null)
        }
    }

    return remember(launcher) {
        { launcher.launch("image/*") }
    }
}

private fun compressImage(bytes: ByteArray): ByteArray {
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return bytes

    val (newWidth, newHeight) = calculateScaledDimensions(bitmap.width, bitmap.height)

    val scaled = if (newWidth != bitmap.width || newHeight != bitmap.height) {
        Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true).also {
            if (it !== bitmap) bitmap.recycle()
        }
    } else {
        bitmap
    }

    val output = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)
    scaled.recycle()
    return output.toByteArray()
}

private fun calculateScaledDimensions(width: Int, height: Int): Pair<Int, Int> {
    if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) return width to height
    val ratio = width.toFloat() / height.toFloat()
    return if (width > height) {
        MAX_IMAGE_DIMENSION to (MAX_IMAGE_DIMENSION / ratio).toInt()
    } else {
        (MAX_IMAGE_DIMENSION * ratio).toInt() to MAX_IMAGE_DIMENSION
    }
}
