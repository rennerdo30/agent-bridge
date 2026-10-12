package dev.agentbridge.pinnedtransport

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrl

class PinnedRequestOptions : Record {
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
}

class PinnedTransportModule : Module() {
  private val calls = ConcurrentHashMap<String, Call>()
  private val reserved = mutableSetOf<String>()
  private val lock = Any()

  override fun definition() = ModuleDefinition {
    Name("PinnedTransport")
    Function("reserve") { id: String ->
      synchronized(lock) {
        require(calls.size + reserved.size < 128 && !calls.containsKey(id) && !reserved.contains(id))
        reserved.add(id)
      }
    }
    AsyncFunction("request") { url: String, options: PinnedRequestOptions, pins: List<String>, id: String, promise: Promise ->
      try {
        val address = url.toHttpUrl()
        require(address.isHttps && address.username.isEmpty() && address.password.isEmpty() && address.fragment == null)
        require(options.method in setOf("GET", "POST", "DELETE") && (options.method != "GET" || options.body == null))
        require((options.body?.toByteArray(Charsets.UTF_8)?.size ?: 0) <= 32768)
        // Each request has a fresh connection pool and pin policy. A previously
        // authenticated pooled socket must never escape a changed device pin set.
        val client = pinnedClient(pins)
        val builder = Request.Builder().url(address)
        options.headers.forEach { (name, value) ->
          require(name.lowercase() !in setOf("cookie", "host", "connection", "proxy-authorization"))
          builder.header(name, value)
        }
        builder.header("Cache-Control", "no-store")
        val body = options.body?.toRequestBody(null)
        builder.method(options.method, if (options.method == "POST") body ?: "".toRequestBody(null) else body)
        val call = client.newCall(builder.build())
        val stopped = synchronized(lock) {
          val stopped = !reserved.remove(id) || calls.containsKey(id)
          if (!stopped) calls[id] = call
          stopped
        }
        if (stopped) {
          client.dispatcher.executorService.shutdown()
          promise.reject("ERR_PINNED_TRANSPORT", "Pinned gateway request cancelled", null)
        } else {
          call.enqueue(object : Callback {
            private fun cleanup() {
              calls.remove(id, call)
              client.connectionPool.evictAll()
              client.dispatcher.executorService.shutdown()
            }
            override fun onFailure(call: Call, error: IOException) {
              cleanup()
              promise.reject("ERR_PINNED_TRANSPORT", "Pinned gateway request failed", null)
            }
            override fun onResponse(call: Call, response: Response) {
              try {
                response.use {
                  require(response.code !in 300..399 && response.request.url == address)
                  val stream = response.body ?: throw IOException("Missing response")
                  require(stream.contentLength() <= 524288)
                  val buffer = ByteArrayOutputStream()
                  stream.byteStream().use { input ->
                    val chunk = ByteArray(8192)
                    while (true) {
                      val count = input.read(chunk)
                      if (count < 0) break
                      require(buffer.size() + count <= 524288)
                      buffer.write(chunk, 0, count)
                    }
                  }
                  val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(buffer.toByteArray())).toString()
                  val headers = response.headers.names().associateWith { response.headers.values(it).joinToString(", ") }
                  promise.resolve(mapOf("status" to response.code, "headers" to headers, "body" to text, "url" to address.toString()))
                }
              } catch (_: Exception) { promise.reject("ERR_PINNED_TRANSPORT", "Pinned gateway response refused", null) }
              finally { cleanup() }
            }
          })
        }
      } catch (_: Exception) {
        synchronized(lock) { reserved.remove(id) }
        promise.reject("ERR_PINNED_TRANSPORT", "Invalid pinned gateway request", null)
      }
    }
    Function("cancel") { id: String ->
      val call = synchronized(lock) {
        val call = calls[id]
        reserved.remove(id)
        call
      }
      call?.cancel()
    }
    OnDestroy { synchronized(lock) { reserved.clear() }; calls.values.forEach { it.cancel() } }
  }
}
