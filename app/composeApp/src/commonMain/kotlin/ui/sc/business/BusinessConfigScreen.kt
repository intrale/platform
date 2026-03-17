package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val BUSINESS_CONFIG_PATH = "/businessConfig"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessConfigScreen : Screen(BUSINESS_CONFIG_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_config_title

    private val logger = LoggerFactory.default.newLogger<BusinessConfigScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BusinessConfigScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BusinessConfigViewModel = viewModel { BusinessConfigViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in ALLOWED_ROLES && businessId?.isNotBlank() == true

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.business_config_access_denied),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        LaunchedEffect(businessId) {
            coroutineScope.launch { viewModel.loadConfig(businessId) }
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
                text = Txt(MessageKey.business_config_title),
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = Txt(MessageKey.business_config_description),
                style = MaterialTheme.typography.bodyLarge
            )

            when (uiState.status) {
                BusinessConfigStatus.Loading -> {
                    CircularProgressIndicator()
                    Text(text = Txt(MessageKey.business_config_loading))
                }
                BusinessConfigStatus.MissingBusiness -> {
                    Text(text = Txt(MessageKey.business_config_missing_business))
                }
                is BusinessConfigStatus.Error -> {
                    Text(text = Txt(MessageKey.business_config_error))
                    TextButton(onClick = {
                        coroutineScope.launch { viewModel.loadConfig(businessId) }
                    }) {
                        Text(text = Txt(MessageKey.business_config_retry))
                    }
                }
                else -> {
                    BusinessConfigForm(viewModel, businessId)
                }
            }
        }
    }

    @Composable
    private fun BusinessConfigForm(viewModel: BusinessConfigViewModel, businessId: String?) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state

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
                val nameState = remember { mutableStateOf(InputState("name")) }
                TextField(
                    label = MessageKey.business_config_name,
                    value = uiState.name,
                    state = nameState,
                    onValueChange = { viewModel.updateName(it) },
                    enabled = uiState.status != BusinessConfigStatus.Saving
                )

                val addressState = remember { mutableStateOf(InputState("address")) }
                TextField(
                    label = MessageKey.business_config_address,
                    value = uiState.address,
                    state = addressState,
                    onValueChange = { viewModel.updateAddress(it) },
                    enabled = uiState.status != BusinessConfigStatus.Saving
                )

                val phoneState = remember { mutableStateOf(InputState("phone")) }
                TextField(
                    label = MessageKey.business_config_phone,
                    value = uiState.phone,
                    state = phoneState,
                    onValueChange = { viewModel.updatePhone(it) },
                    enabled = uiState.status != BusinessConfigStatus.Saving
                )

                val emailState = remember { mutableStateOf(InputState("email")) }
                TextField(
                    label = MessageKey.business_config_email,
                    value = uiState.email,
                    state = emailState,
                    onValueChange = { viewModel.updateEmail(it) },
                    enabled = uiState.status != BusinessConfigStatus.Saving
                )

                val logoState = remember { mutableStateOf(InputState("logoUrl")) }
                TextField(
                    label = MessageKey.business_config_logo_url,
                    value = uiState.logoUrl,
                    state = logoState,
                    onValueChange = { viewModel.updateLogoUrl(it) },
                    enabled = uiState.status != BusinessConfigStatus.Saving
                )
            }
        }

        Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))

        Button(
            onClick = {
                coroutineScope.launch { viewModel.saveConfig(businessId) }
            },
            enabled = uiState.status != BusinessConfigStatus.Saving,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (uiState.status == BusinessConfigStatus.Saving) {
                CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
            } else {
                Text(text = Txt(MessageKey.business_config_save))
            }
        }

        if (uiState.status == BusinessConfigStatus.Saved) {
            Text(
                text = Txt(MessageKey.business_config_saved),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
