import Foundation

func requireFailure(_ label: String, _ action: () throws -> Void) {
  do { try action(); fatalError("Expected rejection: \(label)") } catch { }
}

let fixture = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let base64 = fixture.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") }.joined()
let certificate = Data(base64Encoded: base64)!
// Independently calculated using Node X509Certificate.publicKey.export(spki).
let expected = "ivDBRH6Z79K5nKe7ZccYs0zZ18glP7kgfn2u6lG7bVo"
let actual = try Pinning.fingerprint(certificate)
precondition(actual == expected)
try Pinning.verify(certificate, pins: Pinning.validate([expected]))
try Pinning.verify(certificate, pins: Pinning.validate([String(repeating: "A", count: 43), expected]))
requireFailure("wrong leaf key") { try Pinning.verify(certificate, pins: Pinning.validate([String(repeating: "A", count: 43)])) }
requireFailure("empty pins") { _ = try Pinning.validate([]) }
requireFailure("duplicate pins") { _ = try Pinning.validate([expected, expected]) }
requireFailure("noncanonical pins") { _ = try Pinning.validate([String(repeating: "A", count: 42) + "B"]) }
requireFailure("garbage certificate") { _ = try Pinning.spki(Data([0x30, 0x80, 0x00, 0x00])) }
requireFailure("trailing certificate bytes") { _ = try Pinning.spki(certificate + Data([0])) }
for length in 0..<certificate.count {
  requireFailure("truncation \(length)") { _ = try Pinning.spki(certificate.prefix(length)) }
}
print("Swift SPKI policy passed: correct/next pin, wrong pin, canonical pins and \(certificate.count) truncated certificates")
