package ext

import ar.com.intrale.BuildKonfig
import org.jetbrains.compose.resources.ExperimentalResourceApi

@OptIn(ExperimentalResourceApi::class)
object AppConfig {
    val baseUrl: String = BuildKonfig.BASE_URL
}
