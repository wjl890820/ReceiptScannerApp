/**
 * Production SQLite parity for Shopping List quantity normalize-then-step.
 * Uses system Python sqlite3 (real SQLite), not the in-memory mock.
 */
/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  decrementActiveShoppingIntentQuantityWithDb,
  incrementActiveShoppingIntentQuantityWithDb,
  type ShoppingIntentDatabase,
  type ShoppingIntentRow,
} from './shoppingIntentRepository';
import {
  effectiveShoppingListQuantity,
  mapShoppingIntentRowToListItem,
} from './shoppingList';

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['-c', 'import sqlite3'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode bind params for the Python bridge.
 * JSON cannot represent ±Inf/NaN; use tagged objects.
 */
function encodeBindParams(params: unknown[]): string {
  return JSON.stringify(
    params.map((p) => {
      if (typeof p === 'number') {
        if (Number.isNaN(p)) return { __n: 'nan' };
        if (p === Infinity) return { __n: 'inf' };
        if (p === -Infinity) return { __n: '-inf' };
      }
      return p === undefined ? null : p;
    })
  );
}

function createPythonSqliteShoppingIntentDatabase(): ShoppingIntentDatabase & {
  dbPath: string;
  close: () => void;
  /** Raw SQL helper for legacy quantity injection (e.g. 1e999 ⇒ +Inf). */
  execRaw: (sql: string) => void;
  observeDesiredQuantityBinding: (
    value: number
  ) => { storedIsNull: boolean; storedType: string; quote: string };
} {
  const dbPath = path.join(
    os.tmpdir(),
    `meruno-qty-sqlite-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`
  );
  fs.writeFileSync(dbPath, '');

  const runPython = (body: string): string => {
    const script = `
import json, math, sqlite3, sys
db_path = ${JSON.stringify(dbPath)}

def decode_param(p):
    if isinstance(p, dict) and '__n' in p:
        tag = p['__n']
        if tag == 'inf':
            return float('inf')
        if tag == '-inf':
            return float('-inf')
        if tag == 'nan':
            return float('nan')
    return p

def encode_cell(v):
    if v is None:
        return None
    if isinstance(v, float):
        if math.isinf(v):
            return {'__n': 'inf' if v > 0 else '-inf'}
        if math.isnan(v):
            return {'__n': 'nan'}
    return v

con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
try:
${body}
finally:
    con.close()
`;
    const out = execFileSync('python3', ['-c', script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.trim();
  };

  runPython('    pass');

  const api: ShoppingIntentDatabase & {
    dbPath: string;
    close: () => void;
    execRaw: (sql: string) => void;
    observeDesiredQuantityBinding: (
      value: number
    ) => { storedIsNull: boolean; storedType: string; quote: string };
  } = {
    dbPath,
    close() {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
    },
    execRaw(sql: string) {
      runPython(
        `    con.executescript(${JSON.stringify(sql)})\n    con.commit()`
      );
    },
    observeDesiredQuantityBinding(value: number) {
      const encoded = encodeBindParams([value]);
      const raw = runPython(`
    con.execute('DROP TABLE IF EXISTS _bind_probe')
    con.execute('CREATE TABLE _bind_probe(q REAL)')
    params = json.loads(${JSON.stringify(encoded)})
    con.execute('INSERT INTO _bind_probe(q) VALUES (?)', [decode_param(params[0])])
    con.commit()
    row = con.execute("SELECT q IS NULL AS is_null, typeof(q) AS t, quote(q) AS q FROM _bind_probe").fetchone()
    print(json.dumps({'storedIsNull': bool(row['is_null']), 'storedType': row['t'], 'quote': row['q']}))
`);
      return JSON.parse(raw) as {
        storedIsNull: boolean;
        storedType: string;
        quote: string;
      };
    },
    async execAsync(source: string) {
      runPython(
        `    con.executescript(${JSON.stringify(source)})\n    con.commit()`
      );
    },
    async runAsync(source: string, params: unknown = []) {
      const list = Array.isArray(params) ? params : [];
      const encoded = encodeBindParams(list);
      const raw = runPython(`
    params = [decode_param(p) for p in json.loads(${JSON.stringify(encoded)})]
    cur = con.execute(${JSON.stringify(source)}, params)
    con.commit()
    print(json.dumps({'changes': cur.rowcount if cur.rowcount is not None else 0}))
`);
      return JSON.parse(raw) as { changes: number };
    },
    async getFirstAsync<T>(
      source: string,
      params: unknown = []
    ): Promise<T | null> {
      const list = Array.isArray(params) ? params : [];
      const encoded = encodeBindParams(list);
      const raw = runPython(`
    params = [decode_param(p) for p in json.loads(${JSON.stringify(encoded)})]
    row = con.execute(${JSON.stringify(source)}, params).fetchone()
    if row is None:
        print('null')
    else:
        print(json.dumps({k: encode_cell(row[k]) for k in row.keys()}))
`);
      if (!raw || raw === 'null') return null;
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && '__n' in (v as object)) {
          const tag = (v as { __n: string }).__n;
          obj[k] =
            tag === 'inf' ? Infinity : tag === '-inf' ? -Infinity : Number.NaN;
        }
      }
      return obj as T;
    },
    async getAllAsync<T>(source: string, params: unknown = []): Promise<T[]> {
      const list = Array.isArray(params) ? params : [];
      const encoded = encodeBindParams(list);
      const raw = runPython(`
    params = [decode_param(p) for p in json.loads(${JSON.stringify(encoded)})]
    rows = con.execute(${JSON.stringify(source)}, params).fetchall()
    out = []
    for row in rows:
        out.append({k: encode_cell(row[k]) for k in row.keys()})
    print(json.dumps(out))
`);
      return JSON.parse(raw || '[]') as T[];
    },
  };

  return api;
}

async function seedActiveRow(
  db: ShoppingIntentDatabase,
  id: string,
  desiredQuantity: number | null
): Promise<void> {
  const now = '2026-09-04T12:00:00.000Z';
  await db.runAsync(
    `INSERT INTO shopping_intents (
      id, raw_text, intent_type, status, desired_quantity,
      desired_spec_json, resolution_json, created_at, updated_at,
      completed_at, contract_version,
      source_type, source_identity_kind, source_identity_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      '鶏砂肝',
      'buy',
      'active',
      desiredQuantity,
      null,
      null,
      now,
      now,
      null,
      '1',
      'manual',
      null,
      null,
    ]
  );
}

const describeSqlite = pythonAvailable() ? describe : describe.skip;

describeSqlite('Shopping List quantity — production SQLite finite guard', () => {
  let db: ReturnType<typeof createPythonSqliteShoppingIntentDatabase>;

  beforeEach(async () => {
    db = createPythonSqliteShoppingIntentDatabase();
    await db.execAsync(`
CREATE TABLE IF NOT EXISTS shopping_intents (
  id TEXT PRIMARY KEY NOT NULL,
  raw_text TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  status TEXT NOT NULL,
  desired_quantity REAL,
  desired_spec_json TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  contract_version TEXT NOT NULL,
  source_type TEXT,
  source_identity_kind TEXT,
  source_identity_key TEXT
);
`);
  });

  afterEach(() => {
    db.close();
  });

  it('observes NaN bind behavior (expect NULL ⇒ normalize 1)', async () => {
    const probe = db.observeDesiredQuantityBinding(Number.NaN);
    // Document actual SQLite binding: NaN → NULL.
    expect(probe.storedIsNull).toBe(true);
    expect(probe.storedType).toBe('null');

    await seedActiveRow(db, 'nan-inc', null);
    db.execRaw(
      "UPDATE shopping_intents SET desired_quantity = (0.0/0.0) WHERE id = 'nan-inc'"
    );
    const before = await db.getFirstAsync<ShoppingIntentRow>(
      'SELECT * FROM shopping_intents WHERE id = ?',
      ['nan-inc']
    );
    expect(before?.desired_quantity).toBeNull();
    expect(
      effectiveShoppingListQuantity(before?.desired_quantity ?? null)
    ).toBe(1);

    const row = await incrementActiveShoppingIntentQuantityWithDb(
      db,
      'nan-inc'
    );
    expect(row?.desired_quantity).toBe(2);
    expect(mapShoppingIntentRowToListItem(row!)?.quantity).toBe(2);
  });

  it('+Infinity increment => 2; decrement => 1', async () => {
    await seedActiveRow(db, 'pinf-inc', 1);
    db.execRaw(
      "UPDATE shopping_intents SET desired_quantity = 1e999 WHERE id = 'pinf-inc'"
    );
    const before = await db.getFirstAsync<ShoppingIntentRow>(
      'SELECT * FROM shopping_intents WHERE id = ?',
      ['pinf-inc']
    );
    expect(before?.desired_quantity).toBe(Infinity);
    expect(effectiveShoppingListQuantity(before!.desired_quantity)).toBe(1);

    const inc = await incrementActiveShoppingIntentQuantityWithDb(
      db,
      'pinf-inc'
    );
    expect(inc?.desired_quantity).toBe(2);
    expect(mapShoppingIntentRowToListItem(inc!)?.quantity).toBe(2);

    await seedActiveRow(db, 'pinf-dec', 1);
    db.execRaw(
      "UPDATE shopping_intents SET desired_quantity = 1e999 WHERE id = 'pinf-dec'"
    );
    const dec = await decrementActiveShoppingIntentQuantityWithDb(
      db,
      'pinf-dec'
    );
    expect(dec?.desired_quantity).toBe(1);
    expect(mapShoppingIntentRowToListItem(dec!)?.quantity).toBe(1);
  });

  it('-Infinity increment => 2; decrement => 1', async () => {
    await seedActiveRow(db, 'ninf-inc', 1);
    db.execRaw(
      "UPDATE shopping_intents SET desired_quantity = -1e999 WHERE id = 'ninf-inc'"
    );
    const before = await db.getFirstAsync<ShoppingIntentRow>(
      'SELECT * FROM shopping_intents WHERE id = ?',
      ['ninf-inc']
    );
    expect(before?.desired_quantity).toBe(-Infinity);
    expect(effectiveShoppingListQuantity(before!.desired_quantity)).toBe(1);

    const inc = await incrementActiveShoppingIntentQuantityWithDb(
      db,
      'ninf-inc'
    );
    expect(inc?.desired_quantity).toBe(2);

    await seedActiveRow(db, 'ninf-dec', 1);
    db.execRaw(
      "UPDATE shopping_intents SET desired_quantity = -1e999 WHERE id = 'ninf-dec'"
    );
    const dec = await decrementActiveShoppingIntentQuantityWithDb(
      db,
      'ninf-dec'
    );
    expect(dec?.desired_quantity).toBe(1);
  });

  it('finite legacy: 999−⇒98, 0+⇒2, 1.5+⇒2, 2.75+⇒3; 100/999 stay 99 not 1', async () => {
    await seedActiveRow(db, 'f999', 999);
    const d999 = await decrementActiveShoppingIntentQuantityWithDb(db, 'f999');
    expect(d999?.desired_quantity).toBe(98);

    await seedActiveRow(db, 'f0', 0);
    const i0 = await incrementActiveShoppingIntentQuantityWithDb(db, 'f0');
    expect(i0?.desired_quantity).toBe(2);

    await seedActiveRow(db, 'f15', 1.5);
    const i15 = await incrementActiveShoppingIntentQuantityWithDb(db, 'f15');
    expect(i15?.desired_quantity).toBe(2);

    await seedActiveRow(db, 'f275', 2.75);
    const i275 = await incrementActiveShoppingIntentQuantityWithDb(db, 'f275');
    expect(i275?.desired_quantity).toBe(3);

    await seedActiveRow(db, 'f100', 100);
    const i100 = await incrementActiveShoppingIntentQuantityWithDb(db, 'f100');
    expect(i100?.desired_quantity).toBe(99);

    await seedActiveRow(db, 'f999i', 999);
    const i999 = await incrementActiveShoppingIntentQuantityWithDb(db, 'f999i');
    expect(i999?.desired_quantity).toBe(99);
  });
});
