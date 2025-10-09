package ext.storage

import com.russhwolf.settings.ObservableSettings
import com.russhwolf.settings.Settings
import com.russhwolf.settings.get
import com.russhwolf.settings.remove
import com.russhwolf.settings.set
import com.russhwolf.settings.remove

class KeyValueStorageService : CommKeyValueStorage {
    private val settings: Settings by lazy { Settings() }
    private val observableSettings: ObservableSettings by lazy { settings as ObservableSettings }

    override var token: String?
        get() = settings[StorageKeys.TOKEN.key]
        set(value) {
            settings[StorageKeys.TOKEN.key] = value
        }

    override var brandingTheme: String?
        get() = settings[StorageKeys.BRANDING_THEME.key]
        set(value) {
            if (value == null) {
                settings.remove(StorageKeys.BRANDING_THEME.key)
            } else {
                settings[StorageKeys.BRANDING_THEME.key] = value
            }
        }

}

enum class StorageKeys {
    TOKEN,
    LOGIN_INFO,
    BRANDING_THEME;

    val key get() = this.name
}