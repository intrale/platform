package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientOrder
import asdo.client.ClientOrderDetail
import asdo.client.ToDoGetClientOrders
import asdo.client.ToDoGetClientOrderDetail
import ext.client.toClientException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class ClientOrdersStatus { Idle, Loading, Loaded, Empty, Error }

data class ClientOrdersUiState(
    val status: ClientOrdersStatus = ClientOrdersStatus.Idle,
    val orders: List<ClientOrder> = emptyList(),
    val errorMessage: String? = null,
    val selectedOrder: ClientOrderDetail? = null,
    val loadingDetail: Boolean = false,
    val detailError: String? = null
)

class ClientOrdersViewModel(
    private val getClientOrders: ToDoGetClientOrders = DIManager.di.direct.instance(),
    private val getClientOrderDetail: ToDoGetClientOrderDetail = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientOrdersViewModel>()

    var state by mutableStateOf(ClientOrdersUiState())
        private set

    init {
        initInputState()
    }

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin formularios en pantalla de pedidos
    }

    suspend fun loadOrders() {
        state = state.copy(status = ClientOrdersStatus.Loading, errorMessage = null)
        getClientOrders.execute()
            .onSuccess { orders ->
                state = if (orders.isEmpty()) {
                    state.copy(status = ClientOrdersStatus.Empty, orders = emptyList())
                } else {
                    state.copy(status = ClientOrdersStatus.Loaded, orders = orders)
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar pedidos del cliente" }
                state = state.copy(
                    status = ClientOrdersStatus.Error,
                    errorMessage = throwable.message ?: "Error al cargar pedidos"
                )
            }
    }

    suspend fun loadOrderDetail(orderId: String) {
        state = state.copy(loadingDetail = true, detailError = null)
        getClientOrderDetail.execute(orderId)
            .onSuccess { detail ->
                state = state.copy(selectedOrder = detail, loadingDetail = false)
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar detalle del pedido $orderId" }
                state = state.copy(
                    loadingDetail = false,
                    detailError = throwable.message ?: "Error al cargar detalle"
                )
            }
    }

    fun clearSelectedOrder() {
        state = state.copy(selectedOrder = null, detailError = null)
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
