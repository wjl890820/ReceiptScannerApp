import {
  PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL,
  ensurePersonalProductIdentitySchema,
} from './personalProductIdentitySchema';

describe('G4-1 personal product identity schema', () => {
  it('schema is idempotent', async () => {
    const calls: string[] = [];
    const db = {
      async execAsync(source: string) {
        calls.push(source);
      },
    };
    await ensurePersonalProductIdentitySchema(db);
    await ensurePersonalProductIdentitySchema(db);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL);
    expect(calls[1]).toBe(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL);
  });

  it('creates table and indexes without foreign keys to merchant_products', () => {
    expect(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL).toContain(
      'CREATE TABLE IF NOT EXISTS personal_product_identity_decisions'
    );
    expect(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL).toContain(
      'idx_personal_product_identity_owner_left'
    );
    expect(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL).toContain(
      'idx_personal_product_identity_owner_right'
    );
    expect(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL).not.toContain('FOREIGN KEY');
    expect(PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL).not.toContain('merchant_products');
  });
});
