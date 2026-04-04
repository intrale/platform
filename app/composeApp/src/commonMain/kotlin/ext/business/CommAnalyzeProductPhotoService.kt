package ext.business

import ar.com.intrale.shared.business.AnalyzeProductPhotoResponse

/**
 * Interfaz para el servicio de analisis de fotos de productos con IA.
 */
interface CommAnalyzeProductPhotoService {
    suspend fun analyzePhoto(
        businessId: String,
        imageBase64: String,
        mediaType: String,
        existingCategories: List<String>
    ): Result<AnalyzeProductPhotoResponse>
}
