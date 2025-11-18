package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.sc.shared.ViewModel
import ui.session.BusinessColorPalette
import asdo.lookandfeel.ToGetBusinessLookAndFeelColors
import asdo.lookandfeel.ToSaveBusinessLookAndFeelColors
import ui.session.SessionStore
import ar.com.intrale.strings.model.MessageKey

class PersonalizationViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<PersonalizationViewModel>()
    private val getColors: ToGetBusinessLookAndFeelColors by DIManager.di.instance()
    private val saveColors: ToSaveBusinessLookAndFeelColors by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var isLoading by mutableStateOf(false)
    var isSaving by mutableStateOf(false)

    data class UIState(
        val palette: BusinessColorPalette = BusinessColorPalette(),
        val lastUpdated: String? = null,
        val updatedBy: String? = null
    )

    override fun getState(): Any = state.palette

    init {
        validation = Validation<BusinessColorPalette> {
            BusinessColorPalette::backgroundPrimary required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::screenBackground required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::primaryButton required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::secondaryButton required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::labelText required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::inputBackground required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
            BusinessColorPalette::headerBackground required {
                pattern("^#[0-9a-fA-F]{6}$") hint MessageKey.personalization_colors_invalid_hex.name
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(BusinessColorPalette::backgroundPrimary.name),
            entry(BusinessColorPalette::screenBackground.name),
            entry(BusinessColorPalette::primaryButton.name),
            entry(BusinessColorPalette::secondaryButton.name),
            entry(BusinessColorPalette::labelText.name),
            entry(BusinessColorPalette::inputBackground.name),
            entry(BusinessColorPalette::headerBackground.name)
        )
    }

    fun updateColor(key: String, value: String) {
        state = state.copy(palette = state.palette.update(key, value))
    }

    suspend fun loadColors(businessId: String): Result<Unit> {
        logger.info { "Loading colors for $businessId" }
        isLoading = true
        val result = getColors.execute(businessId)
        result.onSuccess { data ->
            state = state.copy(
                palette = data.palette,
                lastUpdated = data.lastUpdated,
                updatedBy = data.updatedBy
            )
            initInputState()
        }.onFailure { error ->
            logger.error(error) { "Unable to load colors" }
        }
        isLoading = false
        return result.map { }
    }

    suspend fun saveColors(businessId: String): Result<Unit> {
        if (!isValid()) {
            return Result.failure(IllegalStateException("Invalid colors"))
        }
        logger.info { "Saving colors for $businessId" }
        isSaving = true
        val normalizedPalette = state.palette.normalized()
        val result = saveColors.execute(businessId, normalizedPalette)
        result.onSuccess { data ->
            state = state.copy(
                palette = data.palette,
                lastUpdated = data.lastUpdated,
                updatedBy = data.updatedBy
            )
            initInputState()
        }.onFailure { error ->
            logger.error(error) { "Unable to save colors" }
        }
        isSaving = false
        return result.map { }
    }
}

fun PersonalizationViewModel.selectedBusinessId(): String? =
    SessionStore.sessionState.value.selectedBusinessId

fun PersonalizationViewModel.getInputState(key: String): InputState =
    inputsStates[key] ?: InputState(key)
