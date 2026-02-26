package ui.sc.delivery

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object DeliveryOrderSelectionStore {

    private val _selectedOrderId = MutableStateFlow<String?>(null)
    val selectedOrderId: StateFlow<String?> = _selectedOrderId.asStateFlow()

    fun select(orderId: String) {
        _selectedOrderId.value = orderId
    }

    fun clear() {
        _selectedOrderId.value = null
    }
}
