package ui

import DIManager
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.ro.Router
import ui.rs.Res
import ui.rs.back_button
import ui.th.darkScheme
import ui.th.lightScheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppBar(
    title: StringResource,
    canNavigateBack: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    TopAppBar(
        title = { Text(stringResource(title)) },
        colors = TopAppBarDefaults.mediumTopAppBarColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer
        ),
        modifier = modifier,
        navigationIcon = {
            if (canNavigateBack) {
                IconButton(onClick = onClick) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = stringResource(Res.string.back_button)
                    )
                }
            } else {
                Icon(
                    imageVector = Icons.Default.Home,
                    contentDescription = stringResource(Res.string.back_button)
                )
            }
        }
    )

}

//@OptIn( ExperimentalResourceApi::class)
//@OptIn(ExperimentalMaterial3Api::class)
@Composable
//@Preview
fun App() {

    val logger = LoggerFactory.default.newLogger("ui", "App")

    val router:Router by DIManager.di.instance(arg = rememberNavController())

    val colorScheme =
        if (!isSystemInDarkTheme()) {
            lightScheme
        } else {
            darkScheme
        }

    logger.info { "Starting Intrale" }

    MaterialTheme(
        colorScheme = colorScheme
    ){
        Scaffold (
                topBar = {
                    AppBar(
                        title = router.currentScreen().title,
                        canNavigateBack =  router.canNavigateBack(),
                        onClick =  { router.navigateUp() }
                    )
                }
            ) { innerPadding -> router.routes(innerPadding)
            }
        }

}