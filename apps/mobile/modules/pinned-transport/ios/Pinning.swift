import Foundation
import CryptoKit

enum PinningError: Error { case invalidPins, invalidCertificate, wrongPin, invalidRequest, redirect, oversized, failed }

enum Pinning {
  static func validate(_ pins: [String]) throws -> Set<String> {
    let expression = try NSRegularExpression(pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
    guard (1...2).contains(pins.count), Set(pins).count == pins.count,
      pins.allSatisfy({ expression.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil && $0.utf8.count == 43 })
    else { throw PinningError.invalidPins }
    return Set(pins)
  }

  // Extract the complete DER SubjectPublicKeyInfo from TBSCertificate, including
  // its algorithm identifier. SecKeyCopyExternalRepresentation is not SPKI for EC.
  static func spki(_ certificate: Data) throws -> Data {
    let bytes = [UInt8](certificate)
    guard bytes.count <= 65536 else { throw PinningError.invalidCertificate }
    func element(_ offset: Int, _ limit: Int, tag: UInt8? = nil) throws -> (start: Int, body: Int, end: Int) {
      guard offset >= 0, offset + 2 <= limit, limit <= bytes.count,
        bytes[offset] & 0x1f != 0x1f, tag == nil || bytes[offset] == tag else { throw PinningError.invalidCertificate }
      var body = offset + 2
      var length = Int(bytes[offset + 1])
      if length & 0x80 != 0 {
        let count = length & 0x7f
        guard (1...3).contains(count), body + count <= limit, bytes[body] != 0 else { throw PinningError.invalidCertificate }
        length = 0
        for index in body..<(body + count) { length = length * 256 + Int(bytes[index]) }
        body += count
        guard length >= 128 else { throw PinningError.invalidCertificate }
      }
      guard length <= limit - body else { throw PinningError.invalidCertificate }
      return (offset, body, body + length)
    }
    let outer = try element(0, bytes.count, tag: 0x30)
    guard outer.end == bytes.count else { throw PinningError.invalidCertificate }
    let tbs = try element(outer.body, outer.end, tag: 0x30)
    var cursor = tbs.body
    if cursor < tbs.end && bytes[cursor] == 0xa0 { cursor = try element(cursor, tbs.end, tag: 0xa0).end }
    // serialNumber, signature, issuer, validity, subject
    for tag in [UInt8(0x02), 0x30, 0x30, 0x30, 0x30] {
      cursor = try element(cursor, tbs.end, tag: tag).end
    }
    let key = try element(cursor, tbs.end, tag: 0x30)
    let algorithm = try element(key.body, key.end, tag: 0x30)
    let bits = try element(algorithm.end, key.end, tag: 0x03)
    guard bits.end == key.end, bits.body < bits.end, bytes[bits.body] == 0 else { throw PinningError.invalidCertificate }
    return Data(bytes[key.start..<key.end])
  }

  static func fingerprint(_ certificate: Data) throws -> String {
    Data(SHA256.hash(data: try spki(certificate))).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func verify(_ certificate: Data, pins: Set<String>) throws {
    guard pins.contains(try fingerprint(certificate)) else { throw PinningError.wrongPin }
  }
}
