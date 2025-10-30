package ui.sc.signup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.menuAnchor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import ar.com.intrale.strings.model.MessageKey
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.signup_delivery
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.auth.LOGIN_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

const val SIGNUP_DELIVERY_PATH = "/signupDelivery"

class SignUpDeliveryScreen : Screen(SIGNUP_DELIVERY_PATH) {
    private val logger = LoggerFactory.default.newLogger<SignUpDeliveryScreen>()

    override val messageTitle: MessageKey = MessageKey.signup_delivery_title
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun screenImpl(viewModel: SignUpDeliveryViewModel = viewModel { SignUpDeliveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            logger.debug { "Mostrando SignUpDeliveryScreen" }
            Column(
                Modifier
                    .padding(padding)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x4
                    ),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    label = MessageKey.email,
                    MessageKey.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[SignUpDeliveryViewModel.SignUpUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                var expanded by remember { mutableStateOf(false) }
                val showMenu = expanded && viewModel.suggestions.isNotEmpty()
                ExposedDropdownMenuBox(expanded = showMenu, onExpandedChange = { expanded = it }) {
                    TextField(
                        label = MessageKey.business,
                        MessageKey.business,
                        value = viewModel.state.businessName,
                        state = viewModel.inputsStates[SignUpDeliveryViewModel.SignUpUIState::businessPublicId.name]!!,
                        modifier = Modifier.menuAnchor(),
                        onValueChange = {
                            viewModel.state = viewModel.state.copy(businessPublicId = it)
                            logger.debug { "Buscando negocios con $it" }
                            coroutine.launch { viewModel.searchBusinesses(it) }
                            expanded = true
                        }
                    )
                    ExposedDropdownMenu(expanded = showMenu, onDismissRequest = { expanded = false }) {
                        viewModel.suggestions.forEach { business ->
                            DropdownMenuItem(text = { androidx.compose.material3.Text(business.name) }, onClick = {
                                viewModel.state = viewModel.state.copy(
                                    businessPublicId = business.publicId,
                                    businessName = business.name
                                )
                                expanded = false
                            })
                        }
                    }
                }
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val signupDeliveryLabel = Txt(MessageKey.signup_delivery_submit)
                IntralePrimaryButton(
                    text = signupDeliveryLabel,
                    iconAsset = "ic_delivery.svg",
                    iconContentDescription = signupDeliveryLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        logger.info { "Intento de registro Delivery" }
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.signup() },
                                onSuccess = { navigate(LOGIN_PATH) }
                            )
                        }
                    }
                )
            }
        }
    }
}
