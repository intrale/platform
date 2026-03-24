package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrderDetail
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryStatusHistoryEntry
import asdo.delivery.ToDoGetDeliveryOrderDetail
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import kotlinx.datetime.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import ext.delivery.toDeliveryException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class DeliveryOrderDetailStatus { Idle, Loading, Loaded, Error }

enum class NotDeliveredReason {
    ABSENT, WRONG_ADDRESS, REJECTED, PAYMENT, OTHER
}

data class DeliveryOrderDetailUiState(
    val status: DeliveryOrderDetailStatus = DeliveryOrderDetailStatus.Idle,
    val detail: DeliveryOrderDetail? = null,
    val errorMessage: String? = null,
    val updatingStatus: Boolean = false,
    val statusUpdateSuccess: Boolean = false,
    val statusUpdateError: String? = null,
    val showDeliveredConfirmDialog: Boolean = false,
    val showNotDeliveredSheet: Boolean = false,
    val selectedNotDeliveredReason: NotDeliveredReason? = null,
    val notDeliveredOtherText: String = "",
    val notDeliveredReasonError: Boolean = false,
    val notDeliveredOtherError: Boolean = false,
    val notDeliveredSuccess: Boolean = false,
    val statusHistory: List<DeliveryStatusHistoryEntry> = emptyList()
)

class DeliveryOrderDetailViewModel(
    private val getOrderDetail: ToDoGetDeliveryOrderDetail = DIManager.di.direct.instance(),
    private val updateOrderStatus: ToDoUpdateDeliveryOrderStatus = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryOrderDetailViewModel>()

    var state by mutableStateOf(DeliveryOrderDetailUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadDetail() {
        val orderId = DeliveryOrderSelectionStore.selectedOrderId.value
        if (orderId == null) {
            logger.warning { "No hay pedido seleccionado para ver detalle" }
            state = state.copy(
                status = DeliveryOrderDetailStatus.Error,
                errorMessage = "No se selecciono un pedido"
            )
            return
        }
        state = state.copy(status = DeliveryOrderDetailStatus.Loading, errorMessage = null)
        getOrderDetail.execute(orderId)
            .onSuccess { detail ->
                logger.info { "Detalle del pedido $orderId cargado correctamente" }
                val history = if (detail.statusHistory.isNotEmpty()) {
                    detail.statusHistory
                } else {
                    listOf(DeliveryStatusHistoryEntry(
                        status = detail.status,
                        timestamp = detail.updatedAt ?: detail.createdAt ?: "",
                    ))
                }
                state = state.copy(
                    status = DeliveryOrderDetailStatus.Loaded,
                    detail = detail,
                    statusHistory = history
                )
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al cargar detalle del pedido $orderId" }
                state = state.copy(
                    status = DeliveryOrderDetailStatus.Error,
                    errorMessage = deliveryError.message ?: "Error al cargar detalle"
                )
            }
    }

    suspend fun updateStatus(newStatus: DeliveryOrderStatus, reason: String? = null) {
        val orderId = state.detail?.id ?: return
        state = state.copy(updatingStatus = true, statusUpdateSuccess = false, statusUpdateError = null)
        updateOrderStatus.execute(orderId, newStatus, reason)
            .onSuccess { result ->
                logger.info { "Estado del pedido $orderId actualizado a ${result.newStatus}" }
                val newEntry = DeliveryStatusHistoryEntry(
                    status = result.newStatus,
                    timestamp = getCurrentTimestamp(),
                    reason = reason
                )
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateSuccess = true,
                    detail = state.detail?.copy(status = result.newStatus),
                    statusHistory = state.statusHistory + newEntry
                )
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al actualizar estado del pedido $orderId" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateError = deliveryError.message ?: "Error al actualizar estado"
                )
            }
    }

    suspend fun advanceToNextStatus() {
        val currentStatus = state.detail?.status ?: return
        val nextStatus = currentStatus.nextStatus() ?: run {
            logger.warning { "No hay siguiente estado para $currentStatus" }
            return
        }
        updateStatus(nextStatus)
    }

    fun showDeliveredConfirm() {
        state = state.copy(showDeliveredConfirmDialog = true)
    }

    fun dismissDeliveredConfirm() {
        state = state.copy(showDeliveredConfirmDialog = false)
    }

    suspend fun confirmDelivered() {
        state = state.copy(showDeliveredConfirmDialog = false)
        updateStatus(DeliveryOrderStatus.DELIVERED)
    }

    fun showNotDeliveredSheet() {
        state = state.copy(
            showNotDeliveredSheet = true,
            selectedNotDeliveredReason = null,
            notDeliveredOtherText = "",
            notDeliveredReasonError = false,
            notDeliveredOtherError = false
        )
    }

    fun dismissNotDeliveredSheet() {
        state = state.copy(showNotDeliveredSheet = false)
    }

    fun selectNotDeliveredReason(reason: NotDeliveredReason) {
        state = state.copy(
            selectedNotDeliveredReason = reason,
            notDeliveredReasonError = false,
            notDeliveredOtherError = false
        )
    }

    fun updateNotDeliveredOtherText(text: String) {
        state = state.copy(notDeliveredOtherText = text, notDeliveredOtherError = false)
    }

    suspend fun confirmNotDelivered() {
        val reason = state.selectedNotDeliveredReason
        if (reason == null) {
            state = state.copy(notDeliveredReasonError = true)
            return
        }
        if (reason == NotDeliveredReason.OTHER && state.notDeliveredOtherText.isBlank()) {
            state = state.copy(notDeliveredOtherError = true)
            return
        }
        val orderId = state.detail?.id ?: return
        val reasonText = if (reason == NotDeliveredReason.OTHER) {
            state.notDeliveredOtherText.trim()
        } else {
            reason.name.lowercase()
        }
        state = state.copy(showNotDeliveredSheet = false, notDeliveredSuccess = false, updatingStatus = true)
        updateOrderStatus.execute(orderId, DeliveryOrderStatus.NOT_DELIVERED, reasonText)
            .onSuccess { result ->
                logger.info { "Pedido ${state.detail?.id} marcado como no entregado, motivo: $reasonText" }
                val newEntry = DeliveryStatusHistoryEntry(
                    status = result.newStatus,
                    timestamp = getCurrentTimestamp(),
                    reason = reasonText
                )
                state = state.copy(
                    updatingStatus = false,
                    notDeliveredSuccess = true,
                    detail = state.detail?.copy(status = result.newStatus),
                    statusHistory = state.statusHistory + newEntry
                )
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al marcar pedido como no entregado" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateError = deliveryError.message ?: "Error al actualizar estado"
                )
            }
    }

    private fun getCurrentTimestamp(): String {
        val instant = Clock.System.now()
        val localDateTime = instant.toLocalDateTime(TimeZone.currentSystemDefault())
        return "${localDateTime.hour.toString().padStart(2, '0')}:${localDateTime.minute.toString().padStart(2, '0')}"
    }

    fun clearStatusFeedback() {
        state = state.copy(
            statusUpdateSuccess = false,
            statusUpdateError = null,
            notDeliveredSuccess = false
        )
    }
}
