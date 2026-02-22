package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientOrder
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderStatus
import asdo.client.ToDoGetClientOrderDetail
import asdo.client.ToDoGetClientOrders
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
    val selectedFilter: ClientOrderStatus? = null,
    val selectedOrderDetail: ClientOrderDetail? = null,
    val detailLoading: Boolean = false,
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

    private var allOrders: List<ClientOrder> = emptyList()

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin inputs de formulario para listado de pedidos
    }

    suspend fun loadOrders() {
        state = state.copy(status = ClientOrdersStatus.Loading, errorMessage = null)
        getClientOrders.execute()
            .onSuccess { orders ->
                allOrders = orders
                applyFilter()
            }
            .onFailure { throwable ->
                val clientError = throwable.toClientException()
                logger.error(throwable) { "Error al cargar pedidos del cliente" }
                state = state.copy(
                    status = ClientOrdersStatus.Error,
                    errorMessage = clientError.message ?: "Error al cargar pedidos"
                )
            }
    }

    fun selectFilter(filter: ClientOrderStatus?) {
        state = state.copy(selectedFilter = filter)
        applyFilter()
    }

    private fun applyFilter() {
        val filtered = state.selectedFilter?.let { f -> allOrders.filter { it.status == f } } ?: allOrders
        state = if (filtered.isEmpty()) {
            state.copy(status = ClientOrdersStatus.Empty, orders = emptyList())
        } else {
            state.copy(status = ClientOrdersStatus.Loaded, orders = filtered)
        }
    }

    suspend fun loadOrderDetail(orderId: String) {
        state = state.copy(detailLoading = true, detailError = null, selectedOrderDetail = null)
        getClientOrderDetail.execute(orderId)
            .onSuccess { detail ->
                state = state.copy(detailLoading = false, selectedOrderDetail = detail)
            }
            .onFailure { throwable ->
                val clientError = throwable.toClientException()
                logger.error(throwable) { "Error al cargar detalle del pedido $orderId" }
                state = state.copy(
                    detailLoading = false,
                    detailError = clientError.message ?: "Error al cargar detalle del pedido"
                )
            }
    }

    fun clearOrderDetail() {
        state = state.copy(selectedOrderDetail = null, detailError = null, detailLoading = false)
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
