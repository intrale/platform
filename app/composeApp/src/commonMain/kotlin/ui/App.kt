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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import org.jetbrains.compose.resources.StringResource
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.ro.Router
import ui.rs.Res
import ui.rs.back_button
import ui.th.IntraleTheme
import ui.util.RES_ERROR_PREFIX
import ui.util.resStringOr

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppBar(
    title: StringResource,
    canNavigateBack: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    TopAppBar(
        title = { Text(resStringOr(title, RES_ERROR_PREFIX + "Pantalla sin título")) },
        colors = TopAppBarDefaults.mediumTopAppBarColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer
        ),
        modifier = modifier,
        navigationIcon = {
            if (canNavigateBack) {
                IconButton(onClick = onClick) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = resStringOr(
                            Res.string.back_button,
                            RES_ERROR_PREFIX + "Acción volver"
                        )
                    )
                }
            } else {
                Icon(
                    imageVector = Icons.Default.Home,
                    contentDescription = resStringOr(
                        Res.string.back_button,
                        RES_ERROR_PREFIX + "Acción volver"
                    )
                )
            }
        }
    )
}

@Composable
fun App() {
    val logger = LoggerFactory.default.newLogger("ui", "App")
    val router: Router by DIManager.di.instance(arg = rememberNavController())
    val useDarkTheme = isSystemInDarkTheme()
    var animationsEnabled by remember { mutableStateOf(false) }

    logger.info { "Starting Intrale" }

    LaunchedEffect(Unit) {
        // Habilitamos animaciones luego del primer frame para evitar crashes cuando
        // DASHBOARD_ANIMATIONS_ENABLED permanece en false por recursos corruptos.
        animationsEnabled = true
    }

    IntraleTheme(useDarkTheme = useDarkTheme) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                AppBar(
                    title = router.currentScreen().title,
                    canNavigateBack = router.canNavigateBack(),
                    onClick = { router.navigateUp() }
                )
            }
        ) { innerPadding ->
            router.animationsEnabled = animationsEnabled
            router.routes(innerPadding)
        }
    }
}
