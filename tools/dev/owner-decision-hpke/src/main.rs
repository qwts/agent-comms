// Isolated evaluation only. All key material is synthetic or public RFC vectors.
use hpke::{Deserializable, Serializable, Kem as KemTrait, OpModeR, OpModeS};
use hpke::{aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256};
use serde_json::{Value, json};
type Kem = X25519HkdfSha256;
type Aead = ChaCha20Poly1305;
type Kdf = HkdfSha256;
fn bytes(v: &Value, k: &str) -> Vec<u8> { hex::decode(v[k].as_str().unwrap()).unwrap() }
fn main() {
 if std::env::args().nth(1).as_deref() == Some("apple") {
   let v: Value=serde_json::from_str(&std::fs::read_to_string("artifacts/rust-auth-interop-synthetic.json").unwrap()).unwrap();
   let a: Value=serde_json::from_str(&std::fs::read_to_string("artifacts/apple-auth-interop-synthetic.json").unwrap()).unwrap();
   let sk=<Kem as KemTrait>::PrivateKey::from_bytes(&bytes(&v,"skR")).unwrap();
   let pk=<Kem as KemTrait>::PublicKey::from_bytes(&bytes(&v,"pkS")).unwrap();
   let enc=<Kem as KemTrait>::EncappedKey::from_bytes(&bytes(&a,"enc")).unwrap();
   let mut r=hpke::setup_receiver::<Aead,Kdf,Kem>(&OpModeR::Auth(pk),&sk,&enc,&bytes(&v,"info")).unwrap();
   assert_eq!(r.open(&bytes(&a,"ct"),&bytes(&v,"aad")).unwrap(),bytes(&v,"pt"));
   println!("Apple CryptoKit Auth sender -> Rust recipient passed");
   return;
 }

 let v: Value = serde_json::from_str(include_str!("../artifacts/rfc9180-auth-x25519-chacha.json")).unwrap();
 let sk = <Kem as KemTrait>::PrivateKey::from_bytes(&bytes(&v,"skRm")).unwrap();
 let pk_s = <Kem as KemTrait>::PublicKey::from_bytes(&bytes(&v,"pkSm")).unwrap();
 let enc = <Kem as KemTrait>::EncappedKey::from_bytes(&bytes(&v,"enc")).unwrap();
 let mut r = hpke::setup_receiver::<Aead,Kdf,Kem>(&OpModeR::Auth(pk_s), &sk, &enc, &bytes(&v,"info")).unwrap();
 let seqs = v["encryptions"].as_array().unwrap();
 for seq in seqs { assert_eq!(r.open(&bytes(seq,"ct"),&bytes(seq,"aad")).unwrap(),bytes(seq,"pt")); }
 for ex in v["exports"].as_array().unwrap() {
   let mut actual = vec![0; ex["L"].as_u64().unwrap() as usize];
   r.export(&bytes(ex,"exporter_context"), &mut actual).unwrap();
   assert_eq!(actual,bytes(ex,"exported_value"));
 }
 let (sk_r,pk_r) = Kem::gen_keypair();
 let (sk_s,pk_s) = Kem::gen_keypair();
 let info = b"synthetic-owner-staging-evaluation-v1";
 let aad = b"synthetic-account/principal/soul/request/staging/operation/key-id";
 let pt = b"synthetic webhook URL and secret; never enrolled";
 let (enc,mut s) = hpke::setup_sender::<Aead,Kdf,Kem>(&OpModeS::Auth((sk_s.clone(),pk_s.clone())), &pk_r, info).unwrap();
 let ct = s.seal(pt,aad).unwrap();
 let open = |i:&[u8], a:&[u8], c:&[u8], pk: <Kem as KemTrait>::PublicKey| {
   hpke::setup_receiver::<Aead,Kdf,Kem>(&OpModeR::Auth(pk), &sk_r, &enc, i).unwrap().open(c,a)
 };
 assert_eq!(open(info,aad,&ct,pk_s.clone()).unwrap(),pt);
 assert!(open(b"wrong domain",aad,&ct,pk_s.clone()).is_err());
 assert!(open(info,b"wrong namespace",&ct,pk_s.clone()).is_err());
 let (_,wrong_pk)=Kem::gen_keypair(); assert!(open(info,aad,&ct,wrong_pk).is_err());
 let mut altered=ct.clone(); altered[0]^=1; assert!(open(info,aad,&altered,pk_s.clone()).is_err());
 let artifact=json!({"purpose":"synthetic test-only interop; never enroll", "skR":hex::encode(sk_r.to_bytes()),"pkR":hex::encode(pk_r.to_bytes()),"skS":hex::encode(sk_s.to_bytes()),"pkS":hex::encode(pk_s.to_bytes()),"enc":hex::encode(enc.to_bytes()),"info":hex::encode(info),"aad":hex::encode(aad),"pt":hex::encode(pt),"ct":hex::encode(ct)});
 std::fs::write("artifacts/rust-auth-interop-synthetic.json",serde_json::to_string_pretty(&artifact).unwrap()).unwrap();
 println!("RFC9180 Auth X25519/HKDF-SHA256/ChaCha20Poly1305: {} sequential decryptions + {} exports passed; wrong sender/info/AAD/ciphertext refused; synthetic interop artifact written",seqs.len(),v["exports"].as_array().unwrap().len());
}
