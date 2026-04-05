package ui.util

import androidx.compose.runtime.Composable

/**
 * Resultado de la selección de imagen: bytes crudos de la imagen seleccionada.
 */
data class ImagePickerResult(
    val bytes: ByteArray
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ImagePickerResult) return false
        return bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int = bytes.contentHashCode()
}

/**
 * Retorna una función que abre el selector de imágenes del sistema (cámara o galería).
 * La función de callback recibe los bytes de la imagen seleccionada, o null si se canceló.
 *
 * @return launcher function que al invocarse abre el picker nativo.
 */
@Composable
expect fun rememberImagePicker(onImagePicked: (ByteArray?) -> Unit): () -> Unit
