package ui.sc.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object ClientProductSelectionStore {

    private val _selectedProductId = MutableStateFlow<String?>(null)
    val selectedProductId: StateFlow<String?> = _selectedProductId.asStateFlow()

    fun select(productId: String) {
        _selectedProductId.value = productId
    }

    fun clear() {
        _selectedProductId.value = null
    }
}
