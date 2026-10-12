// Explicit synthetic source producer, all 3072 final slots, shared native scan.
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeBrokerOwnerEnrollmentFrame } from '../../lib/owner-enrollment-frame.mjs';
import { bytes } from './owner-decision-lifecycle.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
export function observerSource(t, brokerPublicKey, presencePublicKey, namespaceDigest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-observer-source-')); fs.chmodSync(root,0o700);
  const uid = process.getuid(), pin = key => { const der = key.export({format:'der',type:'spki'}); return {alg:'ed25519',keyId:hash(der),publicKey:der.subarray(-32).toString('base64url')}; };
  const write = (name,data) => fs.writeFileSync(path.join(root,name),data,{mode:0o600});
  write('.journal-lock',Buffer.alloc(0)); write('format','broker-owner-enrollment-fixed-v1\n');
  write('source.record',bytes({v:1,kind:'broker-owner-enrollment-source',namespaceDigest,service:{platform:'darwin',brokerUid:uid}}));
  const common={v:1,namespaceDigest,revision:1};
  const record=bytes({...common,kind:'broker-owner-enrollment',at:1800000000,decisionEvidenceDigest:'a'.repeat(64),previousDigest:null,
    receiptKey:pin(brokerPublicKey),presenceKey:pin(presencePublicKey),service:{platform:'darwin',brokerUid:uid},transactionId:'11111111-1111-4111-8111-111111111111'});
  const audit=bytes({...common,kind:'broker-owner-audit',decisionEvidenceDigest:'a'.repeat(64),recordDigest:hash(record),transactionId:'11111111-1111-4111-8111-111111111111'});
  const confirmation=bytes({...common,kind:'broker-owner-confirmation',recordDigest:hash(record),auditDigest:hash(audit)});
  for(const [kind,dir,suffix,cap,payload] of [['record','records','record',4096,record],['audit','audits','audit',512,audit],['confirmation','confirmations','confirm',512,confirmation]]){
    fs.mkdirSync(path.join(root,dir),{mode:0o700});
    for(let n=1;n<=1024;n++) write(`${dir}/${String(n).padStart(4,'0')}.${suffix}`,n===1?encodeBrokerOwnerEnrollmentFrame(payload,{kind,revision:1,namespaceDigest}):Buffer.alloc(cap+256));
  }
  const verifier=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.alloc(32)]);
  const bootstrap=bytes({v:2,kind:'geniusbar-native-protected-bootstrap',ownerUid:uid+1,brokerUid:uid,
    ownerAccountGuid:'01010101-0101-1101-8101-010101010101',brokerAccountGuid:'02020202-0202-2202-8202-020202020202',namespaceDigest,
    publicSocket:'/fixed/broker.sock',helperService:'app.geniusbar.owner-admin',helperIdentifier:'app.geniusbar.owner-admin',
    enrollmentVerifierPin:{alg:'ed25519',publicKey:Buffer.alloc(32).toString('base64url'),keyId:hash(verifier)}});
  const rootFd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  t.after(()=>{fs.closeSync(rootFd);fs.rmSync(root,{recursive:true,force:true});});
  return {sourceRoot:root,bootstrap,rootFd};
}
