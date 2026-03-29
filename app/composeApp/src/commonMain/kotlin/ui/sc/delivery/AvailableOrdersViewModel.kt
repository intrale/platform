package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrder
import asdo.delivery.ToDoGetAvailableDeliveryOrders
import asdo.delivery.ToDoTakeDeliveryOrder
import ext.delivery.DeliveryExceptionResponse
import ext.delivery.toDeliveryException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class AvailableOrdersStatus { Idle, Loading, Loaded, Empty, Error }

data class AvailableOrdersUiState(
    val status: AvailableOrdersStatus = AvailableOrdersStatus.Idle,
    val orders: List<DeliveryOrder> = emptyList(),
    val errorMessage: String? = null,
    val takingOrderId: String? = null,
    val takeSuccess: Boolean = false,
    val takeError: String? = null,
    val alreadyTakenOrderId: String? = null
)

class AvailableOrdersViewModel(
    private val getAvailableOrders: ToDoGetAvailableDeliveryOrders = DIManager.di.direct.instance(),
    private val takeOrder: ToDoTakeDeliveryOrder = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<AvailableOrdersViewModel>()

    var state by mutableStateOf(AvailableOrdersUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadAvailableOrders() {
        state = state.copy(status = AvailableOrdersStatus.Loading, errorMessage = null)
        getAvailableOrders.execute()
            .onSuccess { orders ->
                state = if (orders.isEmpty()) {
                    state.copy(status = AvailableOrdersStatus.Empty, orders = emptyList())
                } else {
                    state.copy(status = AvailableOrdersStatus.Loaded, orders = orders)
                }
            }
            .onFailure { throwable ->
                val error = throwable.toDeliveryException()
                logger.error(throwable) { "Error al cargar pedidos disponibles" }
                state = state.copy(
                    status = AvailableOrdersStatus.Error,
                    errorMessage = error.message ?: "Error al cargar pedidos"
                )
            }
    }

    suspend fun takeOrder(orderId: String) {
        state = state.copy(takingOrderId = orderId, takeSuccess = false, takeError = null, alreadyTakenOrderId = null)
        takeOrder.execute(orderId)
            .onSuccess {
                val updatedOrders = state.orders.filter { it.id != orderId }
                state = state.copy(
                    orders = updatedOrders,
                    status = if (updatedOrders.isEmpty()) AvailableOrdersStatus.Empty else AvailableOrdersStatus.Loaded,
                    takingOrderId = null,
                    takeSuccess = true
                )
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al tomar pedido $orderId" }
                val isAlreadyTaken = deliveryError is DeliveryExceptionResponse &&
                    deliveryError.statusCode.value == 409
                if (isAlreadyTaken) {
                    val updatedOrders = state.orders.filter { it.id != orderId }
                    state = state.copy(
                        orders = updatedOrders,
                        status = if (updatedOrders.isEmpty()) AvailableOrdersStatus.Empty else AvailableOrdersStatus.Loaded,
                        takingOrderId = null,
                        alreadyTakenOrderId = orderId
                    )
                } else {
                    state = state.copy(
                        takingOrderId = null,
                        takeError = deliveryError.message ?: "Error al tomar el pedido"
                    )
                }
            }
    }

    fun clearFeedback() {
        state = state.copy(takeSuccess = false, takeError = null, alreadyTakenOrderId = null)
    }
}
