#!/usr/bin/env node
/**
 * Test script for category classifier (rules-based + optional AI simulation)
 * Run with: node scripts/test-category-classifier.js
 * 
 * Set SIMULATE_AI=1 to mock AI path without network:
 *   SIMULATE_AI=1 node scripts/test-category-classifier.js
 * 
 * This script simulates the classification logic without requiring React Native environment
 * Tests rule-based matching for Japanese grocery receipts
 */

const SIMULATE_AI = process.env.SIMULATE_AI === '1';

// Test cases: Japanese product names with expected category and source
const testCases = [
  // Dairy & Eggs
  { rawName: '牛乳', expectedCategory: 'dairy_eggs', expectedSource: 'rules' },
  { rawName: 'チーズ', expectedCategory: 'dairy_eggs', expectedSource: 'rules' },
  { rawName: 'たまご', expectedCategory: 'dairy_eggs', expectedSource: 'rules' },
  
  // Produce
  { rawName: 'りんご', expectedCategory: 'produce', expectedSource: 'rules' },
  { rawName: '野菜', expectedCategory: 'produce', expectedSource: 'rules' },
  
  // Meat & Seafood
  { rawName: '牛肉', expectedCategory: 'meat_seafood', expectedSource: 'rules' },
  { rawName: '刺身', expectedCategory: 'meat_seafood', expectedSource: 'rules' },
  
  // Bakery
  { rawName: 'パン', expectedCategory: 'bakery', expectedSource: 'rules' },
  
  // Quick meals
  { rawName: '弁当', expectedCategory: 'quick_meals', expectedSource: 'rules' },
  
  // Frozen foods
  { rawName: '冷凍食品', expectedCategory: 'frozen_foods', expectedSource: 'rules' },
  
  // Alcohol
  { rawName: 'ビール', expectedCategory: 'alcohol', expectedSource: 'rules' },
  
  // Non-alcoholic drinks
  { rawName: 'コーヒー', expectedCategory: 'non_alcoholic_drinks', expectedSource: 'rules' },
  
  // Snacks & Sweets
  { rawName: 'チョコレート', expectedCategory: 'snacks_sweets', expectedSource: 'rules' },
  
  // Condiments
  { rawName: '醤油', expectedCategory: 'condiments', expectedSource: 'rules' },
  
  // Household
  { rawName: 'ティッシュ', expectedCategory: 'household', expectedSource: 'rules' },
  
  // Fallback
  { rawName: '不明な商品名', expectedCategory: 'other_grocery', expectedSource: 'fallback' },
  { rawName: 'テスト商品', expectedCategory: 'other_grocery', expectedSource: 'fallback' },
];

// Simplified rule-based classifier (matches lib/categoryClassifier.ts logic)
function classifyByRules(name) {
  const n = (name || '').toLowerCase();

  // Dairy & Eggs - confidence 0.9 (check before meat to avoid "牛乳" matching "牛")
  if (
    n.includes('牛乳') || n.includes('ミルク') || n.includes('チーズ') || n.includes('ヨーグルト') ||
    n.includes('バター') || n.includes('卵') || n.includes('たまご') || n.includes('milk') ||
    n.includes('cheese') || n.includes('yogurt') || n.includes('butter') || n.includes('egg')
  ) {
    return { category: 'dairy_eggs', confidence: 0.9, reason: 'Dairy/eggs keywords' };
  }

  // Produce (vegetables/fruits) - confidence 0.9
  if (
    n.includes('野菜') || n.includes('白菜') || n.includes('ねぎ') || n.includes('えのき') ||
    n.includes('茸') || n.includes('椎茸') || n.includes('果物') || n.includes('りんご') ||
    n.includes('みかん') || n.includes('バナナ') || n.includes('vegetable') || n.includes('fruit')
  ) {
    return { category: 'produce', confidence: 0.9, reason: 'Produce keywords' };
  }

  // Meat & Seafood - confidence 0.9 (check after dairy to avoid "牛乳" matching "牛")
  if (
    n.includes('牛') || n.includes('豚') || n.includes('鶏') || n.includes('とり') ||
    n.includes('魚') || n.includes('刺身') || n.includes('meat') || n.includes('fish') ||
    n.includes('chicken') || n.includes('beef') || n.includes('pork') || n.includes('seafood')
  ) {
    return { category: 'meat_seafood', confidence: 0.9, reason: 'Meat/seafood keywords' };
  }

  // Bakery - confidence 0.85
  if (
    n.includes('パン') || n.includes('ロール') || n.includes('クロワッサン') || n.includes('ケーキ') ||
    n.includes('bread') || n.includes('pastry') || n.includes('croissant') || n.includes('cake')
  ) {
    return { category: 'bakery', confidence: 0.85, reason: 'Bakery keywords' };
  }

  // Staples - confidence 0.85
  if (
    n.includes('米') || n.includes('ご飯') || n.includes('うどん') || n.includes('そば') ||
    n.includes('ラーメン') || n.includes('パスタ') || n.includes('rice') || n.includes('noodle') ||
    n.includes('bean') || n.includes('豆')
  ) {
    return { category: 'staples', confidence: 0.85, reason: 'Staples keywords' };
  }

  // Quick meals - confidence 0.8
  if (
    n.includes('弁当') || n.includes('おにぎり') || n.includes('惣菜') || n.includes('天') ||
    n.includes('揚げ') || n.includes('からあげ') || n.includes('唐揚') || n.includes('フライ') ||
    n.includes('コロッケ') || n.includes('とり天') || n.includes('bento') || n.includes('ready') ||
    n.includes('instant')
  ) {
    return { category: 'quick_meals', confidence: 0.8, reason: 'Quick meals keywords' };
  }

  // Frozen foods - confidence 0.9
  if (n.includes('冷凍') || n.includes('冷凍食品') || n.includes('frozen') || n.includes('freezer')) {
    return { category: 'frozen_foods', confidence: 0.9, reason: 'Frozen keywords' };
  }

  // Canned and preserved - confidence 0.85
  if (
    n.includes('缶詰') || n.includes('瓶詰') || n.includes('保存食') || n.includes('canned') ||
    n.includes('preserved') || n.includes('jar')
  ) {
    return { category: 'canned_preserved', confidence: 0.85, reason: 'Canned/preserved keywords' };
  }

  // Other beverages - confidence 0.8
  if (
    n.includes('スポーツ') || n.includes('エナジー') || n.includes('栄養') || n.includes('sports') ||
    n.includes('energy') || n.includes('isotonic')
  ) {
    return { category: 'beverages_other', confidence: 0.8, reason: 'Other beverages keywords' };
  }

  // Health supplements - confidence 0.85
  if (
    n.includes('サプリ') || n.includes('ビタミン') || n.includes('栄養補助') || n.includes('supplement') ||
    n.includes('vitamin') || n.includes('health')
  ) {
    return { category: 'health_supplements', confidence: 0.85, reason: 'Health supplements keywords' };
  }

  // Snacks & Sweets - confidence 0.85
  if (
    n.includes('チョコ') || n.includes('ビス') || n.includes('ビスケット') || n.includes('クッキー') ||
    n.includes('スナック') || n.includes('ナッツ') || n.includes('アイス') || n.includes('デザート') ||
    n.includes('菓子') || n.includes('chocolate') || n.includes('snack') || n.includes('cookie') ||
    n.includes('sweet') || n.includes('candy')
  ) {
    return { category: 'snacks_sweets', confidence: 0.85, reason: 'Snacks/sweets keywords' };
  }

  // Non-alcoholic drinks - confidence 0.85
  if (
    n.includes('お茶') || n.includes('茶') || n.includes('コーヒー') || n.includes('coffee') ||
    n.includes('コーラ') || n.includes('ファンタ') || n.includes('ジュース') || n.includes('drink') ||
    n.includes('水') || n.includes('tea') || n.includes('juice')
  ) {
    return { category: 'non_alcoholic_drinks', confidence: 0.85, reason: 'Non-alcoholic drinks keywords' };
  }

  // Alcohol - confidence 0.9
  if (
    n.includes('ビール') || n.includes('酒') || n.includes('ワイン') || n.includes('日本酒') ||
    n.includes('焼酎') || n.includes('beer') || n.includes('wine') || n.includes('sake') ||
    n.includes('alcohol')
  ) {
    return { category: 'alcohol', confidence: 0.9, reason: 'Alcohol keywords' };
  }

  // Condiments - confidence 0.85
  if (
    n.includes('醤油') || n.includes('味噌') || n.includes('塩') || n.includes('砂糖') ||
    n.includes('油') || n.includes('ソース') || n.includes('sauce') || n.includes('soy') ||
    n.includes('salt') || n.includes('sugar')
  ) {
    return { category: 'condiments', confidence: 0.85, reason: 'Condiments keywords' };
  }

  // Household - confidence 0.85
  if (
    n.includes('紙') || n.includes('ティッシュ') || n.includes('洗剤') || n.includes('シャンプー') ||
    n.includes('歯磨き') || n.includes('タオル') || n.includes('household') || n.includes('tissue') ||
    n.includes('shampoo')
  ) {
    return { category: 'household', confidence: 0.85, reason: 'Household keywords' };
  }

  return null;
}

// Mock AI classification (only used when SIMULATE_AI=1)
function mockAiClassification(rawName) {
  if (!SIMULATE_AI) return null;
  
  // Simple mock: return a category for unknown items (simulating AI fallback)
  // In real scenario, this would call Edge Function
  const n = (rawName || '').toLowerCase();
  
  // Mock AI might classify some unknown items
  if (n.includes('商品') || n.includes('item')) {
    return {
      categoryId: 'other_grocery',
      confidence: 0.7,
      reason: 'Mock AI classification',
    };
  }
  
  return null;
}

// Test function (simulates classifyItem: mapping -> rules -> ai -> fallback)
function testClassification(testCase) {
  // 1. Mapping (not tested in this script - would require DB)
  // 2. Rules
  const ruleResult = classifyByRules(testCase.rawName);
  
  let result = {
    categoryId: 'other_grocery',
    confidence: 0.0,
    source: 'fallback',
  };

  if (ruleResult && ruleResult.confidence >= 0.8) {
    result = {
      categoryId: ruleResult.category,
      confidence: ruleResult.confidence,
      source: 'rules',
    };
  } else if (SIMULATE_AI) {
    // 3. AI fallback (only when rules confidence < 0.8)
    const aiResult = mockAiClassification(testCase.rawName);
    if (aiResult && aiResult.confidence >= 0.6) {
      result = {
        categoryId: aiResult.categoryId,
        confidence: aiResult.confidence,
        source: 'ai',
      };
    }
  }
  // 4. Fallback (already set above)

  const passed = 
    result.categoryId === testCase.expectedCategory &&
    result.source === testCase.expectedSource;

  return {
    ...testCase,
    result,
    passed,
  };
}

// Run tests
console.log(`Testing Category Classifier (Rules-Based${SIMULATE_AI ? ' + AI Simulation' : ''})\n`);
if (SIMULATE_AI) {
  console.log('Note: SIMULATE_AI=1 enabled - AI path will be simulated for items without rule matches\n');
}
console.log('='.repeat(60));

let passedCount = 0;
let failedCount = 0;

testCases.forEach((testCase, index) => {
  const testResult = testClassification(testCase);
  
  if (testResult.passed) {
    passedCount++;
    console.log(`✅ Test ${index + 1}: ${testCase.rawName}`);
    console.log(`   Expected: ${testCase.expectedCategory} (${testCase.expectedSource})`);
    console.log(`   Got: ${testResult.result.categoryId} (${testResult.result.source}) [confidence: ${testResult.result.confidence}]`);
  } else {
    failedCount++;
    console.log(`❌ Test ${index + 1}: ${testCase.rawName}`);
    console.log(`   Expected: ${testCase.expectedCategory} (${testCase.expectedSource})`);
    console.log(`   Got: ${testResult.result.categoryId} (${testResult.result.source}) [confidence: ${testResult.result.confidence}]`);
  }
  console.log('');
});

console.log('='.repeat(60));
console.log(`Results: ${passedCount} passed, ${failedCount} failed out of ${testCases.length} tests`);

if (failedCount === 0) {
  console.log('✅ All tests passed!');
  process.exit(0);
} else {
  console.log('❌ Some tests failed');
  process.exit(1);
}
