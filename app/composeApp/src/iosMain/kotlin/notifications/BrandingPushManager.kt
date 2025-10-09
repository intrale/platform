package notifications

class BrandingPushManager {
    fun register(onTokenAvailable: (String) -> Unit) {
        onTokenAvailable("ios-placeholder-token")
    }
}
