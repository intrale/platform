package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientOrder
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderStatus
import asdo.client.RepeatOrderResult
import asdo.client.ToDoGetClientOrders
import asdo.client.ToDoGetClientOrderDetail
import asdo.client.ToDoRepeatOrder
import ext.client.toClientException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.util.formatPrice

enum class ClientOrdersStatus { Idle, Loading, Loaded, Empty, Error }

data class ClientOrdersUiState(
    val status: ClientOrdersStatus = ClientOrdersStatus.Idle,
    val orders: List<ClientOrder> = emptyList(),
    val errorMessage: String? = null,
    val selectedFilter: ClientOrderStatus? = null,
    val selectedOrder: ClientOrderDetail? = null,
    val loadingDetail: Boolean = false,
    val detailError: String? = null,
    val repeatOrderLoading: Boolean = false,
    val repeatOrderResult: RepeatOrderResult? = null,
    val repeatOrderError: String? = null
)

class ClientOrdersViewModel(
    private val getClientOrders: ToDoGetClientOrders = DIManager.di.direct.instance(),
    private val getClientOrderDetail: ToDoGetClientOrderDetail = DIManager.di.direct.instance(),
    private val repeatOrder: ToDoRepeatOrder = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientOrdersViewModel>()

    var state by mutableStateOf(ClientOrdersUiState())
        private set

    private var allOrders: List<ClientOrder> = emptyList()

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
                allOrders = orders.sortedByDescending { it.createdAt }
                applyFilter()
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar pedidos del cliente" }
                state = state.copy(
                    status = ClientOrdersStatus.Error,
                    errorMessage = throwable.message ?: "Error al cargar pedidos"
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

    suspend fun repeatOrderFromDetail(order: ClientOrderDetail) {
        state = state.copy(repeatOrderLoading = true, repeatOrderResult = null, repeatOrderError = null)
        repeatOrder.execute(order)
            .onSuccess { result ->
                if (result.addedItems.isNotEmpty()) {
                    ClientCartStore.clear()
                    result.addedItems.forEach { item ->
                        val product = ClientProduct(
                            id = item.id!!,
                            name = item.name,
                            priceLabel = formatPrice(item.unitPrice),
                            emoji = "",
                            unitPrice = item.unitPrice,
                            isAvailable = true
                        )
                        ClientCartStore.setQuantity(product, item.quantity)
                    }
                }
                state = state.copy(repeatOrderLoading = false, repeatOrderResult = result)
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al repetir pedido ${order.id}" }
                state = state.copy(
                    repeatOrderLoading = false,
                    repeatOrderError = throwable.message ?: "Error al repetir pedido"
                )
            }
    }

    fun clearRepeatOrderResult() {
        state = state.copy(repeatOrderResult = null, repeatOrderError = null)
    }
}
