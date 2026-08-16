// lib/itemRulesV1.ts
// Centralized, rules-first classification for V1 main/sub + tags.
// Inputs should prefer normalized_name (stable normalization).

import type { AnalysisTag, MainCategory, MainSub, SubCategory } from './categoryTaxonomyV1';

export type RuleMatch = {
  main: MainCategory;
  sub: SubCategory | null;
  tags: AnalysisTag[];
  confidence: number; // 0..1
  reason: string;
  brand?: string | null;
  canonical_name?: string | null;
};

type RuleInput = {
  raw_name: string;
  normalized_name: string;
  merchantName?: string;
};

function hasAny(s: string, needles: string[]): boolean {
  return needles.some((n) => s.includes(n));
}

function tagSet(tags: AnalysisTag[]): AnalysisTag[] {
  return Array.from(new Set(tags));
}

function mk(
  main: MainCategory,
  sub: SubCategory | null,
  tags: AnalysisTag[],
  confidence: number,
  reason: string,
  extra?: Partial<Pick<RuleMatch, 'brand' | 'canonical_name'>>
): RuleMatch {
  return {
    main,
    sub,
    tags: tagSet(tags),
    confidence,
    reason,
    brand: extra?.brand ?? null,
    canonical_name: extra?.canonical_name ?? null,
  };
}

export function matchItemRule(input: RuleInput): RuleMatch | null {
  const n = (input.normalized_name || '').toLowerCase();
  const r = (input.raw_name || '').toLowerCase();
  const text = `${n} ${r}`;

  // Brand/context hints (do not decide category alone)
  const brand =
    text.includes('topvalu') || text.includes('トップバリュ') ? 'Topvalu'
    : text.includes('7premium') || text.includes('７プレミアム') || text.includes('7 プレミアム') ? '7 Premium'
    : null;

  // --- High-yield prepared food ---
  if (hasAny(text, ['ラーメン', 'らーめん', 'ramen', 'カップ麺', 'カップめん', 'ヌードル', 'noodle', 'うどん', 'そば', 'パスタ', '炒麺', 'ブルダック', 'buldak'])) {
    return mk('prepared_food', 'instant_food', ['ready_to_eat', 'non_essential_spend'], 0.88, 'Noodles/instant keywords', { brand });
  }

  if (hasAny(text, ['弁当', 'べんとう', 'bento'])) {
    return mk('prepared_food', 'bento', ['ready_to_eat', 'non_essential_spend'], 0.9, 'Bento keywords', { brand });
  }

  if (hasAny(text, ['おにぎり', 'にぎり', 'riceball', 'rice ball', '飯团'])) {
    return mk('prepared_food', 'rice_balls', ['ready_to_eat', 'non_essential_spend'], 0.9, 'Rice ball keywords', { brand });
  }

  if (hasAny(text, ['サンド', 'sandwich', 'ホットドッグ', 'hotdog', 'バーガー', 'burger'])) {
    return mk('prepared_food', 'sandwiches', ['ready_to_eat', 'non_essential_spend'], 0.86, 'Sandwich keywords', { brand });
  }

  if (hasAny(text, ['惣菜', 'そうざい', '唐揚', 'からあげ', 'コロッケ', 'フライ', '天ぷら', '天', 'さつま揚げ', '竹輪', 'ちくわ', 'おでん'])) {
    return mk('prepared_food', 'deli', ['ready_to_eat', 'non_essential_spend'], 0.86, 'Deli keywords', { brand });
  }

  // --- Snacks / sweets (before dairy: エクレア+ミルククリーム must not become ingredients) ---
  if (hasAny(text, ['チョコ', 'choco', 'chocolate'])) {
    return mk('snacks', 'chocolate', ['snack', 'sweet', 'non_essential_spend'], 0.9, 'Chocolate keywords', { brand });
  }
  if (hasAny(text, ['ポテトチップ', 'ポテチ', 'chip', 'chips', 'スナック'])) {
    return mk('snacks', 'chips', ['snack', 'non_essential_spend'], 0.88, 'Chips/snack keywords', { brand });
  }
  if (hasAny(text, ['クッキー', 'ビスケット', 'biscuit', 'cookie'])) {
    return mk('snacks', 'biscuits', ['snack', 'sweet', 'non_essential_spend'], 0.88, 'Biscuits/cookies keywords', { brand });
  }
  if (hasAny(text, ['ケーキ', 'cake', 'デザート', 'dessert', 'プリン', 'pudding', 'シュー', 'エクレア', 'クレープ', 'たい焼き', 'ドーナツ'])) {
    return mk('snacks', 'desserts', ['snack', 'sweet', 'non_essential_spend'], 0.86, 'Dessert keywords', { brand });
  }
  if (hasAny(text, ['アイス', 'ice cream'])) {
    return mk('snacks', 'ice_cream', ['snack', 'sweet', 'non_essential_spend', 'frozen_item'], 0.9, 'Ice cream keywords', { brand });
  }

  // --- Ingredients: vegetables / herbs / mushrooms ---
  if (hasAny(text, ['えのき', 'しめじ', '椎茸', 'しいたけ', '茸', 'きのこ', 'mushroom'])) {
    return mk('ingredients', 'vegetables', ['ingredient', 'cooking_related', 'vegetable_source'], 0.9, 'Mushroom keywords', { brand });
  }
  if (hasAny(text, ['ねぎ', 'ネギ', '葱', '玉ねぎ', 'たまねぎ', 'onion', '香菜', 'パクチー', 'cilantro', 'コリアンダー'])) {
    return mk('ingredients', 'vegetables', ['ingredient', 'cooking_related', 'vegetable_source'], 0.88, 'Vegetable/herb keywords', { brand });
  }
  if (hasAny(text, ['野菜', 'サラダ用', 'レタス', 'ほうれん草', 'キャベツ', 'きゅうり', 'トマト', 'vegetable'])) {
    return mk('ingredients', 'vegetables', ['ingredient', 'cooking_related', 'vegetable_source'], 0.86, 'Vegetable keywords', { brand });
  }

  // --- Dairy / eggs / soy ---
  if (hasAny(text, ['牛乳', 'ミルク', 'milk', 'ヨーグルト', 'yogurt', 'チーズ', 'cheese', 'バター', 'butter'])) {
    return mk('ingredients', 'dairy', ['ingredient', 'cooking_related', 'protein_source'], 0.9, 'Dairy keywords', { brand });
  }
  if (hasAny(text, ['卵', 'たまご', 'タマゴ', 'egg'])) {
    return mk('ingredients', 'eggs', ['ingredient', 'cooking_related', 'protein_source'], 0.9, 'Egg keywords', { brand });
  }
  if (hasAny(text, ['豆腐', 'とうふ', '納豆', 'なっとう', '豆乳', 'soymilk', 'soy', 'tofu'])) {
    return mk('ingredients', 'soy_products', ['ingredient', 'cooking_related', 'protein_source'], 0.9, 'Soy products keywords', { brand });
  }

  // --- Beverages ---
  if (hasAny(text, ['水', 'mineral water', 'water'])) {
    return mk('beverages', 'water', ['non_essential_spend'], 0.82, 'Water keywords', { brand });
  }
  if (hasAny(text, ['お茶', '緑茶', '麦茶', '烏龍茶', 'ほうじ茶', 'tea'])) {
    return mk('beverages', 'tea', ['non_essential_spend'], 0.86, 'Tea keywords', { brand });
  }
  if (hasAny(text, ['コーヒー', 'coffee', 'カフェ'])) {
    return mk('beverages', 'coffee', ['non_essential_spend'], 0.86, 'Coffee keywords', { brand });
  }
  if (hasAny(text, ['ファンタ', 'cola', 'コーラ', 'サイダー', '炭酸', 'soda', 'carbonated'])) {
    return mk('beverages', 'carbonated_drinks', ['sugary_drink', 'non_essential_spend'], 0.88, 'Carbonated drink keywords', { brand });
  }
  if (hasAny(text, ['ジュース', 'nectar', '果汁', 'juice'])) {
    return mk('beverages', 'juice', ['sugary_drink', 'non_essential_spend'], 0.86, 'Juice keywords', { brand });
  }
  if (hasAny(text, ['エナジー', 'energy', 'スポーツ', 'isotonic'])) {
    return mk('beverages', 'energy_drinks', ['sugary_drink', 'non_essential_spend'], 0.84, 'Energy/sports drink keywords', { brand });
  }

  // --- Alcohol ---
  if (hasAny(text, ['ビール', 'beer', 'エール', 'ale', 'ラガー', 'lager', 'ギネス', 'stout', '発泡酒'])) {
    return mk('alcohol', 'beer', ['alcoholic', 'non_essential_spend'], 0.9, 'Beer keywords', { brand });
  }
  if (hasAny(text, ['日本酒', 'sake'])) {
    return mk('alcohol', 'sake', ['alcoholic', 'non_essential_spend'], 0.88, 'Sake keywords', { brand });
  }
  if (hasAny(text, ['焼酎', 'shochu'])) {
    return mk('alcohol', 'shochu', ['alcoholic', 'non_essential_spend'], 0.88, 'Shochu keywords', { brand });
  }
  if (hasAny(text, ['ワイン', 'wine'])) {
    return mk('alcohol', 'wine', ['alcoholic', 'non_essential_spend'], 0.88, 'Wine keywords', { brand });
  }
  if (hasAny(text, ['ウイスキー', 'whisky', 'whiskey'])) {
    return mk('alcohol', 'whisky', ['alcoholic', 'non_essential_spend'], 0.88, 'Whisky keywords', { brand });
  }

  // --- Household ---
  if (hasAny(text, ['ティッシュ', 'tissue', 'トイレット', 'ペーパー'])) {
    return mk('household', 'tissue_paper', ['household_essential'], 0.9, 'Tissue/paper keywords', { brand });
  }
  if (hasAny(text, ['洗剤', 'detergent', 'クリーナ', 'cleaner', '漂白', 'bleach'])) {
    return mk('household', 'cleaning', ['household_essential'], 0.86, 'Cleaning keywords', { brand });
  }

  // --- Health / supplements (not protein snack foods) ---
  if (
    hasAny(text, ['サプリ', 'supplement', 'ビタミン', 'vitamin']) ||
    (hasAny(text, ['プロテイン', 'protein']) &&
      !hasAny(text, ['ボール', 'バー', '菓子', 'スナック', 'ball', 'bar', 'snack', 'クッキー']))
  ) {
    return mk('health', 'supplements', ['non_essential_spend'], 0.84, 'Supplements keywords', { brand });
  }

  return null;
}

