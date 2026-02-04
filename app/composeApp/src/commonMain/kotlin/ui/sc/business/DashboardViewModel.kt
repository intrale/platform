package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.ToDoResetLoginCache
import asdo.business.ToGetBusinesses
import asdo.business.ToGetBusinessDashboardSummary
import ext.dto.BusinessDashboardSummaryDTO
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.session.SessionStore

data class DashboardBusiness(
    val id: String,
    val name: String
)

sealed interface BusinessDashboardSummaryState {
    data object Loading : BusinessDashboardSummaryState
    data object MissingBusiness : BusinessDashboardSummaryState
    data class Error(val message: String) : BusinessDashboardSummaryState
    data class Loaded(val summary: BusinessDashboardSummaryDTO) : BusinessDashboardSummaryState
}

data class DashboardUiState(
    val businesses: List<DashboardBusiness> = emptyList(),
    val selectedBusinessId: String? = null,
    val selectedBusinessName: String = "",
    val isBusinessLoading: Boolean = true,
    val businessError: String? = null,
    val summaryState: BusinessDashboardSummaryState = BusinessDashboardSummaryState.Loading
)

class DashboardViewModel(
    private val toDoResetLoginCache: ToDoResetLoginCache = DIManager.di.direct.instance(),
    private val toGetBusinesses: ToGetBusinesses = DIManager.di.direct.instance(),
    private val toGetBusinessDashboardSummary: ToGetBusinessDashboardSummary = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<DashboardViewModel>()

    var state by mutableStateOf(DashboardUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<DashboardUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() { /* No-op */ }

    suspend fun loadDashboard() {
        state = state.copy(isBusinessLoading = true, businessError = null)
        toGetBusinesses.execute()
            .onSuccess { response ->
                val businesses = response.businesses.map { DashboardBusiness(it.businessId, it.name) }
                val storedBusinessId = SessionStore.sessionState.value.selectedBusinessId
                val resolvedBusinessId = when {
                    businesses.size == 1 -> businesses.first().id
                    storedBusinessId != null && businesses.any { it.id == storedBusinessId } -> storedBusinessId
                    else -> null
                }
                if (resolvedBusinessId != storedBusinessId) {
                    SessionStore.updateSelectedBusiness(resolvedBusinessId)
                }
                val selectedName = businesses.firstOrNull { it.id == resolvedBusinessId }?.name.orEmpty()
                state = state.copy(
                    businesses = businesses,
                    selectedBusinessId = resolvedBusinessId,
                    selectedBusinessName = selectedName,
                    isBusinessLoading = false,
                    businessError = null,
                    summaryState = if (resolvedBusinessId == null) {
                        BusinessDashboardSummaryState.MissingBusiness
                    } else {
                        BusinessDashboardSummaryState.Loading
                    }
                )
                if (resolvedBusinessId != null) {
                    loadSummary(resolvedBusinessId)
                }
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar negocios administrados" }
                state = state.copy(
                    isBusinessLoading = false,
                    businessError = error.message ?: "Error al cargar negocios",
                    summaryState = BusinessDashboardSummaryState.Error(
                        error.message ?: "Error al obtener métricas"
                    )
                )
            }
    }

    suspend fun refreshSummary() {
        val businessId = state.selectedBusinessId
        if (businessId.isNullOrBlank()) {
            state = state.copy(summaryState = BusinessDashboardSummaryState.MissingBusiness)
            return
        }
        loadSummary(businessId)
    }

    suspend fun selectBusiness(businessId: String) {
        val business = state.businesses.firstOrNull { it.id == businessId } ?: return
        SessionStore.updateSelectedBusiness(business.id)
        state = state.copy(
            selectedBusinessId = business.id,
            selectedBusinessName = business.name,
            summaryState = BusinessDashboardSummaryState.Loading
        )
        loadSummary(business.id)
    }

    private suspend fun loadSummary(businessId: String) {
        state = state.copy(summaryState = BusinessDashboardSummaryState.Loading)
        toGetBusinessDashboardSummary.execute(businessId)
            .onSuccess { summary ->
                state = state.copy(summaryState = BusinessDashboardSummaryState.Loaded(summary))
            }
            .onFailure { error ->
                logger.error(error) { "Error al obtener métricas del dashboard" }
                state = state.copy(
                    summaryState = BusinessDashboardSummaryState.Error(
                        error.message ?: "Error al obtener métricas"
                    )
                )
            }
    }

    suspend fun logout() {
        logger.info { "Ejecutando logout" }
        try {
            toDoResetLoginCache.execute()
            logger.info { "Logout completado" }
            SessionStore.clear()
        } catch (e: Throwable) {
            logger.error(e) { "Error al ejecutar logout" }
            throw e
        }
    }
}
