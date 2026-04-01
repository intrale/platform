package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

/**
 * Request para traducir el catalogo de un negocio.
 */
@Serializable
data class TranslateCatalogRequestDTO(
    val targetLocale: String = "",
    val productIds: List<String>? = null,
    val offset: Int = 0,
    val limit: Int = 20
)

/**
 * Producto con traduccion automatica.
 * Incluye el texto original para que el cliente pueda alternar.
 */
@Serializable
data class TranslatedProductDTO(
    val id: String,
    val name: String,
    val originalName: String,
    val shortDescription: String? = null,
    val originalDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val isAvailable: Boolean = true,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null,
    val stockQuantity: Int? = null,
    val translated: Boolean = false,
    val targetLocale: String = "",
    val sourceLocale: String = "es"
)

/**
 * Respuesta del endpoint de traduccion de catalogo.
 */
@Serializable
data class TranslateCatalogResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val products: List<TranslatedProductDTO> = emptyList(),
    val translated: Boolean = false,
    val targetLocale: String = "",
    val sourceLocale: String = "es",
    val total: Int = 0,
    val offset: Int = 0,
    val limit: Int = 20,
    val hasMore: Boolean = false
)
