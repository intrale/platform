package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrder
import asdo.delivery.ToDoGetDeliveryOrderHistory
import ext.delivery.toDeliveryException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class DeliveryHistoryStatus { Idle, Loading, Loaded, Empty, Error }

data class DeliveryHistoryUiState(
    val status: DeliveryHistoryStatus = DeliveryHistoryStatus.Idle,
    val orders: List<DeliveryOrder> = emptyList(),
    val errorMessage: String? = null
)

class DeliveryHistoryViewModel(
    private val getOrderHistory: ToDoGetDeliveryOrderHistory = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryHistoryViewModel>()

    var state by mutableStateOf(DeliveryHistoryUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadHistory() {
        state = state.copy(status = DeliveryHistoryStatus.Loading, errorMessage = null)
        getOrderHistory.execute()
            .onSuccess { orders ->
                logger.info { "Historial de pedidos cargado: ${orders.size} pedidos" }
                state = if (orders.isEmpty()) {
                    state.copy(status = DeliveryHistoryStatus.Empty, orders = emptyList())
                } else {
                    state.copy(status = DeliveryHistoryStatus.Loaded, orders = orders)
                }
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al cargar historial de pedidos" }
                state = state.copy(
                    status = DeliveryHistoryStatus.Error,
                    errorMessage = deliveryError.message ?: "Error al cargar historial"
                )
            }
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
