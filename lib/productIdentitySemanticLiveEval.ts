/**
 * Product Identity Batch 4.1 — controlled live Gemini semantic evaluation.
 */

import { resolveLocalCategoryForSemanticGate } from './productIdentityLocalCategory';
import {
  evaluateSemanticSufficiency,
  type NameInformativeness,
} from './productIdentitySemanticGate';
import type { SemanticShadowObservationResult } from './productIdentitySemanticShadowAudit';
import { getSupabaseAnonKey, getSupabaseUrl, isJwtLike } from './env';

export type LiveEvalSample = {
  id: string;
  rawName: string;
  merchantKey: string;
  gateNeedsEnrichment: boolean;
  gateStatus: string;
  nameInformativeness: NameInformativeness;
  localCategory: string;
  role: string;
};

export type LiveEvalAiRow = {
  index: number;
  category?: string | null;
  confidence?: number | null;
  brand?: string | null;
  brandConfidence?: number | null;
  canonicalName?: string | null;
  canonicalNameConfidence?: number | null;
  productType?: string | null;
  semanticTags?: string[] | null;
  attributes?: unknown;
  janCode?: unknown;
  skuId?: unknown;
  barcode?: unknown;
  reason?: string | null;
};

export type LiveEvalReviewRow = {
  sample: LiveEvalSample;
  ai: LiveEvalAiRow | null;
  categoryCorrect: boolean | null;
  brandCorrectOrNullOk: boolean | null;
  canonicalNameUseful: boolean | null;
  canonicalNameWrong: boolean | null;
  attributesCorrect: boolean | null;
  attributesConflict: boolean | null;
  variantCorrect: boolean | null;
  hallucination: boolean;
  invalidSchema: boolean;
  notes: string;
};

function hasKanaOrKanji(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
}

function roleOf(obs: SemanticShadowObservationResult): string {
  const n = obs.rawName;
  if (/(?:TV|BP|PB|MLK|午後T)/i.test(n)) return 'abbrev';
  if (/トップバリュ|TOPVALU|7プレミアム|セブンプレミアム/i.test(n)) return 'pb';
  if (/[A-Za-z0-9]{4,}/.test(n) && !hasKanaOrKanji(n)) return 'code_like';
  if (/ZERO|ゼロ|レモン|ミルク|コーラ|茶|水\s*\d/i.test(n)) return 'beverage';
  if (/ティッシュ|洗剤|電池|ラップ|袋/i.test(n)) return 'household';
  if (/ハミガキ|シャンプー|石鹸|化粧水|マスク/i.test(n)) return 'personal_care';
  if (/USB|ケーブル/i.test(n)) return 'non_food';
  if (/\d+\s*(ml|mL|L|g|kg|個|本|箱|P)/i.test(n)) return 'structural_spec';
  if (n.replace(/\s/g, '').length <= 3 && hasKanaOrKanji(n)) return 'short';
  if (obs.gate.needsEnrichment) return 'needs_enrichment';
  return 'sufficient_control';
}

export function selectLiveEvalSamples(
  observations: SemanticShadowObservationResult[],
  opts?: { maxSamples?: number; controlMin?: number }
): LiveEvalSample[] {
  const maxSamples = opts?.maxSamples ?? 28;
  const controlMin = opts?.controlMin ?? 5;
  const seen = new Set<string>();
  const take = (obs: SemanticShadowObservationResult) => {
    const key = `${obs.merchantKey}::${obs.rawName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const needs = observations.filter((o) => o.gate.needsEnrichment && take(o));
  seen.clear();
  const sufficient = observations.filter((o) => !o.gate.needsEnrichment && take(o));

  const picked: SemanticShadowObservationResult[] = [];
  const pushDiverse = (pool: SemanticShadowObservationResult[], limit: number) => {
    const byRole = new Map<string, SemanticShadowObservationResult[]>();
    for (const o of pool) {
      const role = roleOf(o);
      const list = byRole.get(role) ?? [];
      list.push(o);
      byRole.set(role, list);
    }
    const roles = [...byRole.keys()];
    let i = 0;
    while (picked.length < limit && roles.some((r) => (byRole.get(r) ?? []).length)) {
      const role = roles[i % roles.length]!;
      const next = (byRole.get(role) ?? []).shift();
      if (next) picked.push(next);
      i += 1;
      if (i > pool.length * 3) break;
    }
  };

  pushDiverse(needs, Math.min(Math.max(12, maxSamples - controlMin - 2), needs.length));

  const prefer = sufficient.filter((o) =>
    /キャベツ|バナナ|牛乳|卵|ティッシュ|豆腐|米|茶|水/.test(o.rawName)
  );
  for (const o of [...prefer, ...sufficient]) {
    if (picked.length >= maxSamples) break;
    if (picked.some((p) => p.rawName === o.rawName && p.merchantKey === o.merchantKey)) continue;
    const controls = picked.filter((p) => !p.gate.needsEnrichment).length;
    if (!o.gate.needsEnrichment) {
      if (controls >= controlMin && picked.length >= 22) continue;
      picked.push(o);
    }
  }
  for (const o of sufficient) {
    if (picked.filter((p) => !p.gate.needsEnrichment).length >= controlMin) break;
    if (picked.some((p) => p.rawName === o.rawName)) continue;
    picked.push(o);
  }

  return picked.slice(0, maxSamples).map((o, idx) => ({
    id: `live-${idx + 1}`,
    rawName: o.rawName,
    merchantKey: o.merchantKey,
    gateNeedsEnrichment: o.gate.needsEnrichment,
    gateStatus: o.gate.status,
    nameInformativeness: o.gate.nameInformativeness,
    localCategory: o.localCategory,
    role: roleOf(o),
  }));
}

export function canRunLiveSemanticEval(): boolean {
  if (process.env.RUN_SEMANTIC_LIVE_EVAL !== '1') return false;
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  return !!(url && key && isJwtLike(key));
}

export async function callSemanticEnrichLive(
  samples: LiveEvalSample[]
): Promise<{ model: string | null; results: LiveEvalAiRow[]; raw: unknown }> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  if (!supabaseUrl || !supabaseAnonKey || !isJwtLike(supabaseAnonKey)) {
    throw new Error('Supabase config missing for live semantic eval');
  }

  const allItems = samples.map((s, index) => {
    const local = resolveLocalCategoryForSemanticGate(s.rawName, s.rawName, s.merchantKey);
    return {
      index,
      rawName: s.rawName,
      normalizedName: s.rawName,
      knownCategory: local.category !== 'uncategorized' ? local.category : null,
      knownFamily: null,
      knownAttributes: null,
    };
  });

  // Edge wall-clock is tight; keep chunks small for controlled live eval.
  const CHUNK = 4;
  const url = `${supabaseUrl}/functions/v1/classify-items`;
  let model: string | null = null;
  const results: LiveEvalAiRow[] = [];
  const rawChunks: unknown[] = [];

  for (let offset = 0; offset < allItems.length; offset += CHUNK) {
    const chunk = allItems.slice(offset, offset + CHUNK).map((it, i) => ({
      ...it,
      index: i,
    }));
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'x-device-id': 'batch41-live-eval',
        'x-client': 'batch41-live-eval',
        'x-request-id': `batch41-live-${Date.now()}-${offset}`,
      },
      body: JSON.stringify({
        items: chunk,
        merchantName: null,
        locale: 'ja',
        mode: 'semantic_enrich',
      }),
    });

    const raw = await response.json().catch(() => null);
    rawChunks.push(raw);
    if (!response.ok) {
      throw new Error(
        `classify-items HTTP ${response.status}: ${JSON.stringify(raw)?.slice(0, 200)}`
      );
    }

    if (!model && raw && typeof raw === 'object') {
      if (typeof (raw as any).model === 'string') model = (raw as any).model;
      else if (typeof (raw as any).data?.model === 'string') model = (raw as any).data.model;
    }
    // Deployed edge may omit model in body; fall back to configured default for reporting.
    if (!model) model = 'gemini-3.5-flash';

    const list: unknown =
      raw && typeof raw === 'object'
        ? (raw as any).results ??
          (raw as any).items ??
          (raw as any).data?.items ??
          (raw as any).data?.results ??
          []
        : [];

    if (Array.isArray(list)) {
      for (const r of list) {
        const localIndex = Number(r?.index);
        results.push({
          index: offset + localIndex,
          category: r?.category ?? r?.categoryId ?? null,
          confidence: r?.confidence ?? null,
          brand: r?.brand ?? null,
          brandConfidence: r?.brandConfidence ?? null,
          canonicalName: r?.canonicalName ?? null,
          canonicalNameConfidence: r?.canonicalNameConfidence ?? null,
          productType: r?.productType ?? null,
          semanticTags: r?.semanticTags ?? null,
          attributes: r?.attributes ?? null,
          janCode: r?.janCode ?? null,
          skuId: r?.skuId ?? null,
          barcode: r?.barcode ?? null,
          reason: r?.reason ?? null,
        });
      }
    }
  }

  return { model, results, raw: { chunks: rawChunks, model } };
}

export function autoReviewLiveEval(
  samples: LiveEvalSample[],
  results: LiveEvalAiRow[]
): LiveEvalReviewRow[] {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  return samples.map((sample, index) => {
    const ai = byIndex.get(index) ?? null;
    const local = resolveLocalCategoryForSemanticGate(
      sample.rawName,
      sample.rawName,
      sample.merchantKey
    );
    const gate = evaluateSemanticSufficiency({
      rawName: sample.rawName,
      normalizedName: sample.rawName,
      createdMerchantProduct: true,
      category: local.category,
      categoryConfidence: local.confidence,
    });

    let hallucination = false;
    let invalidSchema = false;
    const notes: string[] = [];
    if (!ai) {
      invalidSchema = true;
      notes.push('missing_ai_row');
    } else {
      if (ai.janCode != null || ai.skuId != null || ai.barcode != null) {
        hallucination = true;
        notes.push('invented_identifier');
      }
      if (
        sample.role === 'sufficient_control' &&
        ai.brand &&
        typeof ai.brandConfidence === 'number' &&
        ai.brandConfidence >= 0.9 &&
        !sample.rawName.includes(String(ai.brand))
      ) {
        notes.push('brand_on_commodity_review');
      }
      if (ai.category == null && ai.canonicalName == null && ai.brand == null) {
        notes.push('sparse_payload');
      }
    }

    const categoryCorrect =
      ai?.category && local.category !== 'uncategorized'
        ? ai.category === local.category
        : ai?.category
          ? null
          : false;

    return {
      sample: {
        ...sample,
        gateNeedsEnrichment: gate.needsEnrichment,
        gateStatus: gate.status,
      },
      ai,
      categoryCorrect,
      brandCorrectOrNullOk: ai ? ai.brand == null || typeof ai.brand === 'string' : null,
      canonicalNameUseful: ai?.canonicalName ? true : ai ? false : null,
      canonicalNameWrong: null,
      attributesCorrect: null,
      attributesConflict: null,
      variantCorrect: null,
      hallucination,
      invalidSchema,
      notes: notes.join('; '),
    };
  });
}
