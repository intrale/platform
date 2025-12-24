package ui.ro

import DIManager
import SCREENS
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import ar.com.intrale.appconfig.AppRuntimeConfig
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.business.DASHBOARD_PATH
import ui.sc.shared.Screen

class CommonRouter(navigator: NavHostController) : Router(navigator) {

    override var animationsEnabled: Boolean = true

    val screens: List<Screen> by DIManager.di.instance<List<Screen>>(tag = SCREENS)

    private val logger = LoggerFactory.default.newLogger<CommonRouter>()

    @Composable
    override fun routes(){
        routes(PaddingValues())
    }

    @Composable
    override fun routes(padding: PaddingValues) {
        var modifier = Modifier
            .fillMaxSize()
            //.verticalScroll(rememberScrollState())
            .padding(padding)

        logger.info { "Inicializando rutas" }

        NavHost(
            navController = navigator,
            startDestination = screens.first().route,
            modifier = modifier,
            enterTransition = {
                if (animationsEnabled) fadeIn() else EnterTransition.None
            },
            exitTransition = {
                if (animationsEnabled) fadeOut() else ExitTransition.None
            },
            popEnterTransition = {
                if (animationsEnabled) fadeIn() else EnterTransition.None
            },
            popExitTransition = {
                if (animationsEnabled) fadeOut() else ExitTransition.None
            }
        ) {

            val iterator = screens.listIterator()
            while (iterator.hasNext()) {

                // sharing the navigator for navigate into the screen composable
                val actual = iterator.next()
                actual.navigator = { route: String ->
                    if (AppRuntimeConfig.isBusiness && route == DASHBOARD_PATH) {
                        navigator.navigate(route) {
                            popUpTo(screens.first().route) { inclusive = true }
                            launchSingleTop = true
                        }
                    } else {
                        navigator.navigate(route)
                    }
                }
                actual.navigateBack = { navigator.popBackStack() }

                // relationship between screen and route
                composable(route = actual.route) {
                    actual.screen()
                }
            }

        }

    }

    @Composable
    override fun currentScreen():Screen{
        val backStackEntry by currentBackStackEntryAsState()
        val currentPath = backStackEntry?.destination?.route ?: screens.first().route

        return screens.map { it.route to it }.toMap().get(currentPath)!!
    }


    @Composable
    override fun currentBackStackEntryAsState(): State<NavBackStackEntry?> =
                                                    navigator.currentBackStackEntryAsState()


    override fun canNavigateBack():Boolean  {
        val canNavigate = navigator.previousBackStackEntry != null
        logger.info { "Puede navegar hacia atrás: $canNavigate" }
        return canNavigate
    }

    override fun navigateUp(): Boolean {
        logger.info { "Navegación hacia arriba solicitada" }
        return navigator.navigateUp()
    }

}
