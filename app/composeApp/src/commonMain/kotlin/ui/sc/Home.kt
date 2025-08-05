package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.Button
import ui.rs.Res
import ui.rs.app_name
import ui.rs.login
import ui.rs.logout
import ui.rs.change_password
import ui.rs.register_business


const val HOME_PATH = "/home"

class Home() : Screen(HOME_PATH, Res.string.app_name){

    private val logger = LoggerFactory.default.newLogger<Home>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Home" }
        screenImplementation()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImplementation(viewModel: HomeViewModel = viewModel {HomeViewModel()} ) {
        val coroutineScope = rememberCoroutineScope()
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("This is the home screen")

            Button(
                label = stringResource(Res.string.login),
                onClick = {
                    logger.info { "Navegando a $SECUNDARY_PATH" }
                    navigate(SECUNDARY_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.change_password),
                onClick = {
                    logger.info { "Navegando a $CHANGE_PASSWORD_PATH" }
                    navigate(CHANGE_PASSWORD_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.register_business),
                onClick = {
                    logger.info { "Navegando a $REGISTER_BUSINESS_PATH" }
                    navigate(REGISTER_BUSINESS_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.logout),
                onClick = {
                    coroutineScope.launch {
                        logger.info { "Solicitando logout" }
                        try {
                            viewModel.logout()
                            logger.info { "Logout exitoso" }
                            navigate(LOGIN_PATH)
                        } catch (e: Throwable) {
                            logger.error(e) { "Error durante logout" }
                        }
                    }

                }
            )

        }
    }

}


/*@OptIn(ExperimentalResourceApi::class)
@Composable
@Preview
fun Home() {

    Text("This is the home screen")

}*/