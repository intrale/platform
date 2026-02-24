package ui.sc.business

import ext.business.ProductStatus

data class ProductDraft(
    val id: String? = null,
    val name: String = "",
    val shortDescription: String = "",
    val basePrice: Double? = null,
    val unit: String = "",
    val categoryId: String = "",
    val status: ProductStatus = ProductStatus.Draft,
    val isAvailable: Boolean = true,
    val stockQuantity: Int? = null
)
