package dev.agentbridge.pinnedtransport

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager
import javax.net.ssl.SSLContext
import java.security.SecureRandom
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionSpec
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okio.ByteString.Companion.toByteString

internal class PinPolicy(pins: List<String>) : X509TrustManager {
  private val accepted: Set<String>
  init {
    require(pins.size in 1..2 && pins.toSet().size == pins.size &&
      pins.all { Regex("^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$").matches(it) }) { "Invalid TLS pin set" }
    accepted = pins.toSet()
  }

  fun matches(leaf: X509Certificate): Boolean {
    // Java PublicKey.encoded is X.509 SubjectPublicKeyInfo DER, not EC raw bytes.
    val spki = leaf.publicKey.encoded ?: return false
    val pin = spki.toByteString().sha256().base64().replace('+', '-').replace('/', '_').trimEnd('=')
    return accepted.contains(pin)
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    if (chain.isNullOrEmpty() || !matches(chain[0])) throw CertificateException("TLS pin mismatch")
    // This enrolled leaf SPKI is the complete trust decision. No CA, hostname or dates.
  }
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("Client trust is unsupported")
  }
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

internal fun pinnedClient(pins: List<String>): OkHttpClient {
  val policy = PinPolicy(pins)
  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(policy), SecureRandom())
  return OkHttpClient.Builder()
    .sslSocketFactory(context.socketFactory, policy)
    .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
    .hostnameVerifier { _, session ->
      try { (session.peerCertificates.firstOrNull() as? X509Certificate)?.let { policy.matches(it) } == true }
      catch (_: Exception) { false }
    }
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .cookieJar(CookieJar.NO_COOKIES).cache(null)
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
    .writeTimeout(10, TimeUnit.SECONDS).callTimeout(10, TimeUnit.SECONDS)
    .addInterceptor { chain ->
      val response = chain.proceed(chain.request())
      if (response.code in 300..399) { response.close(); throw IOException("Pinned gateway redirect refused") }
      response
    }.build()
}
