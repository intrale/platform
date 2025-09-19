


import androidx.navigation.NavHostController
import asdo.auth.DoChangePassword
import asdo.auth.DoCheckPreviousLogin
import asdo.auth.DoConfirmPasswordRecovery
import asdo.auth.DoLogin
import asdo.auth.DoPasswordRecovery
import asdo.auth.DoResetLoginCache
import asdo.auth.DoTwoFactorSetup
import asdo.auth.DoTwoFactorVerify
import asdo.auth.ToDoChangePassword
import asdo.auth.ToDoCheckPreviousLogin
import asdo.auth.ToDoConfirmPasswordRecovery
import asdo.auth.ToDoLogin
import asdo.auth.ToDoPasswordRecovery
import asdo.auth.ToDoResetLoginCache
import asdo.auth.ToDoTwoFactorSetup
import asdo.auth.ToDoTwoFactorVerify
import asdo.business.DoGetBusinesses
import asdo.business.DoRegisterBusiness
import asdo.business.DoRequestJoinBusiness
import asdo.business.DoReviewBusinessRegistration
import asdo.business.DoReviewJoinBusiness
import asdo.business.ToDoRegisterBusiness
import asdo.business.ToDoRequestJoinBusiness
import asdo.business.ToDoReviewBusinessRegistration
import asdo.business.ToDoReviewJoinBusiness
import asdo.business.ToGetBusinesses
import asdo.signup.DoRegisterSaler
import asdo.signup.DoSignUp
import asdo.signup.DoSignUpDelivery
import asdo.signup.DoSignUpPlatformAdmin
import asdo.signup.ToDoRegisterSaler
import asdo.signup.ToDoSignUp
import asdo.signup.ToDoSignUpDelivery
import asdo.signup.ToDoSignUpPlatformAdmin
import ext.auth.ClientChangePasswordService
import ext.auth.ClientLoginService
import ext.auth.ClientPasswordRecoveryService
import ext.auth.ClientTwoFactorSetupService
import ext.auth.ClientTwoFactorVerifyService
import ext.auth.CommChangePasswordService
import ext.auth.CommLoginService
import ext.auth.CommPasswordRecoveryService
import ext.auth.CommTwoFactorSetupService
import ext.auth.CommTwoFactorVerifyService
import ext.business.ClientRegisterBusinessService
import ext.business.ClientRequestJoinBusinessService
import ext.business.ClientReviewBusinessRegistrationService
import ext.business.ClientReviewJoinBusinessService
import ext.business.ClientSearchBusinessesService
import ext.business.CommRegisterBusinessService
import ext.business.CommRequestJoinBusinessService
import ext.business.CommReviewBusinessRegistrationService
import ext.business.CommReviewJoinBusinessService
import ext.business.CommSearchBusinessesService
import ext.signup.ClientRegisterSalerService
import ext.signup.ClientSignUpDeliveryService
import ext.signup.ClientSignUpPlatformAdminService
import ext.signup.ClientSignUpService
import ext.signup.CommRegisterSalerService
import ext.signup.CommSignUpDeliveryService
import ext.signup.CommSignUpPlatformAdminService
import ext.signup.CommSignUpService
import ext.storage.CommKeyValueStorage
import ext.storage.KeyValueStorageService
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
import io.ktor.client.plugins.logging.Logger
import ui.ro.CommonRouter
import ui.ro.Router
import ui.sc.auth.ChangePasswordScreen
import ui.sc.auth.ConfirmPasswordRecoveryScreen
import ui.sc.auth.Login
import ui.sc.auth.PasswordRecoveryScreen
import ui.sc.auth.TwoFactorSetupScreen
import ui.sc.auth.TwoFactorVerifyScreen
import ui.sc.business.DashboardScreen
import ui.sc.business.RegisterNewBusinessScreen
import ui.sc.business.RequestJoinBusinessScreen
import ui.sc.business.ReviewBusinessScreen
import ui.sc.business.ReviewJoinBusinessScreen
import ui.sc.shared.ButtonsPreviewScreen
import ui.sc.shared.Home
import ui.sc.shared.Screen
import ui.sc.signup.RegisterSalerScreen
import ui.sc.signup.SelectSignUpProfileScreen
import ui.sc.signup.SignUpDeliveryScreen
import ui.sc.signup.SignUpPlatformAdminScreen
import ui.sc.signup.SignUpScreen


public const val SCREENS = "screens"

public const val HOME = "home"
public const val INIT = "init"
public const val DASHBOARD = "dashboard"
public const val BUTTONS_PREVIEW = "buttonsPreview"
public const val SIGNUP = "signup"
public const val SIGNUP_PLATFORM_ADMIN = "signupPlatformAdmin"
public const val SIGNUP_DELIVERY = "signupDelivery"
public const val REGISTER_SALER = "registerSaler"
public const val SELECT_SIGNUP_PROFILE = "selectSignupProfile"
public const val CHANGE_PASSWORD = "changePassword"
public const val PASSWORD_RECOVERY = "passwordRecovery"
public const val CONFIRM_PASSWORD_RECOVERY = "confirmPasswordRecovery"
public const val REVIEW_BUSINESS = "reviewBusiness"
public const val REGISTER_NEW_BUSINESS = "registerNewBusiness"
public const val REQUEST_JOIN_BUSINESS = "requestJoinBusiness"
public const val REVIEW_JOIN_BUSINESS = "reviewJoinBusiness"
public const val TWO_FACTOR_SETUP = "twoFactorSetup"
public const val TWO_FACTOR_VERIFY = "twoFactorVerify"

const val LOGIN_PATH = "/login"

// These class define bindings for dependencies injections on our App
class DIManager {

    companion object {

            var di = DI {

                /* Bindings */
                bindFactory<NavHostController, Router> {
                    navigator -> CommonRouter(navigator)
                }

                bindSingleton(tag = HOME) { Home() }
                bindSingleton(tag = INIT) { Login() }
                bindSingleton(tag = DASHBOARD) { DashboardScreen() }
                bindSingleton(tag = BUTTONS_PREVIEW) { ButtonsPreviewScreen() }
                bindSingleton(tag = SIGNUP) { SignUpScreen() }
                bindSingleton(tag = SIGNUP_PLATFORM_ADMIN) { SignUpPlatformAdminScreen() }
                bindSingleton(tag = SIGNUP_DELIVERY) { SignUpDeliveryScreen() }
                bindSingleton(tag = REGISTER_SALER) { RegisterSalerScreen() }
                bindSingleton(tag = SELECT_SIGNUP_PROFILE) { SelectSignUpProfileScreen() }
                bindSingleton(tag = CHANGE_PASSWORD) { ChangePasswordScreen() }
                bindSingleton(tag = PASSWORD_RECOVERY) { PasswordRecoveryScreen() }
                bindSingleton(tag = CONFIRM_PASSWORD_RECOVERY) { ConfirmPasswordRecoveryScreen() }
                bindSingleton(tag = REGISTER_NEW_BUSINESS) { RegisterNewBusinessScreen() }
                bindSingleton(tag = REVIEW_BUSINESS) { ReviewBusinessScreen() }
                bindSingleton(tag = REQUEST_JOIN_BUSINESS) { RequestJoinBusinessScreen() }
                bindSingleton(tag = REVIEW_JOIN_BUSINESS) { ReviewJoinBusinessScreen() }
                bindSingleton(tag = TWO_FACTOR_SETUP) { TwoFactorSetupScreen() }
                bindSingleton(tag = TWO_FACTOR_VERIFY) { TwoFactorVerifyScreen() }

                bindSingleton (tag = SCREENS) {
                    arrayListOf<Screen>(
                        instance(tag = HOME),
                        instance(tag = INIT),
                        instance(tag = DASHBOARD),
                        instance(tag = BUTTONS_PREVIEW),
                        instance(tag = SIGNUP),
                        instance(tag = SELECT_SIGNUP_PROFILE),
                        instance(tag = SIGNUP_PLATFORM_ADMIN),
                        instance(tag = SIGNUP_DELIVERY),
                        instance(tag = REGISTER_SALER),
                        instance(tag = CHANGE_PASSWORD),
                        instance(tag = PASSWORD_RECOVERY),
                        instance(tag = CONFIRM_PASSWORD_RECOVERY),
                        instance(tag = REVIEW_BUSINESS),
                        instance(tag = REGISTER_NEW_BUSINESS),
                        instance(tag = REQUEST_JOIN_BUSINESS),
                        instance(tag = REVIEW_JOIN_BUSINESS),
                        instance(tag = TWO_FACTOR_SETUP),
                        instance(tag = TWO_FACTOR_VERIFY)
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
                bindSingleton<CommRegisterSalerService> { ClientRegisterSalerService(instance()) }
                bindSingleton<CommSearchBusinessesService> { ClientSearchBusinessesService(instance()) }
                bindSingleton<CommChangePasswordService> { ClientChangePasswordService(instance()) }
                bindSingleton<CommPasswordRecoveryService> { ClientPasswordRecoveryService(instance()) }
                bindSingleton<CommRegisterBusinessService> { ClientRegisterBusinessService(instance()) }
                bindSingleton<CommReviewBusinessRegistrationService> { ClientReviewBusinessRegistrationService(instance()) }
                bindSingleton<CommRequestJoinBusinessService> { ClientRequestJoinBusinessService(instance()) }
                bindSingleton<CommReviewJoinBusinessService> { ClientReviewJoinBusinessService(instance()) }
                bindSingleton<CommTwoFactorSetupService> { ClientTwoFactorSetupService(instance()) }
                bindSingleton<CommTwoFactorVerifyService> { ClientTwoFactorVerifyService(instance()) }

                bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
                bindSingleton<ToDoSignUp> { DoSignUp(instance()) }
                bindSingleton<ToDoSignUpPlatformAdmin> { DoSignUpPlatformAdmin(instance()) }
                bindSingleton<ToDoSignUpDelivery> { DoSignUpDelivery(instance()) }
                bindSingleton<ToDoRegisterSaler> { DoRegisterSaler(instance(), instance()) }
                bindSingleton<ToGetBusinesses> { DoGetBusinesses(instance()) }
                bindSingleton<ToDoCheckPreviousLogin> { DoCheckPreviousLogin(instance()) }
                bindSingleton<ToDoResetLoginCache> { DoResetLoginCache(instance()) }
                bindSingleton<ToDoChangePassword> { DoChangePassword(instance(), instance()) }
                bindSingleton<ToDoPasswordRecovery> { DoPasswordRecovery(instance()) }
                bindSingleton<ToDoConfirmPasswordRecovery> { DoConfirmPasswordRecovery(instance()) }
                bindSingleton<ToDoRegisterBusiness> { DoRegisterBusiness(instance()) }
                bindSingleton<ToDoReviewBusinessRegistration> { DoReviewBusinessRegistration(instance(), instance()) }
                bindSingleton<ToDoRequestJoinBusiness> { DoRequestJoinBusiness(instance()) }
                bindSingleton<ToDoReviewJoinBusiness> { DoReviewJoinBusiness(instance()) }
                bindSingleton<ToDoTwoFactorSetup> { DoTwoFactorSetup(instance(), instance()) }
                bindSingleton<ToDoTwoFactorVerify> { DoTwoFactorVerify(instance(), instance()) }

            }
    }
}