/**
 * DS1 — cloud migration / RLS contract for personal product identity decisions.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('user_personal_product_identity_decisions migration', () => {
  const sql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../supabase/migrations/010_user_personal_product_identity_decisions.sql'
    ),
    'utf8'
  );

  it('uses the next free migration number and the account-owned table', () => {
    expect(
      fs.existsSync(
        path.resolve(__dirname, '../supabase/migrations/010_user_personal_product_identity_decisions.sql')
      )
    ).toBe(true);
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.user_personal_product_identity_decisions'
    );
    expect(sql).toContain(
      'PRIMARY KEY (user_id, left_merchant_product_id, right_merchant_product_id)'
    );
    expect(sql).toContain('identity_pipeline_version TEXT NOT NULL');
    expect(sql).toContain('created_at BIGINT NOT NULL');
    expect(sql).toContain('updated_at BIGINT NOT NULL');
  });

  it('checks canonical pair order, the three decisions, and auth.users cascade', () => {
    expect(sql).toMatch(/left_merchant_product_id < right_merchant_product_id/);
    expect(sql).toMatch(/'same_product'/);
    expect(sql).toMatch(/'not_same_product'/);
    expect(sql).toMatch(/'unsure'/);
    expect(sql).toMatch(/REFERENCES auth\.users \(id\) ON DELETE CASCADE/);
    expect(sql).not.toMatch(/decision_id/);
    expect(sql).not.toMatch(/deleted_at/);
    expect(sql).not.toMatch(/installation_id/);
  });

  it('enables RLS for own SELECT/INSERT/UPDATE and does not grant delete or public access', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toMatch(/FOR SELECT[\s\S]*TO authenticated[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/FOR INSERT[\s\S]*TO authenticated[\s\S]*user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/FOR UPDATE[\s\S]*TO authenticated[\s\S]*USING \(user_id = auth\.uid\(\)\)[\s\S]*WITH CHECK \(user_id = auth\.uid\(\)\)/);
    expect(sql).not.toMatch(/FOR DELETE/);
    expect(sql).not.toMatch(/TO public/);
    expect(sql).not.toMatch(/TO anon/);
    expect(sql).not.toMatch(/GRANT /);
  });
});
