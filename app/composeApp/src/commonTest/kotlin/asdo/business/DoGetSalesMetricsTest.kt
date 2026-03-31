package asdo.business

import ar.com.intrale.shared.business.DailySalesMetricsDTO
import ext.business.CommGetSalesMetricsService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeSalesMetricsService(
    private val result: Result<DailySalesMetricsDTO> = Result.success(DailySalesMetricsDTO())
) : CommGetSalesMetricsService {
    override suspend fun execute(businessId: String): Result<DailySalesMetricsDTO> = result
}

class DoGetSalesMetricsTest {

    @Test
    fun executeReturnsMetricsOnSuccess() = runTest {
        val expected = DailySalesMetricsDTO(
            orderCount = 5,
            totalRevenue = 10000.0,
            averageTicket = 2000.0,
            previousDayOrderCount = 3,
            previousDayRevenue = 6000.0,
            revenueChangePercent = 66.67,
            orderCountChangePercent = 66.67,
            topProductName = "Empanadas",
            topProductQuantity = 12
        )
        val service = FakeSalesMetricsService(Result.success(expected))
        val doGetSalesMetrics = DoGetSalesMetrics(service)

        val result = doGetSalesMetrics.execute("business-1")

        assertTrue(result.isSuccess)
        assertEquals(expected, result.getOrNull())
    }

    @Test
    fun executeReturnsFailureOnError() = runTest {
        val exception = RuntimeException("Network error")
        val service = FakeSalesMetricsService(Result.failure(exception))
        val doGetSalesMetrics = DoGetSalesMetrics(service)

        val result = doGetSalesMetrics.execute("business-1")

        assertTrue(result.isFailure)
        assertEquals("Network error", result.exceptionOrNull()?.message)
    }

    @Test
    fun executeReturnsEmptyMetricsWhenNoSales() = runTest {
        val emptyMetrics = DailySalesMetricsDTO()
        val service = FakeSalesMetricsService(Result.success(emptyMetrics))
        val doGetSalesMetrics = DoGetSalesMetrics(service)

        val result = doGetSalesMetrics.execute("business-1")

        assertTrue(result.isSuccess)
        val metrics = result.getOrNull()!!
        assertEquals(0, metrics.orderCount)
        assertEquals(0.0, metrics.totalRevenue)
        assertEquals(0.0, metrics.averageTicket)
    }

    @Test
    fun executePassesCorrectBusinessId() = runTest {
        var capturedBusinessId: String? = null
        val service = object : CommGetSalesMetricsService {
            override suspend fun execute(businessId: String): Result<DailySalesMetricsDTO> {
                capturedBusinessId = businessId
                return Result.success(DailySalesMetricsDTO())
            }
        }
        val doGetSalesMetrics = DoGetSalesMetrics(service)

        doGetSalesMetrics.execute("mi-negocio-123")

        assertEquals("mi-negocio-123", capturedBusinessId)
    }
}
