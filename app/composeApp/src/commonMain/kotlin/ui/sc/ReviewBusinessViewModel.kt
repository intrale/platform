package ui.sc

import DIManager
import asdo.ToDoReviewBusinessRegistration
import asdo.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ext.BusinessDTO
import io.konform.validation.Validation
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ReviewBusinessViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<ReviewBusinessViewModel>()
    private val review: ToDoReviewBusinessRegistration by DIManager.di.instance()
    private val getBusinesses: ToGetBusinesses by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)
    var pending by mutableStateOf(listOf<BusinessDTO>())
    var selected by mutableStateOf(setOf<String>())

    data class UIState(
        val twoFactorCode: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::twoFactorCode required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::twoFactorCode.name)
        )
    }

    suspend fun approve(publicId: String) =
        review.execute(publicId, "approved", state.twoFactorCode)
            .onSuccess { logger.info { "Negocio aprobado: ${'$'}publicId" } }
            .onFailure { error -> logger.error { "Error aprobando ${'$'}publicId: ${'$'}{error.message}" } }

    suspend fun reject(publicId: String) =
        review.execute(publicId, "rejected", state.twoFactorCode)
            .onSuccess { logger.warning { "Negocio rechazado: ${'$'}publicId" } }
            .onFailure { error -> logger.error { "Error rechazando ${'$'}publicId: ${'$'}{error.message}" } }

    suspend fun approveSelected() {
        selected.forEach { approve(it) }
    }

    suspend fun rejectSelected() {
        selected.forEach { reject(it) }
    }

    fun toggleSelection(publicId: String) {
        selected = if (selected.contains(publicId)) selected - publicId else selected + publicId
    }

    fun selectAll() {
        selected = pending.map { it.publicId }.toSet()
    }

    fun clearSelection() {
        selected = emptySet()
    }

    suspend fun loadPending() {
        logger.debug { "Cargando negocios pendientes" }
        getBusinesses.execute(status = "PENDING")
            .onSuccess {
                pending = it.businesses
                selected = emptySet()
                logger.info { "Pendientes obtenidos: ${'$'}{pending.size}" }
            }
            .onFailure { error -> logger.error { "Error cargando pendientes: ${'$'}{error.message}" } }
    }
}
