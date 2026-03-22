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
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val BUSINESS_SCHEDULES_PATH = "/businessSchedules"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessSchedulesScreen : Screen(BUSINESS_SCHEDULES_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_schedules_title

    private val logger = LoggerFactory.default.newLogger<BusinessSchedulesScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BusinessSchedulesScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BusinessSchedulesViewModel = viewModel { BusinessSchedulesViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val role = sessionState.role
        val businessId = sessionState.selectedBusinessId
        val hasAccess = role in ALLOWED_ROLES && businessId?.isNotBlank() == true

        if (!hasAccess) {
            Text(
                text = Txt(MessageKey.business_schedules_access_denied),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        LaunchedEffect(businessId) {
            coroutineScope.launch { viewModel.loadSchedules(businessId) }
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
                text = Txt(MessageKey.business_schedules_title),
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = Txt(MessageKey.business_schedules_description),
                style = MaterialTheme.typography.bodyLarge
            )

            when (uiState.status) {
                BusinessSchedulesStatus.Loading -> {
                    CircularProgressIndicator()
                    Text(text = Txt(MessageKey.business_schedules_loading))
                }
                BusinessSchedulesStatus.MissingBusiness -> {
                    Text(text = Txt(MessageKey.business_schedules_missing_business))
                }
                is BusinessSchedulesStatus.Error -> {
                    Text(text = Txt(MessageKey.business_schedules_error))
                    TextButton(onClick = {
                        coroutineScope.launch { viewModel.loadSchedules(businessId) }
                    }) {
                        Text(text = Txt(MessageKey.business_schedules_retry))
                    }
                }
                else -> {
                    SchedulesForm(viewModel, businessId)
                }
            }
        }
    }

    @Composable
    private fun SchedulesForm(viewModel: BusinessSchedulesViewModel, businessId: String?) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val isSaving = uiState.status == BusinessSchedulesStatus.Saving

        uiState.schedules.forEachIndexed { index, dayState ->
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = dayState.day.replaceFirstChar { it.uppercase() },
                            style = MaterialTheme.typography.titleMedium
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                        ) {
                            Text(
                                text = if (dayState.isOpen)
                                    Txt(MessageKey.business_schedules_open_label)
                                else
                                    Txt(MessageKey.business_schedules_closed_label),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Switch(
                                checked = dayState.isOpen,
                                onCheckedChange = { viewModel.toggleDayOpen(index, it) },
                                enabled = !isSaving
                            )
                        }
                    }

                    if (dayState.isOpen) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            val openTimeState = remember(index) { mutableStateOf(InputState("openTime_$index")) }
                            TextField(
                                label = MessageKey.business_schedules_open_time,
                                value = dayState.openTime,
                                state = openTimeState,
                                onValueChange = { viewModel.updateOpenTime(index, it) },
                                enabled = !isSaving,
                                modifier = Modifier.weight(1f)
                            )
                            val closeTimeState = remember(index) { mutableStateOf(InputState("closeTime_$index")) }
                            TextField(
                                label = MessageKey.business_schedules_close_time,
                                value = dayState.closeTime,
                                state = closeTimeState,
                                onValueChange = { viewModel.updateCloseTime(index, it) },
                                enabled = !isSaving,
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))

        Button(
            onClick = {
                coroutineScope.launch { viewModel.saveSchedules(businessId) }
            },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (isSaving) {
                CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
            } else {
                Text(text = Txt(MessageKey.business_schedules_save))
            }
        }

        if (uiState.status == BusinessSchedulesStatus.Saved) {
            Text(
                text = Txt(MessageKey.business_schedules_saved),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
