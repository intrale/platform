package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val PAYMENT_METHODS_CONFIG_PATH = "/paymentMethodsConfig"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class PaymentMethodsConfigScreen : Screen(PAYMENT_METHODS_CONFIG_PATH) {

    override val messageTitle: MessageKey = MessageKey.payment_methods_config_title

    private val logger = LoggerFactory.default.newLogger<PaymentMethodsConfigScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando PaymentMethodsConfigScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(
        viewModel: PaymentMethodsConfigViewModel = viewModel { PaymentMethodsConfigViewModel() }
    ) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in ALLOWED_ROLES && businessId?.isNotBlank() == true

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.payment_methods_config_access_denied),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        LaunchedEffect(businessId) {
            coroutineScope.launch { viewModel.loadPaymentMethods(businessId) }
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
                text = Txt(MessageKey.payment_methods_config_title),
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = Txt(MessageKey.payment_methods_config_description),
                style = MaterialTheme.typography.bodyLarge
            )

            when (val status = uiState.status) {
                PaymentMethodsConfigStatus.Loading -> {
                    CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x6))
                    Text(text = Txt(MessageKey.payment_methods_config_loading))
                }
                PaymentMethodsConfigStatus.MissingBusiness -> {
                    Text(text = Txt(MessageKey.payment_methods_config_missing_business))
                }
                is PaymentMethodsConfigStatus.Error -> {
                    Text(
                        text = Txt(MessageKey.payment_methods_config_error),
                        color = MaterialTheme.colorScheme.error
                    )
                    TextButton(onClick = {
                        coroutineScope.launch { viewModel.loadPaymentMethods(businessId) }
                    }) {
                        Text(text = Txt(MessageKey.payment_methods_config_retry))
                    }
                }
                else -> {
                    PaymentMethodsList(viewModel, businessId, uiState.status)
                }
            }
        }
    }

    @Composable
    private fun PaymentMethodsList(
        viewModel: PaymentMethodsConfigViewModel,
        businessId: String?,
        status: PaymentMethodsConfigStatus
    ) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val isSaving = status == PaymentMethodsConfigStatus.Saving

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                uiState.methods.forEachIndexed { index, method ->
                    PaymentMethodRow(
                        method = method,
                        enabled = !isSaving,
                        onToggle = { checked ->
                            viewModel.togglePaymentMethod(method.id, checked)
                        }
                    )
                    if (index < uiState.methods.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1)
                        )
                    }
                }
            }
        }

        if (status == PaymentMethodsConfigStatus.Saved) {
            Text(
                text = Txt(MessageKey.payment_methods_config_saved),
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.bodyMedium
            )
        }

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

        Button(
            onClick = {
                coroutineScope.launch { viewModel.savePaymentMethods(businessId) }
            },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (isSaving) {
                CircularProgressIndicator(
                    modifier = Modifier.size(MaterialTheme.spacing.x3),
                    color = MaterialTheme.colorScheme.onPrimary
                )
            } else {
                Text(text = Txt(MessageKey.payment_methods_config_save))
            }
        }
    }
}

@Composable
private fun PaymentMethodRow(
    method: BusinessPaymentMethodDTO,
    enabled: Boolean,
    onToggle: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.x1),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = method.name,
                style = MaterialTheme.typography.bodyLarge
            )
            if (!method.description.isNullOrBlank()) {
                Text(
                    text = method.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Switch(
            checked = method.enabled,
            onCheckedChange = onToggle,
            enabled = enabled
        )
    }
}
