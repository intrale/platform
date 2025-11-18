package ui.sc.business

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Title
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.ColorPickerField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.session.BusinessColorPalette
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing
import ui.util.toColorOrNull

const val PERSONALIZATION_PATH = "/personalization"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

private val COLOR_FIELDS = listOf(
    BusinessColorPalette.KEY_BACKGROUND_PRIMARY to MessageKey.personalization_colors_background_primary,
    BusinessColorPalette.KEY_SCREEN_BACKGROUND to MessageKey.personalization_colors_screen_background,
    BusinessColorPalette.KEY_PRIMARY_BUTTON to MessageKey.personalization_colors_primary_button,
    BusinessColorPalette.KEY_SECONDARY_BUTTON to MessageKey.personalization_colors_secondary_button,
    BusinessColorPalette.KEY_LABEL_TEXT to MessageKey.personalization_colors_label_text,
    BusinessColorPalette.KEY_INPUT_BACKGROUND to MessageKey.personalization_colors_input_background,
    BusinessColorPalette.KEY_HEADER_BACKGROUND to MessageKey.personalization_colors_header_background
)

class PersonalizationScreen : Screen(PERSONALIZATION_PATH) {

    override val messageTitle: MessageKey = MessageKey.personalization_title

    private val logger = LoggerFactory.default.newLogger<PersonalizationScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando PersonalizationScreen" }
        PersonalizationContent()
    }

    @Composable
    private fun PersonalizationContent(viewModel: PersonalizationViewModel = viewModel { PersonalizationViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val role = sessionState.role
        val hasAccess = role in ALLOWED_ROLES && sessionState.selectedBusinessId?.isNotBlank() == true

        val accessDeniedMessage = Txt(MessageKey.personalization_access_denied)

        if (!hasAccess) {
            Text(
                text = accessDeniedMessage,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        val businessId = sessionState.selectedBusinessId.orEmpty()
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        val saveLabel = Txt(MessageKey.personalization_colors_save)
        val saveSuccess = Txt(MessageKey.personalization_colors_save_success)
        val saveError = Txt(MessageKey.personalization_colors_save_error)
        val loadError = Txt(MessageKey.personalization_colors_load_error)

        LaunchedEffect(businessId) {
            val result = viewModel.loadColors(businessId)
            result.onFailure {
                snackbarHostState.showSnackbar(loadError)
            }
        }

        val description = Txt(MessageKey.personalization_description)
        val businessContext = Txt(
            key = MessageKey.personalization_business_context,
            params = mapOf("businessId" to businessId),
        )
        val pendingLabel = Txt(MessageKey.personalization_section_pending)

        val pendingSections = listOf(
            PersonalizationSection(
                icon = Icons.Default.Title,
                title = Txt(MessageKey.personalization_section_typography),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Image,
                title = Txt(MessageKey.personalization_section_images),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Brush,
                title = Txt(MessageKey.personalization_section_app_icon),
                description = pendingLabel,
            ),
        )

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                modifier = Modifier
                    .padding(padding)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x4
                    ),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodyLarge,
                )

                Text(
                    text = businessContext,
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
                )

                if (viewModel.isLoading) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }

                ColorsCard(
                    viewModel = viewModel,
                    saveLabel = saveLabel,
                    saveSuccess = saveSuccess,
                    saveError = saveError,
                    snackbarHostState = snackbarHostState,
                    coroutineScope = coroutineScope,
                    businessId = businessId
                )

                PreviewCard(viewModel.state.palette)

                pendingSections.forEach { section ->
                    PersonalizationCard(section)
                }
            }
        }
    }

    @Composable
    private fun ColorsCard(
        viewModel: PersonalizationViewModel,
        saveLabel: String,
        saveSuccess: String,
        saveError: String,
        snackbarHostState: SnackbarHostState,
        coroutineScope: CoroutineScope,
        businessId: String
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = Txt(MessageKey.personalization_section_colors),
                    style = MaterialTheme.typography.titleMedium,
                )

                val paletteMap = viewModel.state.palette.toMap()
                COLOR_FIELDS.forEach { (key, labelKey) ->
                    ColorPickerField(
                        label = labelKey,
                        value = paletteMap[key].orEmpty(),
                        state = viewModel.inputsStates[key]!!,
                        onValueChange = { newValue -> viewModel.updateColor(key, newValue) }
                    )
                }

                viewModel.state.lastUpdated?.let {
                    Text(
                        text = Txt(
                            MessageKey.personalization_colors_last_updated,
                            mapOf("timestamp" to it)
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                viewModel.state.updatedBy?.let {
                    Text(
                        text = Txt(
                            MessageKey.personalization_colors_updated_by,
                            mapOf("user" to it)
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                IntralePrimaryButton(
                    text = saveLabel,
                    loading = viewModel.isSaving,
                    enabled = !viewModel.isSaving,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.isSaving = it },
                                serviceCall = { viewModel.saveColors(businessId) },
                                onSuccess = {
                                    coroutineScope.launch { snackbarHostState.showSnackbar(saveSuccess) }
                                },
                                onError = {
                                    coroutineScope.launch { snackbarHostState.showSnackbar(saveError) }
                                }
                            )
                        } else {
                            coroutineScope.launch { snackbarHostState.showSnackbar(saveError) }
                        }
                    }
                )
            }
        }
    }

    @Composable
    private fun PreviewCard(palette: BusinessColorPalette) {
        val background = palette.backgroundPrimary.toColorOrNull() ?: MaterialTheme.colorScheme.background
        val screen = palette.screenBackground.toColorOrNull() ?: MaterialTheme.colorScheme.surface
        val header = palette.headerBackground.toColorOrNull() ?: MaterialTheme.colorScheme.primaryContainer
        val label = palette.labelText.toColorOrNull() ?: MaterialTheme.colorScheme.onBackground
        val primaryButton = palette.primaryButton.toColorOrNull() ?: MaterialTheme.colorScheme.primary
        val secondaryButton = palette.secondaryButton.toColorOrNull() ?: MaterialTheme.colorScheme.secondary
        val inputBackground = palette.inputBackground.toColorOrNull() ?: MaterialTheme.colorScheme.surface

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = background)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(header, MaterialTheme.shapes.medium)
                        .padding(MaterialTheme.spacing.x1_5),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = Txt(MessageKey.personalization_colors_preview_header),
                        style = MaterialTheme.typography.titleSmall,
                        color = label
                    )
                    Text(
                        text = Txt(MessageKey.personalization_colors_preview_badge),
                        style = MaterialTheme.typography.labelSmall,
                        color = label
                    )
                }
                Text(
                    text = Txt(MessageKey.personalization_colors_preview_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = label
                )
                Divider(color = label.copy(alpha = 0.2f))
                Text(
                    text = Txt(MessageKey.personalization_colors_preview_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = label
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    Button(
                        onClick = {},
                        colors = ButtonDefaults.buttonColors(
                            containerColor = primaryButton,
                            contentColor = MaterialTheme.colorScheme.onPrimary
                        )
                    ) {
                        Text(text = Txt(MessageKey.personalization_colors_preview_cta_primary))
                    }
                    Button(
                        onClick = {},
                        colors = ButtonDefaults.buttonColors(
                            containerColor = secondaryButton,
                            contentColor = MaterialTheme.colorScheme.onSecondary
                        )
                    ) {
                        Text(text = Txt(MessageKey.personalization_colors_preview_cta_secondary))
                    }
                }
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1_5))
                Card(
                    colors = CardDefaults.cardColors(containerColor = screen)
                ) {
                    Text(
                        text = Txt(MessageKey.personalization_colors_preview_input_label),
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(inputBackground)
                            .padding(MaterialTheme.spacing.x1_5),
                        color = label
                    )
                }
            }
        }
    }

    @Composable
    private fun PersonalizationCard(section: PersonalizationSection) {
        Card(
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                RowHeader(section)

                Text(
                    text = section.description,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }

    @Composable
    private fun RowHeader(section: PersonalizationSection) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            androidx.compose.material3.Icon(
                imageVector = section.icon,
                contentDescription = null
            )
            Text(
                text = section.title,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}

private data class PersonalizationSection(
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val title: String,
    val description: String,
)
