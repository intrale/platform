package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ext.delivery.CommDeliveryOrdersService
import ext.delivery.DeliveryOrderDTO
import ext.delivery.DeliveryOrdersSummaryDTO
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

data class DeliveryActiveOrder(
    val id: String,
    val label: String,
    val businessName: String,
    val neighborhood: String,
    val status: String,
    val eta: String?
)

sealed interface DeliverySummaryState {
    data object Loading : DeliverySummaryState
    data class Error(val message: String) : DeliverySummaryState
    data class Loaded(val summary: DeliveryOrdersSummaryDTO) : DeliverySummaryState
}

sealed interface DeliveryActiveOrdersState {
    data object Loading : DeliveryActiveOrdersState
    data object Empty : DeliveryActiveOrdersState
    data class Error(val message: String) : DeliveryActiveOrdersState
    data class Loaded(val orders: List<DeliveryActiveOrder>) : DeliveryActiveOrdersState
}

data class DeliveryHomeUiState(
    val summaryState: DeliverySummaryState = DeliverySummaryState.Loading,
    val activeOrdersState: DeliveryActiveOrdersState = DeliveryActiveOrdersState.Loading,
    val today: String = Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date.toString()
)

class DeliveryHomeViewModel(
    private val ordersService: CommDeliveryOrdersService = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryHomeViewModel>()
    private val statusPriority = listOf("pending", "inprogress", "in_progress", "assigned")

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

    private suspend fun loadSummary() {
        state = state.copy(summaryState = DeliverySummaryState.Loading)
        ordersService.fetchSummary(Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date)
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
        ordersService.fetchActiveOrders()
            .onSuccess { orders ->
                val filtered = orders.filterNot { it.status.equals("delivered", ignoreCase = true) }
                    .map { it.toDomain() }
                    .sortedWith(compareBy(
                        { statusPriority.indexOf(it.status.lowercase()).let { idx -> if (idx >= 0) idx else Int.MAX_VALUE } },
                        { it.eta.orEmpty() }
                    ))
                state = if (filtered.isEmpty()) {
                    state.copy(activeOrdersState = DeliveryActiveOrdersState.Empty)
                } else {
                    state.copy(activeOrdersState = DeliveryActiveOrdersState.Loaded(filtered.take(5)))
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

    private fun DeliveryOrderDTO.toDomain(): DeliveryActiveOrder = DeliveryActiveOrder(
        id = id,
        label = publicId ?: shortCode ?: id,
        businessName = businessName,
        neighborhood = neighborhood,
        status = status,
        eta = eta ?: promisedAt
    )
}
