package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoCreateBanner
import asdo.business.ToDoUpdateBanner
import ar.com.intrale.shared.business.BannerRequest
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface BannerFormStatus {
    data object Idle : BannerFormStatus
    data object Saving : BannerFormStatus
    data object Saved : BannerFormStatus
    data object MissingBusiness : BannerFormStatus
    data class Error(val message: String) : BannerFormStatus
}

data class BannerFormUiState(
    val bannerId: String? = null,
    val title: String = "",
    val text: String = "",
    val imageUrl: String = "",
    val position: String = "home",
    val active: Boolean = true,
    val isEditing: Boolean = false,
    val status: BannerFormStatus = BannerFormStatus.Idle
)

class BannerFormViewModel(
    private val toDoCreateBanner: ToDoCreateBanner = DIManager.di.direct.instance(),
    private val toDoUpdateBanner: ToDoUpdateBanner = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BannerFormViewModel>()

    var state by mutableStateOf(BannerFormUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<BannerFormUiState> {
            BannerFormUiState::title {
                minLength(1) hint "El titulo es obligatorio"
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry("title"),
            entry("text"),
            entry("imageUrl"),
            entry("position")
        )
    }

    fun loadDraft(draft: BannerDraft?) {
        if (draft != null) {
            state = state.copy(
                bannerId = draft.id,
                title = draft.title,
                text = draft.text,
                imageUrl = draft.imageUrl,
                position = draft.position,
                active = draft.active,
                isEditing = draft.id != null,
                status = BannerFormStatus.Idle
            )
        }
    }

    fun updateTitle(value: String) { state = state.copy(title = value) }
    fun updateText(value: String) { state = state.copy(text = value) }
    fun updateImageUrl(value: String) { state = state.copy(imageUrl = value) }
    fun updatePosition(value: String) { state = state.copy(position = value) }
    fun updateActive(value: Boolean) { state = state.copy(active = value) }

    suspend fun saveBanner(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BannerFormStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        if (!isValid()) {
            return Result.failure(IllegalStateException("Validacion fallida"))
        }
        state = state.copy(status = BannerFormStatus.Saving)
        val request = BannerRequest(
            title = state.title,
            text = state.text,
            imageUrl = state.imageUrl,
            position = state.position,
            active = state.active
        )
        val result = if (state.isEditing && state.bannerId != null) {
            toDoUpdateBanner.execute(businessId, state.bannerId!!, request)
        } else {
            toDoCreateBanner.execute(businessId, request)
        }
        return result
            .map { banner ->
                state = state.copy(
                    bannerId = banner.id,
                    title = banner.title,
                    text = banner.text,
                    imageUrl = banner.imageUrl,
                    position = banner.position,
                    active = banner.active,
                    isEditing = true,
                    status = BannerFormStatus.Saved
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar banner" }
                state = state.copy(
                    status = BannerFormStatus.Error(
                        error.message ?: "Error al guardar banner"
                    )
                )
            }
    }
}
