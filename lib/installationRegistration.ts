/**
 * Best-effort cloud installation registration (Phase 3).
 * Non-fatal: never signs the user out on failure.
 */

export type InstallationRegisterResult = {
  attempted: boolean;
  ok: boolean;
  error?: string;
};

/**
 * Upsert semantics via select + insert/update so first_seen_at is preserved,
 * and UNIQUE(user_id, installation_id) allows another auth user to register
 * the same installation_id under their own row.
 */
export async function registerInstallationForUser(params: {
  supabase: { from: (table: string) => any };
  userId: string;
  installationId: string;
  platform?: string | null;
  appVersion?: string | null;
  nowIso?: string;
}): Promise<InstallationRegisterResult> {
  const nowIso = params.nowIso ?? new Date().toISOString();

  try {
    const { data: existing, error: selectError } = await params.supabase
      .from('installations')
      .select('row_id')
      .eq('user_id', params.userId)
      .eq('installation_id', params.installationId)
      .maybeSingle();

    if (selectError) {
      console.warn('[Installation] select failed (nonfatal):', selectError.message || selectError);
      return { attempted: true, ok: false, error: selectError.message || 'select failed' };
    }

    if (existing?.row_id) {
      const { error: updateError } = await params.supabase
        .from('installations')
        .update({
          last_seen_at: nowIso,
          platform: params.platform ?? null,
          app_version: params.appVersion ?? null,
        })
        .eq('row_id', existing.row_id);

      if (updateError) {
        console.warn('[Installation] update failed (nonfatal):', updateError.message || updateError);
        return { attempted: true, ok: false, error: updateError.message || 'update failed' };
      }
      return { attempted: true, ok: true };
    }

    const { error: insertError } = await params.supabase.from('installations').insert({
      user_id: params.userId,
      installation_id: params.installationId,
      platform: params.platform ?? null,
      app_version: params.appVersion ?? null,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    });

    if (insertError) {
      console.warn('[Installation] insert failed (nonfatal):', insertError.message || insertError);
      return { attempted: true, ok: false, error: insertError.message || 'insert failed' };
    }

    return { attempted: true, ok: true };
  } catch (e: any) {
    console.warn('[Installation] registration threw (nonfatal):', e?.message || e);
    return { attempted: true, ok: false, error: String(e?.message || e) };
  }
}
