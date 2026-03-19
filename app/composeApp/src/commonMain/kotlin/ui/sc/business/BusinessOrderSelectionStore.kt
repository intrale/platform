package ui.sc.business

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object BusinessOrderSelectionStore {

    private val _selectedOrderId = MutableStateFlow<String?>(null)
    val selectedOrderId: StateFlow<String?> = _selectedOrderId.asStateFlow()

    fun select(orderId: String) {
        _selectedOrderId.value = orderId
    }

    fun clear() {
        _selectedOrderId.value = null
    }
}
