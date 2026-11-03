const encode = value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
const column = name => {
  if (!/^[a-z_]+$/.test(name)) throw Error('Invalid settings column');
  return name;
};

// A single-row settings table (id=1). The first start inserts the initial row and later starts keep what was saved;
// reads return the whole row and writes set columns by name, encoding objects as JSON. Each service still
// validates its own settings.
export class SettingsStore {
  constructor(db, table) {
    this.db = db;
    this.table = column(table);
  }
  async initialize(initial) {
    const names = Object.keys(initial).map(column);
    await this.db
      .prepare(
        `INSERT INTO ${this.table}(id,${names.join(',')}) VALUES(1,${names.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`,
      )
      .run(...Object.values(initial).map(encode));
  }
  async read({ lock = false } = {}) {
    return this.db.prepare(`SELECT * FROM ${this.table} WHERE id=1` + (lock ? ' FOR UPDATE' : '')).get();
  }
  async write(values) {
    const names = Object.keys(values).map(column);
    await this.db
      .prepare(`UPDATE ${this.table} SET ${names.map(name => name + '=?').join(',')} WHERE id=1`)
      .run(...Object.values(values).map(encode));
  }
}
