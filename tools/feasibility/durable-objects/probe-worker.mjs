// Disposable provider probe only: no federation protocol, identity or crypto.
export class SyntheticProbe {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS probe_blob (id TEXT PRIMARY KEY, payload BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS probe_evidence (id TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL, bytes INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS probe_usage (singleton INTEGER PRIMARY KEY, bodies INTEGER NOT NULL, body_bytes INTEGER NOT NULL, outcomes INTEGER NOT NULL, outcome_bytes INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO probe_usage VALUES (1,0,0,0,0)');
  }
  usage() { return this.sql.exec('SELECT bodies,body_bytes,outcomes,outcome_bytes FROM probe_usage').one(); }
  admit(input) {
    return this.ctx.storage.transactionSync(() => {
      const prior = this.sql.exec('SELECT digest FROM probe_evidence WHERE id=?', input.id).toArray()[0];
      if (prior) return { result: prior.digest === input.digest ? 'duplicate' : 'conflict' };
      const usage = this.usage();
      const evidenceBytes = new TextEncoder().encode(JSON.stringify([input.id, input.digest, input.expires])).byteLength;
      const limits = input.limits;
      if (usage.bodies + 1 > limits.bodies || usage.body_bytes + input.bytes > limits.bodyBytes ||
          usage.outcomes + 1 > limits.outcomes || usage.outcome_bytes + evidenceBytes > limits.outcomeBytes) return { result: 'capacity' };
      this.sql.exec('INSERT INTO probe_blob VALUES (?,?)', input.id, new Uint8Array(input.bytes));
      if (input.failAfter === 'body') throw new Error('injected-body');
      this.sql.exec('INSERT INTO probe_evidence VALUES (?,?,?,?)', input.id, input.digest, input.expires, evidenceBytes);
      if (input.failAfter === 'outcome') throw new Error('injected-outcome');
      this.sql.exec('UPDATE probe_usage SET bodies=bodies+1,body_bytes=body_bytes+?,outcomes=outcomes+1,outcome_bytes=outcome_bytes+? WHERE singleton=1', input.bytes, evidenceBytes);
      if (input.failAfter === 'counter') throw new Error('injected-counter');
      return { result: 'accepted' };
    });
  }
  async fetch(request) {
    const input = await request.json();
    try {
      if (input.op === 'egress-check') return Response.json({ outboundStatus: (await fetch('https://external.invalid/blocked')).status });
      if (input.op === 'admit') {
        const result = this.admit(input);
        if (input.dropReply && result.result === 'accepted') {
          await this.ctx.storage.sync();
          return new Response(null,{status:503}); // Deliberate missing outcome after durable commit.
        }
        return Response.json(result);
      }
      if (input.op === 'inspect') return Response.json({
        bodies: this.sql.exec('SELECT id,hex(payload) AS body FROM probe_blob ORDER BY id').toArray(),
        outcomes: this.sql.exec('SELECT id,digest,expires,bytes FROM probe_evidence ORDER BY id').toArray()
      });
      if (input.op === 'usage') return Response.json({ ...this.usage(), databaseBytes: this.sql.databaseSize });
      if (input.op === 'drop-body') {
        this.ctx.storage.transactionSync(() => {
          const row = this.sql.exec('SELECT length(payload) AS bytes FROM probe_blob WHERE id=?',input.id).toArray()[0];
          if (!row) return;
          this.sql.exec('DELETE FROM probe_blob WHERE id=?',input.id);
          this.sql.exec('UPDATE probe_usage SET bodies=bodies-1,body_bytes=body_bytes-? WHERE singleton=1',row.bytes);
        });
        return Response.json(this.usage());
      }
      if (input.op === 'page') {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 32) throw new Error('invalid-page-limit');
        const cursor = this.sql.exec('SELECT id,length(payload) AS bytes FROM probe_blob WHERE id>? ORDER BY id LIMIT ?',input.after,input.limit);
        const rows = cursor.toArray();
        return Response.json({ rows, rowsRead: cursor.rowsRead, databaseBytes: this.sql.databaseSize });
      }
      return new Response(null,{status:400});
    } catch (error) {
      if (!/^injected-|^invalid-page-limit$/.test(error.message)) throw error;
      return Response.json({ error: error.message },{status:409});
    }
  }
}
export default { fetch() { return new Response(null,{status:404}); } };
