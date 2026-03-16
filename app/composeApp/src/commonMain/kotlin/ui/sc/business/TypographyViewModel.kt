package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoGetFonts
import asdo.business.ToDoUpdateFonts
import ar.com.intrale.shared.business.FontsRequest
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

data class TypographyUIState(
    val titleFont: String = "",
    val subtitleFont: String = "",
    val bodyFont: String = "",
    val buttonFont: String = ""
)

class TypographyViewModel(
    private val getFonts: ToDoGetFonts = DIManager.di.direct.instance(),
    private val updateFonts: ToDoUpdateFonts = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<TypographyViewModel>()

    var uiState by mutableStateOf(TypographyUIState())
    var loading by mutableStateOf(false)
    var saving by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)
    var successMessage by mutableStateOf<String?>(null)

    override fun getState(): Any = uiState

    init {
        validation = Validation<TypographyUIState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadFonts(businessId: String) {
        if (businessId.isBlank()) return
        loading = true
        errorMessage = null
        getFonts.execute(businessId)
            .onSuccess { dto ->
                uiState = uiState.copy(
                    titleFont = dto.fonts["title"].orEmpty(),
                    subtitleFont = dto.fonts["subtitle"].orEmpty(),
                    bodyFont = dto.fonts["body"].orEmpty(),
                    buttonFont = dto.fonts["button"].orEmpty()
                )
                logger.info { "Fonts cargadas para negocio $businessId: ${dto.fonts}" }
            }
            .onFailure { e ->
                errorMessage = e.message
                logger.error(e) { "Error al cargar fonts para negocio $businessId" }
            }
        loading = false
    }

    suspend fun saveFonts(businessId: String): Result<Unit> {
        if (businessId.isBlank()) return Result.failure(IllegalStateException("Negocio no seleccionado"))
        saving = true
        errorMessage = null
        successMessage = null

        val fontsMap = buildMap {
            if (uiState.titleFont.isNotBlank()) put("title", uiState.titleFont)
            if (uiState.subtitleFont.isNotBlank()) put("subtitle", uiState.subtitleFont)
            if (uiState.bodyFont.isNotBlank()) put("body", uiState.bodyFont)
            if (uiState.buttonFont.isNotBlank()) put("button", uiState.buttonFont)
        }

        val result = updateFonts.execute(businessId, FontsRequest(fonts = fontsMap))
            .map { Unit }
            .onSuccess {
                logger.info { "Fonts guardadas para negocio $businessId" }
            }
            .onFailure { e ->
                errorMessage = e.message
                logger.error(e) { "Error al guardar fonts para negocio $businessId" }
            }

        saving = false
        return result
    }

    fun updateTitleFont(font: String) { uiState = uiState.copy(titleFont = font) }
    fun updateSubtitleFont(font: String) { uiState = uiState.copy(subtitleFont = font) }
    fun updateBodyFont(font: String) { uiState = uiState.copy(bodyFont = font) }
    fun updateButtonFont(font: String) { uiState = uiState.copy(buttonFont = font) }
}
