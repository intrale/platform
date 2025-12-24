package ext.storage

import com.russhwolf.settings.ObservableSettings
import com.russhwolf.settings.Settings
import com.russhwolf.settings.get
import com.russhwolf.settings.remove
import com.russhwolf.settings.set
import ext.storage.model.ClientProfileCache
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class KeyValueStorageService : CommKeyValueStorage {
    private val settings: Settings by lazy { Settings() }
    private val observableSettings: ObservableSettings by lazy { settings as ObservableSettings }

    override var token: String?
        get() = settings[StorageKeys.TOKEN.key]
        set(value) {
            settings[StorageKeys.TOKEN.key] = value
        }

    override var profileCache: ClientProfileCache?
        get() = settings[StorageKeys.LOGIN_INFO.key]?.let { raw ->
            runCatching { Json.decodeFromString(ClientProfileCache.serializer(), raw) }.getOrNull()
        }
        set(value) {
            if (value == null) {
                settings.remove(StorageKeys.LOGIN_INFO.key)
            } else {
                settings[StorageKeys.LOGIN_INFO.key] = Json.encodeToString(value)
            }
        }

    override var preferredLanguage: String?
        get() = settings[StorageKeys.PREFERRED_LANGUAGE.key] ?: profileCache?.preferredLanguage
        set(value) {
            if (value.isNullOrBlank()) {
                settings.remove(StorageKeys.PREFERRED_LANGUAGE.key)
            } else {
                settings[StorageKeys.PREFERRED_LANGUAGE.key] = value
            }
            profileCache = profileCache?.copy(preferredLanguage = value) ?: ClientProfileCache(preferredLanguage = value)
        }

}

enum class StorageKeys {
    TOKEN,
    LOGIN_INFO,
    PREFERRED_LANGUAGE;

    val key get() = this.name
}
