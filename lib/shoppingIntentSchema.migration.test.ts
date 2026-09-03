/**
 * Shopping intents schema migration order + uniqueness index safety.
 */
import {
  ensureShoppingIntentsSchema,
  ShoppingIntentsDuplicateActiveIdentityError,
  type ShoppingIntentsSchemaDatabase,
} from './shoppingIntentSchema';

type LegacyRow = {
  id: string;
  status: string;
  source_identity_kind?: string | null;
  source_identity_key?: string | null;
};

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function referencedColumnsFromCreateIndex(sql: string): string[] {
  const match = sql.match(/ON\s+shopping_intents\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/\s+DESC$/i, '').replace(/\s+ASC$/i, ''))
    .filter(Boolean);
}

function createIndexName(sql: string): string | null {
  const match = sql.match(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/i
  );
  return match?.[1] ?? null;
}

/**
 * Simulates an existing install: shopping_intents exists WITHOUT provenance columns.
 * CREATE TABLE IF NOT EXISTS is a no-op that preserves legacy columns.
 */
function createLegacyShoppingIntentsMigrationDb(options?: {
  rows?: LegacyRow[];
  withProvenanceAlready?: boolean;
}): ShoppingIntentsSchemaDatabase & {
  columns: string[];
  indexes: string[];
  rows: LegacyRow[];
  execLog: string[];
} {
  const columns = options?.withProvenanceAlready
    ? [
        'id',
        'raw_text',
        'intent_type',
        'status',
        'desired_quantity',
        'desired_spec_json',
        'resolution_json',
        'created_at',
        'updated_at',
        'completed_at',
        'contract_version',
        'source_type',
        'source_identity_kind',
        'source_identity_key',
      ]
    : [
        'id',
        'raw_text',
        'intent_type',
        'status',
        'desired_quantity',
        'desired_spec_json',
        'resolution_json',
        'created_at',
        'updated_at',
        'completed_at',
        'contract_version',
      ];
  const indexes: string[] = [];
  const rows = [...(options?.rows ?? [])];
  const execLog: string[] = [];
  let tableExists = true;

  const api: ShoppingIntentsSchemaDatabase & {
    columns: string[];
    indexes: string[];
    rows: LegacyRow[];
    execLog: string[];
  } = {
    columns,
    indexes,
    rows,
    execLog,
    async execAsync(source: string) {
      for (const stmt of splitStatements(source)) {
        execLog.push(stmt);
        if (/^\s*CREATE TABLE IF NOT EXISTS shopping_intents/i.test(stmt)) {
          if (tableExists) {
            // Existing install: do not replace columns.
            continue;
          }
          tableExists = true;
          continue;
        }
        if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX IF NOT EXISTS/i.test(stmt)) {
          const refs = referencedColumnsFromCreateIndex(stmt);
          for (const col of refs) {
            if (!columns.includes(col)) {
              throw new Error(`no such column: ${col}`);
            }
          }
          const name = createIndexName(stmt);
          if (name && !indexes.includes(name)) indexes.push(name);
          continue;
        }
      }
    },
    async getAllAsync<T>(source: string): Promise<T[]> {
      if (/PRAGMA table_info\(shopping_intents\)/i.test(source)) {
        return columns.map((name) => ({ name })) as T[];
      }
      if (
        /GROUP BY source_identity_kind, source_identity_key/i.test(source) &&
        /HAVING COUNT\(\*\) > 1/i.test(source)
      ) {
        if (
          !columns.includes('source_identity_kind') ||
          !columns.includes('source_identity_key')
        ) {
          throw new Error('no such column: source_identity_kind');
        }
        const counts = new Map<
          string,
          { kind: string; key: string; count: number }
        >();
        for (const row of rows) {
          if (row.status !== 'active') continue;
          if (row.source_identity_kind == null || row.source_identity_key == null) {
            continue;
          }
          const mapKey = `${row.source_identity_kind}\0${row.source_identity_key}`;
          const prev = counts.get(mapKey);
          if (prev) prev.count += 1;
          else {
            counts.set(mapKey, {
              kind: row.source_identity_kind,
              key: row.source_identity_key,
              count: 1,
            });
          }
        }
        return [...counts.values()].filter((entry) => entry.count > 1) as T[];
      }
      return [] as T[];
    },
    async runAsync(source: string) {
      const add = source.match(
        /ALTER TABLE shopping_intents ADD COLUMN (\w+)/i
      );
      if (add) {
        const col = add[1];
        if (!columns.includes(col)) columns.push(col);
        return { changes: 0 };
      }
      return { changes: 0 };
    },
  };

  return api;
}

function createEmptyFreshShoppingIntentsDb(): ShoppingIntentsSchemaDatabase & {
  columns: string[];
  indexes: string[];
  tableExists: boolean;
} {
  const columns: string[] = [];
  const indexes: string[] = [];
  let tableExists = false;

  return {
    columns,
    indexes,
    get tableExists() {
      return tableExists;
    },
    async execAsync(source: string) {
      for (const stmt of splitStatements(source)) {
        if (/^\s*CREATE TABLE IF NOT EXISTS shopping_intents/i.test(stmt)) {
          if (tableExists) continue;
          tableExists = true;
          columns.push(
            'id',
            'raw_text',
            'intent_type',
            'status',
            'desired_quantity',
            'desired_spec_json',
            'resolution_json',
            'created_at',
            'updated_at',
            'completed_at',
            'contract_version',
            'source_type',
            'source_identity_kind',
            'source_identity_key'
          );
          continue;
        }
        if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX IF NOT EXISTS/i.test(stmt)) {
          const refs = referencedColumnsFromCreateIndex(stmt);
          for (const col of refs) {
            if (!columns.includes(col)) {
              throw new Error(`no such column: ${col}`);
            }
          }
          const name = createIndexName(stmt);
          if (name && !indexes.includes(name)) indexes.push(name);
        }
      }
    },
    async getAllAsync<T>(source: string): Promise<T[]> {
      if (/PRAGMA table_info\(shopping_intents\)/i.test(source)) {
        return columns.map((name) => ({ name })) as T[];
      }
      if (/HAVING COUNT\(\*\) > 1/i.test(source)) return [] as T[];
      return [] as T[];
    },
    async runAsync(source: string) {
      const add = source.match(
        /ALTER TABLE shopping_intents ADD COLUMN (\w+)/i
      );
      if (add && !columns.includes(add[1])) columns.push(add[1]);
      return { changes: 0 };
    },
  };
}

describe('Shopping intents schema migration safety', () => {
  it('A — existing-install migration adds provenance cols before provenance indexes', async () => {
    const db = createLegacyShoppingIntentsMigrationDb({
      rows: [{ id: 'legacy-1', status: 'active' }],
    });
    await expect(ensureShoppingIntentsSchema(db)).resolves.toBeUndefined();
    expect(db.columns).toEqual(
      expect.arrayContaining([
        'source_type',
        'source_identity_kind',
        'source_identity_key',
      ])
    );
    expect(db.indexes).toEqual(
      expect.arrayContaining([
        'idx_shopping_intents_status_updated',
        'idx_shopping_intents_created',
        'idx_shopping_intents_active_identity',
        'idx_shopping_intents_active_trusted_identity_unique',
      ])
    );
    expect(db.rows).toEqual([{ id: 'legacy-1', status: 'active' }]);

    // Provenance-dependent index statements must appear after ALTER adds.
    const firstProvenanceIndex = db.execLog.findIndex((stmt) =>
      /idx_shopping_intents_active_identity/i.test(stmt)
    );
    const firstUnique = db.execLog.findIndex((stmt) =>
      /idx_shopping_intents_active_trusted_identity_unique/i.test(stmt)
    );
    expect(firstProvenanceIndex).toBeGreaterThan(-1);
    expect(firstUnique).toBeGreaterThan(-1);
    expect(db.columns.indexOf('source_identity_kind')).toBeGreaterThan(-1);
  });

  it('B — fresh install yields complete final schema', async () => {
    const db = createEmptyFreshShoppingIntentsDb();
    await ensureShoppingIntentsSchema(db);
    expect(db.tableExists).toBe(true);
    expect(db.columns).toEqual(
      expect.arrayContaining([
        'source_type',
        'source_identity_kind',
        'source_identity_key',
      ])
    );
    expect(db.indexes).toEqual(
      expect.arrayContaining([
        'idx_shopping_intents_active_trusted_identity_unique',
      ])
    );
  });

  it('C — repeated initialization is idempotent', async () => {
    const db = createLegacyShoppingIntentsMigrationDb();
    await ensureShoppingIntentsSchema(db);
    await ensureShoppingIntentsSchema(db);
    await ensureShoppingIntentsSchema(db);
    expect(
      db.indexes.filter(
        (name) => name === 'idx_shopping_intents_active_trusted_identity_unique'
      )
    ).toHaveLength(1);
    expect(
      db.columns.filter((name) => name === 'source_identity_key')
    ).toHaveLength(1);
  });

  it('fails explicitly when duplicate active trusted identities exist', async () => {
    const db = createLegacyShoppingIntentsMigrationDb({
      withProvenanceAlready: true,
      rows: [
        {
          id: 'a1',
          status: 'active',
          source_identity_kind: 'merchant_product',
          source_identity_key: 'mp:dup',
        },
        {
          id: 'a2',
          status: 'active',
          source_identity_kind: 'merchant_product',
          source_identity_key: 'mp:dup',
        },
      ],
    });
    await expect(ensureShoppingIntentsSchema(db)).rejects.toBeInstanceOf(
      ShoppingIntentsDuplicateActiveIdentityError
    );
    expect(db.rows).toHaveLength(2);
    expect(db.indexes).not.toContain(
      'idx_shopping_intents_active_trusted_identity_unique'
    );
  });
});
