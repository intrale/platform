package notifications

class BrandingFirebaseService {
    fun handleNewToken(token: String, onTokenReady: (String) -> Unit) {
        onTokenReady(token)
    }

    fun simulateMessage(onBrandingUpdate: () -> Unit) {
        onBrandingUpdate()
    }
}
