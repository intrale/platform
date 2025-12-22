package ar.com.intrale.appconfig

import ar.com.intrale.BuildKonfig

enum class AppType {
    CLIENT,
    BUSINESS,
    UNKNOWN;

    companion object {
        fun fromValue(raw: String): AppType = when {
            raw.equals(CLIENT.name, ignoreCase = true) -> CLIENT
            raw.equals(BUSINESS.name, ignoreCase = true) -> BUSINESS
            else -> UNKNOWN
        }
    }
}

object AppRuntimeConfig {
    val appType: AppType
        get() = AppType.fromValue(BuildKonfig.APP_TYPE)

    val isClient: Boolean
        get() = appType == AppType.CLIENT

    val isBusiness: Boolean
        get() = appType == AppType.BUSINESS
}
