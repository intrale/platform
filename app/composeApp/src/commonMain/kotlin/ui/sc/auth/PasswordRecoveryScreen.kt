package ui.sc.auth

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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.email
import ui.rs.password_recovery
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.safeString

const val PASSWORD_RECOVERY_PATH = "/passwordRecovery"

class PasswordRecoveryScreen : Screen(PASSWORD_RECOVERY_PATH, Res.string.password_recovery) {

    private val logger = LoggerFactory.default.newLogger<PasswordRecoveryScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: PasswordRecoveryViewModel = viewModel { PasswordRecoveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
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
                    Res.string.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[PasswordRecoveryViewModel.PasswordRecoveryUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val recoveryLabel = safeString(Res.string.password_recovery)
                IntralePrimaryButton(
                    text = recoveryLabel,
                    iconAsset = "ic_recover.svg",
                    iconContentDescription = recoveryLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido" }
                            logger.debug { "Solicitando recuperación de contraseña" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.recovery() },
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar("Correo enviado") } },
                                onError = { error ->
                                    logger.error { "Error en recuperación de contraseña: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: "Error")
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
