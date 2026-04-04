package asdo.business

import ar.com.intrale.shared.business.AnalyzeProductPhotoResponse
import ext.business.CommAnalyzeProductPhotoService

/**
 * Implementacion del caso de uso de analisis de foto de producto.
 */
class DoAnalyzeProductPhoto(
    private val service: CommAnalyzeProductPhotoService
) : ToDoAnalyzeProductPhoto {

    override suspend fun execute(
        businessId: String,
        imageBase64: String,
        mediaType: String,
        existingCategories: List<String>
    ): Result<AnalyzeProductPhotoResponse> = service.analyzePhoto(
        businessId = businessId,
        imageBase64 = imageBase64,
        mediaType = mediaType,
        existingCategories = existingCategories
    )
}
