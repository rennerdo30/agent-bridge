package dev.agentbridge.pinnedtransport

import java.io.IOException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.util.Base64
import javax.net.ssl.SSLHandshakeException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class PinPolicyTest {
  private fun certificate() = HeldCertificate.Builder().ecdsa256().commonName("fixture")
    .addSubjectAlternativeName("different-host.example").build()
  private fun pin(cert: HeldCertificate) = Base64.getUrlEncoder().withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.certificate.publicKey.encoded))
  private fun server(cert: HeldCertificate) = MockWebServer().apply {
    useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
    start()
  }
  private fun close(client: OkHttpClient) { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

  @Test fun hashesSpkiAndAcceptsOnlyLeaf() {
    val first = certificate(); val other = certificate(); val policy = PinPolicy(listOf(pin(first)))
    policy.checkServerTrusted(arrayOf(first.certificate), "EC")
    assertTrue(policy.matches(first.certificate)); assertFalse(policy.matches(other.certificate))
    assertThrows(CertificateException::class.java) { policy.checkServerTrusted(arrayOf(other.certificate, first.certificate), "EC") }
    assertThrows(CertificateException::class.java) { policy.checkServerTrusted(emptyArray(), "EC") }
    assertThrows(IllegalArgumentException::class.java) { PinPolicy(emptyList()) }
    assertThrows(IllegalArgumentException::class.java) { PinPolicy(listOf("malformed")) }
  }

  @Test fun selfSignedAndWrongHostnameReadSucceeds() {
    val cert = certificate(); val gateway = server(cert); val client = pinnedClient(listOf(pin(cert)))
    try {
      gateway.enqueue(MockResponse().setBody("pinned read"))
      client.newCall(Request.Builder().url(gateway.url("/hello")).build()).execute().use {
        assertEquals(200, it.code); assertEquals("pinned read", it.body!!.string())
      }
    } finally { close(client); gateway.shutdown() }
  }

  @Test fun differentKeyFailsBeforeHttp() {
    val gateway = server(certificate()); val client = pinnedClient(listOf(pin(certificate())))
    try {
      gateway.enqueue(MockResponse().setBody("must not read"))
      assertThrows(SSLHandshakeException::class.java) { client.newCall(Request.Builder().url(gateway.url("/hello")).build()).execute() }
      assertEquals(0, gateway.requestCount)
    } finally { close(client); gateway.shutdown() }
  }

  @Test fun nextPinAcceptsRotationWithoutUnpinnedTrust() {
    val current = certificate(); val next = certificate(); val gateway = server(next)
    val client = pinnedClient(listOf(pin(current), pin(next)))
    try {
      gateway.enqueue(MockResponse().setBody("next key"))
      client.newCall(Request.Builder().url(gateway.url("/hello")).build()).execute().use { assertEquals("next key", it.body!!.string()) }
    } finally { close(client); gateway.shutdown() }
  }

  @Test fun datesDoNotReplaceTheEnrolledKeyDecision() {
    val now = System.currentTimeMillis()
    val cert = HeldCertificate.Builder().ecdsa256().commonName("expired-fixture")
      .validityInterval(now - 172800000, now - 86400000).build()
    val gateway = server(cert); val client = pinnedClient(listOf(pin(cert)))
    try {
      gateway.enqueue(MockResponse().setBody("enrolled key"))
      client.newCall(Request.Builder().url(gateway.url("/hello")).build()).execute().use { assertEquals("enrolled key", it.body!!.string()) }
    } finally { close(client); gateway.shutdown() }
  }

  @Test fun redirectRefusedAndTargetNeverReceivesCredentials() {
    val cert = certificate(); val gateway = server(cert); val target = server(cert); val client = pinnedClient(listOf(pin(cert)))
    try {
      gateway.enqueue(MockResponse().setResponseCode(302).setHeader("Location", target.url("/leak")))
      assertThrows(IOException::class.java) { client.newCall(Request.Builder().url(gateway.url("/hello"))
        .header("Authorization", "Bearer fixture").build()).execute() }
      assertEquals(1, gateway.requestCount); assertEquals(0, target.requestCount)
    } finally { close(client); gateway.shutdown(); target.shutdown() }
  }

  @Test fun plainHttpFailsBeforeRequest() {
    val gateway = MockWebServer(); gateway.start(); val client = pinnedClient(listOf(pin(certificate())))
    try {
      assertThrows(IOException::class.java) { client.newCall(Request.Builder().url(gateway.url("/hello")).build()).execute() }
      assertEquals(0, gateway.requestCount)
    } finally { close(client); gateway.shutdown() }
  }
}
