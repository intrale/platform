


import androidx.navigation.NavHostController
import asdo.*
import ext.*
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
import ui.sc.*
import io.ktor.client.plugins.logging.*


public const val SCREENS = "screens"

public const val INIT = "init"
public const val DASHBOARD = "dashboard"
public const val SECUNDARY = "secundary"
public const val SIGNUP = "signup"
public const val SIGNUP_PLATFORM_ADMIN = "signupPlatformAdmin"
public const val SIGNUP_DELIVERY = "signupDelivery"
public const val SIGNUP_SALER = "signupSaler"
public const val SELECT_SIGNUP_PROFILE = "selectSignupProfile"
public const val CHANGE_PASSWORD = "changePassword"
public const val PASSWORD_RECOVERY = "passwordRecovery"
public const val CONFIRM_PASSWORD_RECOVERY = "confirmPasswordRecovery"
public const val REGISTER_BUSINESS = "registerBusiness"
public const val REVIEW_BUSINESS = "reviewBusiness"
public const val REGISTER_NEW_BUSINESS = "registerNewBusiness"

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
                bindSingleton(tag = SELECT_SIGNUP_PROFILE) { SelectSignUpProfileScreen() }
                bindSingleton(tag = CHANGE_PASSWORD) { ChangePasswordScreen() }
                bindSingleton(tag = PASSWORD_RECOVERY) { PasswordRecoveryScreen() }
                bindSingleton(tag = CONFIRM_PASSWORD_RECOVERY) { ConfirmPasswordRecoveryScreen() }
                bindSingleton(tag = REGISTER_NEW_BUSINESS) { RegisterNewBusinessScreen() }
                bindSingleton(tag = REGISTER_BUSINESS) { RegisterBusinessScreen() }
                bindSingleton(tag = REVIEW_BUSINESS) { ReviewBusinessScreen() }

                bindSingleton (tag = SCREENS) {
                    arrayListOf<Screen>(
                        instance(tag = INIT),
                        instance(tag = DASHBOARD),
                        instance(tag = SECUNDARY),
                        instance(tag = SIGNUP),
                        instance(tag = SELECT_SIGNUP_PROFILE),
                        instance(tag = SIGNUP_PLATFORM_ADMIN),
                        instance(tag = SIGNUP_DELIVERY),
                        instance(tag = SIGNUP_SALER),
                        instance(tag = CHANGE_PASSWORD),
                        instance(tag = PASSWORD_RECOVERY),
                        instance(tag = CONFIRM_PASSWORD_RECOVERY),
                        instance(tag = REGISTER_BUSINESS),
                        instance(tag = REVIEW_BUSINESS),
                        instance(tag = REGISTER_NEW_BUSINESS),
                        instance(tag = REGISTER_BUSINESS)
                    )
                }

                bindSingleton<HttpClient>{
                    HttpClient() {
                        install(ContentNegotiation) {
                            json(
                                Json { isLenient = true; ignoreUnknownKeys = true }
                            )
                        }
                        install(Logging) {
                            level = LogLevel.ALL // También podés usar HEADERS, BODY, etc.
                            logger = object : Logger {
                                override fun log(message: String) {
                                    println("HTTP TRACE: $message") // o usá un logger real
                                }
                            }
                        }
                        install(DefaultRequest) {
                            header(HttpHeaders.ContentType, ContentType.Application.Json)
                        }

                    }
                }

                bindSingleton<CommKeyValueStorage> { KeyValueStorageService() }
                bindSingleton<CommLoginService> { ClientLoginService(instance()) }
                bindSingleton<CommSignUpService> { ClientSignUpService(instance()) }
                bindSingleton<CommSignUpPlatformAdminService> { ClientSignUpPlatformAdminService(instance()) }
                bindSingleton<CommSignUpDeliveryService> { ClientSignUpDeliveryService(instance()) }
                bindSingleton<CommSignUpSalerService> { ClientSignUpSalerService(instance()) }
                bindSingleton<CommSearchBusinessesService> { ClientSearchBusinessesService(instance()) }
                bindSingleton<CommChangePasswordService> { ClientChangePasswordService(instance()) }
                bindSingleton<CommPasswordRecoveryService> { ClientPasswordRecoveryService(instance()) }
                bindSingleton<CommRegisterBusinessService> { ClientRegisterBusinessService(instance()) }
                bindSingleton<CommReviewBusinessRegistrationService> { ClientReviewBusinessRegistrationService(instance()) }

                bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
                bindSingleton<ToDoSignUp> { DoSignUp(instance()) }
                bindSingleton<ToDoSignUpPlatformAdmin> { DoSignUpPlatformAdmin(instance()) }
                bindSingleton<ToDoSignUpDelivery> { DoSignUpDelivery(instance()) }
                bindSingleton<ToDoSignUpSaler> { DoSignUpSaler(instance()) }
                bindSingleton<ToGetBusinesses> { DoGetBusinesses(instance()) }
                bindSingleton<ToDoCheckPreviousLogin> { DoCheckPreviousLogin(instance()) }
                bindSingleton<ToDoResetLoginCache> { DoResetLoginCache(instance()) }
                bindSingleton<ToDoChangePassword> { DoChangePassword(instance(), instance()) }
                bindSingleton<ToDoPasswordRecovery> { DoPasswordRecovery(instance()) }
                bindSingleton<ToDoConfirmPasswordRecovery> { DoConfirmPasswordRecovery(instance()) }
                bindSingleton<ToDoRegisterBusiness> { DoRegisterBusiness(instance()) }
                bindSingleton<ToDoReviewBusinessRegistration> { DoReviewBusinessRegistration(instance()) }

            }
    }
}