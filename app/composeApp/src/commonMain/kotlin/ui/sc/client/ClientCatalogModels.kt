package ui.sc.client

data class ClientProduct(
    val id: String,
    val name: String,
    val priceLabel: String,
    val emoji: String,
    val unitPrice: Double,
    val categoryId: String? = null,
    val isAvailable: Boolean = true
)

sealed interface ClientProductsState {
    data object Loading : ClientProductsState
    data object Empty : ClientProductsState
    data class Error(val message: String) : ClientProductsState
    data class Loaded(val products: List<ClientProduct>) : ClientProductsState
}
