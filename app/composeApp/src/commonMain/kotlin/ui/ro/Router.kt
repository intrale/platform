package ui.ro

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import ui.sc.Screen
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

abstract class Router (var navigator: NavHostController){

    protected val logger = LoggerFactory.default.newLogger<Router>()

    @Composable
    abstract fun routes()

    @Composable
    abstract fun routes(padding: PaddingValues)

    @Composable
    abstract fun currentScreen(): Screen

    @Composable
    abstract fun currentBackStackEntryAsState(): State<NavBackStackEntry?>

    abstract fun canNavigateBack():Boolean

    abstract fun navigateUp(): Boolean

}