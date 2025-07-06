import ar.com.intrale.Business
import ar.com.intrale.BusinessState
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import kotlin.test.Test
import kotlin.test.assertEquals
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import kotlin.test.assertNotNull
import kotlin.reflect.full.findAnnotation

class BusinessTest {
    @Test
    fun defaultStateIsPending() {
        val business = Business()
        assertEquals(BusinessState.PENDING, business.state)
        assertEquals(false, business.autoAcceptDeliveries)
    }

    @Test
    fun propertiesCanBeAssigned() {
        val business = Business()
        business.name = "Biz"
        business.emailAdmin = "admin@biz.com"
        business.description = "desc"
        business.state = BusinessState.APPROVED
        business.autoAcceptDeliveries = true

        assertEquals("Biz", business.name)
        assertEquals("admin@biz.com", business.emailAdmin)
        assertEquals("desc", business.description)
        assertEquals(BusinessState.APPROVED, business.state)
        assertEquals(true, business.autoAcceptDeliveries)
    }

    @Test
    fun hasDynamoDbBeanAnnotation() {
        val annotation = Business::class.java.getAnnotation(DynamoDbBean::class.java)
        assertEquals(true, annotation != null)
    }

    @Test
    fun namePropertyIsPartitionKey() {
        val getter = Business::class.java.getMethod("getName")
        val annotation = getter.getAnnotation(DynamoDbPartitionKey::class.java)
        assertEquals(true, annotation != null)
    }
    
    @Test
    fun namePropertyHasPartitionKeyAnnotation() {
        val annotation = Business::name.getter.findAnnotation<DynamoDbPartitionKey>()
        assertNotNull(annotation)
    }
}
