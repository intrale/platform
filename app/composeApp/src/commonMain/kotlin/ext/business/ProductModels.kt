package ext.business

import ext.dto.StatusCodeDTO
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
    val description: String? = null,
    val imageUrl: String? = null,
    val stock: Int? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val status: ProductStatus = ProductStatus.Draft
)

@Serializable
data class ProductRequest(
    val name: String,
    val shortDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val status: ProductStatus
)

@Serializable
data class ProductListResponse(
    val statusCode: StatusCodeDTO? = null,
    val products: List<ProductDTO> = emptyList()
)
