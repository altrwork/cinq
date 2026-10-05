// AccountDO: one per deployment. Holds agent keys (hashed) and the list of repos.
// The owner authenticates with the OWNER_KEY secret (set by `init`); agents with keys minted here.
// `stopAll` revokes every agent key at once ("stop all agents").
import { DurableObject } from 'cloudflare:workers';

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class AccountDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, agent TEXT, created INTEGER, revoked INTEGER)');
    try { ctx.storage.sql.exec('ALTER TABLE keys ADD COLUMN repo TEXT'); } catch {} // each key knows its repo
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, created INTEGER)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deleted (name TEXT PRIMARY KEY, at INTEGER)'); // names that once held a main
  }
  async createKey(agent, repo = null) {
    const key = `glk_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    this.ctx.storage.sql.exec('INSERT INTO keys (hash, agent, created, repo) VALUES (?, ?, ?, ?)', await sha(key), agent, Date.now(), repo);
    return { agent, key, repo };
  }
  async verify(key) {
    const r = this.ctx.storage.sql.exec('SELECT agent, repo FROM keys WHERE hash = ? AND revoked IS NULL AND repo IS NOT NULL', await sha(key)).toArray()[0];
    return r ? { agent: r.agent, repo: r.repo } : null;
  }
  listKeys() { return this.ctx.storage.sql.exec('SELECT agent, created, revoked FROM keys ORDER BY created').toArray(); }
  stopAll() {
    const n = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM keys WHERE revoked IS NULL').toArray()[0].n;
    this.ctx.storage.sql.exec('UPDATE keys SET revoked = ? WHERE revoked IS NULL', Date.now());
    return { revoked: n };
  }
  addRepo(name) { this.ctx.storage.sql.exec('INSERT OR IGNORE INTO repos (name, created) VALUES (?, ?)', name, Date.now()); return { name }; }
  removeRepo(name) { this.ctx.storage.sql.exec('DELETE FROM repos WHERE name = ?', name); this.ctx.storage.sql.exec('UPDATE keys SET revoked = ? WHERE repo = ? AND revoked IS NULL', Date.now(), name); // a re-created repo of the same name starts with no keys
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO deleted (name, at) VALUES (?, ?)', name, Date.now()); return { name }; }
  wasDeleted(name) { return this.ctx.storage.sql.exec('SELECT 1 AS x FROM deleted WHERE name = ?', name).toArray().length > 0; }
  listRepos() { return this.ctx.storage.sql.exec('SELECT name, created FROM repos ORDER BY created').toArray(); }
}
