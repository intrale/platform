package ui.sc.delivery

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import kotlinx.datetime.DayOfWeek
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.th.spacing

const val DELIVERY_PROFILE_PATH = "/delivery/profile"

class DeliveryProfileScreen : Screen(DELIVERY_PROFILE_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_profile_title

    @Composable
    override fun screen() {
        val viewModel: DeliveryProfileViewModel = viewModel { DeliveryProfileViewModel() }
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val scrollState = rememberScrollState()

        val saveLabel = Txt(MessageKey.delivery_profile_save)
        val logoutLabel = Txt(MessageKey.delivery_profile_logout)
        val zonesLabel = Txt(MessageKey.delivery_profile_zones_title)
        val zonesEmpty = Txt(MessageKey.delivery_profile_zones_empty)
        val contactLabel = Txt(MessageKey.delivery_profile_contact_title)
        val vehicleLabel = Txt(MessageKey.delivery_profile_vehicle_title)
        val successMessage = state.successKey?.let { Txt(it) }

        LaunchedEffect(Unit) {
            viewModel.loadProfile()
        }

        LaunchedEffect(successMessage) {
            successMessage?.let { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        LaunchedEffect(state.error) {
            state.error?.let { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            if (state.loading) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    CircularProgressIndicator()
                    Text(text = Txt(MessageKey.client_profile_loading))
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .verticalScroll(scrollState)
                        .padding(MaterialTheme.spacing.x3),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    DeliveryProfileHeader(
                        name = state.form.fullName,
                        email = state.form.email
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
                            Text(
                                text = contactLabel,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            TextField(
                                label = MessageKey.delivery_profile_full_name,
                                value = state.form.fullName,
                                state = viewModel.inputsStates[DeliveryProfileForm::fullName.name]!!,
                                onValueChange = viewModel::onNameChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                            TextField(
                                label = MessageKey.delivery_profile_email,
                                value = state.form.email,
                                state = viewModel.inputsStates[DeliveryProfileForm::email.name]!!,
                                onValueChange = viewModel::onEmailChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                            TextField(
                                label = MessageKey.delivery_profile_phone,
                                value = state.form.phone,
                                state = viewModel.inputsStates[DeliveryProfileForm::phone.name]!!,
                                onValueChange = viewModel::onPhoneChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }

                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(MaterialTheme.spacing.x3),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            Text(
                                text = vehicleLabel,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            TextField(
                                label = MessageKey.delivery_profile_vehicle_type,
                                value = state.form.vehicleType,
                                state = viewModel.inputsStates[DeliveryProfileForm::vehicleType.name]!!,
                                onValueChange = viewModel::onVehicleTypeChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                            TextField(
                                label = MessageKey.delivery_profile_vehicle_model,
                                value = state.form.vehicleModel,
                                state = viewModel.inputsStates[DeliveryProfileForm::vehicleModel.name]!!,
                                onValueChange = viewModel::onVehicleModelChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                            TextField(
                                label = MessageKey.delivery_profile_vehicle_plate,
                                value = state.form.vehiclePlate,
                                state = viewModel.inputsStates[DeliveryProfileForm::vehiclePlate.name]!!,
                                onValueChange = viewModel::onVehiclePlateChange,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }

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
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Map,
                                    contentDescription = zonesLabel
                                )
                                Text(
                                    text = zonesLabel,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                            }

                            if (state.zones.isEmpty()) {
                                Text(
                                    text = zonesEmpty,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            } else {
                                state.zones.forEach { zone ->
                                    AssistChip(
                                        onClick = {},
                                        label = { Text(zone.name) },
                                        leadingIcon = {
                                            Icon(
                                                imageVector = Icons.Default.Map,
                                                contentDescription = zone.name
                                            )
                                        },
                                        modifier = Modifier.semantics { contentDescription = zone.name },
                                        colors = AssistChipDefaults.assistChipColors(
                                            containerColor = MaterialTheme.colorScheme.primaryContainer
                                        )
                                    )
                                    if (!zone.description.isNullOrBlank()) {
                                        Text(
                                            text = zone.description.orEmpty(),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                            }
                        }
                    }

                    DeliveryAvailabilitySection(
                        viewModel = viewModel,
                        state = state
                    )

                    Column(
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        var contentDescriptionTxt = Txt(MessageKey.delivery_profile_save_content_description)
                        IntralePrimaryButton(
                            text = saveLabel,
                            onClick = { coroutineScope.launch { viewModel.saveProfile() } },
                            loading = state.saving,
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics { contentDescription = contentDescriptionTxt },
                            leadingIcon = Icons.Default.Save,
                            iconContentDescription = saveLabel
                        )
                        TextButton(
                            onClick = {
                                coroutineScope.launch {
                                    viewModel.logout()
                                    navigate(DELIVERY_HOME_PATH)
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.Center,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Logout,
                                    contentDescription = logoutLabel,
                                    tint = MaterialTheme.colorScheme.error
                                )
                                Spacer(modifier = Modifier.width(MaterialTheme.spacing.x1))
                                Text(
                                    text = logoutLabel,
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodyLarge,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DeliveryAvailabilitySection(
    viewModel: DeliveryProfileViewModel,
    state: DeliveryProfileUiState
) {
    val availabilityTitle = Txt(MessageKey.delivery_availability_title)
    val availabilitySubtitle = Txt(MessageKey.delivery_availability_subtitle)
    val timezoneState = viewModel.inputsStates[AVAILABILITY_TIMEZONE_KEY]!!
    val availabilityError = state.availabilityErrorKey?.let { keyName ->
        runCatching { MessageKey.valueOf(keyName) }.getOrNull()?.let { Txt(it) } ?: keyName
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Default.Schedule,
                    contentDescription = availabilityTitle
                )
                Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                    Text(
                        text = availabilityTitle,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = availabilitySubtitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            TextField(
                label = MessageKey.delivery_availability_timezone,
                value = state.availability.timezone,
                state = timezoneState,
                onValueChange = viewModel::onTimezoneChange,
                modifier = Modifier.fillMaxWidth()
            )

            if (!availabilityError.isNullOrBlank()) {
                Text(
                    text = availabilityError,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }

            state.availability.slots.forEach { slot ->
                AvailabilitySlotRow(
                    slot = slot,
                    onToggleDay = { enabled -> viewModel.onToggleDay(slot.dayOfWeek, enabled) },
                    onBlockSelected = { block -> viewModel.onBlockSelected(slot.dayOfWeek, block) },
                    onCustomSelected = { viewModel.onCustomSelected(slot.dayOfWeek) },
                    onStartChange = { value -> viewModel.onCustomStartChange(slot.dayOfWeek, value) },
                    onEndChange = { value -> viewModel.onCustomEndChange(slot.dayOfWeek, value) },
                    startState = viewModel.inputsStates[availabilityKey(slot.dayOfWeek, "start")]!!,
                    endState = viewModel.inputsStates[availabilityKey(slot.dayOfWeek, "end")]!!
                )
            }
        }
    }
}

@Composable
private fun AvailabilitySlotRow(
    slot: DeliveryAvailabilitySlotForm,
    onToggleDay: (Boolean) -> Unit,
    onBlockSelected: (DeliveryAvailabilityBlock) -> Unit,
    onCustomSelected: () -> Unit,
    onStartChange: (String) -> Unit,
    onEndChange: (String) -> Unit,
    startState: MutableState<InputState>,
    endState: MutableState<InputState>
) {
    val dayLabel = Txt(slot.dayOfWeek.toMessageKey())
    val customLabel = Txt(MessageKey.delivery_availability_mode_custom)
    val blockLabel = Txt(MessageKey.delivery_availability_mode_block)
    val blockLabels = mapOf(
        DeliveryAvailabilityBlock.MORNING to Txt(MessageKey.delivery_availability_block_morning),
        DeliveryAvailabilityBlock.AFTERNOON to Txt(MessageKey.delivery_availability_block_afternoon),
        DeliveryAvailabilityBlock.NIGHT to Txt(MessageKey.delivery_availability_block_night)
    )
    val rangeLabel = if (slot.mode == DeliveryAvailabilityMode.BLOCK) {
        Txt(MessageKey.delivery_availability_block_range_template)
            .replace("{start}", slot.start)
            .replace("{end}", slot.end)
    } else ""

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.medium)
            .padding(MaterialTheme.spacing.x2),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                Text(text = dayLabel, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text(
                    text = if (slot.enabled) Txt(MessageKey.delivery_availability_day_enabled) else Txt(MessageKey.delivery_availability_day_disabled),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = slot.enabled,
                onCheckedChange = onToggleDay
            )
        }

        if (slot.enabled) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = blockLabel, style = MaterialTheme.typography.labelLarge)
                blockLabels.forEach { (block, label) ->
                    FilterChip(
                        selected = slot.mode == DeliveryAvailabilityMode.BLOCK && slot.block == block,
                        onClick = { onBlockSelected(block) },
                        label = { Text(label) }
                    )
                }
                FilterChip(
                    selected = slot.mode == DeliveryAvailabilityMode.CUSTOM,
                    onClick = onCustomSelected,
                    label = { Text(customLabel) }
                )
            }

            if (slot.mode == DeliveryAvailabilityMode.BLOCK) {
                Text(
                    text = rangeLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    TextField(
                        label = MessageKey.delivery_availability_start,
                        value = slot.start,
                        state = startState,
                        onValueChange = onStartChange,
                        modifier = Modifier.weight(1f)
                    )
                    TextField(
                        label = MessageKey.delivery_availability_end,
                        value = slot.end,
                        state = endState,
                        onValueChange = onEndChange,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}

private fun DayOfWeek.toMessageKey(): MessageKey = when (this) {
    DayOfWeek.MONDAY -> MessageKey.delivery_availability_day_monday
    DayOfWeek.TUESDAY -> MessageKey.delivery_availability_day_tuesday
    DayOfWeek.WEDNESDAY -> MessageKey.delivery_availability_day_wednesday
    DayOfWeek.THURSDAY -> MessageKey.delivery_availability_day_thursday
    DayOfWeek.FRIDAY -> MessageKey.delivery_availability_day_friday
    DayOfWeek.SATURDAY -> MessageKey.delivery_availability_day_saturday
    DayOfWeek.SUNDAY -> MessageKey.delivery_availability_day_sunday
    else -> MessageKey.delivery_availability_day_monday
}

@Composable
private fun DeliveryProfileHeader(name: String, email: String) {
    val subtitle = Txt(MessageKey.delivery_profile_subtitle)
    val initials = name.trim().takeIf { it.isNotBlank() }?.firstOrNull()?.uppercase() ?: "R"

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Column(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .padding(MaterialTheme.spacing.x3)
            ) {
                Text(
                    text = initials,
                    color = Color.White,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
            }
            Column(
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = Txt(MessageKey.delivery_profile_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
                Text(
                    text = email,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
        }
    }
}
