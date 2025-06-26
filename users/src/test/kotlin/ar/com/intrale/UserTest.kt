package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.reflect.full.findAnnotation
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

class UserTest {
    @Test
    fun `default values and setters work`() {
        val user = User()
        user.email = "mail@test.com"
        user.name = "Name"
        user.familyName = "Last"
        user.secret = "secret"
        user.enabled = true

        assertEquals("mail@test.com", user.email)
        assertEquals("Name", user.name)
        assertEquals("Last", user.familyName)
        assertEquals("secret", user.secret)
        assertEquals(true, user.enabled)
    }

    @Test
    fun `initial values are null or false`() {
        val user = User()
        assertNull(user.email)
        assertNull(user.name)
        assertNull(user.familyName)
        assertNull(user.secret)
        assertFalse(user.enabled)
    }

    @Test
    fun `email property has partition key annotation`() {
        val annotation = User::email.getter.findAnnotation<DynamoDbPartitionKey>()
        assertNotNull(annotation)
    }
}
