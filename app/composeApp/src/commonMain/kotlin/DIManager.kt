


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
import asdo.client.DoGetClientProfile
import asdo.client.DoManageClientAddress
import asdo.client.DoUpdateClientProfile
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoManageClientAddress
import asdo.client.ToDoUpdateClientProfile
import asdo.delivery.DoGetDeliveryProfile
import asdo.delivery.DoUpdateDeliveryProfile
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryProfile
import asdo.business.DoCreateProduct
import asdo.business.DoDeleteProduct
import asdo.business.DoDeleteCategory
import asdo.business.DoGetBusinesses
import asdo.business.DoGetBusinessProducts
import asdo.business.DoListCategories
import asdo.business.DoRegisterBusiness
import asdo.business.DoRequestJoinBusiness
import asdo.business.DoReviewBusinessRegistration
import asdo.business.DoReviewJoinBusiness
import asdo.business.DoListProducts
import asdo.business.DoCreateCategory
import asdo.business.DoUpdateCategory
import asdo.business.DoUpdateProduct
import asdo.business.ToDoCreateProduct
import asdo.business.ToDoCreateCategory
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoRegisterBusiness
import asdo.business.ToDoRequestJoinBusiness
import asdo.business.ToDoReviewBusinessRegistration
import asdo.business.ToDoReviewJoinBusiness
import asdo.business.ToDoListProducts
import asdo.business.ToDoListCategories
import asdo.business.ToDoUpdateCategory
import asdo.business.ToDoUpdateProduct
import asdo.business.ToGetBusinesses
import asdo.business.ToGetBusinessProducts
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
import ext.auth.DeliveryLoginService
import ext.auth.CommChangePasswordService
import ext.auth.CommLoginService
import ext.auth.CommPasswordRecoveryService
import ext.auth.CommTwoFactorSetupService
import ext.auth.CommTwoFactorVerifyService
import ext.client.ClientAddressesService
import ext.client.ClientProfileService
import ext.client.CommClientAddressesService
import ext.client.CommClientProfileService
import ext.delivery.CommDeliveryProfileService
import ext.delivery.CommDeliveryOrdersService
import ext.delivery.DeliveryProfileService
import ext.delivery.DeliveryOrdersService
import ext.business.ClientGetBusinessProductsService
import ext.business.ClientCategoryService
import ext.business.ClientProductService
import ext.business.ClientRegisterBusinessService
import ext.business.ClientRequestJoinBusinessService
import ext.business.ClientReviewBusinessRegistrationService
import ext.business.ClientReviewJoinBusinessService
import ext.business.ClientSearchBusinessesService
import ext.business.CommCategoryService
import ext.business.CommGetBusinessProductsService
import ext.business.CommProductService
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
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import ar.com.intrale.appconfig.AppRuntimeConfig
import ar.com.intrale.appconfig.AppType
import org.kodein.di.DI
import org.kodein.di.bindFactory
import org.kodein.di.bindSingleton
import org.kodein.di.instance
import ui.ro.CommonRouter
import ui.ro.Router
import ui.sc.auth.ChangePasswordScreen
import ui.sc.auth.ConfirmPasswordRecoveryScreen
import ui.sc.auth.Login
import ui.sc.auth.PasswordRecoveryScreen
import ui.sc.auth.TwoFactorSetupScreen
import ui.sc.auth.TwoFactorVerifyScreen
import ui.sc.business.BusinessOnboardingScreen
import ui.sc.business.DashboardScreen
import ui.sc.business.PersonalizationScreen
import ui.sc.business.ProductFormScreen
import ui.sc.business.ProductListScreen
import ui.sc.business.CategoryFormScreen
import ui.sc.business.CategoryListScreen
import ui.sc.business.RegisterNewBusinessScreen
import ui.sc.business.RequestJoinBusinessScreen
import ui.sc.business.ReviewBusinessScreen
import ui.sc.business.ReviewJoinBusinessScreen
import ui.sc.client.ClientEntryScreen
import ui.sc.client.ClientHomeScreen
import ui.sc.client.ClientOrdersScreen
import ui.sc.client.ClientCartScreen
import ui.sc.delivery.DeliveryDashboardScreen
import ui.sc.delivery.DeliveryHomeScreen
import ui.sc.delivery.DeliveryProfileScreen
import ui.sc.client.ClientProfileScreen
import ui.sc.shared.ButtonsPreviewScreen
import ui.sc.shared.Home
import ui.sc.shared.Screen
import ui.sc.signup.RegisterSalerScreen
import ui.sc.signup.SelectSignUpProfileScreen
import ui.sc.signup.SignUpDeliveryScreen
import ui.sc.signup.SignUpPlatformAdminScreen
import ui.sc.signup.SignUpScreen


public const val SCREENS = "screens"

public const val CLIENT_ENTRY = "clientEntry"
public const val CLIENT_HOME = "clientHome"
public const val CLIENT_ORDERS = "clientOrders"
public const val CLIENT_CART = "clientCart"
public const val CLIENT_PROFILE = "clientProfile"
public const val HOME = "home"
public const val INIT = "init"
public const val DASHBOARD = "dashboard"
public const val BUSINESS_ONBOARDING = "businessOnboarding"
public const val BUTTONS_PREVIEW = "buttonsPreview"
public const val SIGNUP = "signup"
public const val SIGNUP_PLATFORM_ADMIN = "signupPlatformAdmin"
public const val SIGNUP_DELIVERY = "signupDelivery"
public const val REGISTER_SALER = "registerSaler"
public const val DELIVERY_HOME = "deliveryHome"
public const val DELIVERY_DASHBOARD = "deliveryDashboard"
public const val DELIVERY_PROFILE = "deliveryProfile"
public const val SELECT_SIGNUP_PROFILE = "selectSignupProfile"
public const val CHANGE_PASSWORD = "changePassword"
public const val PASSWORD_RECOVERY = "passwordRecovery"
public const val CONFIRM_PASSWORD_RECOVERY = "confirmPasswordRecovery"
public const val REVIEW_BUSINESS = "reviewBusiness"
public const val REGISTER_NEW_BUSINESS = "registerNewBusiness"
public const val REQUEST_JOIN_BUSINESS = "requestJoinBusiness"
public const val REVIEW_JOIN_BUSINESS = "reviewJoinBusiness"
public const val PERSONALIZATION = "personalization"
public const val BUSINESS_PRODUCTS = "businessProducts"
public const val BUSINESS_PRODUCT_FORM = "businessProductForm"
public const val BUSINESS_CATEGORIES = "businessCategories"
public const val BUSINESS_CATEGORY_FORM = "businessCategoryForm"
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

                bindSingleton(tag = CLIENT_ENTRY) { ClientEntryScreen() }
                bindSingleton(tag = CLIENT_HOME) { ClientHomeScreen() }
                bindSingleton(tag = CLIENT_ORDERS) { ClientOrdersScreen() }
                bindSingleton(tag = CLIENT_CART) { ClientCartScreen() }
                bindSingleton(tag = CLIENT_PROFILE) { ClientProfileScreen() }
                bindSingleton(tag = HOME) { Home() }
                bindSingleton(tag = INIT) { Login() }
                bindSingleton(tag = DASHBOARD) { DashboardScreen() }
                bindSingleton(tag = BUSINESS_ONBOARDING) { BusinessOnboardingScreen() }
                bindSingleton(tag = BUTTONS_PREVIEW) { ButtonsPreviewScreen() }
                bindSingleton(tag = SIGNUP) { SignUpScreen() }
                bindSingleton(tag = SIGNUP_PLATFORM_ADMIN) { SignUpPlatformAdminScreen() }
                bindSingleton(tag = SIGNUP_DELIVERY) { SignUpDeliveryScreen() }
                bindSingleton(tag = REGISTER_SALER) { RegisterSalerScreen() }
                bindSingleton(tag = DELIVERY_HOME) { DeliveryHomeScreen() }
                bindSingleton(tag = DELIVERY_DASHBOARD) { DeliveryDashboardScreen() }
                bindSingleton(tag = DELIVERY_PROFILE) { DeliveryProfileScreen() }
                bindSingleton(tag = SELECT_SIGNUP_PROFILE) { SelectSignUpProfileScreen() }
                bindSingleton(tag = CHANGE_PASSWORD) { ChangePasswordScreen() }
                bindSingleton(tag = PASSWORD_RECOVERY) { PasswordRecoveryScreen() }
                bindSingleton(tag = CONFIRM_PASSWORD_RECOVERY) { ConfirmPasswordRecoveryScreen() }
                bindSingleton(tag = REGISTER_NEW_BUSINESS) { RegisterNewBusinessScreen() }
                bindSingleton(tag = REVIEW_BUSINESS) { ReviewBusinessScreen() }
                bindSingleton(tag = REQUEST_JOIN_BUSINESS) { RequestJoinBusinessScreen() }
                bindSingleton(tag = REVIEW_JOIN_BUSINESS) { ReviewJoinBusinessScreen() }
                bindSingleton(tag = PERSONALIZATION) { PersonalizationScreen() }
                bindSingleton(tag = BUSINESS_PRODUCTS) { ProductListScreen() }
                bindSingleton(tag = BUSINESS_PRODUCT_FORM) { ProductFormScreen() }
                bindSingleton(tag = BUSINESS_CATEGORIES) { CategoryListScreen() }
                bindSingleton(tag = BUSINESS_CATEGORY_FORM) { CategoryFormScreen() }
                bindSingleton(tag = TWO_FACTOR_SETUP) { TwoFactorSetupScreen() }
                bindSingleton(tag = TWO_FACTOR_VERIFY) { TwoFactorVerifyScreen() }

                bindSingleton(tag = SCREENS) {
                    val appType = AppRuntimeConfig.appType

                    arrayListOf<Screen>().apply {
                        when (appType) {
                            AppType.CLIENT -> {
                                add(instance(tag = CLIENT_ENTRY))
                                add(instance(tag = CLIENT_HOME))
                                add(instance(tag = CLIENT_ORDERS))
                                add(instance(tag = CLIENT_CART))
                                add(instance(tag = CLIENT_PROFILE))
                                add(instance(tag = INIT))
                                add(instance(tag = SIGNUP))
                                add(instance(tag = CHANGE_PASSWORD))
                                add(instance(tag = PASSWORD_RECOVERY))
                                add(instance(tag = CONFIRM_PASSWORD_RECOVERY))
                                add(instance(tag = TWO_FACTOR_SETUP))
                                add(instance(tag = TWO_FACTOR_VERIFY))
                            }

                            AppType.DELIVERY -> {
                                add(instance(tag = DELIVERY_HOME))
                                add(instance(tag = INIT))
                                add(instance(tag = DELIVERY_DASHBOARD))
                                add(instance(tag = DELIVERY_PROFILE))
                                add(instance(tag = SIGNUP_DELIVERY))
                                add(instance(tag = CHANGE_PASSWORD))
                                add(instance(tag = PASSWORD_RECOVERY))
                                add(instance(tag = CONFIRM_PASSWORD_RECOVERY))
                                add(instance(tag = TWO_FACTOR_SETUP))
                                add(instance(tag = TWO_FACTOR_VERIFY))
                            }

                            AppType.BUSINESS -> {
                                add(instance(tag = BUSINESS_ONBOARDING))
                                add(instance(tag = INIT))
                                add(instance(tag = DASHBOARD))
                                add(instance(tag = BUTTONS_PREVIEW))
                                add(instance(tag = SIGNUP))
                                add(instance(tag = SELECT_SIGNUP_PROFILE))
                                add(instance(tag = SIGNUP_PLATFORM_ADMIN))
                                add(instance(tag = SIGNUP_DELIVERY))
                                add(instance(tag = REGISTER_SALER))
                                add(instance(tag = CHANGE_PASSWORD))
                                add(instance(tag = PASSWORD_RECOVERY))
                                add(instance(tag = CONFIRM_PASSWORD_RECOVERY))
                                add(instance(tag = REVIEW_BUSINESS))
                                add(instance(tag = REGISTER_NEW_BUSINESS))
                                add(instance(tag = REQUEST_JOIN_BUSINESS))
                                add(instance(tag = REVIEW_JOIN_BUSINESS))
                                add(instance(tag = PERSONALIZATION))
                                add(instance(tag = BUSINESS_PRODUCTS))
                                add(instance(tag = BUSINESS_PRODUCT_FORM))
                                add(instance(tag = BUSINESS_CATEGORIES))
                                add(instance(tag = BUSINESS_CATEGORY_FORM))
                                add(instance(tag = TWO_FACTOR_SETUP))
                                add(instance(tag = TWO_FACTOR_VERIFY))
                            }

                            else -> {
                                add(instance(tag = HOME))
                                add(instance(tag = INIT))
                                add(instance(tag = DASHBOARD))
                                add(instance(tag = BUTTONS_PREVIEW))
                                add(instance(tag = SIGNUP))
                                add(instance(tag = SELECT_SIGNUP_PROFILE))
                                add(instance(tag = SIGNUP_PLATFORM_ADMIN))
                                add(instance(tag = SIGNUP_DELIVERY))
                                add(instance(tag = REGISTER_SALER))
                                add(instance(tag = CHANGE_PASSWORD))
                                add(instance(tag = PASSWORD_RECOVERY))
                                add(instance(tag = CONFIRM_PASSWORD_RECOVERY))
                                add(instance(tag = REVIEW_BUSINESS))
                                add(instance(tag = REGISTER_NEW_BUSINESS))
                                add(instance(tag = REQUEST_JOIN_BUSINESS))
                                add(instance(tag = REVIEW_JOIN_BUSINESS))
                                add(instance(tag = PERSONALIZATION))
                                add(instance(tag = BUSINESS_PRODUCTS))
                                add(instance(tag = BUSINESS_PRODUCT_FORM))
                                add(instance(tag = BUSINESS_CATEGORIES))
                                add(instance(tag = BUSINESS_CATEGORY_FORM))
                                add(instance(tag = TWO_FACTOR_SETUP))
                                add(instance(tag = TWO_FACTOR_VERIFY))
                            }
                        }
                    }
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
                bindSingleton<CommLoginService> {
                    if (AppRuntimeConfig.isDelivery) {
                        DeliveryLoginService(instance())
                    } else {
                        ClientLoginService(instance())
                    }
                }
                bindSingleton<CommSignUpService> { ClientSignUpService(instance()) }
                bindSingleton<CommSignUpPlatformAdminService> { ClientSignUpPlatformAdminService(instance()) }
                bindSingleton<CommSignUpDeliveryService> { ClientSignUpDeliveryService(instance()) }
                bindSingleton<CommRegisterSalerService> { ClientRegisterSalerService(instance()) }
                bindSingleton<CommSearchBusinessesService> { ClientSearchBusinessesService(instance()) }
                bindSingleton<CommCategoryService> { ClientCategoryService(instance(), instance()) }
                bindSingleton<CommProductService> { ClientProductService(instance(), instance()) }
                bindSingleton<CommChangePasswordService> { ClientChangePasswordService(instance()) }
                bindSingleton<CommPasswordRecoveryService> { ClientPasswordRecoveryService(instance()) }
                bindSingleton<CommRegisterBusinessService> { ClientRegisterBusinessService(instance()) }
                bindSingleton<CommReviewBusinessRegistrationService> { ClientReviewBusinessRegistrationService(instance()) }
                bindSingleton<CommRequestJoinBusinessService> { ClientRequestJoinBusinessService(instance()) }
                bindSingleton<CommReviewJoinBusinessService> { ClientReviewJoinBusinessService(instance()) }
                bindSingleton<CommGetBusinessProductsService> { ClientGetBusinessProductsService(instance()) }
                bindSingleton<CommTwoFactorSetupService> { ClientTwoFactorSetupService(instance()) }
                bindSingleton<CommTwoFactorVerifyService> { ClientTwoFactorVerifyService(instance()) }
                bindSingleton<CommClientProfileService> { ClientProfileService(instance(), instance()) }
                bindSingleton<CommClientAddressesService> { ClientAddressesService(instance(), instance()) }
                bindSingleton<CommDeliveryProfileService> { DeliveryProfileService(instance(), instance()) }
                bindSingleton<CommDeliveryOrdersService> { DeliveryOrdersService(instance(), instance()) }

                bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
                bindSingleton<ToDoSignUp> { DoSignUp(instance()) }
                bindSingleton<ToDoSignUpPlatformAdmin> { DoSignUpPlatformAdmin(instance()) }
                bindSingleton<ToDoSignUpDelivery> { DoSignUpDelivery(instance()) }
                bindSingleton<ToDoRegisterSaler> { DoRegisterSaler(instance(), instance()) }
                bindSingleton<ToGetBusinesses> { DoGetBusinesses(instance()) }
                bindSingleton<ToDoListProducts> { DoListProducts(instance()) }
                bindSingleton<ToDoListCategories> { DoListCategories(instance()) }
                bindSingleton<ToDoCreateProduct> { DoCreateProduct(instance()) }
                bindSingleton<ToDoCreateCategory> { DoCreateCategory(instance()) }
                bindSingleton<ToDoUpdateProduct> { DoUpdateProduct(instance()) }
                bindSingleton<ToDoUpdateCategory> { DoUpdateCategory(instance()) }
                bindSingleton<ToDoDeleteProduct> { DoDeleteProduct(instance()) }
                bindSingleton<ToDoDeleteCategory> { DoDeleteCategory(instance()) }
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
                bindSingleton<ToDoGetClientProfile> { DoGetClientProfile(instance(), instance(), instance()) }
                bindSingleton<ToDoUpdateClientProfile> { DoUpdateClientProfile(instance(), instance(), instance()) }
                bindSingleton<ToDoManageClientAddress> { DoManageClientAddress(instance(), instance(), instance()) }
                bindSingleton<ToDoGetDeliveryProfile> { DoGetDeliveryProfile(instance()) }
                bindSingleton<ToDoUpdateDeliveryProfile> { DoUpdateDeliveryProfile(instance()) }
                bindSingleton<ToGetBusinessProducts> { DoGetBusinessProducts(instance()) }

            }
    }
}
