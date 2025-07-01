package ui.sc

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource

abstract class Screen (val route: String, val title: StringResource) {

    lateinit var navigate: (route:String) -> Unit

    @Composable
    abstract fun screen()

}