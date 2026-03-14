package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.BusinessOrder
import asdo.business.BusinessOrderDateFilter
import asdo.business.BusinessOrderStatus
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
    val isEmpty: Boolean = false
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

class BusinessOrdersViewModel : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<BusinessOrdersViewModel>()

    private val getBusinessOrders: ToGetBusinessOrders = DIManager.di.direct.instance()

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
                state = state.copy(isLoading = false, orders = orders, isEmpty = orders.isEmpty())
            }
            .onFailure { e ->
                logger.error(e) { "Error al cargar pedidos del negocio" }
                state = state.copy(isLoading = false, error = e.message)
            }
    }

    fun selectStatusFilter(status: BusinessOrderStatus?) {
        state = state.copy(statusFilter = status)
    }

    fun selectDateFilter(filter: BusinessOrderDateFilter) {
        state = state.copy(dateFilter = filter)
    }
}
