package ar.com.intrale

import net.datafaker.Faker
import org.slf4j.Logger

const val PROFILE_PLATFORM_ADMIN = "PlatformAdmin"

const val PROFILE_BUSINESS_ADMIN = "BusinessAdmin"

const val PROFILE_DELIVERY = "Delivery"

const val PROFILE_SALER = "Saler"

const val PROFILE_CLIENT = "Client"

class Profiles(override val config: UsersConfig, override val logger: Logger) :
    SecuredFunction(config=config, logger=logger ) {
    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        return ProfilesResponse(profiles = arrayOf(
            Profile(PROFILE_PLATFORM_ADMIN),
            Profile(PROFILE_BUSINESS_ADMIN),
            Profile(PROFILE_DELIVERY),
            Profile(PROFILE_SALER),
            Profile(PROFILE_CLIENT)
        ))
    }
}