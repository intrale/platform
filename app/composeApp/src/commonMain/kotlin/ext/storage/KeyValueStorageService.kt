package ext.storage

import com.russhwolf.settings.Settings
import ext.storage.model.ClientProfileCache
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class KeyValueStorageService : CommKeyValueStorage {
    private val settings: Settings by lazy { Settings() }

    override var token: String?
        get() = settings.getStringOrNull(StorageKeys.TOKEN.key)
        set(value) {
            if (value == null) {
                settings.remove(StorageKeys.TOKEN.key)
            } else {
                settings.putString(StorageKeys.TOKEN.key, value)
            }
        }

    override var profileCache: ClientProfileCache?
        get() = settings.getStringOrNull(StorageKeys.LOGIN_INFO.key)?.let { raw ->
            runCatching { Json.decodeFromString(ClientProfileCache.serializer(), raw) }.getOrNull()
        }
        set(value) {
            if (value == null) {
                settings.remove(StorageKeys.LOGIN_INFO.key)
            } else {
                settings.putString(StorageKeys.LOGIN_INFO.key, Json.encodeToString(value))
            }
        }

    override var preferredLanguage: String?
        get() = settings.getStringOrNull(StorageKeys.PREFERRED_LANGUAGE.key) ?: profileCache?.preferredLanguage
        set(value) {
            if (value.isNullOrBlank()) {
                settings.remove(StorageKeys.PREFERRED_LANGUAGE.key)
            } else {
                settings.putString(StorageKeys.PREFERRED_LANGUAGE.key, value)
            }
            profileCache = profileCache?.copy(preferredLanguage = value) ?: ClientProfileCache(preferredLanguage = value)
        }

    override var onboardingCompleted: Boolean
        get() = settings.getBoolean(StorageKeys.ONBOARDING_COMPLETED.key, false)
        set(value) {
            settings.putBoolean(StorageKeys.ONBOARDING_COMPLETED.key, value)
        }

}

enum class StorageKeys {
    TOKEN,
    LOGIN_INFO,
    PREFERRED_LANGUAGE,
    ONBOARDING_COMPLETED;

    val key get() = this.name
}
