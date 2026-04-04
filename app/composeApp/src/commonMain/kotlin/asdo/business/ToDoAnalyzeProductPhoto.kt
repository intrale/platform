package asdo.business

import ar.com.intrale.shared.business.AnalyzeProductPhotoResponse

/**
 * Caso de uso: analizar una foto de producto con IA para generar
 * nombre, descripcion y categoria sugeridos.
 */
interface ToDoAnalyzeProductPhoto {
    suspend fun execute(
        businessId: String,
        imageBase64: String,
        mediaType: String,
        existingCategories: List<String>
    ): Result<AnalyzeProductPhotoResponse>
}
