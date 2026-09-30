package app.murmur.android.cloud

import android.content.Context
import android.util.Log
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.network.serialization.onFailure
import com.clerk.api.network.serialization.onSuccess
import com.clerk.api.session.GetTokenOptions
import dev.convex.android.AuthProvider
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

data class ClerkCredentials(val userId: String, val email: String?, val name: String?, val token: String)

/** How long a Clerk call (a session token, a sign-out) may take before it counts as failed. */
const val CLERK_CALL_TIMEOUT_MS = 15_000L

/**
 * A session token from Clerk, or an explanation: null with [error] set when nobody is signed in,
 * when Clerk answers with an error, when it does not answer within [CLERK_CALL_TIMEOUT_MS], or when
 * the cloud never came up (its classes may then not even load, so Clerk is not touched at all).
 */
private class TokenAnswer(val token: String?, val error: String?)

private suspend fun clerkToken(skipCache: Boolean, timeoutMs: Long): TokenAnswer {
    if (!CloudBootstrap.state.value.usable) return TokenAnswer(null, "Murmur's server is not connected")
    return try {
        withTimeoutOrNull(timeoutMs) {
            if (Clerk.userFlow.value == null) return@withTimeoutOrNull TokenAnswer(null, "Not signed in")
            var token: String? = null
            var error: String? = null
            Clerk.auth.getToken(GetTokenOptions(template = CloudConfig.JWT_TEMPLATE, skipCache = skipCache))
                .onSuccess { token = it }
                .onFailure { error = it.errorMessage }
            TokenAnswer(token, if (token == null) error ?: "Could not get a session token" else null)
        } ?: TokenAnswer(null, "Timed out getting a session token")
    } catch (e: Throwable) {
        // Anything Clerk throws (including an Error from a static initialiser) stays here.
        if (e is kotlinx.coroutines.CancellationException) throw e
        Log.w("MurmurCloud", "getting a session token failed", e)
        TokenAnswer(null, CloudBootstrap.describe(e))
    }
}

/** Session tokens for callers outside the Convex client, such as the managed-inference gateway. */
object ClerkTokens {
    /**
     * A Convex JWT for the signed-in account, or null when nobody is signed in, Clerk cannot mint
     * one, or does not answer in time. Never throws and never waits longer than [timeoutMs], so the
     * dictation service cannot hang on it.
     */
    suspend fun sessionToken(skipCache: Boolean, timeoutMs: Long = CLERK_CALL_TIMEOUT_MS): String? {
        val answer = clerkToken(skipCache, timeoutMs)
        if (answer.token == null && answer.error != "Not signed in") {
            Log.w("MurmurCloud", "could not get a session token: ${answer.error}")
        }
        return answer.token
    }
}

/**
 * Bridges the Clerk Android SDK into Convex's [AuthProvider]. Sign-in itself happens in the UI
 * (Clerk's AuthView); this provider only turns the resulting session into Convex JWTs minted from
 * the `convex` JWT template, and hands out a fresh one whenever the Rust client asks for a refresh.
 */
class ClerkAuthProvider(private val timeoutMs: Long = CLERK_CALL_TIMEOUT_MS) : AuthProvider<ClerkCredentials> {
    override suspend fun login(context: Context, onIdToken: (String?) -> Unit): Result<ClerkCredentials> {
        Clerk.userFlow.filterNotNull().first()
        return fetch(skipCache = false)
    }

    override suspend fun loginFromCache(onIdToken: (String?) -> Unit): Result<ClerkCredentials> =
        fetch(skipCache = true)

    override suspend fun logout(context: Context): Result<Void?> {
        var failure: String? = null
        val finished = try {
            withTimeoutOrNull(timeoutMs) {
                Clerk.auth.signOut().onFailure { failure = it.errorMessage }
            }
        } catch (e: Throwable) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            failure = CloudBootstrap.describe(e)
            Unit
        }
        if (finished == null) failure = "Timed out signing out"
        return if (failure == null) Result.success(null) else Result.failure(IllegalStateException(failure))
    }

    override fun extractIdToken(authResult: ClerkCredentials): String = authResult.token

    private suspend fun fetch(skipCache: Boolean): Result<ClerkCredentials> {
        val user = try {
            Clerk.userFlow.value
        } catch (e: Throwable) {
            return Result.failure(IllegalStateException(CloudBootstrap.describe(e), e))
        } ?: return Result.failure(IllegalStateException("Not signed in"))
        val answer = clerkToken(skipCache, timeoutMs)
        val jwt = answer.token ?: return Result.failure(IllegalStateException(answer.error ?: "Could not get a session token"))
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
