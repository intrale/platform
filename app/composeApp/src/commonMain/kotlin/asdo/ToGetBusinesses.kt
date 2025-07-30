package asdo

import ext.SearchBusinessesResponse

interface ToGetBusinesses { suspend fun execute(query: String): Result<SearchBusinessesResponse> }
