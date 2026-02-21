package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryOrdersSummary
import asdo.delivery.ToDoGetActiveDeliveryOrders
import asdo.delivery.ToDoGetDeliveryOrdersSummary
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import ext.delivery.toDeliveryException
import kotlinx.datetime.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.session.SessionStore
import ui.session.UserRole

sealed interface DeliverySummaryState {
    data object Loading : DeliverySummaryState
    data class Error(val message: String) : DeliverySummaryState
    data class Loaded(val summary: DeliveryOrdersSummary) : DeliverySummaryState
}

sealed interface DeliveryActiveOrdersState {
    data object Loading : DeliveryActiveOrdersState
    data object Empty : DeliveryActiveOrdersState
    data class Error(val message: String) : DeliveryActiveOrdersState
    data class Loaded(val orders: List<DeliveryOrder>) : DeliveryActiveOrdersState
}

data class DeliveryHomeUiState(
    val summaryState: DeliverySummaryState = DeliverySummaryState.Loading,
    val activeOrdersState: DeliveryActiveOrdersState = DeliveryActiveOrdersState.Loading,
    val today: String = Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date.toString(),
    val updatingOrderId: String? = null,
    val statusUpdateSuccess: Boolean = false,
    val statusUpdateError: String? = null
)

class DeliveryHomeViewModel(
    private val getActiveOrders: ToDoGetActiveDeliveryOrders = DIManager.di.direct.instance(),
    private val getOrdersSummary: ToDoGetDeliveryOrdersSummary = DIManager.di.direct.instance(),
    private val updateOrderStatus: ToDoUpdateDeliveryOrderStatus = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryHomeViewModel>()

    var state by mutableStateOf(DeliveryHomeUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadData() {
        if (SessionStore.sessionState.value.role != UserRole.Delivery) {
            state = state.copy(
                summaryState = DeliverySummaryState.Error("No tenés permisos para ver esta pantalla"),
                activeOrdersState = DeliveryActiveOrdersState.Empty
            )
            return
        }

        loadSummary()
        loadActiveOrders()
    }

    suspend fun refreshSummary() = loadSummary()

    suspend fun refreshActive() = loadActiveOrders()

    suspend fun updateStatus(orderId: String, newStatus: DeliveryOrderStatus) {
        state = state.copy(updatingOrderId = orderId, statusUpdateSuccess = false, statusUpdateError = null)
        updateOrderStatus.execute(orderId, newStatus)
            .onSuccess {
                state = state.copy(updatingOrderId = null, statusUpdateSuccess = true)
                loadSummary()
                loadActiveOrders()
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

    private suspend fun loadSummary() {
        state = state.copy(summaryState = DeliverySummaryState.Loading)
        getOrdersSummary.execute(Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date)
            .onSuccess { summary ->
                state = state.copy(summaryState = DeliverySummaryState.Loaded(summary))
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                state = state.copy(
                    summaryState = DeliverySummaryState.Error(
                        deliveryError.message ?: "Error al obtener resumen"
                    )
                )
            }
    }

    private suspend fun loadActiveOrders() {
        state = state.copy(activeOrdersState = DeliveryActiveOrdersState.Loading)
        getActiveOrders.execute()
            .onSuccess { orders ->
                state = if (orders.isEmpty()) {
                    state.copy(activeOrdersState = DeliveryActiveOrdersState.Empty)
                } else {
                    state.copy(activeOrdersState = DeliveryActiveOrdersState.Loaded(orders.take(5)))
                }
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                state = state.copy(
                    activeOrdersState = DeliveryActiveOrdersState.Error(
                        deliveryError.message ?: "Error al obtener pedidos activos"
                    )
                )
            }
    }
}
