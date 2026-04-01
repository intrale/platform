package ar.com.intrale

import java.util.concurrent.ConcurrentHashMap

/**
 * Registro de evaluacion de calidad de foto almacenado en memoria.
 */
data class PhotoQualityRecord(
    val id: String = "",
    val businessId: String = "",
    val productId: String = "",
    val overallScore: Double = 0.0,
    val quality: String = "BAD",
    val issues: List<String> = emptyList(),
    val recommendations: List<String> = emptyList(),
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Repositorio in-memory para evaluaciones de calidad de fotos.
 * Almacena la ultima evaluacion por producto.
 */
class PhotoQualityRepository {

    private val assessments = ConcurrentHashMap<String, PhotoQualityRecord>()

    private fun key(business: String, productId: String) = "${business.lowercase()}#$productId"

    fun save(business: String, record: PhotoQualityRecord): PhotoQualityRecord {
        val saved = record.copy(businessId = business.lowercase())
        assessments[key(business, saved.productId)] = saved
        return saved
    }

    fun getByProduct(business: String, productId: String): PhotoQualityRecord? =
        assessments[key(business, productId)]?.copy()

    fun listByBusiness(business: String): List<PhotoQualityRecord> =
        assessments.values
            .filter { it.businessId == business.lowercase() }
            .sortedByDescending { it.timestamp }
            .map { it.copy() }

    fun listLowQuality(business: String): List<PhotoQualityRecord> =
        assessments.values
            .filter {
                it.businessId == business.lowercase() &&
                    (it.quality == "IMPROVABLE" || it.quality == "BAD")
            }
            .sortedBy { it.overallScore }
            .map { it.copy() }

    fun delete(business: String, productId: String): Boolean =
        assessments.remove(key(business, productId)) != null
}
