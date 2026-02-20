package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrder
import asdo.delivery.ToDoGetActiveDeliveryOrders
import ext.delivery.toDeliveryException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class DeliveryOrdersStatus { Idle, Loading, Loaded, Empty, Error }

data class DeliveryOrdersUiState(
    val status: DeliveryOrdersStatus = DeliveryOrdersStatus.Idle,
    val orders: List<DeliveryOrder> = emptyList(),
    val errorMessage: String? = null
)

class DeliveryOrdersViewModel(
    private val getActiveOrders: ToDoGetActiveDeliveryOrders = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryOrdersViewModel>()

    var state by mutableStateOf(DeliveryOrdersUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadOrders() {
        state = state.copy(status = DeliveryOrdersStatus.Loading, errorMessage = null)
        getActiveOrders.execute()
            .onSuccess { orders ->
                state = if (orders.isEmpty()) {
                    state.copy(status = DeliveryOrdersStatus.Empty, orders = emptyList())
                } else {
                    state.copy(status = DeliveryOrdersStatus.Loaded, orders = orders)
                }
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al cargar pedidos asignados" }
                state = state.copy(
                    status = DeliveryOrdersStatus.Error,
                    errorMessage = deliveryError.message ?: "Error al cargar pedidos"
                )
            }
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
