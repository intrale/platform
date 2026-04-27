package ext.business

import android.content.Context

/**
 * Holder estatico del Application Context para targets Android.
 *
 * Inicializado por `MainActivity.onCreate(...)`. Usado por implementaciones
 * Android que necesitan Context fuera de Compose (ej. AndroidDeliveryZonesCache
 * con DataStore en #2420 split 1).
 *
 * NO usar para servicios UI — esos deben usar `LocalContext.current` desde un
 * Composable. Este holder existe solo para servicios de larga vida que se
 * instancian en DI.
 */
object AppContextHolder {

    @Volatile
    private var appContext: Context? = null

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    fun requireContext(): Context = appContext
        ?: error("AppContextHolder no fue inicializado. Llama a init(applicationContext) en MainActivity.onCreate()")
}
