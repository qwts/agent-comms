// Isolated interop evaluation: input contains only synthetic test keys.
import Foundation
import CryptoKit
enum FixtureError: Error {
    case oddHexLength
    case invalidHex
    case missingField(String)
}
func unhex(_ s: String) throws -> Data {
    let chars = Array(s.utf8)
    guard chars.count.isMultiple(of: 2) else { throw FixtureError.oddHexLength }
    func nibble(_ c: UInt8) throws -> UInt8 {
        switch c {
        case 48...57: return c - 48
        case 65...70: return c - 65 + 10
        case 97...102: return c - 97 + 10
        default: throw FixtureError.invalidHex
        }
    }
    var bytes = [UInt8]()
    for i in stride(from: 0, to: chars.count, by: 2) {
        bytes.append(try (nibble(chars[i]) << 4) | nibble(chars[i + 1]))
    }
    return Data(bytes)
}
func hex(_ d:Data)->String { d.map { String(format:"%02x",$0) }.joined() }
let input = try Data(contentsOf: URL(fileURLWithPath:"artifacts/rust-auth-interop-synthetic.json"))
let v = try JSONSerialization.jsonObject(with:input) as! [String:String]
func d(_ k:String) throws -> Data {
    guard let value = v[k] else { throw FixtureError.missingField(k) }
    return try unhex(value)
}
let skR = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation:d("skR"))
let pkS = try Curve25519.KeyAgreement.PublicKey(rawRepresentation:d("pkS"))
let suite = HPKE.Ciphersuite.Curve25519_SHA256_ChachaPoly
var r = try HPKE.Recipient(privateKey:skR,ciphersuite:suite,info:d("info"),encapsulatedKey:d("enc"),authenticatedBy:pkS)
let pt = try r.open(d("ct"),authenticating:d("aad"))
let expectedPlaintext = try d("pt")
precondition(pt == expectedPlaintext)
let skS = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation:d("skS"))
var s = try HPKE.Sender(recipientKey:skR.publicKey,ciphersuite:suite,info:d("info"),authenticatedBy:skS)
let ct = try s.seal(pt,authenticating:d("aad"))
let out = ["enc":hex(s.encapsulatedKey), "ct":hex(ct)]
try JSONSerialization.data(withJSONObject:out,options:[.sortedKeys]).write(to:URL(fileURLWithPath:"artifacts/apple-auth-interop-synthetic.json"))
print("Rust Auth sender -> Apple CryptoKit recipient passed; Apple Auth sender synthetic artifact written")
