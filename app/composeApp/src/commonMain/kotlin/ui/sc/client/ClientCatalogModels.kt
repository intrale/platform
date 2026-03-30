package ui.sc.client

data class ClientProduct(
    val id: String,
    val name: String,
    val priceLabel: String,
    val emoji: String,
    val unitPrice: Double,
    val categoryId: String? = null,
    val isAvailable: Boolean = true,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null
)

sealed interface ClientProductsState {
    data object Loading : ClientProductsState
    data object Empty : ClientProductsState
    data class Error(val message: String) : ClientProductsState
    data class Loaded(val products: List<ClientProduct>) : ClientProductsState
}

data class RecommendedProduct(
    val id: String,
    val name: String,
    val priceLabel: String,
    val emoji: String,
    val unitPrice: Double,
    val isAvailable: Boolean = true,
    val promotionPrice: Double? = null,
    val reason: String? = null
)

sealed interface RecommendedProductsState {
    data object Loading : RecommendedProductsState
    data object Empty : RecommendedProductsState
    data class Loaded(val products: List<RecommendedProduct>) : RecommendedProductsState
}
