package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoListBanners
import asdo.business.ToDoToggleBanner
import ar.com.intrale.shared.business.BannerDTO
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class BannerListStatus { Idle, Loading, Loaded, Empty, Error, MissingBusiness }

data class BannerListItem(
    val id: String,
    val title: String,
    val text: String,
    val imageUrl: String,
    val position: String,
    val active: Boolean
)

data class BannerListUiState(
    val status: BannerListStatus = BannerListStatus.Idle,
    val items: List<BannerListItem> = emptyList(),
    val errorMessage: String? = null
)

class BannerListViewModel(
    private val listBanners: ToDoListBanners = DIManager.di.direct.instance(),
    private val toggleBanner: ToDoToggleBanner = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BannerListViewModel>()
    private var currentBusinessId: String? = null

    var state by mutableStateOf(BannerListUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<BannerListUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadBanners(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            logger.warning { "No hay negocio seleccionado para cargar banners" }
            state = state.copy(
                status = BannerListStatus.MissingBusiness,
                items = emptyList(),
                errorMessage = null
            )
            return
        }
        currentBusinessId = businessId
        state = state.copy(
            status = BannerListStatus.Loading,
            errorMessage = null
        )
        listBanners.execute(businessId)
            .onSuccess { banners ->
                val mapped = banners.mapNotNull { it.toItem() }
                state = state.copy(
                    status = if (mapped.isEmpty()) BannerListStatus.Empty else BannerListStatus.Loaded,
                    items = mapped,
                    errorMessage = null
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar banners" }
                state = state.copy(
                    status = BannerListStatus.Error,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun refresh() {
        loadBanners(currentBusinessId)
    }

    suspend fun toggleBannerActive(bannerId: String, active: Boolean): Result<BannerDTO> {
        val businessId = currentBusinessId
            ?: return Result.failure(IllegalStateException("No hay negocio seleccionado"))
        val result = toggleBanner.execute(businessId, bannerId, active)
        result.onSuccess {
            state = state.copy(
                items = state.items.map { item ->
                    if (item.id == bannerId) item.copy(active = active) else item
                }
            )
        }.onFailure { error ->
            logger.error(error) { "Error al cambiar estado del banner $bannerId" }
            state = state.copy(errorMessage = error.message)
        }
        return result
    }

    fun clearError() {
        if (state.errorMessage != null) {
            state = state.copy(errorMessage = null)
        }
    }

    fun toDraft(item: BannerListItem): BannerDraft =
        BannerDraft(
            id = item.id,
            title = item.title,
            text = item.text,
            imageUrl = item.imageUrl,
            position = item.position,
            active = item.active
        )

    private fun BannerDTO.toItem(): BannerListItem? {
        val id = id ?: return null
        return BannerListItem(
            id = id,
            title = title,
            text = text,
            imageUrl = imageUrl,
            position = position,
            active = active
        )
    }
}
