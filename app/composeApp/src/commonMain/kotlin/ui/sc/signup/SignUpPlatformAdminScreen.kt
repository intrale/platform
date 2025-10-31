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
import ar.com.intrale.strings.model.MessageKey
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ar.com.intrale.strings.Txt
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing
import ui.sc.auth.LOGIN_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService

const val SIGNUP_PLATFORM_ADMIN_PATH = "/signupPlatformAdmin"

class SignUpPlatformAdminScreen : Screen(SIGNUP_PLATFORM_ADMIN_PATH) {
    private val logger = LoggerFactory.default.newLogger<SignUpPlatformAdminScreen>()

    override val messageTitle: MessageKey = MessageKey.signup_platform_admin_title

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: SignUpPlatformAdminViewModel = viewModel { SignUpPlatformAdminViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            logger.debug { "Mostrando SignUpPlatformAdminScreen" }
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
                    state = viewModel.inputsStates[SignUpPlatformAdminViewModel.SignUpUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val submitLabel = Txt(MessageKey.signup_platform_admin_submit)
                Button(
                    label = submitLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        logger.info { "Intento de registro PlatformAdmin" }
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
