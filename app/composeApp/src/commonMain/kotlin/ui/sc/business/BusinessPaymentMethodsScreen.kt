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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val BUSINESS_PAYMENT_METHODS_PATH = "/businessPaymentMethods"

private val PAYMENT_METHODS_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessPaymentMethodsScreen : Screen(BUSINESS_PAYMENT_METHODS_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_payment_methods_title

    private val logger = LoggerFactory.default.newLogger<BusinessPaymentMethodsScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BusinessPaymentMethodsScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(
        viewModel: BusinessPaymentMethodsViewModel = viewModel { BusinessPaymentMethodsViewModel() }
    ) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in PAYMENT_METHODS_ALLOWED_ROLES && businessId?.isNotBlank() == true

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.business_payment_methods_access_denied),
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
                text = Txt(MessageKey.business_payment_methods_title),
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = Txt(MessageKey.business_payment_methods_description),
                style = MaterialTheme.typography.bodyLarge
            )

            when (uiState.status) {
                BusinessPaymentMethodsStatus.Loading -> {
                    CircularProgressIndicator()
                    Text(text = Txt(MessageKey.business_payment_methods_loading))
                }
                BusinessPaymentMethodsStatus.MissingBusiness -> {
                    Text(text = Txt(MessageKey.business_payment_methods_missing_business))
                }
                is BusinessPaymentMethodsStatus.Error -> {
                    Text(
                        text = Txt(MessageKey.business_payment_methods_error),
                        color = MaterialTheme.colorScheme.error
                    )
                    TextButton(onClick = {
                        coroutineScope.launch { viewModel.loadPaymentMethods(businessId) }
                    }) {
                        Text(text = Txt(MessageKey.business_payment_methods_retry))
                    }
                }
                else -> {
                    PaymentMethodsForm(viewModel, businessId)
                }
            }
        }
    }

    @Composable
    private fun PaymentMethodsForm(
        viewModel: BusinessPaymentMethodsViewModel,
        businessId: String?
    ) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val isSaving = uiState.status == BusinessPaymentMethodsStatus.Saving

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
                Text(
                    text = Txt(MessageKey.business_payment_methods_section_title),
                    style = MaterialTheme.typography.labelLarge
                )
                uiState.methods.forEach { method ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
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
                            onCheckedChange = { viewModel.toggleMethod(method.id) },
                            enabled = !isSaving
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))

        Button(
            onClick = {
                coroutineScope.launch { viewModel.savePaymentMethods(businessId) }
            },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (isSaving) {
                CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
            } else {
                Text(text = Txt(MessageKey.business_payment_methods_save))
            }
        }

        if (uiState.status == BusinessPaymentMethodsStatus.Saved) {
            Text(
                text = Txt(MessageKey.business_payment_methods_saved),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
