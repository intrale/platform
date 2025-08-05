package ui.sc

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

abstract class Screen (val route: String, val title: StringResource) {

    protected val logger = LoggerFactory.default.newLogger<Screen>()

    lateinit var navigate: (route:String) -> Unit

    @Composable
    abstract fun screen()

}