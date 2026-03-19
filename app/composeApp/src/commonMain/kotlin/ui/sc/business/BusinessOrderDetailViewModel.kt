package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.BusinessOrderDetail
import asdo.business.BusinessOrderStatus
import asdo.business.BusinessOrderStatusUpdateResult
import asdo.business.ToGetBusinessOrderDetail
import asdo.business.ToUpdateBusinessOrderStatus
import asdo.business.validTransitions
import ext.business.toBusinessException
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.session.SessionStore

enum class BusinessOrderDetailStatus { Idle, Loading, Loaded, Error }

data class BusinessOrderDetailUIState(
    val screenStatus: BusinessOrderDetailStatus = BusinessOrderDetailStatus.Idle,
    val detail: BusinessOrderDetail? = null,
    val errorMessage: String? = null,
    val updatingStatus: Boolean = false,
    val statusUpdateSuccess: Boolean = false,
    val statusUpdateError: String? = null,
    val showCancelDialog: Boolean = false,
    val cancelReason: String = "",
    val cancelReasonError: Boolean = false
)

class BusinessOrderDetailViewModel(
    private val getOrderDetail: ToGetBusinessOrderDetail = DIManager.di.direct.instance(),
    private val updateOrderStatus: ToUpdateBusinessOrderStatus = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<BusinessOrderDetailViewModel>()

    var state by mutableStateOf(BusinessOrderDetailUIState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    init {
        @Suppress("UNCHECKED_CAST")
        validation = Validation<BusinessOrderDetailUIState> { } as Validation<Any>
        initInputState()
    }

    suspend fun loadDetail() {
        val businessId = SessionStore.sessionState.value.selectedBusinessId
        val orderId = BusinessOrderSelectionStore.selectedOrderId.value
        if (businessId.isNullOrBlank() || orderId.isNullOrBlank()) {
            logger.warning { "No hay negocio u orden seleccionados" }
            state = state.copy(
                screenStatus = BusinessOrderDetailStatus.Error,
                errorMessage = "No se selecciono un pedido"
            )
            return
        }
        state = state.copy(screenStatus = BusinessOrderDetailStatus.Loading, errorMessage = null)
        getOrderDetail.execute(businessId, orderId)
            .onSuccess { detail ->
                logger.info { "Detalle del pedido $orderId cargado correctamente" }
                state = state.copy(screenStatus = BusinessOrderDetailStatus.Loaded, detail = detail)
            }
            .onFailure { throwable ->
                val error = throwable.toBusinessException()
                logger.error(throwable) { "Error al cargar detalle del pedido $orderId" }
                state = state.copy(
                    screenStatus = BusinessOrderDetailStatus.Error,
                    errorMessage = error.message ?: "Error al cargar detalle"
                )
            }
    }

    suspend fun advanceStatus(newStatus: BusinessOrderStatus, reason: String? = null) {
        val businessId = SessionStore.sessionState.value.selectedBusinessId ?: return
        val orderId = state.detail?.id ?: return
        val currentStatus = state.detail?.status ?: return

        // Validar transicion
        if (newStatus !in currentStatus.validTransitions()) {
            logger.warning { "Transicion invalida de $currentStatus a $newStatus" }
            state = state.copy(statusUpdateError = "Transicion de estado no permitida")
            return
        }

        state = state.copy(updatingStatus = true, statusUpdateSuccess = false, statusUpdateError = null)
        updateOrderStatus.execute(businessId, orderId, newStatus, reason)
            .onSuccess { result ->
                logger.info { "Estado del pedido $orderId actualizado a ${result.newStatus}" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateSuccess = true,
                    detail = state.detail?.copy(status = result.newStatus)
                )
            }
            .onFailure { throwable ->
                val error = throwable.toBusinessException()
                logger.error(throwable) { "Error al actualizar estado del pedido $orderId" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateError = error.message ?: "Error al actualizar estado"
                )
            }
    }

    fun showCancelDialog() {
        state = state.copy(showCancelDialog = true, cancelReason = "", cancelReasonError = false)
    }

    fun dismissCancelDialog() {
        state = state.copy(showCancelDialog = false)
    }

    fun updateCancelReason(reason: String) {
        state = state.copy(cancelReason = reason, cancelReasonError = false)
    }

    suspend fun confirmCancel() {
        if (state.cancelReason.isBlank()) {
            state = state.copy(cancelReasonError = true)
            return
        }
        state = state.copy(showCancelDialog = false)
        advanceStatus(BusinessOrderStatus.CANCELLED, state.cancelReason.trim())
    }

    fun clearStatusFeedback() {
        state = state.copy(
            statusUpdateSuccess = false,
            statusUpdateError = null
        )
    }
}
