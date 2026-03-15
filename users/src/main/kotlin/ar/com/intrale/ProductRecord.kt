package ar.com.intrale

data class ProductRecord(
    val id: String = "",
    val businessId: String = "",
    val name: String = "",
    val shortDescription: String? = null,
    val basePrice: Double = 0.0,
    val unit: String = "",
    val categoryId: String = "",
    val status: String = "DRAFT",
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null
)
