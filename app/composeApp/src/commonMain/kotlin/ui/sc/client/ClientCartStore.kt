package ui.sc.client

import asdo.client.DoCheckAddressResult
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
    private val _selectedPaymentMethodId = MutableStateFlow<String?>(null)
    val selectedPaymentMethodId: StateFlow<String?> = _selectedPaymentMethodId.asStateFlow()
    /**
     * Resultado de la ultima verificacion de direccion + zona (Hija A #2422).
     * Mientras este vigente, `addToCart` no requiere re-verificacion (CA-1).
     * Se borra al limpiar el carrito o cambiar de negocio.
     */
    private val _lastZoneCheckResult = MutableStateFlow<DoCheckAddressResult?>(null)
    val lastZoneCheckResult: StateFlow<DoCheckAddressResult?> = _lastZoneCheckResult.asStateFlow()

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

    fun setQuantity(product: ClientProduct, quantity: Int) {
        _items.update { current ->
            if (quantity <= 0) {
                current - product.id
            } else {
                current + (product.id to ClientCartItem(product = product, quantity = quantity))
            }
        }
    }

    fun remove(productId: String) {
        _items.update { current -> current - productId }
    }

    fun clear() {
        _items.value = emptyMap()
        _selectedAddressId.value = null
        _selectedPaymentMethodId.value = null
        _lastZoneCheckResult.value = null
    }

    fun selectAddress(addressId: String?) {
        _selectedAddressId.value = addressId
    }

    fun selectPaymentMethod(paymentMethodId: String?) {
        _selectedPaymentMethodId.value = paymentMethodId
    }

    /**
     * Persiste el resultado de verificacion de direccion + zona del negocio
     * (issue #2424 CA-1, CA-2). Llamado por la pantalla de verificacion (Hija A
     * #2422) al confirmar la direccion.
     */
    fun setZoneCheckResult(result: DoCheckAddressResult?) {
        _lastZoneCheckResult.value = result
    }
}
