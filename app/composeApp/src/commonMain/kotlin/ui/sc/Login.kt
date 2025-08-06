package ui.sc

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.konform.validation.ValidationResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import asdo.DoLoginException
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.login
import ui.rs.password
import ui.rs.username
import ui.rs.new_password
import ui.rs.name
import ui.rs.family_name
import ui.rs.update_password
import ui.rs.signup
import ui.rs.register_business
import io.ktor.client.plugins.ClientRequestException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.rs.error_credentials
import ui.rs.password_recovery
import ui.rs.confirm_password_recovery
import ui.sc.PASSWORD_RECOVERY_PATH
import ui.sc.CONFIRM_PASSWORD_RECOVERY_PATH
import ui.sc.REGISTER_NEW_BUSINESS_PATH

const val LOGIN_PATH = "/login"

class Login() : Screen(LOGIN_PATH, Res.string.login){

    private lateinit var validationResult:ValidationResult<LoginViewModel>

    private val logger = LoggerFactory.default.newLogger<Login>()

    @Composable
    override fun screen() {
        screenImplementation()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImplementation(viewModel: LoginViewModel = viewModel {LoginViewModel()} ) {

        val errorCredentials = stringResource(Res.string.error_credentials)

        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        callService(viewModel, coroutineScope, snackbarHostState, suspend { viewModel.previousLogin() }, errorCredentials)

        val background = Brush.verticalGradient(listOf(Color(0xFFB2E5F9), Color(0xFF5AA9E6)))

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(background)
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        modifier = Modifier
                            .size(72.dp)
                            .background(Color(0xFF2C71C7), shape = CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Filled.Code, contentDescription = null, tint = Color.White)
                    }
                    Spacer(modifier = Modifier.size(16.dp))
                    Text(
                        text = "Plataforma",
                        color = Color.White,
                        style = MaterialTheme.typography.headlineSmall,
                        textAlign = TextAlign.Center
                    )
                    Spacer(modifier = Modifier.size(32.dp))
                    Card(
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 32.dp)
                    ) {
                        Column(
                            modifier = Modifier
                                .padding(16.dp)
                                .verticalScroll(rememberScrollState()),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Spacer(modifier = Modifier.size(16.dp))
                            TextField(
                                Res.string.username,
                                value = viewModel.state.user,
                                state = viewModel.inputsStates[LoginViewModel.LoginUIState::user.name]!!,
                                onValueChange = { value ->
                                    viewModel.state = viewModel.state.copy(user = value)
                                }
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                            TextField(
                                Res.string.password,
                                visualTransformation = true,
                                value = viewModel.state.password,
                                state = viewModel.inputsStates[LoginViewModel.LoginUIState::password.name]!!,
                                onValueChange = { value ->
                                    viewModel.state = viewModel.state.copy(password = value)
                                }
                            )
                            if (viewModel.changePasswordRequired) {
                                Spacer(modifier = Modifier.size(16.dp))
                                TextField(
                                    Res.string.new_password,
                                    visualTransformation = true,
                                    value = viewModel.state.newPassword,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::newPassword.name]!!,
                                    onValueChange = { value ->
                                        viewModel.state = viewModel.state.copy(newPassword = value)
                                    }
                                )
                                Spacer(modifier = Modifier.size(16.dp))
                                TextField(
                                    Res.string.name,
                                    value = viewModel.state.name,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::name.name]!!,
                                    onValueChange = { value ->
                                        viewModel.state = viewModel.state.copy(name = value)
                                    }
                                )
                                Spacer(modifier = Modifier.size(16.dp))
                                TextField(
                                    Res.string.family_name,
                                    value = viewModel.state.familyName,
                                    state = viewModel.inputsStates[LoginViewModel.LoginUIState::familyName.name]!!,
                                    onValueChange = { value ->
                                        viewModel.state = viewModel.state.copy(familyName = value)
                                    }
                                )
                            }
                            Spacer(modifier = Modifier.size(16.dp))
                            Button(
                                label = stringResource(if (viewModel.changePasswordRequired) Res.string.update_password else Res.string.login),
                                loading = viewModel.loading,
                                enabled = !viewModel.loading,
                                onClick = {
                                    viewModel.setupValidation()
                                    if (viewModel.isValid()) {
                                        logger.debug { "Formulario valido" }
                                        viewModel.loading = true
                                        callService(viewModel, coroutineScope, snackbarHostState, suspend { true }, errorCredentials)
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2C71C7), contentColor = Color.White)
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                            Button(
                                label = stringResource(Res.string.signup),
                                onClick = { navigate(SELECT_SIGNUP_PROFILE_PATH) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = Color(0xFF2C71C7))
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                            Button(
                                label = stringResource(Res.string.register_business),
                                onClick = { navigate(REVIEW_BUSINESS_PATH) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = Color(0xFF2C71C7))
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                            Button(
                                label = stringResource(Res.string.password_recovery),
                                onClick = { navigate(PASSWORD_RECOVERY_PATH) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = Color(0xFF4D84CC))
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                            Button(
                                label = stringResource(Res.string.confirm_password_recovery),
                                onClick = { navigate(CONFIRM_PASSWORD_RECOVERY_PATH) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = Color(0xFF4D84CC))
                            )
                            Spacer(modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
    }

    private fun callService(
        viewModel: LoginViewModel,
        coroutineScope: CoroutineScope,
        snackbarHostState: SnackbarHostState,
        navigateDecision: suspend () -> Boolean,
        errorCredentials: String
    ){

        coroutineScope.launch {
            logger.debug { "Condicional" }
            //TODO: revisar si es necesario el navigateDecision
            if (navigateDecision()) {
                logger.debug { "Invocando login" }
                val result = viewModel.login()

                logger.debug { "Obteniendo resultado login" }
                result.onSuccess {
                    viewModel.loading = false
                    navigate(HOME_PATH)
                }.onFailure { error ->
                    logger.error { "Error al iniciar sesión: ${error.message}" }
                    viewModel.loading = false
                    if (error is DoLoginException) {
                        val loginError:DoLoginException = error as DoLoginException
                        if (loginError.statusCode.value == 401) {
                            logger.debug { "Credenciales inválidas" }
                            val userKey = LoginViewModel.LoginUIState::user.name
                            val passKey = LoginViewModel.LoginUIState::password.name

                            /*viewModel.inputsStates[userKey]?.let {
                                it.value = it.value.copy(
                                    isValid = false,
                                    details = "Usuario o contraseña incorrectos"
                                )
                            }*/

                            viewModel.inputsStates[passKey]?.let {
                                it.value = it.value.copy(
                                    isValid = false,
                                    details = "Usuario o contraseña incorrectos"
                                )
                            }
                        } else if (loginError.message?.contains("newPassword is required") == true) {
                            viewModel.changePasswordRequired = true
                            viewModel.setupValidation()
                            snackbarHostState.showSnackbar("Actualizá tu contraseña para continuar")
                        } else {
                            logger.error { "Error de conexión: ${loginError.message} -> ${loginError.cause?.message}" }
                            snackbarHostState.showSnackbar("Error de comunicación, intente mas tarde" )
                        }
                    }else snackbarHostState.showSnackbar(error.message ?: "Error")
                }
            }
        }

    }



}

