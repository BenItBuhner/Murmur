package app.murmur.android.cloud

import android.content.Context
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.network.serialization.onFailure
import com.clerk.api.network.serialization.onSuccess
import com.clerk.api.session.GetTokenOptions
import dev.convex.android.AuthProvider
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

data class ClerkCredentials(val userId: String, val email: String?, val name: String?, val token: String)

/**
 * Bridges the Clerk Android SDK into Convex's [AuthProvider]. Sign-in itself happens in the UI
 * (Clerk's AuthView); this provider only turns the resulting session into Convex JWTs minted from
 * the `convex` JWT template, and hands out a fresh one whenever the Rust client asks for a refresh.
 */
class ClerkAuthProvider : AuthProvider<ClerkCredentials> {
    override suspend fun login(context: Context, onIdToken: (String?) -> Unit): Result<ClerkCredentials> {
        Clerk.userFlow.filterNotNull().first()
        return fetch(skipCache = false)
    }

    override suspend fun loginFromCache(onIdToken: (String?) -> Unit): Result<ClerkCredentials> =
        fetch(skipCache = true)

    override suspend fun logout(context: Context): Result<Void?> {
        var failure: String? = null
        Clerk.auth.signOut().onFailure { failure = it.errorMessage }
        return if (failure == null) Result.success(null) else Result.failure(IllegalStateException(failure))
    }

    override fun extractIdToken(authResult: ClerkCredentials): String = authResult.token

    private suspend fun fetch(skipCache: Boolean): Result<ClerkCredentials> {
        val user = Clerk.userFlow.value ?: return Result.failure(IllegalStateException("Not signed in"))
        var token: String? = null
        var error: String? = null
        Clerk.auth.getToken(GetTokenOptions(template = CloudConfig.JWT_TEMPLATE, skipCache = skipCache))
            .onSuccess { token = it }
            .onFailure { error = it.errorMessage }
        val jwt = token ?: return Result.failure(IllegalStateException(error ?: "Could not get a session token"))
        val name = listOfNotNull(user.firstName, user.lastName).joinToString(" ").trim().ifEmpty { null }
        return Result.success(
            ClerkCredentials(
                userId = user.id,
                email = user.primaryEmailAddress?.emailAddress,
                name = name,
                token = jwt
            )
        )
    }
}
