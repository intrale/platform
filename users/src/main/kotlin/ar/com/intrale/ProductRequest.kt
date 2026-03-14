package ar.com.intrale

data class ProductRequest(
    val name: String = "",
    val shortDescription: String? = null,
    val basePrice: Double = 0.0,
    val unit: String = "",
    val categoryId: String = "",
    val status: String? = null,
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null
)
