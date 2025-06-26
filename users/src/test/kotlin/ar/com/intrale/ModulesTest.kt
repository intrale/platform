package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.kodein.di.DI
import org.kodein.di.bind
import net.datafaker.Faker
import org.slf4j.Logger
import ar.com.intrale.Function
import ar.com.intrale.SignUp
import org.kodein.di.instance
import org.kodein.di.singleton
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ModulesTest {
    private val testConfig = UsersConfig(setOf("intrale"), "us-east-1", "key", "secret", "pool", "client")

    private val di = DI {
        import(appModule, allowOverride = true)
        bind<UsersConfig>(overrides = true) { singleton { testConfig } }
        bind<CognitoIdentityProviderClient>(overrides = true) { singleton { CognitoIdentityProviderClient { region = testConfig.region } } }
    }

    @Test
    fun `faker es singleton`() {
        val f1: Faker by di.instance()
        val f2: Faker by di.instance()
        assertEquals(f1, f2)
    }

    @Test
    fun `logger es singleton`() {
        val l1: Logger by di.instance()
        val l2: Logger by di.instance()
        assertEquals(l1, l2)
    }

    @Test
    fun `signup se resuelve`() {
        val signUp: Function by di.instance(tag = "signup")
        assertTrue(signUp is SignUp)
    }
}
