package ui.sc.auth

import ar.com.intrale.appconfig.AppRuntimeConfig
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
import androidx.compose.material.icons.filled.LockReset
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.auth.DoLoginException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.PasswordStrengthIndicator
import ui.cp.inputs.TextField
import ui.sc.client.CLIENT_HOME_PATH
import ui.sc.business.DASHBOARD_PATH
import ui.sc.delivery.DELIVERY_DASHBOARD_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val FORCE_CHANGE_PASSWORD_PATH = "/force-change-password"

class ForceChangePasswordScreen : Screen(FORCE_CHANGE_PASSWORD_PATH) {

    override val messageTitle: MessageKey = MessageKey.force_change_password_appbar_title

    private val logger = LoggerFactory.default.newLogger<ForceChangePasswordScreen>()

    @Composable
    override fun screen() {
        screenImpl()
    }

    @Composable
    private fun screenImpl(viewModel: ForceChangePasswordViewModel = viewModel { ForceChangePasswordViewModel() }) {
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val focusManager = LocalFocusManager.current
        val scrollState = rememberScrollState()

        val welcomeTitle = Txt(MessageKey.force_change_password_welcome_title)
        val securityMessage = Txt(MessageKey.force_change_password_security_message)
        val continueLabel = Txt(MessageKey.force_change_password_continue)
        val genericError = Txt(MessageKey.login_generic_error)
        val errorCredentials = Txt(MessageKey.login_error_credentials)

        val isDeliveryApp = AppRuntimeConfig.isDelivery
        val isBusinessApp = AppRuntimeConfig.isBusiness

        val submitChange: () -> Unit = {
            focusManager.clearFocus()
            viewModel.setupValidation()
            if (viewModel.isValid()) {
                callService(
                    coroutineScope = coroutineScope,
                    snackbarHostState = snackbarHostState,
                    setLoading = { viewModel.loading = it },
                    serviceCall = { viewModel.completeLogin() },
                    onSuccess = {
                        val destination = when {
                            AppRuntimeConfig.isClient -> {
                                SessionStore.updateRole(UserRole.Client)
                                CLIENT_HOME_PATH
                            }
                            isDeliveryApp -> {
                                SessionStore.updateRole(UserRole.Delivery)
                                DELIVERY_DASHBOARD_PATH
                            }
                            else -> {
                                SessionStore.updateRole(UserRole.BusinessAdmin)
                                DASHBOARD_PATH
                            }
                        }
                        logger.info { "Cambio de contraseña completado, navegando a $destination" }
                        navigateClearingBackStack(destination)
                    },
                    onError = { error ->
                        when (error) {
                            is DoLoginException -> when {
                                error.statusCode.value == 401 ->
                                    snackbarHostState.showSnackbar(errorCredentials)
                                else -> {
                                    logger.error { "Error al completar cambio de contraseña: ${error.message}" }
                                    snackbarHostState.showSnackbar(genericError)
                                }
                            }
                            else -> snackbarHostState.showSnackbar(error.message ?: genericError)
                        }
                    }
                )
            }
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(scrollState)
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
                        text = welcomeTitle,
                        style = MaterialTheme.typography.headlineMedium,
                        textAlign = TextAlign.Center
                    )
                    Text(
                        text = securityMessage,
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
                            label = MessageKey.new_password,
                            value = viewModel.state.newPassword,
                            state = viewModel.inputsStates[ForceChangePasswordViewModel.ForceChangePasswordUIState::newPassword.name]!!,
                            visualTransformation = true,
                            onValueChange = viewModel::onNewPasswordChange,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions.Default.copy(
                                keyboardType = KeyboardType.Password,
                                imeAction = ImeAction.Next
                            ),
                            keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                            placeholder = MessageKey.login_new_password_placeholder,
                            enabled = !viewModel.loading
                        )
                        PasswordStrengthIndicator(
                            password = viewModel.state.newPassword,
                            modifier = Modifier.fillMaxWidth()
                        )
                        TextField(
                            label = MessageKey.first_name,
                            value = viewModel.state.name,
                            state = viewModel.inputsStates[ForceChangePasswordViewModel.ForceChangePasswordUIState::name.name]!!,
                            onValueChange = viewModel::onNameChange,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions.Default.copy(
                                capitalization = KeyboardCapitalization.Words,
                                imeAction = ImeAction.Next
                            ),
                            keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                            placeholder = MessageKey.login_name_placeholder,
                            enabled = !viewModel.loading
                        )
                        TextField(
                            label = MessageKey.family_name,
                            value = viewModel.state.familyName,
                            state = viewModel.inputsStates[ForceChangePasswordViewModel.ForceChangePasswordUIState::familyName.name]!!,
                            onValueChange = viewModel::onFamilyNameChange,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions.Default.copy(
                                capitalization = KeyboardCapitalization.Words,
                                imeAction = ImeAction.Done
                            ),
                            keyboardActions = KeyboardActions(onDone = { submitChange() }),
                            placeholder = MessageKey.login_family_name_placeholder,
                            enabled = !viewModel.loading
                        )
                    }
                }

                IntralePrimaryButton(
                    text = continueLabel,
                    onClick = submitChange,
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.LockReset,
                    enabled = !viewModel.loading,
                    loading = viewModel.loading
                )
            }
        }
    }
}
