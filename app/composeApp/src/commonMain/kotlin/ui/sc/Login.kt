package ui.sc

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.DoLoginException
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.IntralePrimaryButton
import ui.cp.TextField
import ui.rs.Res
import ui.rs.confirm_password_recovery
import ui.rs.error_credentials
import ui.rs.family_name
import ui.rs.login
import ui.rs.login_change_password_description
import ui.rs.login_change_password_required
import ui.rs.login_change_password_title
import ui.rs.login_email_placeholder
import ui.rs.login_family_name_placeholder
import ui.rs.login_generic_error
import ui.rs.login_name_placeholder
import ui.rs.login_new_password_placeholder
import ui.rs.login_password_icon_content_description
import ui.rs.login_password_placeholder
import ui.rs.login_subtitle
import ui.rs.login_title
import ui.rs.login_user_icon_content_description
import ui.rs.name
import ui.rs.new_password
import ui.rs.password
import ui.rs.password_recovery
import ui.rs.register_business
import ui.rs.signup
import ui.rs.signup_delivery
import ui.rs.username
import ui.sc.callService
import ui.th.rememberLoginBackgroundGradient
import ui.th.elevations
import ui.th.spacing

const val LOGIN_PATH = "/login"

class Login : Screen(LOGIN_PATH, Res.string.login) {

    private val logger = LoggerFactory.default.newLogger<Login>()

    @Composable
    override fun screen() {
        screenImplementation()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImplementation(viewModel: LoginViewModel = viewModel { LoginViewModel() }) {
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val focusManager = LocalFocusManager.current
        val scrollState = rememberScrollState()

        val loginText = stringResource(Res.string.login)
        val errorCredentials = stringResource(Res.string.error_credentials)
        val changePasswordMessage = stringResource(Res.string.login_change_password_required)
        val genericError = stringResource(Res.string.login_generic_error)

        val loginErrorHandler: suspend (Throwable) -> Unit = { error ->
            when (error) {
                is DoLoginException -> when {
                    error.statusCode.value == 401 -> {
                        viewModel.markCredentialsAsInvalid(errorCredentials)
                        snackbarHostState.showSnackbar(errorCredentials)
                    }

                    error.message?.contains("newPassword is required", ignoreCase = true) == true -> {
                        viewModel.requirePasswordChange()
                        snackbarHostState.showSnackbar(changePasswordMessage)
                    }

                    else -> {
                        logger.error { "Error durante el login: ${error.message}" }
                        snackbarHostState.showSnackbar(genericError)
                    }
                }

                else -> snackbarHostState.showSnackbar(error.message ?: genericError)
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

        val backgroundBrush = rememberLoginBackgroundGradient()

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(backgroundBrush)
        ) {
            Scaffold(
                modifier = Modifier.fillMaxSize(),
                containerColor = Color.Transparent,
                snackbarHost = { SnackbarHost(snackbarHostState) }
            ) { padding ->
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .imePadding()
                        .verticalScroll(scrollState)
                        .padding(horizontal = 24.dp, vertical = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = stringResource(Res.string.login_title),
                            style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                            color = MaterialTheme.colorScheme.onPrimary,
                            textAlign = TextAlign.Center
                        )
                        Text(
                            text = stringResource(Res.string.login_subtitle),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
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
                            label = Res.string.username,
                            value = viewModel.state.user,
                            state = viewModel.inputsStates[LoginViewModel.LoginUIState::user.name]!!,
                            onValueChange = viewModel::onUserChange,
                            modifier = Modifier.fillMaxWidth(),
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Person,
                                    contentDescription = stringResource(Res.string.login_user_icon_content_description)
                                )
                            },
                            keyboardOptions = KeyboardOptions.Default.copy(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Next
                            ),
                            keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                            placeholder = Res.string.login_email_placeholder,
                            enabled = !viewModel.loading
                        )

                        TextField(
                            label = Res.string.password,
                            value = viewModel.state.password,
                            state = viewModel.inputsStates[LoginViewModel.LoginUIState::password.name]!!,
                            visualTransformation = true,
                            onValueChange = viewModel::onPasswordChange,
                            modifier = Modifier.fillMaxWidth(),
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Lock,
                                    contentDescription = stringResource(Res.string.login_password_icon_content_description)
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
                            placeholder = Res.string.login_password_placeholder,
                            enabled = !viewModel.loading
                        )

                        AnimatedVisibility(visible = viewModel.changePasswordRequired) {
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Divider()
                                Text(
                                    text = stringResource(Res.string.login_change_password_title),
                                    style = MaterialTheme.typography.titleLarge
                                )
                                Text(
                                    text = stringResource(Res.string.login_change_password_description),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                TextField(
                                    label = Res.string.new_password,
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
                                    placeholder = Res.string.login_new_password_placeholder,
                                    enabled = !viewModel.loading
                                )
                                TextField(
                                    label = Res.string.name,
                                    value = viewModel.state.name,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::name.name]!!,
                                    onValueChange = viewModel::onNameChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    keyboardOptions = KeyboardOptions.Default.copy(
                                        capitalization = KeyboardCapitalization.Words,
                                        imeAction = ImeAction.Next
                                    ),
                                    keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) }),
                                    placeholder = Res.string.login_name_placeholder,
                                    enabled = !viewModel.loading
                                )
                                TextField(
                                    label = Res.string.family_name,
                                    value = viewModel.state.familyName,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::familyName.name]!!,
                                    onValueChange = viewModel::onFamilyNameChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    keyboardOptions = KeyboardOptions.Default.copy(
                                        capitalization = KeyboardCapitalization.Words,
                                        imeAction = ImeAction.Done
                                    ),
                                    keyboardActions = KeyboardActions(onDone = { submitLogin() }),
                                    placeholder = Res.string.login_family_name_placeholder,
                                    enabled = !viewModel.loading
                                )
                            }
                        }
                    }
                }

                IntralePrimaryButton(
                    text = loginText,
                    iconAsset = "ic_login.svg",
                    onClick = submitLogin,
                    enabled = !viewModel.loading,
                    loading = viewModel.loading,
                    modifier = Modifier.fillMaxWidth()
                )

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    TextButton(
                        onClick = { navigate(SELECT_SIGNUP_PROFILE_PATH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Text(text = stringResource(Res.string.signup))
                    }
                    TextButton(
                        onClick = { navigate(REGISTER_NEW_BUSINESS_PATH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Text(text = stringResource(Res.string.register_business))
                    }
                    TextButton(
                        onClick = { navigate(SIGNUP_DELIVERY_PATH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Text(text = stringResource(Res.string.signup_delivery))
                    }
                    TextButton(
                        onClick = { navigate(PASSWORD_RECOVERY_PATH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Text(text = stringResource(Res.string.password_recovery))
                    }
                    TextButton(
                        onClick = { navigate(CONFIRM_PASSWORD_RECOVERY_PATH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onPrimary)
                    ) {
                        Text(text = stringResource(Res.string.confirm_password_recovery))
                    }
                }
            }
        }
    }
}
}
