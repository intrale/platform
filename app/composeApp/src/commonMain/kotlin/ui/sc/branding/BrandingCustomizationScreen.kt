@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ui.sc.branding

import asdo.branding.BrandingCustomizationViewModel
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.StringResource
import ui.cp.buttons.IntralePrimaryButton
import ui.rs.dashboard
import ui.sc.shared.Screen
import ui.th.spacing
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

const val BRANDING_CUSTOMIZATION_PATH = "/branding/customization"

private val BRANDING_CUSTOMIZATION_LABEL: StringResource = dashboard

class BrandingCustomizationScreen : Screen(BRANDING_CUSTOMIZATION_PATH, BRANDING_CUSTOMIZATION_LABEL) {

    @Composable
    override fun screen() {
        val viewModel: BrandingCustomizationViewModel = viewModel { BrandingCustomizationViewModel() }
        val uiState by viewModel.uiState.collectAsState()
        val scrollState = rememberScrollState()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(MaterialTheme.spacing.x2)
                .verticalScroll(scrollState),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
        ) {
            BrandingHeader()
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Color primario (HEX)")
                ),
                value = uiState.theme.palette.primary,
                onValueChange = viewModel::updatePrimaryColor
            )
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Color secundario (HEX)")
                ),
                value = uiState.theme.palette.secondary,
                onValueChange = viewModel::updateSecondaryColor
            )
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Color de fondo (HEX)")
                ),
                value = uiState.theme.palette.background,
                onValueChange = viewModel::updateBackgroundColor
            )
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Tipografía principal")
                ),
                value = uiState.theme.typography,
                onValueChange = viewModel::updateTypography
            )
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Logo (URL o base64)")
                ),
                value = uiState.theme.assets.logoUrl.orEmpty(),
                onValueChange = viewModel::updateLogoUrl
            )
            BrandingTextField(
                label = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Splash (URL opcional)")
                ),
                value = uiState.theme.assets.splashImageUrl.orEmpty(),
                onValueChange = viewModel::updateSplashUrl
            )

            if (uiState.isLoading) {
                LoadingIndicator(text = resString(fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Cargando branding…")))
            }

            if (uiState.message != null && uiState.message.isNotBlank()) {
                Text(
                    text = uiState.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            IntralePrimaryButton(
                text = resString(fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Guardar cambios")),
                loading = uiState.isSaving,
                onClick = { viewModel.saveBranding() }
            )
        }
    }

    @Composable
    private fun BrandingHeader() {
        val title = resString(
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Personalización de branding")
        )
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_75)
        ) {
            Icon(
                imageVector = Icons.Default.Palette,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall
            )
            Text(
                text = resString(
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Ajusta colores, tipografías e imágenes antes de publicar.")
                ),
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }

    @Composable
    private fun BrandingTextField(
        label: String,
        value: String,
        onValueChange: (String) -> Unit
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            label = { Text(text = label) }
        )
    }

    @Composable
    private fun LoadingIndicator(text: String) {
        val spacing = MaterialTheme.spacing.x1
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = spacing),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(spacing)
        ) {
            CircularProgressIndicator()
            Text(text = text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
