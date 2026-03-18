package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

private val BANNER_FORM_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BannerFormScreen(
    private val editorStore: BannerEditorStore = BannerEditorStore
) : Screen(BUSINESS_BANNER_FORM_PATH) {

    override val messageTitle: MessageKey = MessageKey.banner_form_title_create

    private val logger = LoggerFactory.default.newLogger<BannerFormScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BannerFormScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BannerFormViewModel = viewModel { BannerFormViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState by SessionStore.sessionState.collectAsState()
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in BANNER_FORM_ALLOWED_ROLES && businessId?.isNotBlank() == true
        val draft by editorStore.draft.collectAsState()

        LaunchedEffect(draft) {
            viewModel.loadDraft(draft)
        }

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.business_banners_access_denied),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = if (uiState.isEditing) {
                    Txt(MessageKey.banner_form_title_edit)
                } else {
                    Txt(MessageKey.banner_form_title_create)
                },
                style = MaterialTheme.typography.headlineMedium
            )

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
                    val titleState = remember { mutableStateOf(InputState("title")) }
                    TextField(
                        label = MessageKey.banner_form_field_title,
                        value = uiState.title,
                        state = titleState,
                        onValueChange = { viewModel.updateTitle(it) },
                        enabled = uiState.status != BannerFormStatus.Saving
                    )

                    val textState = remember { mutableStateOf(InputState("text")) }
                    TextField(
                        label = MessageKey.banner_form_field_text,
                        value = uiState.text,
                        state = textState,
                        onValueChange = { viewModel.updateText(it) },
                        enabled = uiState.status != BannerFormStatus.Saving
                    )

                    val imageUrlState = remember { mutableStateOf(InputState("imageUrl")) }
                    TextField(
                        label = MessageKey.banner_form_field_image_url,
                        value = uiState.imageUrl,
                        state = imageUrlState,
                        onValueChange = { viewModel.updateImageUrl(it) },
                        enabled = uiState.status != BannerFormStatus.Saving
                    )

                    val positionState = remember { mutableStateOf(InputState("position")) }
                    TextField(
                        label = MessageKey.banner_form_field_position,
                        value = uiState.position,
                        state = positionState,
                        onValueChange = { viewModel.updatePosition(it) },
                        enabled = uiState.status != BannerFormStatus.Saving
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = Txt(MessageKey.banner_form_field_active),
                            style = MaterialTheme.typography.bodyLarge
                        )
                        Switch(
                            checked = uiState.active,
                            onCheckedChange = { viewModel.updateActive(it) },
                            enabled = uiState.status != BannerFormStatus.Saving
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))

            IntralePrimaryButton(
                text = Txt(MessageKey.banner_form_save),
                onClick = {
                    coroutineScope.launch { viewModel.saveBanner(businessId) }
                },
                enabled = uiState.status != BannerFormStatus.Saving,
                modifier = Modifier.fillMaxWidth()
            )

            if (uiState.status == BannerFormStatus.Saving) {
                CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
            }

            if (uiState.status == BannerFormStatus.Saved) {
                Text(
                    text = Txt(MessageKey.banner_form_saved),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            if (uiState.status is BannerFormStatus.Error) {
                Text(
                    text = Txt(MessageKey.banner_form_error),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}
