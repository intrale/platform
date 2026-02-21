package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetActiveDeliveryOrders
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
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
    val errorMessage: String? = null,
    val selectedFilter: DeliveryOrderStatus? = null,
    val updatingOrderId: String? = null,
    val statusUpdateSuccess: Boolean = false,
    val statusUpdateError: String? = null
)

class DeliveryOrdersViewModel(
    private val getActiveOrders: ToDoGetActiveDeliveryOrders = DIManager.di.direct.instance(),
    private val updateOrderStatus: ToDoUpdateDeliveryOrderStatus = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryOrdersViewModel>()

    var state by mutableStateOf(DeliveryOrdersUiState())
        private set

    private var allOrders: List<DeliveryOrder> = emptyList()

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadOrders() {
        state = state.copy(status = DeliveryOrdersStatus.Loading, errorMessage = null)
        getActiveOrders.execute()
            .onSuccess { orders ->
                allOrders = orders
                applyFilter()
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

    fun selectFilter(filter: DeliveryOrderStatus?) {
        state = state.copy(selectedFilter = filter)
        applyFilter()
    }

    private fun applyFilter() {
        val filtered = state.selectedFilter?.let { f -> allOrders.filter { it.status == f } } ?: allOrders
        state = if (filtered.isEmpty()) {
            state.copy(status = DeliveryOrdersStatus.Empty, orders = emptyList())
        } else {
            state.copy(status = DeliveryOrdersStatus.Loaded, orders = filtered)
        }
    }

    suspend fun updateStatus(orderId: String, newStatus: DeliveryOrderStatus) {
        state = state.copy(updatingOrderId = orderId, statusUpdateSuccess = false, statusUpdateError = null)
        updateOrderStatus.execute(orderId, newStatus)
            .onSuccess { result ->
                allOrders = allOrders.map { order ->
                    if (order.id == result.orderId) order.copy(status = result.newStatus) else order
                }
                applyFilter()
                state = state.copy(updatingOrderId = null, statusUpdateSuccess = true)
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al actualizar estado del pedido $orderId" }
                state = state.copy(
                    updatingOrderId = null,
                    statusUpdateError = deliveryError.message ?: "Error al actualizar estado"
                )
            }
    }

    fun clearStatusFeedback() {
        state = state.copy(statusUpdateSuccess = false, statusUpdateError = null)
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
