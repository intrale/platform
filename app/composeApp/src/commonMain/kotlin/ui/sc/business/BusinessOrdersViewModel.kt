package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.BusinessOrder
import asdo.business.BusinessOrderDateFilter
import asdo.business.BusinessOrderStatus
import asdo.business.DeliveryPersonSummary
import asdo.business.ToDoAssignOrderDeliveryPerson
import asdo.business.ToDoGetBusinessDeliveryPeople
import asdo.business.ToGetBusinessOrders
import io.konform.validation.Validation
import kotlin.time.Duration.Companion.days
import kotlinx.datetime.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.session.SessionStore

data class BusinessOrdersUIState(
    val isLoading: Boolean = false,
    val orders: List<BusinessOrder> = emptyList(),
    val statusFilter: BusinessOrderStatus? = null,
    val dateFilter: BusinessOrderDateFilter = BusinessOrderDateFilter.ALL,
    val error: String? = null,
    val isEmpty: Boolean = false,
    val deliveryPeople: List<DeliveryPersonSummary> = emptyList(),
    val isLoadingDeliveryPeople: Boolean = false,
    val assigningOrderId: String? = null,
    val assignSuccess: String? = null,
    val assignError: String? = null,
    val selectedOrderId: String? = null
) {
    val filteredOrders: List<BusinessOrder>
        get() {
            var result = orders
            statusFilter?.let { filter -> result = result.filter { it.status == filter } }
            result = when (dateFilter) {
                BusinessOrderDateFilter.TODAY -> result.filter { it.isFromToday() }
                BusinessOrderDateFilter.LAST_7_DAYS -> result.filter { it.isFromLast7Days() }
                BusinessOrderDateFilter.ALL -> result
            }
            return result
        }
}

private fun BusinessOrder.isFromToday(): Boolean {
    if (createdAt.isBlank()) return false
    return try {
        val today = Clock.System.now()
            .toLocalDateTime(TimeZone.currentSystemDefault()).date.toString()
        createdAt.startsWith(today)
    } catch (_: Exception) {
        false
    }
}

private fun BusinessOrder.isFromLast7Days(): Boolean {
    if (createdAt.isBlank()) return false
    return try {
        val now = Clock.System.now()
        val sevenDaysAgo = now.minus(7.days)
        val orderInstant = kotlinx.datetime.Instant.parse(createdAt)
        orderInstant >= sevenDaysAgo
    } catch (_: Exception) {
        true
    }
}

class BusinessOrdersViewModel(
    private val getBusinessOrders: ToGetBusinessOrders = DIManager.di.direct.instance(),
    private val assignOrderDeliveryPerson: ToDoAssignOrderDeliveryPerson = DIManager.di.direct.instance(),
    private val getBusinessDeliveryPeople: ToDoGetBusinessDeliveryPeople = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<BusinessOrdersViewModel>()

    var state by mutableStateOf(BusinessOrdersUIState())
        private set

    override fun getState(): Any = state
    override fun initInputState() {}

    init {
        @Suppress("UNCHECKED_CAST")
        validation = Validation<BusinessOrdersUIState> { } as Validation<Any>
        initInputState()
    }

    suspend fun loadOrders() {
        val businessId = SessionStore.sessionState.value.selectedBusinessId
        if (businessId.isNullOrBlank()) {
            state = state.copy(isLoading = false, isEmpty = true)
            return
        }
        logger.info { "Cargando pedidos del negocio $businessId" }
        state = state.copy(isLoading = true, error = null)
        getBusinessOrders.execute(businessId)
            .onSuccess { orders ->
                logger.info { "Pedidos cargados: ${orders.size}" }
                // Detectar pedidos nuevos y disparar notificacion sonora
                val newOrders = BusinessOrderNotificationStore.processOrders(orders)
                if (newOrders.isNotEmpty()) {
                    logger.info { "Nuevos pedidos detectados para alerta sonora: ${newOrders.size}" }
                }
                state = state.copy(isLoading = false, orders = orders, isEmpty = orders.isEmpty())
            }
            .onFailure { e ->
                logger.error(e) { "Error al cargar pedidos del negocio" }
                state = state.copy(isLoading = false, error = e.message)
            }
    }

    suspend fun loadDeliveryPeople() {
        val businessId = SessionStore.sessionState.value.selectedBusinessId
        if (businessId.isNullOrBlank()) return
        logger.info { "Cargando repartidores del negocio $businessId" }
        state = state.copy(isLoadingDeliveryPeople = true)
        getBusinessDeliveryPeople.execute(businessId)
            .onSuccess { people ->
                logger.info { "Repartidores cargados: ${people.size}" }
                state = state.copy(isLoadingDeliveryPeople = false, deliveryPeople = people)
            }
            .onFailure { e ->
                logger.error(e) { "Error al cargar repartidores" }
                state = state.copy(isLoadingDeliveryPeople = false)
            }
    }

    suspend fun assignDeliveryPerson(orderId: String, deliveryPersonEmail: String?) {
        val businessId = SessionStore.sessionState.value.selectedBusinessId
        if (businessId.isNullOrBlank()) return
        val label = if (deliveryPersonEmail != null) deliveryPersonEmail else "sin asignar"
        logger.info { "Asignando repartidor $label al pedido $orderId" }
        state = state.copy(assigningOrderId = orderId, assignSuccess = null, assignError = null)
        assignOrderDeliveryPerson.execute(businessId, orderId, deliveryPersonEmail)
            .onSuccess { updatedOrder ->
                logger.info { "Repartidor asignado al pedido $orderId" }
                val updatedOrders = state.orders.map { order ->
                    if (order.id == orderId) order.copy(assignedDeliveryPersonEmail = updatedOrder.assignedDeliveryPersonEmail)
                    else order
                }
                state = state.copy(
                    assigningOrderId = null,
                    orders = updatedOrders,
                    assignSuccess = "ok",
                    selectedOrderId = null
                )
            }
            .onFailure { e ->
                logger.error(e) { "Error al asignar repartidor al pedido $orderId" }
                state = state.copy(assigningOrderId = null, assignError = e.message)
            }
    }

    fun selectOrderForAssignment(orderId: String?) {
        state = state.copy(selectedOrderId = orderId, assignSuccess = null, assignError = null)
    }

    fun selectStatusFilter(status: BusinessOrderStatus?) {
        state = state.copy(statusFilter = status)
    }

    fun selectDateFilter(filter: BusinessOrderDateFilter) {
        state = state.copy(dateFilter = filter)
    }

    fun clearAssignMessages() {
        state = state.copy(assignSuccess = null, assignError = null)
    }
}
