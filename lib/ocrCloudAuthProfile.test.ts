/**
 * Cloud OCR v2 needs a Supabase user session.
 * Supported EAS profiles enable anonymous auth explicitly.
 * The application default stays off.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

describe('cloud OCR auth profile contract', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8')) as {
    build: Record<string, { env?: Record<string, string> }>;
  };

  it('enables anonymous auth on development, preview, validation, and production', () => {
    for (const name of ['development', 'preview', 'validation', 'production']) {
      expect(eas.build[name].env?.ENABLE_ANON_AUTH).toBe('true');
    }
  });

  it('keeps the application default documented as off', () => {
    const env = fs.readFileSync(path.join(root, 'lib/env.ts'), 'utf8');
    expect(env).toContain('Default OFF');
    expect(env).toMatch(/return false;/);
  });

  it('documents the cloud OCR session requirement', () => {
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const engineering = fs.readFileSync(path.join(root, 'docs/ENGINEERING.md'), 'utf8');
    expect(example).toContain('ENABLE_ANON_AUTH=true');
    expect(example).toContain('ocr-receipt-v2');
    expect(engineering).toContain('ENABLE_ANON_AUTH');
    expect(engineering).toContain('enable_anonymous_sign_ins');
  });

  it('leaves local Supabase anonymous sign-in disabled', () => {
    const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
    expect(config).toMatch(/enable_anonymous_sign_ins = false/);
  });
});
