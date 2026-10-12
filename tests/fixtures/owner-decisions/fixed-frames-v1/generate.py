import hashlib, json, struct
from pathlib import Path
SLOTS = {
    'broker': [('acceptance',4096),('original-action',32768),('prepared-challenge',32768),('presence',4096),('receipt',4096),('authorization',4096),('release',4096),('initial-outcome',4096),('observation-reference',2048),('terminal-reference',2048)],
    'daemon': [('acceptance-context',4096),('original-action',32768),('prepared-challenge',32768),('presence',4096),('receipt',4096),('preparation',4096),('successful-check',4096),('pre-effect-refused',4096),('entered',4096),('completed',4096),('observation-pair',4352),('terminal-pair',4352),('linked-authoritative-event',16384),('local-lifecycle-outcome',4096)],
}
sha = lambda b: hashlib.sha256(b).digest()
canonical = lambda v: json.dumps(v, sort_keys=True, separators=(',',':')).encode('ascii')
namespace = 'a'*64
request = '11111111-1111-4111-8111-111111111111'
vectors=[]
for role, slots in SLOTS.items():
    for slot_id,(slot,cap) in enumerate(slots,1):
        for case,byte,length in [('one-byte',48,1),('maximum',97,cap)]:
            payload=bytes([byte])*length
            context=sha(canonical(dict(namespaceDigest=namespace,requestId=request,role=role,slot=slot,v=1)))
            header=bytearray(128)
            header[:8]=b'ODJSLOT1'
            struct.pack_into('>HHIIIQ',header,8,1,slot_id,0,cap,length,1)
            header[32:64]=context
            header[64:96]=sha(payload)
            padded=payload+bytes(cap-length)
            trailer=bytearray(128)
            trailer[:8]=b'ODJCOM01'
            struct.pack_into('>HHIQII',trailer,8,1,slot_id,0,1,length,0)
            trailer[32:64]=sha(b'owner-journal-frame-v1\n'+header+padded)
            trailer[64:96]=context
            frame=header+padded+trailer
            vectors.append(dict(id=f'{role}:{slot}:{case}',role=role,slot=slot,slotId=slot_id,payloadCap=cap,namespaceDigest=namespace,requestId=request,payload={'repeatByte':byte,'count':length},headerHex=header.hex(),trailerHex=trailer.hex(),frameBytes=len(frame),frameSha256=sha(frame).hex()))
result={'version':1,'contractCommit':'6b90f825b5651a50718046379e5adbea193cbabf','purpose':'Storage integrity framing only. Synthetic payloads are not typed lifecycle records or authority. Reconstruct header + repeated payload byte + zero padding to payloadCap + trailer. Producer role is fixed by implementation.','vectors':vectors}
out=Path(__file__).with_name('vectors.json')
out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'vectors':len(vectors),'sha256':sha(out.read_bytes()).hex(),'bytes':out.stat().st_size}))
