package ar.com.intrale

import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class ProfilesTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val profiles = Profiles(config, logger)

    @Test
    fun returnsAllProfiles() = runBlocking {
        val response = profiles.securedExecute("biz", "profiles", emptyMap(), "") as ProfilesResponse
        val names = response.profiles.map { it.name }
        assertEquals(listOf(
            PROFILE_PLATFORM_ADMIN,
            PROFILE_BUSINESS_ADMIN,
            PROFILE_DELIVERY,
            PROFILE_SALER,
            PROFILE_CLIENT
        ), names)
    }
}
