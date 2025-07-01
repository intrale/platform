


import androidx.navigation.NavHostController
import asdo.DoCheckPreviousLogin
import asdo.DoLogin
import asdo.DoResetLoginCache
import asdo.ToDoCheckPreviousLogin
import asdo.ToDoLogin
import asdo.ToDoResetLoginCache
import ext.ClientLoginService
import ext.CommKeyValueStorage
import ext.CommLoginService
import ext.KeyValueStorageService
import io.ktor.client.HttpClient
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import org.kodein.di.DI
import org.kodein.di.bindFactory
import org.kodein.di.bindSingleton
import org.kodein.di.instance
import ui.ro.CommonRouter
import ui.ro.Router
import ui.sc.Home
import ui.sc.Login
import ui.sc.Screen
import ui.sc.Secundary


public const val SCREENS = "screens"
//public const val SCREENS2 = "screens2"

public const val INIT = "init"
public const val DASHBOARD = "dashboard"
public const val SECUNDARY = "secundary"


//private const val LOGIN_VIEW_MODEL = "loginViewModel"

const val LOGIN_PATH = "/login"

// These class define bindings for dependencies injections on our App
class DIManager {

    companion object {

            var di = DI {

                /* Bindings */
                bindFactory<NavHostController, Router> {
                    navigator -> CommonRouter(navigator)
                }

                bindSingleton(tag = INIT) { Login() }
                bindSingleton(tag = DASHBOARD) { Home() }
                bindSingleton(tag = SECUNDARY) { Secundary() }

                bindSingleton (tag = SCREENS) {
                    arrayListOf<Screen>(
                        instance(tag = INIT),
                        instance(tag = DASHBOARD),
                        instance(tag = SECUNDARY)
                    )
                }

                bindSingleton<HttpClient>{
                    HttpClient {
                        install(ContentNegotiation) {
                            json(
                                Json { isLenient = true; ignoreUnknownKeys = true }
                            )
                        }
                        //if (true) {
                            install(Logging) {
                                //logger = Logger.DEFAULT
                                level = LogLevel.NONE
                            }
                        //}
                        install(DefaultRequest) {
                            header(HttpHeaders.ContentType, ContentType.Application.Json)
                        }

                    }
                }

                bindSingleton<CommKeyValueStorage> { KeyValueStorageService() }
                bindSingleton<CommLoginService> { ClientLoginService(instance()) }

                bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
                bindSingleton<ToDoCheckPreviousLogin> { DoCheckPreviousLogin(instance()) }
                bindSingleton<ToDoResetLoginCache> { DoResetLoginCache(instance()) }

            }
    }
}