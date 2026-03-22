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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.shared.business.BusinessDeliveryZoneType
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

const val BUSINESS_DELIVERY_ZONE_PATH = "/businessDeliveryZone"

private val DELIVERY_ZONE_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessDeliveryZoneScreen : Screen(BUSINESS_DELIVERY_ZONE_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_delivery_zone_title

    private val logger = LoggerFactory.default.newLogger<BusinessDeliveryZoneScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BusinessDeliveryZoneScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BusinessDeliveryZoneViewModel = viewModel { BusinessDeliveryZoneViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in DELIVERY_ZONE_ALLOWED_ROLES && businessId?.isNotBlank() == true

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.business_delivery_zone_access_denied),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        LaunchedEffect(businessId) {
            coroutineScope.launch { viewModel.loadDeliveryZone(businessId) }
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
                text = Txt(MessageKey.business_delivery_zone_title),
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = Txt(MessageKey.business_delivery_zone_description),
                style = MaterialTheme.typography.bodyLarge
            )

            when (uiState.status) {
                BusinessDeliveryZoneStatus.Loading -> {
                    CircularProgressIndicator()
                    Text(text = Txt(MessageKey.business_delivery_zone_loading))
                }
                BusinessDeliveryZoneStatus.MissingBusiness -> {
                    Text(text = Txt(MessageKey.business_delivery_zone_missing_business))
                }
                is BusinessDeliveryZoneStatus.Error -> {
                    Text(text = Txt(MessageKey.business_delivery_zone_error))
                    TextButton(onClick = {
                        coroutineScope.launch { viewModel.loadDeliveryZone(businessId) }
                    }) {
                        Text(text = Txt(MessageKey.business_delivery_zone_retry))
                    }
                }
                else -> {
                    DeliveryZoneForm(viewModel, businessId)
                }
            }
        }
    }

    @Composable
    private fun DeliveryZoneForm(viewModel: BusinessDeliveryZoneViewModel, businessId: String?) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val isSaving = uiState.status == BusinessDeliveryZoneStatus.Saving

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
                    text = Txt(MessageKey.business_delivery_zone_type_label),
                    style = MaterialTheme.typography.labelLarge
                )
                Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                    FilterChip(
                        selected = uiState.type == BusinessDeliveryZoneType.RADIUS,
                        onClick = { viewModel.updateType(BusinessDeliveryZoneType.RADIUS) },
                        label = { Text(Txt(MessageKey.business_delivery_zone_type_radius)) },
                        enabled = !isSaving
                    )
                    FilterChip(
                        selected = uiState.type == BusinessDeliveryZoneType.POSTAL_CODES,
                        onClick = { viewModel.updateType(BusinessDeliveryZoneType.POSTAL_CODES) },
                        label = { Text(Txt(MessageKey.business_delivery_zone_type_postal_codes)) },
                        enabled = !isSaving
                    )
                }

                if (uiState.type == BusinessDeliveryZoneType.RADIUS) {
                    val radiusState = remember { mutableStateOf(InputState("radiusKm")) }
                    TextField(
                        label = MessageKey.business_delivery_zone_radius_label,
                        value = uiState.radiusKm,
                        state = radiusState,
                        onValueChange = { viewModel.updateRadiusKm(it) },
                        enabled = !isSaving
                    )
                } else {
                    Text(
                        text = Txt(MessageKey.business_delivery_zone_postal_codes_label),
                        style = MaterialTheme.typography.labelLarge
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        val postalCodeState = remember { mutableStateOf(InputState("postalCode")) }
                        TextField(
                            label = MessageKey.business_delivery_zone_postal_codes_hint,
                            value = uiState.postalCodeInput,
                            state = postalCodeState,
                            onValueChange = { viewModel.updatePostalCodeInput(it) },
                            enabled = !isSaving,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedButton(
                            onClick = { viewModel.addPostalCode() },
                            enabled = !isSaving && uiState.postalCodeInput.isNotBlank()
                        ) {
                            Text(text = Txt(MessageKey.business_delivery_zone_postal_codes_add))
                        }
                    }

                    uiState.postalCodes.forEach { code ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(text = code, style = MaterialTheme.typography.bodyMedium)
                            TextButton(
                                onClick = { viewModel.removePostalCode(code) },
                                enabled = !isSaving
                            ) {
                                Text(
                                    text = Txt(MessageKey.business_delivery_zone_postal_codes_remove),
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))

        Button(
            onClick = {
                coroutineScope.launch { viewModel.saveDeliveryZone(businessId) }
            },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (isSaving) {
                CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
            } else {
                Text(text = Txt(MessageKey.business_delivery_zone_save))
            }
        }

        if (uiState.status == BusinessDeliveryZoneStatus.Saved) {
            Text(
                text = Txt(MessageKey.business_delivery_zone_saved),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
