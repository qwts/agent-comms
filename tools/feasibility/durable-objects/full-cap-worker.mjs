// Synthetic storage experiment only; injected clock and padded labels are not a protocol.
import { SyntheticProbe } from './probe-worker.mjs';
export class FullCapProbe extends SyntheticProbe {
  constructor(ctx) {
    super(ctx);
    this.sql.exec('CREATE INDEX IF NOT EXISTS probe_expiry ON probe_evidence(expires,id)');
  }
  dropBody(id) {
    this.ctx.storage.transactionSync(()=>{
      const row=this.sql.exec('SELECT length(payload) AS bytes FROM probe_blob WHERE id=?',id).toArray()[0];
      if(!row)return;
      this.sql.exec('DELETE FROM probe_blob WHERE id=?',id);
      this.sql.exec('UPDATE probe_usage SET bodies=bodies-1,body_bytes=body_bytes-? WHERE singleton=1',row.bytes);
    });
  }
  async fetch(request) {
    const input=await request.json();
    if(input.op==='batch') {
      if(!Array.isArray(input.items)||input.items.length>100)return new Response(null,{status:400});
      const results=[];
      for(const item of input.items) {
        results.push(this.admit(item).result);
        if(item.dropBody)this.dropBody(item.id);
      }
      return Response.json({results});
    }
    if(input.op==='sweep') {
      if(!Number.isSafeInteger(input.now)||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)return new Response(null,{status:400});
      let bodies=0,outcomes=0;
      this.ctx.storage.transactionSync(()=>{
        const expired=this.sql.exec('SELECT b.id,length(b.payload) AS bytes FROM probe_blob b JOIN probe_evidence e ON e.id=b.id WHERE e.expires<=? LIMIT ?',input.now,input.limit).toArray();
        for(const row of expired) {this.dropBody(row.id);bodies++;}
        const released=this.sql.exec('SELECT id,bytes FROM probe_evidence WHERE expires<? ORDER BY expires,id LIMIT ?',input.now-120000,input.limit).toArray();
        for(const row of released) {
          this.dropBody(row.id);
          this.sql.exec('DELETE FROM probe_evidence WHERE id=?',row.id);
          this.sql.exec('UPDATE probe_usage SET outcomes=outcomes-1,outcome_bytes=outcome_bytes-? WHERE singleton=1',row.bytes);
          outcomes++;
        }
      });
      return Response.json({bodies,outcomes});
    }
    if(input.op==='evidence-page') {
      if(!Number.isInteger(input.limit)||input.limit<1||input.limit>32)return new Response(null,{status:400});
      const cursor=this.sql.exec('SELECT id,digest,expires,bytes FROM probe_evidence WHERE id>? ORDER BY id LIMIT ?',input.after,input.limit);
      return Response.json({rows:cursor.toArray(),rowsRead:cursor.rowsRead});
    }
    if(input.op==='body-page') {
      // One complete body at a time keeps the serialized response below the accepted 64KiB envelope ceiling.
      const cursor=this.sql.exec('SELECT id,hex(payload) AS body FROM probe_blob WHERE id>? ORDER BY id LIMIT 1',input.after);
      return Response.json({rows:cursor.toArray(),rowsRead:cursor.rowsRead});
    }
    return super.fetch(new Request(request.url,{method:'POST',body:JSON.stringify(input)}));
  }
}
export default {fetch(request,env){return env.PROBE.get(env.PROBE.idFromName('full-cap')).fetch(request);}};
