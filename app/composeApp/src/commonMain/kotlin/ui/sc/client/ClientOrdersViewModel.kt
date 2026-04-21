package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientOrder
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderStatus
import asdo.client.DeliveryTimeEstimation
import asdo.client.PriceChange
import asdo.client.RepeatOrderResult
import asdo.client.ToDoGetClientOrders
import asdo.client.ToDoGetClientOrderDetail
import asdo.client.ToDoGetDeliveryTimeEstimation
import asdo.client.ToDoRepeatOrder
import ext.client.toClientException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.session.SessionStore
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
    val repeatOrderError: String? = null,
    // Estimacion inteligente de tiempo de entrega (issue #1931)
    val deliveryEstimation: DeliveryTimeEstimation? = null,
    val estimationLoading: Boolean = false,
    val estimationError: String? = null,
    val estimationDelayed: Boolean = false
)

class ClientOrdersViewModel(
    private val getClientOrders: ToDoGetClientOrders = DIManager.di.direct.instance(),
    private val getClientOrderDetail: ToDoGetClientOrderDetail = DIManager.di.direct.instance(),
    private val repeatOrder: ToDoRepeatOrder = DIManager.di.direct.instance(),
    private val getDeliveryEstimation: ToDoGetDeliveryTimeEstimation = DIManager.di.direct.instance(),
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
                ClientNotificationStore.updateFromOrders(allOrders)
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

    /**
     * True si el pedido sigue activo (pendiente, en preparacion, en camino, etc.).
     * Usado por la UI para decidir si pedir la estimacion de tiempo.
     */
    fun isActiveOrder(status: ClientOrderStatus): Boolean =
        status != ClientOrderStatus.DELIVERED &&
            status != ClientOrderStatus.CANCELLED &&
            status != ClientOrderStatus.UNKNOWN

    suspend fun loadDeliveryEstimation(orderId: String) {
        state = state.copy(estimationLoading = true, estimationError = null)
        getDeliveryEstimation.execute(orderId)
            .onSuccess { estimation ->
                val delayed = isDelayed(estimation)
                state = state.copy(
                    deliveryEstimation = estimation,
                    estimationLoading = false,
                    estimationDelayed = delayed
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar estimacion de tiempo para $orderId" }
                state = state.copy(
                    estimationLoading = false,
                    estimationError = throwable.message ?: "Error al cargar estimacion"
                )
            }
    }

    private fun isDelayed(estimation: DeliveryTimeEstimation): Boolean {
        val historical = estimation.factors.historicalAvgMinutes ?: return false
        // Demorado si la estimacion supera en 25% o mas el historico (con minimo 5 min)
        val threshold = historical * 1.25
        return estimation.estimatedMinutes >= (historical + 5) &&
            estimation.estimatedMinutes >= threshold
    }

    fun clearSelectedOrder() {
        state = state.copy(
            selectedOrder = null,
            detailError = null,
            deliveryEstimation = null,
            estimationError = null,
            estimationDelayed = false
        )
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }

    suspend fun repeatOrderFromDetail(order: ClientOrderDetail) {
        state = state.copy(repeatOrderLoading = true, repeatOrderResult = null, repeatOrderError = null)
        val businessId = SessionStore.sessionState.value.selectedBusinessId
        repeatOrder.execute(order, businessId)
            .onSuccess { result ->
                if (result.addedItems.isNotEmpty()) {
                    // Crear mapa de precios actuales para items con cambio
                    val currentPriceMap = result.priceChangedItems.associate { it.item.id to it.currentPrice }
                    ClientCartStore.clear()
                    result.addedItems.forEach { item ->
                        // Usar precio actual del catálogo si cambió (CA-3)
                        val effectivePrice = currentPriceMap[item.id] ?: item.unitPrice
                        val product = ClientProduct(
                            id = item.id!!,
                            name = item.name,
                            priceLabel = formatPrice(effectivePrice),
                            emoji = "",
                            unitPrice = effectivePrice,
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
