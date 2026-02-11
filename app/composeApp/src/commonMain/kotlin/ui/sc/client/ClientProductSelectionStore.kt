package ui.sc.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object ClientProductSelectionStore {

    private val _productId = MutableStateFlow<String?>(null)
    val productId: StateFlow<String?> = _productId.asStateFlow()

    fun select(productId: String) {
        _productId.value = productId
    }
}
