package ext

import java.util.Properties

actual fun getBaseUrl(): String {
    val props = Properties()
    val stream = ClassLoader.getSystemResourceAsStream("application.properties")
    stream.use { props.load(it) }
    return props.getProperty("baseUrl")
}
