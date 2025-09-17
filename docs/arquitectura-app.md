# Arquitectura Técnica - Módulo `app`

El módulo `app` corresponde al frontend multiplataforma de la plataforma Intrale. Está construido con **Compose Multiplatform** e incluye todas las pantallas y lógica de presentación para Android, iOS, escritorio (JVM) y web (Kotlin/Wasm).

## 1. Propósito del módulo

- Proveer la interfaz de usuario de la plataforma.
- Compartir la mayor parte de la lógica entre todas las plataformas soportadas.
- Manejar el flujo de navegación, temas y validaciones de entrada.

## 2. Estructura de carpetas

```
app/
 └─ composeApp/
    ├─ src/
    │  ├─ commonMain/kotlin/        # Código multiplataforma
    │  │   ├─ asdo/                 # Lógica de negocio (acciones)
    │  │   ├─ ext/                  # Acceso a servicios externos
    │  │   └─ ui/                   # Componentes y pantallas
    │  ├─ androidMain/kotlin/       # Implementaciones para Android
    │  ├─ iosMain/kotlin/           # Implementaciones para iOS
    │  ├─ desktopMain/kotlin/       # Implementaciones para JVM
    │  └─ wasmJsMain/kotlin/        # Implementaciones para Web
```

### Paquetes principales

- `asdo`: define interfaces (`ToDo`) e implementaciones (`Do`) con la lógica de negocio. Ejemplo: `DoLogin` y `ToDoLogin` manejan el proceso de autenticación.
- `ext`: contiene servicios para interactuar con recursos externos (APIs, almacenamiento). Por ejemplo, `ClientLoginService` realiza la llamada HTTP al endpoint de login y `KeyValueStorageService` guarda el token en un almacenamiento multiplataforma.
- `ui`: agrupa todo lo relacionado con la interfaz. Incluye submódulos `cp` (componentes reutilizables), `ro` (ruteo y navegación), `sc` (pantallas) y `th` (temas y colores).

## 3. Inyección de dependencias

El archivo `DIManager.kt` configura Kodein y registra las dependencias necesarias. Se definen bindings para el `Router`, la lista de pantallas (`Screen`) y servicios como el `HttpClient`, el almacenamiento local y el cliente de login. Cada pantalla se registra como `singleton` para su uso posterior.

```kotlin
var di = DI {
    bindFactory<NavHostController, Router> { navigator -> CommonRouter(navigator) }
    bindSingleton(tag = HOME) { Home() }
    bindSingleton(tag = INIT) { Login() }
    bindSingleton(tag = DASHBOARD) { DashboardScreen() }
    bindSingleton(tag = BUTTONS_PREVIEW) { ButtonsPreviewScreen() }
    bindSingleton(tag = SCREENS) {
        arrayListOf(
            instance(tag = HOME),
            instance(tag = INIT),
            instance(tag = DASHBOARD),
            instance(tag = BUTTONS_PREVIEW),
            // ...resto de las pantallas
        )
    }
    bindSingleton<HttpClient> {
        HttpClient() {
            install(ContentNegotiation) { json(Json { isLenient = true; ignoreUnknownKeys = true }) }
            install(Logging) { level = LogLevel.ALL }
            install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
        }
    }
    bindSingleton<CommKeyValueStorage> { KeyValueStorageService() }
    bindSingleton<CommLoginService> { ClientLoginService(instance()) }
    bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
    bindSingleton<ToDoCheckPreviousLogin> { DoCheckPreviousLogin(instance()) }
    bindSingleton<ToDoResetLoginCache> { DoResetLoginCache(instance()) }
}
```
【F:app/composeApp/src/commonMain/kotlin/DIManager.kt†L35-L118】

## 4. Pantallas y navegación

La navegación se gestiona mediante `Router` y su implementación `CommonRouter`. Cada pantalla extiende la clase `Screen`, donde define su ruta y título. Tras la nueva landing pública, la aplicación inicia en `Home` con los CTA de acceso y delega el resto de acciones en `DashboardScreen`. `CommonRouter` expone el `NavHost`, comparte el controlador de navegación con cada pantalla y usa la primera pantalla registrada (Home) como `startDestination`.

```kotlin
abstract class Router(var navigator: NavHostController) {
    @Composable abstract fun routes()
    @Composable abstract fun routes(padding: PaddingValues)
    @Composable abstract fun currentScreen(): Screen
    @Composable abstract fun currentBackStackEntryAsState(): State<NavBackStackEntry?>
    abstract fun canNavigateBack(): Boolean
    abstract fun navigateUp(): Boolean
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/ro/Router.kt†L1-L26】

```kotlin
class CommonRouter(navigator: NavHostController) : Router(navigator) {
    val screens: List<Screen> by DIManager.di.instance<List<Screen>>(tag = SCREENS)

    @Composable
    override fun routes() {
        routes(PaddingValues())
    }

    @Composable
    override fun routes(padding: PaddingValues) {
        val modifier = Modifier
            .fillMaxSize()
            .padding(padding)

        NavHost(
            navController = navigator,
            startDestination = screens.first().route,
            modifier = modifier
        ) {
            val iterator = screens.listIterator()
            while (iterator.hasNext()) {
                val actual = iterator.next()
                actual.navigator = { route: String -> navigator.navigate(route) }
                composable(route = actual.route) { actual.screen() }
            }
        }
    }

    @Composable
    override fun currentScreen(): Screen {
        val backStackEntry by currentBackStackEntryAsState()
        val currentPath = backStackEntry?.destination?.route ?: screens.first().route
        return screens.associateBy { it.route }.getValue(currentPath)
    }

    // ...
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/ro/CommonRouter.kt†L1-L83】

### Ejemplo de pantalla: `Login`

La pantalla de login utiliza un `LoginViewModel` para manejar el estado y las validaciones. Cuando el usuario ingresa las credenciales y éstas son válidas, se invoca la acción `login()` y, con el token persistido, se navega a `DASHBOARD_PATH` para mostrar el menú autenticado.

Si la llamada al servicio de autenticación falla, la interfaz despliega un `Snackbar` informando si las credenciales son inválidas o si ocurrió un problema de conexión.

En caso de recibir la respuesta `newPassword is required`, la pantalla muestra campos adicionales para ingresar la nueva contraseña, nombre y apellido. Al completarlos se vuelve a invocar `login()` enviando estos datos.

```kotlin
result.onSuccess {
    viewModel.loading = false
    navigate(DASHBOARD_PATH)
}.onFailure { error ->
    // Manejo de errores y mensajes de snack bar
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/sc/Login.kt†L229-L256】

Al presionar el botón principal se valida el formulario, se ejecuta `login()` y, si la respuesta es exitosa, la navegación lleva al nuevo panel interno sin pasar por la landing pública.

## 5. Vista Modelo y validaciones

`ViewModel` es la clase base para todos los view models y se apoya en la librería **Konform** para realizar validaciones de entrada. Mantiene un mapa de estados (`InputState`) que se actualiza con los mensajes de error correspondientes.

```kotlin
abstract class ViewModel : androidx.lifecycle.ViewModel() {
    lateinit var validation: Validation<Any>
    var inputsStates by mutableStateOf(mutableMapOf<String, InputState>())
    abstract fun getState(): Any
    fun isValid(): Boolean {
        val validationResult: ValidationResult<Any> = validation(getState())
        initInputState()
        validationResult.errors.forEach {
            val inputState: InputState = this[it.dataPath.substring(1)]
            inputState.isValid = false
            inputState.details = it.message
        }
        return validationResult.isValid
    }
    operator fun get(propertyName: String): InputState {
        var inputState: InputState? = inputsStates[propertyName]
        if (inputState == null) {
            inputState = InputState(propertyName)
            inputsStates[propertyName] = inputState
        }
        return inputState
    }
    abstract fun initInputState()
    fun entry(key: String) = key to InputState(key)
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/sc/ViewModel.kt†L1-L47】

El `LoginViewModel` concreta esta clase para manejar los campos `user` y `password`, aplicando reglas de longitud mínima y ofreciendo funciones `login()` y `previousLogin()` para interactuar con las acciones definidas en `asdo`.

```kotlin
class LoginViewModel : ViewModel() {
    private val todoLogin: ToDoLogin by DIManager.di.instance()
    private val toDoCheckPreviousLogin: ToDoCheckPreviousLogin by DIManager.di.instance()
    var state by mutableStateOf(LoginUIState())
    data class LoginUIState(val user: String = "", val password: String = "")
    override fun getState(): Any = state
    init {
        validation = Validation<LoginUIState> {
            LoginUIState::user required { minLength(8) hint "Debe contener al menos 8 caracteres." }
            LoginUIState::password required { minLength(8) hint "Debe contener al menos 8 caracteres." }
        } as Validation<Any>
        initInputState()
    }
    override fun initInputState() {
        inputsStates = mutableMapOf(entry(LoginUIState::user.name), entry(LoginUIState::password.name))
    }
    suspend fun login(): String = todoLogin.execute(user = state.user, password = state.password)
    suspend fun previousLogin(): Boolean = toDoCheckPreviousLogin.execute()
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/sc/LoginViewModel.kt†L1-L55】

## 6. Servicios externos y almacenamiento

Los servicios declarados en `ext` proporcionan acceso a recursos externos. `ClientLoginService` realiza una petición HTTP con Ktor a un endpoint de prueba y retorna un `LoginResponse` con el token recibido. `KeyValueStorageService` guarda dicho token usando la librería `Settings` para que sea accesible en todas las plataformas.

```kotlin
class ClientLoginService(val httpClient: HttpClient) : CommLoginService {
    private val logger = LoggerFactory.default.newLogger<ClientLoginService>()
    @OptIn(InternalAPI::class)
    override suspend fun execute(user: String, password: String): LoginResponse {
        val response: LoginResponse =
            httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/login") {
                headers { }
                setBody(LoginRequest(user, password))
            }.body()
        logger.debug { "response body:" + response }
        return response
    }
}
```
【F:app/composeApp/src/commonMain/kotlin/ext/ClientLoginService.kt†L1-L33】

```kotlin
class KeyValueStorageService : CommKeyValueStorage {
    private val settings: Settings by lazy { Settings() }
    private val observableSettings: ObservableSettings by lazy { settings as ObservableSettings }
    override var token: String?
        get() = settings[StorageKeys.TOKEN.key]
        set(value) { settings[StorageKeys.TOKEN.key] = value }
}
```
【F:app/composeApp/src/commonMain/kotlin/ext/KeyValueStorageService.kt†L1-L18】

## 7. Tema y aplicación principal

`App.kt` define el `Scaffold` principal y la barra superior (`AppBar`). Se decide el esquema de colores según el tema claro u oscuro del sistema y se insertan las rutas del `Router` en el contenido.

```kotlin
@Composable
fun App() {
    val logger = LoggerFactory.default.newLogger("ui", "App")
    val router: Router by DIManager.di.instance(arg = rememberNavController())
    val colorScheme = if (!isSystemInDarkTheme()) { lightScheme } else { darkScheme }
    logger.info { "Starting Intrale" }
    MaterialTheme(colorScheme = colorScheme) {
        Scaffold(
            topBar = {
                AppBar(
                    title = router.currentScreen().title,
                    canNavigateBack = router.canNavigateBack(),
                    onClick = { router.navigateUp() }
                )
            }
        ) { innerPadding -> router.routes(innerPadding) }
    }
}
```
【F:app/composeApp/src/commonMain/kotlin/ui/App.kt†L63-L97】

El módulo incluye implementaciones específicas por plataforma, por ejemplo `MainActivity.kt` para Android y `MainViewController.kt` para iOS, que simplemente invocan la función `App()` para renderizar la interfaz en cada entorno.

## 8. Resumen

El frontend de Intrale se organiza en capas bien diferenciadas que separan la lógica de negocio (`asdo`), el acceso a recursos externos (`ext`) y la interfaz de usuario (`ui`). La inyección de dependencias con Kodein facilita reutilizar servicios en todas las plataformas. Compose Multiplatform permite compartir la mayor parte del código, conservando archivos específicos para cada sistema operativo cuando es necesario.

Closes #<ISSUE_NUMBER>
