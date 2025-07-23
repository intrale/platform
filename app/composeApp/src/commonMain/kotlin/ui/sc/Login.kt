package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.konform.validation.ValidationResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import asdo.DoLoginException
import asdo.DoLoginResult
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.login
import ui.rs.password
import ui.rs.username
import io.ktor.client.plugins.ClientRequestException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

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

        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        forwardToHome(viewModel, coroutineScope, snackbarHostState, suspend  { viewModel.previousLogin()  } )

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(modifier = Modifier.size(10.dp))
            TextField(
                Res.string.username,
                value = viewModel.state.user,
                state = viewModel.inputsStates[LoginViewModel.LoginUIState::user.name]!!,
                onValueChange = { value ->
                                    viewModel.state = viewModel.state.copy(user = value)}
            )
            Spacer(modifier = Modifier.size(10.dp))
            TextField(
                Res.string.password,
                visualTransformation = true,
                value = viewModel.state.password,
                state = viewModel.inputsStates[LoginViewModel.LoginUIState::password.name]!!,
                onValueChange = { value ->
                                    viewModel.state = viewModel.state.copy(password = value)}
            )
            Spacer(modifier = Modifier.size(10.dp))
            Button(
                label= stringResource(Res.string.login),
                onClick = {
                    if (viewModel.isValid()) {
                        logger.debug { "Formulario valido" }
                        forwardToHome(viewModel, coroutineScope, snackbarHostState, suspend { true })
                    }
                }
            )


        }
        }
    }


    private fun forwardToHome(
        viewModel: LoginViewModel,
        coroutineScope: CoroutineScope,
        snackbarHostState: SnackbarHostState,
        navigateDecision: suspend () -> Boolean

    ){
        coroutineScope.launch {
            logger.debug { "Condicional" }
            //TODO: revisar si es necesario el navigateDecision
            if (navigateDecision()) {
                logger.debug { "Invocando login" }
                val result = viewModel.login()



                logger.debug { "Obteniendo resultado login" }
                result.onSuccess {
                    navigate(HOME_PATH)
                }.onFailure { error ->
                    logger.error { "Error al iniciar sesión: ${error.message}" }
                    if (error is DoLoginException) {
                        val loginError:DoLoginException = error as DoLoginException
                        if (loginError.statusCode.value == 401) {
                            logger.debug { "Credenciales inválidas" }
                            val userKey = LoginViewModel.LoginUIState::user.name
                            val passKey = LoginViewModel.LoginUIState::password.name

                            viewModel.inputsStates[userKey]?.let {
                                it.value = it.value.copy(
                                    isValid = false,
                                    details = "Usuario o contraseña incorrectos"
                                )
                            }

                            viewModel.inputsStates[passKey]?.let {
                                it.value = it.value.copy(
                                    isValid = false,
                                    details = "Usuario o contraseña incorrectos"
                                )
                            }
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

