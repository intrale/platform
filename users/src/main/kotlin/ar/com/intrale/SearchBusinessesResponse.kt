package ar.com.intrale

class SearchBusinessesResponse(
    val businesses: Array<BusinessDTO>,
    val lastKey: String? = null
) : Response()
