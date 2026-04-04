package ui.cp.photo

/**
 * Resultado de seleccion de imagen desde camara o galeria.
 * @param base64 imagen codificada en base64
 * @param mediaType tipo MIME (image/jpeg, image/png)
 */
data class ImagePickerResult(
    val base64: String,
    val mediaType: String = "image/jpeg"
)
