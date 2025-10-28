package ui.sc.auth

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import ui.cp.inputs.TextField
import ui.sc.auth.CONFIRM_PASSWORD_RECOVERY_PATH
import ui.sc.auth.PASSWORD_RECOVERY_PATH
import ui.sc.business.DASHBOARD_PATH
import ui.sc.business.REGISTER_NEW_BUSINESS_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.sc.signup.SIGNUP_DELIVERY_PATH
import ui.th.elevations
import ui.th.spacing

const val LOGIN_PATH = "/login"

class Login : Screen(LOGIN_PATH, MessageKey.login_title) {

    private val logger = LoggerFactory.default.newLogger<Login>()

    @Composable
    override fun screen() {
        screenImplementation()
    }

    @Composable
    private fun screenImplementation(viewModel: LoginViewModel = viewModel { LoginViewModel() }) {
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val focusManager = LocalFocusManager.current
        val scrollState = rememberScrollState()

        val loginTitleText = Txt(MessageKey.login_title)
        val loginSubtitleText = Txt(MessageKey.login_subtitle)
        val loginButtonText = Txt(MessageKey.login_button)
        val genericErrorText = Txt(MessageKey.error_generic)
        val userIconDescription = Txt(MessageKey.login_user_icon_content_description)
        val passwordIconDescription = Txt(MessageKey.login_password_icon_content_description)
        val changePasswordTitleText = Txt(MessageKey.login_change_password_title)
        val changePasswordDescriptionText = Txt(MessageKey.login_change_password_description)
        val signupLinkText = Txt(MessageKey.signup)
        val registerBusinessLinkText = Txt(MessageKey.register_business)
        val signupDeliveryLinkText = Txt(MessageKey.signup_delivery)
        val passwordRecoveryLinkText = Txt(MessageKey.password_recovery)
        val confirmRecoveryLinkText = Txt(MessageKey.confirm_password_recovery)
        val usernameLabel = Txt(MessageKey.username)
        val passwordLabel = Txt(MessageKey.password)
        val newPasswordLabel = Txt(MessageKey.new_password)
        val nameLabel = Txt(MessageKey.name)
        val familyNameLabel = Txt(MessageKey.family_name)
        val emailPlaceholder = Txt(MessageKey.login_email_placeholder)
        val passwordPlaceholder = Txt(MessageKey.login_password_placeholder)
        val newPasswordPlaceholder = Txt(MessageKey.login_new_password_placeholder)
        val namePlaceholder = Txt(MessageKey.login_name_placeholder)
        val familyNamePlaceholder = Txt(MessageKey.login_family_name_placeholder)

        val errorCredentialsKey = MessageKey.login_error_credentials
        val changePasswordRequiredKey = MessageKey.login_change_password_required

        val loginErrorHandler: suspend (Throwable) -> Unit = { error ->
            when (error) {
                is DoLoginException -> when {
                    error.statusCode.value == 401 -> {
                        viewModel.markCredentialsAsInvalid(errorCredentialsKey)
                        snackbarHostState.showSnackbar(Txt(errorCredentialsKey))
                    }

                    error.message?.contains("newPassword is required", ignoreCase = true) == true -> {
                        viewModel.requirePasswordChange()
                        snackbarHostState.showSnackbar(Txt(changePasswordRequiredKey))
                    }

                    else -> {
                        logger.error { "Error durante el login: ${error.message}" }
                        snackbarHostState.showSnackbar(genericErrorText)
                    }
                }

                else -> snackbarHostState.showSnackbar(error.message ?: genericErrorText)
            }
        }

        val triggerLogin: () -> Unit = {
            callService(
                coroutineScope = coroutineScope,
                snackbarHostState = snackbarHostState,
                setLoading = { viewModel.loading = it },
                serviceCall = { viewModel.login() },
                onSuccess = {
                    logger.info { "Login exitoso, navegando a $DASHBOARD_PATH" }
                    navigate(DASHBOARD_PATH)
                },
                onError = loginErrorHandler
            )
        }

        LaunchedEffect(Unit) {
            if (viewModel.previousLogin()) {
                triggerLogin()
            }
        }

        val submitLogin: () -> Unit = {
            focusManager.clearFocus()
            viewModel.setupValidation()
            if (viewModel.isValid()) {
                triggerLogin()
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
                        vertical = MaterialTheme.spacing.x4
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
                        text = loginTitleText,
                        style = MaterialTheme.typography.headlineMedium,
                        textAlign = TextAlign.Center
                    )
                    Text(
                        text = loginSubtitleText,
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
                            labelText = usernameLabel,
                            value = viewModel.state.user,
                            state = viewModel.inputsStates[LoginViewModel.LoginUIState::user.name]!!,
                            onValueChange = viewModel::onUserChange,
                            modifier = Modifier.fillMaxWidth(),
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Person,
                                    contentDescription = userIconDescription
                                )
                            },
                            keyboardOptions = KeyboardOptions.Default.copy(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Next
                            ),
                            keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                            placeholderText = emailPlaceholder,
                            enabled = !viewModel.loading
                        )

                        TextField(
                            labelText = passwordLabel,
                            value = viewModel.state.password,
                            state = viewModel.inputsStates[LoginViewModel.LoginUIState::password.name]!!,
                            visualTransformation = true,
                            onValueChange = viewModel::onPasswordChange,
                            modifier = Modifier.fillMaxWidth(),
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Lock,
                                    contentDescription = passwordIconDescription
                                )
                            },
                            keyboardOptions = KeyboardOptions.Default.copy(
                                keyboardType = KeyboardType.Password,
                                imeAction = if (viewModel.changePasswordRequired) ImeAction.Next else ImeAction.Done
                            ),
                            keyboardActions = if (viewModel.changePasswordRequired) {
                                KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) })
                            } else {
                                KeyboardActions(onDone = { submitLogin() })
                            },
                            placeholderText = passwordPlaceholder,
                            enabled = !viewModel.loading
                        )

                        AnimatedVisibility(visible = viewModel.changePasswordRequired) {
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Divider()
                                Text(
                                    text = changePasswordTitleText,
                                    style = MaterialTheme.typography.titleLarge
                                )
                                Text(
                                    text = changePasswordDescriptionText,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                TextField(
                                    labelText = newPasswordLabel,
                                    value = viewModel.state.newPassword,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::newPassword.name]!!,
                                    visualTransformation = true,
                                    onValueChange = viewModel::onNewPasswordChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    keyboardOptions = KeyboardOptions.Default.copy(
                                        keyboardType = KeyboardType.Password,
                                        imeAction = ImeAction.Next
                                    ),
                                    keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                                    placeholderText = newPasswordPlaceholder,
                                    enabled = !viewModel.loading
                                )
                                TextField(
                                    labelText = nameLabel,
                                    value = viewModel.state.name,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::name.name]!!,
                                    onValueChange = viewModel::onNameChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    keyboardOptions = KeyboardOptions.Default.copy(
                                        capitalization = KeyboardCapitalization.Words,
                                        imeAction = ImeAction.Next
                                    ),
                                    keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                                    placeholderText = namePlaceholder,
                                    enabled = !viewModel.loading
                                )
                                TextField(
                                    labelText = familyNameLabel,
                                    value = viewModel.state.familyName,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::familyName.name]!!,
                                    onValueChange = viewModel::onFamilyNameChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    keyboardOptions = KeyboardOptions.Default.copy(
                                        capitalization = KeyboardCapitalization.Words,
                                        imeAction = ImeAction.Done
                                    ),
                                    keyboardActions = KeyboardActions(onDone = { submitLogin() }),
                                    placeholderText = familyNamePlaceholder,
                                    enabled = !viewModel.loading
                                )
                            }
                        }
                    }
                }

                IntralePrimaryButton(
                    text = loginButtonText,
                    onClick = submitLogin,
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.Login,
                    enabled = !viewModel.loading,
                    loading = viewModel.loading
                )

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    TextButton(onClick = { navigate(SELECT_SIGNUP_PROFILE_PATH) }) {
                        Text(text = signupLinkText)
                    }
                    TextButton(onClick = { navigate(REGISTER_NEW_BUSINESS_PATH) }) {
                        Text(text = registerBusinessLinkText)
                    }
                    TextButton(onClick = { navigate(SIGNUP_DELIVERY_PATH) }) {
                        Text(text = signupDeliveryLinkText)
                    }
                    TextButton(onClick = { navigate(PASSWORD_RECOVERY_PATH) }) {
                        Text(text = passwordRecoveryLinkText)
                    }
                    TextButton(onClick = { navigate(CONFIRM_PASSWORD_RECOVERY_PATH) }) {
                        Text(text = confirmRecoveryLinkText)
                    }
                }
            }
        }
    }
}
