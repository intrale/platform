package ui.ro

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen

abstract class Router (var navigator: NavHostController){

    protected val routerLogger = LoggerFactory.default.newLogger<Router>()

    open var animationsEnabled: Boolean = true

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