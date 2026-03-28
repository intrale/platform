package ui.sc.delivery

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object DeliveryOrderSelectionStore {

    private val _selectedOrderId = MutableStateFlow<String?>(null)
    val selectedOrderId: StateFlow<String?> = _selectedOrderId.asStateFlow()

    private val _readOnly = MutableStateFlow(false)
    val readOnly: StateFlow<Boolean> = _readOnly.asStateFlow()

    fun select(orderId: String, readOnly: Boolean = false) {
        _selectedOrderId.value = orderId
        _readOnly.value = readOnly
    }

    fun clear() {
        _selectedOrderId.value = null
        _readOnly.value = false
    }
}
