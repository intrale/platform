package ui.sc.signup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import ar.com.intrale.strings.model.MessageKey
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.signup
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing
import ui.sc.auth.LOGIN_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

const val SIGNUP_PATH = "/signup"

class SignUpScreen : Screen(SIGNUP_PATH, Res.string.signup) {
    private val logger = LoggerFactory.default.newLogger<SignUpScreen>()
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: SignUpViewModel = viewModel { SignUpViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            logger.debug { "Mostrando SignUpScreen" }
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
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[SignUpViewModel.SignUpUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = resString(
                        composeId = Res.string.signup,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Crear cuenta"),
                    ),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        logger.info { "Intento de registro generico" }
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
