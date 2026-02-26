package ui.sc.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.elevations
import ui.th.spacing

const val PASSWORD_RECOVERY_PATH = "/passwordRecovery"

class PasswordRecoveryScreen : Screen(PASSWORD_RECOVERY_PATH) {

    override val messageTitle: MessageKey = MessageKey.password_recovery

    private val logger = LoggerFactory.default.newLogger<PasswordRecoveryScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: PasswordRecoveryViewModel = viewModel { PasswordRecoveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val focusManager = LocalFocusManager.current

        val titleText = Txt(MessageKey.password_recovery_title)
        val subtitleText = Txt(MessageKey.password_recovery_subtitle)
        val sendCodeText = Txt(MessageKey.password_recovery_send_code)
        val passwordRecoverySuccessMessage = Txt(MessageKey.password_recovery_email_sent)
        val genericErrorMessage = Txt(MessageKey.error_generic)
        val userIconDescription = Txt(MessageKey.login_user_icon_content_description)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("password_recovery_screen")
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x2
                    ),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x4),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    Text(
                        text = titleText,
                        style = MaterialTheme.typography.headlineMedium,
                        textAlign = TextAlign.Center
                    )
                    Text(
                        text = subtitleText,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                }

                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    tonalElevation = MaterialTheme.elevations.level2,
                    shape = MaterialTheme.shapes.large
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x3),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        TextField(
                            label = MessageKey.email,
                            value = viewModel.state.email,
                            state = viewModel.inputsStates[PasswordRecoveryViewModel.PasswordRecoveryUIState::email.name]!!,
                            onValueChange = { viewModel.state = viewModel.state.copy(email = it) },
                            modifier = Modifier.fillMaxWidth(),
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Person,
                                    contentDescription = userIconDescription
                                )
                            },
                            keyboardOptions = KeyboardOptions.Default.copy(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Done
                            ),
                            keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
                            enabled = !viewModel.loading
                        )
                    }
                }

                IntralePrimaryButton(
                    text = sendCodeText,
                    iconAsset = "ic_recover.svg",
                    iconContentDescription = sendCodeText,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        focusManager.clearFocus()
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido" }
                            logger.debug { "Solicitando recuperación de contraseña" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.recovery() },
                                onSuccess = {
                                    coroutine.launch {
                                        snackbarHostState.showSnackbar(passwordRecoverySuccessMessage)
                                    }
                                    navigate(CONFIRM_PASSWORD_RECOVERY_PATH)
                                },
                                onError = { error ->
                                    logger.error { "Error en recuperación de contraseña: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: genericErrorMessage)
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
