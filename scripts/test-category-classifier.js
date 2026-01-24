#!/usr/bin/env node
/**
 * Test script for category classifier
 * Run with: node scripts/test-category-classifier.js
 * 
 * This script simulates the classification logic without requiring React Native environment
 */

// Mock data
const testCases = [
  { rawName: '牛乳', expectedCategory: 'dairy_eggs', expectedSource: 'rules' },
  { rawName: 'りんご', expectedCategory: 'produce', expectedSource: 'rules' },
  { rawName: 'ビール', expectedCategory: 'alcohol', expectedSource: 'rules' },
  { rawName: 'パン', expectedCategory: 'bakery', expectedSource: 'rules' },
  { rawName: '弁当', expectedCategory: 'quick_meals', expectedSource: 'rules' },
  { rawName: '冷凍食品', expectedCategory: 'frozen_foods', expectedSource: 'rules' },
  { rawName: '不明な商品名', expectedCategory: 'other_grocery', expectedSource: 'fallback' },
];

// Simplified rule-based classifier (for testing)
function classifyByRules(name) {
  const n = (name || '').toLowerCase();

  if (n.includes('牛乳') || n.includes('ミルク') || n.includes('milk')) {
    return { category: 'dairy_eggs', confidence: 0.9 };
  }
  if (n.includes('りんご') || n.includes('果物') || n.includes('fruit')) {
    return { category: 'produce', confidence: 0.9 };
  }
  if (n.includes('ビール') || n.includes('beer') || n.includes('alcohol')) {
    return { category: 'alcohol', confidence: 0.9 };
  }
  if (n.includes('パン') || n.includes('bread')) {
    return { category: 'bakery', confidence: 0.85 };
  }
  if (n.includes('弁当') || n.includes('bento')) {
    return { category: 'quick_meals', confidence: 0.8 };
  }
  if (n.includes('冷凍') || n.includes('frozen')) {
    return { category: 'frozen_foods', confidence: 0.9 };
  }

  return null;
}

// Test function
function testClassification(testCase) {
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
  }

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
console.log('Testing Category Classifier\n');
console.log('='.repeat(60));

let passedCount = 0;
let failedCount = 0;

testCases.forEach((testCase, index) => {
  const testResult = testClassification(testCase);
  
  if (testResult.passed) {
    passedCount++;
    console.log(`✅ Test ${index + 1}: ${testCase.rawName}`);
    console.log(`   Expected: ${testCase.expectedCategory} (${testCase.expectedSource})`);
    console.log(`   Got: ${testResult.result.categoryId} (${testResult.result.source})`);
  } else {
    failedCount++;
    console.log(`❌ Test ${index + 1}: ${testCase.rawName}`);
    console.log(`   Expected: ${testCase.expectedCategory} (${testCase.expectedSource})`);
    console.log(`   Got: ${testResult.result.categoryId} (${testResult.result.source})`);
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
