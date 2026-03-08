package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.business.AVAILABLE_FONTS
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.th.spacing

const val TYPOGRAPHY_PATH = "/typography"

class TypographyScreen : Screen(TYPOGRAPHY_PATH) {

    override val messageTitle: MessageKey = MessageKey.typography_title

    private val logger = LoggerFactory.default.newLogger<TypographyScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando TypographyScreen" }
        TypographyContent()
    }

    @Composable
    private fun TypographyContent() {
        val sessionState by SessionStore.sessionState.collectAsState()
        val businessId = sessionState.selectedBusinessId.orEmpty()
        val viewModel = remember { TypographyViewModel() }
        val snackbarHostState = remember { SnackbarHostState() }
        val scope = rememberCoroutineScope()

        val successText = Txt(MessageKey.typography_saved)
        val errorGenericText = Txt(MessageKey.error_generic)

        LaunchedEffect(businessId) {
            if (businessId.isNotBlank()) {
                viewModel.loadFonts(businessId)
            }
        }

        LaunchedEffect(viewModel.errorMessage) {
            viewModel.errorMessage?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.errorMessage = null
            }
        }

        LaunchedEffect(viewModel.successMessage) {
            viewModel.successMessage?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.successMessage = null
            }
        }

        Box(modifier = Modifier.fillMaxSize()) {
            if (viewModel.loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(
                            horizontal = MaterialTheme.spacing.x3,
                            vertical = MaterialTheme.spacing.x4
                        ),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    Text(
                        text = Txt(MessageKey.typography_description),
                        style = MaterialTheme.typography.bodyLarge
                    )

                    FontSelectorRow(
                        label = Txt(MessageKey.typography_type_title),
                        selected = viewModel.uiState.titleFont,
                        onSelect = { viewModel.updateTitleFont(it) }
                    )

                    FontSelectorRow(
                        label = Txt(MessageKey.typography_type_subtitle),
                        selected = viewModel.uiState.subtitleFont,
                        onSelect = { viewModel.updateSubtitleFont(it) }
                    )

                    FontSelectorRow(
                        label = Txt(MessageKey.typography_type_body),
                        selected = viewModel.uiState.bodyFont,
                        onSelect = { viewModel.updateBodyFont(it) }
                    )

                    FontSelectorRow(
                        label = Txt(MessageKey.typography_type_button),
                        selected = viewModel.uiState.buttonFont,
                        onSelect = { viewModel.updateButtonFont(it) }
                    )

                    TypographyPreviewCard(state = viewModel.uiState)

                    Button(
                        onClick = {
                            scope.launch {
                                val result = viewModel.saveFonts(businessId)
                                if (result.isSuccess) {
                                    viewModel.successMessage = successText
                                } else if (viewModel.errorMessage == null) {
                                    viewModel.errorMessage = errorGenericText
                                }
                            }
                        },
                        enabled = !viewModel.saving && businessId.isNotBlank(),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        if (viewModel.saving) {
                            CircularProgressIndicator(
                                modifier = Modifier.padding(end = MaterialTheme.spacing.x2),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        }
                        Text(Txt(MessageKey.typography_save))
                    }
                }
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun FontSelectorRow(
        label: String,
        selected: String,
        onSelect: (String) -> Unit
    ) {
        var expanded by remember { mutableStateOf(false) }
        val displayValue = selected.ifBlank { Txt(MessageKey.typography_font_none) }

        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge
            )
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = it },
                modifier = Modifier.fillMaxWidth()
            ) {
                OutlinedTextField(
                    value = displayValue,
                    onValueChange = {},
                    readOnly = true,
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = true)
                )
                ExposedDropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false }
                ) {
                    DropdownMenuItem(
                        text = { Text(Txt(MessageKey.typography_font_none)) },
                        onClick = {
                            onSelect("")
                            expanded = false
                        }
                    )
                    AVAILABLE_FONTS.forEach { font ->
                        DropdownMenuItem(
                            text = { Text(font) },
                            onClick = {
                                onSelect(font)
                                expanded = false
                            }
                        )
                    }
                }
            }
        }
    }

    @Composable
    private fun TypographyPreviewCard(state: TypographyUIState) {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = Txt(MessageKey.typography_preview_title),
                    style = MaterialTheme.typography.titleMedium
                )

                PreviewRow(
                    label = Txt(MessageKey.typography_type_title),
                    font = state.titleFont,
                    sampleText = Txt(MessageKey.typography_preview_sample_title)
                )
                PreviewRow(
                    label = Txt(MessageKey.typography_type_subtitle),
                    font = state.subtitleFont,
                    sampleText = Txt(MessageKey.typography_preview_sample_subtitle)
                )
                PreviewRow(
                    label = Txt(MessageKey.typography_type_body),
                    font = state.bodyFont,
                    sampleText = Txt(MessageKey.typography_preview_sample_body)
                )
                PreviewRow(
                    label = Txt(MessageKey.typography_type_button),
                    font = state.buttonFont,
                    sampleText = Txt(MessageKey.typography_preview_sample_button)
                )
            }
        }
    }

    @Composable
    private fun PreviewRow(label: String, font: String, sampleText: String) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline
                )
                Text(
                    text = sampleText,
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            Text(
                text = font.ifBlank { "-" },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
