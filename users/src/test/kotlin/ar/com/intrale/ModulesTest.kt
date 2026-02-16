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
    private val testConfig = testConfig("intrale")

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

    //TODO: El binding de "signup" requiere DynamoDbTable<User> y DynamoDbTable<UserBusinessProfile>
    // que se resuelven via DynamoDbClient real (necesita credenciales AWS). Para habilitar este test
    // hay que: 1) Extraer las tablas como interfaces mockeables, o 2) Agregar overrides de DummyTable
    // en el DI de test para las 3 tablas (Business, User, UserBusinessProfile).
    /*@Test
    fun `signup se resuelve`() {
        val signUp: Function by di.instance(tag = "signup")
        assertTrue(signUp is SignUp)
    }*/
}
