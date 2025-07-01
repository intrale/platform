package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.konform.validation.ValidationResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.login
import ui.rs.password
import ui.rs.username

const val LOGIN_PATH = "/login"

class Login() : Screen(LOGIN_PATH, Res.string.login){

    private lateinit var validationResult:ValidationResult<LoginViewModel>

    @Composable
    override fun screen() {
        screenImplementation()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImplementation(viewModel: LoginViewModel = viewModel {LoginViewModel()} ) {

        val coroutineScope = rememberCoroutineScope()

        forwardToHome(viewModel, coroutineScope, suspend  { viewModel.previousLogin()  } )

        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
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
                        forwardToHome(viewModel, coroutineScope, suspend { true })
                    }
                }
            )


        }
    }


    private fun forwardToHome(viewModel: LoginViewModel,
                              coroutineScope: CoroutineScope ,
                              navigateDecision: suspend () -> Boolean

    ){
        coroutineScope.launch {
            if (navigateDecision()) {
                val token: String = viewModel.login()
                if (token != null) {
                    navigate(HOME_PATH)
                }
            }
        }

    }



}

