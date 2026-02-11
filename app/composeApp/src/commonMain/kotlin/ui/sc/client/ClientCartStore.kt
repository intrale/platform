package ui.sc.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class ClientCartItem(
    val product: ClientProduct,
    val quantity: Int
)

object ClientCartStore {

    private val _items = MutableStateFlow<Map<String, ClientCartItem>>(emptyMap())
    val items: StateFlow<Map<String, ClientCartItem>> = _items.asStateFlow()
    private val _selectedAddressId = MutableStateFlow<String?>(null)
    val selectedAddressId: StateFlow<String?> = _selectedAddressId.asStateFlow()

    fun add(product: ClientProduct) {
        if (!product.isAvailable) return
        _items.update { current ->
            val existing = current[product.id]
            val nextQuantity = (existing?.quantity ?: 0) + 1
            current + (product.id to ClientCartItem(product = product, quantity = nextQuantity))
        }
    }

    fun increment(productId: String) {
        _items.update { current ->
            current[productId]?.let { item ->
                current + (productId to item.copy(quantity = item.quantity + 1))
            } ?: current
        }
    }

    fun decrement(productId: String) {
        _items.update { current ->
            current[productId]?.let { item ->
                if (item.quantity <= 1) {
                    current - productId
                } else {
                    current + (productId to item.copy(quantity = item.quantity - 1))
                }
            } ?: current
        }
    }

    fun remove(productId: String) {
        _items.update { current -> current - productId }
    }

    fun clear() {
        _items.value = emptyMap()
        _selectedAddressId.value = null
    }

    fun selectAddress(addressId: String?) {
        _selectedAddressId.value = addressId
    }
}
