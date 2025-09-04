package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.rs.Res
import ui.rs.two_factor_setup

const val TWO_FACTOR_SETUP_PATH = "/twoFactorSetup"

class TwoFactorSetupScreen : Screen(TWO_FACTOR_SETUP_PATH, Res.string.two_factor_setup) {

    private val logger = LoggerFactory.default.newLogger<TwoFactorSetupScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: TwoFactorSetupViewModel = viewModel { TwoFactorSetupViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(Unit) {
            logger.debug { "Invocando setup de 2FA" }
            callService(
                coroutineScope = coroutine,
                snackbarHostState = snackbarHostState,
                setLoading = { viewModel.loading = it },
                serviceCall = { viewModel.setup() },
                onSuccess = { result -> viewModel.state = viewModel.state.copy(otpAuthUri = result.otpAuthUri) }
            )
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                Modifier
                    .padding(padding)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                if (viewModel.state.otpAuthUri.isNotEmpty()) {
                    androidx.compose.material3.Text(viewModel.state.otpAuthUri)
                }
            }
        }
    }
}

