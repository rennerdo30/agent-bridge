import ExpoModulesCore
import Foundation
import Security

struct PinnedRequestOptions: Record {
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String? = nil
}

public final class PinnedTransportModule: Module {
  private let lock = NSLock()
  private var requests: [String: PinnedRequest] = [:]
  private var reserved = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("PinnedTransport")
    Function("reserve") { (id: String) in
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.requests.count + self.reserved.count < 128,
        self.requests[id] == nil, !self.reserved.contains(id) else { throw PinningError.invalidRequest }
      self.reserved.insert(id)
    }
    AsyncFunction("request") { (url: String, options: PinnedRequestOptions, pins: [String], id: String, promise: Promise) in
      do {
        let request = try PinnedRequest(url: url, options: options, pins: pins) { [weak self] result in
          if let self = self { self.lock.lock(); self.requests.removeValue(forKey: id); self.lock.unlock() }
          switch result {
          case .success(let response): promise.resolve(response)
          case .failure: promise.reject("ERR_PINNED_TRANSPORT", "Pinned gateway request failed")
          }
        }
        self.lock.lock()
        let wasCancelled = self.reserved.remove(id) == nil
        let duplicate = self.requests[id] != nil
        if !wasCancelled && !duplicate { self.requests[id] = request }
        self.lock.unlock()
        if wasCancelled || duplicate { promise.reject("ERR_PINNED_TRANSPORT", "Pinned gateway request cancelled") }
        else { request.start() }
      } catch {
        self.lock.lock(); self.reserved.remove(id); self.lock.unlock()
        promise.reject("ERR_PINNED_TRANSPORT", "Invalid pinned gateway request")
      }
    }
    Function("cancel") { (id: String) in
      self.lock.lock()
      let request = self.requests[id]
      self.reserved.remove(id)
      self.lock.unlock()
      request?.cancel()
    }
    OnDestroy {
      self.lock.lock(); let active = Array(self.requests.values); self.reserved.removeAll(); self.lock.unlock()
      active.forEach { $0.cancel() }
    }
  }
}

private final class PinnedRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let pins: Set<String>
  private let request: URLRequest
  private let completion: (Result<[String: Any], Error>) -> Void
  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var completed = false
  private var data = Data()
  private var response: HTTPURLResponse?
  private var authenticated = false

  init(url: String, options: PinnedRequestOptions, pins: [String], completion: @escaping (Result<[String: Any], Error>) -> Void) throws {
    self.pins = try Pinning.validate(pins)
    guard let address = URL(string: url), address.scheme == "https", address.host != nil,
      address.user == nil, address.password == nil, address.fragment == nil,
      ["GET", "POST", "PUT", "DELETE"].contains(options.method),
      options.method != "GET" || options.body == nil,
      (options.body?.utf8.count ?? 0) <= 32768 else { throw PinningError.invalidRequest }
    var nativeRequest = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    nativeRequest.httpMethod = options.method
    for (name, value) in options.headers {
      guard !["cookie", "host", "connection", "proxy-authorization"].contains(name.lowercased()),
        !name.contains("\r"), !name.contains("\n"), !value.contains("\r"), !value.contains("\n") else { throw PinningError.invalidRequest }
      nativeRequest.setValue(value, forHTTPHeaderField: name)
    }
    nativeRequest.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    nativeRequest.httpShouldHandleCookies = false
    nativeRequest.httpBody = options.body?.data(using: .utf8)
    self.request = nativeRequest
    self.completion = completion
  }

  func start() {
    lock.lock()
    guard !completed else { lock.unlock(); return }
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false
    config.urlCache = nil; config.urlCredentialStorage = nil
    config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 10
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.tlsMinimumSupportedProtocolVersion = .TLSv12
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.dataTask(with: request)
    self.task = task
    task.resume()
    lock.unlock()
  }

  func cancel() { finish(.failure(PinningError.failed)) }

  private func finish(_ result: Result<[String: Any], Error>) {
    lock.lock()
    guard !completed else { lock.unlock(); return }
    completed = true
    let session = self.session; self.session = nil
    lock.unlock()
    session?.invalidateAndCancel()
    completion(result)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let leaf = SecTrustGetCertificateAtIndex(trust, 0) else {
      completionHandler(.cancelAuthenticationChallenge, nil); finish(.failure(PinningError.wrongPin)); return
    }
    do {
      try Pinning.verify(SecCertificateCopyData(leaf) as Data, pins: pins)
      authenticated = true
      // The enrolled leaf SPKI is the entire trust decision, by owner policy.
      // Deliberately do not evaluate chain, certificate dates, or hostname.
      completionHandler(.useCredential, URLCredential(trust: trust))
    } catch {
      completionHandler(.cancelAuthenticationChallenge, nil); finish(.failure(PinningError.wrongPin))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
    finish(.failure(PinningError.redirect))
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard authenticated, let http = response as? HTTPURLResponse,
      http.url == request.url, !(300..<400).contains(http.statusCode),
      response.expectedContentLength <= 524288 else {
      completionHandler(.cancel); finish(.failure(PinningError.failed)); return
    }
    self.response = http
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard self.data.count + data.count <= 524288 else { finish(.failure(PinningError.oversized)); return }
    self.data.append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard error == nil, authenticated, let response = response,
      let body = String(data: data, encoding: .utf8), let url = response.url else { finish(.failure(PinningError.failed)); return }
    var headers: [String: String] = [:]
    for (key, value) in response.allHeaderFields { headers[String(describing: key)] = String(describing: value) }
    finish(.success(["status": response.statusCode, "headers": headers, "body": body, "url": url.absoluteString]))
  }
}
