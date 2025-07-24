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
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.email
import ui.rs.signup_platform_admin
import ui.sc.callService
import LOGIN_PATH

const val SIGNUP_PLATFORM_ADMIN_PATH = "/signupPlatformAdmin"

class SignUpPlatformAdminScreen : Screen(SIGNUP_PLATFORM_ADMIN_PATH, Res.string.signup_platform_admin) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: SignUpPlatformAdminViewModel = viewModel { SignUpPlatformAdminViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(modifier = Modifier.size(10.dp))
            TextField(
                Res.string.email,
                value = viewModel.state.email,
                state = viewModel.inputsStates[SignUpPlatformAdminViewModel.SignUpUIState::email.name]!!,
                onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
            )
            Spacer(modifier = Modifier.size(10.dp))
            Button(label = stringResource(Res.string.signup_platform_admin),
                loading = viewModel.loading,
                enabled = !viewModel.loading,
                onClick =  {
                if (viewModel.isValid()) {
                    callService(
                        coroutineScope = coroutine,
                        snackbarHostState = snackbarHostState,
                        setLoading = { viewModel.loading = it },
                        serviceCall = { viewModel.signup() },
                        onSuccess = { navigate(LOGIN_PATH) }
                    )
                }
            })
        }
        }
    }
}
