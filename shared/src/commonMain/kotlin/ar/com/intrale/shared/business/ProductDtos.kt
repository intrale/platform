package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ProductStatus {
    @SerialName("DRAFT")
    Draft,

    @SerialName("PUBLISHED")
    Published;

    companion object {
        fun fromRaw(value: String?): ProductStatus =
            when (value?.uppercase()) {
                "PUBLISHED" -> Published
                else -> Draft
            }
    }
}

@Serializable
data class ProductDTO(
    val id: String? = null,
    val businessId: String? = null,
    val name: String,
    val shortDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val status: ProductStatus = ProductStatus.Draft,
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null
)

@Serializable
data class ProductRequest(
    val name: String,
    val shortDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val status: ProductStatus,
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null
)

@Serializable
data class ProductListResponse(
    val statusCode: StatusCodeDTO? = null,
    val products: List<ProductDTO> = emptyList()
)

@Serializable
data class BusinessProductDTO(
    val id: String,
    val name: String,
    val basePrice: Double,
    val status: String,
    val emoji: String? = null,
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null
)

@Serializable
data class BusinessProductsResponse(
    val statusCode: StatusCodeDTO,
    val products: List<BusinessProductDTO>
)
