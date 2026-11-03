// Configuration read on the request and delivery paths, cached in process memory. One gateway process owns
// the database, and every change goes through a service method that calls invalidate(): entries are dropped
// just before and again just after the writing transaction commits, and the generation counter stops a value
// loaded before that commit from being stored afterwards. Changes made directly in the database take effect
// only after a restart.
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const kinds = ['app', 'notifications', 'quota', 'policy', 'channel'];

export class ConfigCache {
  constructor(db, { capacity = 10000 } = {}) {
    this.db = db;
    this.capacity = capacity;
    this.entries = new Map();
    this.generation = 0;
    // Changes between their pre-commit and post-commit hooks; nothing is stored while any is in flight.
    this.committing = 0;
  }
  // Values are frozen; callers copy before changing them. `missing: false` leaves absent rows uncached, for keys
  // a caller can choose freely.
  async get(key, load, { missing = true } = {}) {
    // A transaction that changed configuration must read its own writes.
    if (this.db.changedConfiguration()) return load();
    if (this.entries.has(key)) return this.entries.get(key);
    const generation = this.generation;
    const value = freeze(await load());
    if (generation === this.generation && !this.committing && (value != null || missing)) {
      if (this.entries.size >= this.capacity) this.entries.clear();
      this.entries.set(key, value);
    }
    return value;
  }
  // Marks the current transaction as a configuration change before its first read, so every read in it goes to
  // the database: a change committed just before it may not have dropped its entries yet.
  writing() {
    this.db.onCommit(this.change(() => {}));
  }
  // Drops `kind:id` and `kind:id:*` just before the current transaction commits and again after.
  invalidate(kind, id) {
    const key = kind + ':' + id;
    this.db.onCommit(
      this.change(() => {
        for (const entry of this.entries.keys())
          if (entry === key || entry.startsWith(key + ':')) this.entries.delete(entry);
      }),
    );
  }
  // A commit hook: between 'before' and 'after' (or 'rollback') the change counts as in flight, so a value read in
  // that window, possibly from before the commit, is never stored; each phase also bumps the generation.
  change(drop) {
    return phase => {
      this.generation++;
      drop();
      if (phase === 'before') this.committing++;
      else this.committing--;
    };
  }
  invalidateApplication(id) {
    for (const kind of kinds) this.invalidate(kind, id);
  }
  application(id) {
    return this.get('app:' + id, () => this.one('SELECT * FROM applications WHERE id=?', id), { missing: false });
  }
  async notifications(id) {
    return this.get(
      'notifications:' + id,
      async () =>
        (await this.one('SELECT settings FROM application_notifications WHERE app_id=?', id))?.settings ?? null,
    );
  }
  quota(id) {
    return this.get(
      'quota:' + id,
      async () => (await this.one('SELECT settings FROM application_quotas WHERE app_id=?', id))?.settings ?? null,
    );
  }
  policy(id) {
    return this.get('policy:' + id, () => this.one('SELECT * FROM access_policies WHERE app_id=?', id));
  }
  // `stored` marks an ID read from a registration: their number is bounded, so an absent server is cached too.
  server(id, { stored = false } = {}) {
    return this.get('server:' + id, () => this.one('SELECT * FROM trusted_servers WHERE id=?', id), {
      missing: stored,
    });
  }
  async one(sql, ...values) {
    return (await this.db.prepare(sql).get(...values)) ?? null;
  }
}
