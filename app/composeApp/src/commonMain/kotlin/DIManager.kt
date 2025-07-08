


import androidx.navigation.NavHostController
import asdo.*
import ext.*
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
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
import ui.sc.*


public const val SCREENS = "screens"
//public const val SCREENS2 = "screens2"

public const val INIT = "init"
public const val DASHBOARD = "dashboard"
public const val SECUNDARY = "secundary"
public const val SIGNUP = "signup"
public const val SIGNUP_PLATFORM_ADMIN = "signupPlatformAdmin"
public const val SIGNUP_DELIVERY = "signupDelivery"
public const val SIGNUP_SALER = "signupSaler"


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
                bindSingleton(tag = SIGNUP) { SignUpScreen() }
                bindSingleton(tag = SIGNUP_PLATFORM_ADMIN) { SignUpPlatformAdminScreen() }
                bindSingleton(tag = SIGNUP_DELIVERY) { SignUpDeliveryScreen() }
                bindSingleton(tag = SIGNUP_SALER) { SignUpSalerScreen() }

                bindSingleton (tag = SCREENS) {
                    arrayListOf<Screen>(
                        instance(tag = INIT),
                        instance(tag = DASHBOARD),
                        instance(tag = SECUNDARY),
                        instance(tag = SIGNUP),
                        instance(tag = SIGNUP_PLATFORM_ADMIN),
                        instance(tag = SIGNUP_DELIVERY),
                        instance(tag = SIGNUP_SALER)
                    )
                }

                bindSingleton<HttpClient>{
                    HttpClient(CIO) {
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
                bindSingleton<CommSignUpService> { ClientSignUpService(instance()) }

                bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
                bindSingleton<ToDoSignUp> { DoSignUp(instance()) }
                bindSingleton<ToDoSignUpPlatformAdmin> { DoSignUpPlatformAdmin(instance()) }
                bindSingleton<ToDoSignUpDelivery> { DoSignUpDelivery(instance()) }
                bindSingleton<ToDoSignUpSaler> { DoSignUpSaler(instance()) }
                bindSingleton<ToDoCheckPreviousLogin> { DoCheckPreviousLogin(instance()) }
                bindSingleton<ToDoResetLoginCache> { DoResetLoginCache(instance()) }

            }
    }
}