// Isolated interop evaluation: input contains only synthetic test keys.
import Foundation
import CryptoKit
func unhex(_ s: String) -> Data { var b = [UInt8](); var i=s.startIndex; while i<s.endIndex { let j=s.index(i,offsetBy:2); b.append(UInt8(s[i..<j],radix:16)!); i=j }; return Data(b) }
func hex(_ d:Data)->String { d.map { String(format:"%02x",$0) }.joined() }
let input = try Data(contentsOf: URL(fileURLWithPath:"artifacts/rust-auth-interop-synthetic.json"))
let v = try JSONSerialization.jsonObject(with:input) as! [String:String]
func d(_ k:String)->Data { unhex(v[k]!) }
let skR = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation:d("skR"))
let pkS = try Curve25519.KeyAgreement.PublicKey(rawRepresentation:d("pkS"))
let suite = HPKE.Ciphersuite.Curve25519_SHA256_ChachaPoly
var r = try HPKE.Recipient(privateKey:skR,ciphersuite:suite,info:d("info"),encapsulatedKey:d("enc"),authenticatedBy:pkS)
let pt = try r.open(d("ct"),authenticating:d("aad"))
precondition(pt == d("pt"))
let skS = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation:d("skS"))
var s = try HPKE.Sender(recipientKey:skR.publicKey,ciphersuite:suite,info:d("info"),authenticatedBy:skS)
let ct = try s.seal(pt,authenticating:d("aad"))
let out = ["enc":hex(s.encapsulatedKey), "ct":hex(ct)]
try JSONSerialization.data(withJSONObject:out,options:[.sortedKeys]).write(to:URL(fileURLWithPath:"artifacts/apple-auth-interop-synthetic.json"))
print("Rust Auth sender -> Apple CryptoKit recipient passed; Apple Auth sender synthetic artifact written")
