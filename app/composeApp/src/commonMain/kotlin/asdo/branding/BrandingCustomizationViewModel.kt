package asdo.branding

import DIManager
import androidx.lifecycle.viewModelScope
import ext.branding.CommBrandingService
import ext.dto.BrandingAssetsDto
import ext.dto.BrandingPaletteDto
import ext.dto.BrandingThemeDto
import io.konform.validation.Validation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class BrandingCustomizationViewModel : ViewModel() {

    private val brandingService: CommBrandingService by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<BrandingCustomizationViewModel>()

    private val _uiState = MutableStateFlow(BrandingCustomizationUiState())
    val uiState: StateFlow<BrandingCustomizationUiState> = _uiState.asStateFlow()

    init {
        validation = Validation<BrandingCustomizationUiState> { }.let { @Suppress("UNCHECKED_CAST") (it as Validation<Any>) }
        initInputState()
        loadBranding()
    }

    override fun getState(): Any = uiState.value

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    fun updatePrimaryColor(primary: String) {
        _uiState.update { state ->
            state.copy(theme = state.theme.copy(palette = state.theme.palette.copy(primary = primary)))
        }
    }

    fun updateSecondaryColor(secondary: String) {
        _uiState.update { state ->
            state.copy(theme = state.theme.copy(palette = state.theme.palette.copy(secondary = secondary)))
        }
    }

    fun updateBackgroundColor(background: String) {
        _uiState.update { state ->
            state.copy(theme = state.theme.copy(palette = state.theme.palette.copy(background = background)))
        }
    }

    fun updateTypography(typography: String) {
        _uiState.update { state -> state.copy(theme = state.theme.copy(typography = typography)) }
    }

    fun updateLogoUrl(logo: String) {
        _uiState.update { state ->
            state.copy(theme = state.theme.copy(assets = state.theme.assets.copy(logoUrl = logo)))
        }
    }

    fun updateSplashUrl(url: String) {
        _uiState.update { state ->
            state.copy(theme = state.theme.copy(assets = state.theme.assets.copy(splashImageUrl = url)))
        }
    }

    fun loadBranding() {
        viewModelScope.launch {
            logger.info { "Solicitando branding al servicio" }
            _uiState.update { it.copy(isLoading = true, message = null) }
            brandingService.getBranding()
                .onSuccess { theme ->
                    logger.info { "Branding recibido" }
                    _uiState.update { it.copy(theme = theme, isLoading = false) }
                }
                .onFailure { error ->
                    logger.error(error) { "Error obteniendo branding" }
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            message = error.message ?: "No se pudo cargar el branding"
                        )
                    }
                }
        }
    }

    fun saveBranding() {
        viewModelScope.launch {
            val currentTheme = uiState.value.theme
            logger.info { "Enviando cambios de branding" }
            _uiState.update { it.copy(isSaving = true, message = null) }
            brandingService.updateBranding(currentTheme)
                .onSuccess { theme ->
                    logger.info { "Branding actualizado" }
                    _uiState.update {
                        it.copy(
                            theme = theme,
                            isSaving = false,
                            message = "Cambios guardados"
                        )
                    }
                }
                .onFailure { error ->
                    logger.error(error) { "Error actualizando branding" }
                    _uiState.update {
                        it.copy(
                            isSaving = false,
                            message = error.message ?: "No se pudo guardar"
                        )
                    }
                }
        }
    }
}

data class BrandingCustomizationUiState(
    val theme: BrandingThemeDto = BrandingThemeDto(
        palette = BrandingPaletteDto(),
        assets = BrandingAssetsDto()
    ),
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val message: String? = null
)
