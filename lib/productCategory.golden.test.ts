/**
 * Golden dataset：基于 5 张真实小票样本固定分类器行为。
 * 任何关键词/优先级调整都必须保持以下样本全部通过。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import { classifyItemByName, type ProductCategory } from './productCategory';

type Sample = [string, ProductCategory];

const RECEIPT_1: Sample[] = [
  ['メークイン', 'food_ingredients'],
  ['ポテト濃厚キング旨', 'snacks_drinks'],
  ['スコーンやみつき', 'snacks_drinks'],
  ['しっとりチョコ', 'snacks_drinks'],
  ['チョコ棒', 'snacks_drinks'],
  ['トッポザ・ショコラ', 'snacks_drinks'],
  ['自社製豆大福', 'snacks_drinks'],
  ['はいから黒糖', 'snacks_drinks'],
  ['ゴールドあずきバー', 'snacks_drinks'],
  ['クロッカンサン', 'snacks_drinks'],
  ['横浜家系', 'ready_to_eat'],
];

const RECEIPT_2: Sample[] = [
  ['鶏卵', 'food_ingredients'],
  ['とりささみ', 'food_ingredients'],
  ['とりきも', 'food_ingredients'],
  ['えのき茸', 'food_ingredients'],
  ['味ぽん360ml', 'food_ingredients'],
  ['コカゼロカフェフ', 'snacks_drinks'],
  ['ポテト濃厚キング旨', 'snacks_drinks'],
  ['ポテト濃厚キングチ', 'snacks_drinks'],
  ['金のミルク抹茶L', 'snacks_drinks'],
  ['チョコレート効果', 'snacks_drinks'],
  ['チョコ棒', 'snacks_drinks'],
  ['三ツ矢サイダー', 'snacks_drinks'],
  ['あんドーナツ白ごま', 'snacks_drinks'],
  ['抹茶あずきモナカ', 'snacks_drinks'],
  ['クロッカンサン', 'snacks_drinks'],
  ['岩手葛巻牛乳', 'food_ingredients'],
  ['LPミルクティー', 'snacks_drinks'],
  ['塩釜発さつまあげ', 'ready_to_eat'],
  ['濃い木綿2個入', 'food_ingredients'],
  ['横浜家系', 'ready_to_eat'],
];

const RECEIPT_3: Sample[] = [
  ['世界TEA チャイラテ', 'snacks_drinks'],
  ['アーモンドチョコ抹茶', 'snacks_drinks'],
  ['アーモンド香るカカオ', 'snacks_drinks'],
  ['アーモンドCクリスプ', 'snacks_drinks'],
  ['モンデリッチョコサン', 'snacks_drinks'],
  ['タルタルチキン南蛮丼', 'ready_to_eat'],
  ['ツナとたまごのサンド', 'ready_to_eat'],
  ['NEWジャイアントコーン', 'snacks_drinks'],
];

const RECEIPT_4: Sample[] = [
  ['有機農産物パクチー', 'food_ingredients'],
  ['FA白桃700', 'snacks_drinks'],
  ['冬のくちどけ', 'snacks_drinks'],
  ['チョコレート効果', 'snacks_drinks'],
  ['チョコ棒', 'snacks_drinks'],
  ['トッポザ・ショコラ', 'snacks_drinks'],
  ['あんドーナツ白ごま', 'snacks_drinks'],
  ['乱切り煮ぼうとう', 'ready_to_eat'],
  ['肉まん', 'ready_to_eat'],
  ['横浜家系', 'ready_to_eat'],
];

const RECEIPT_5: Sample[] = [
  ['キンレイ横浜家系ラーメン', 'ready_to_eat'],
  ['キンレイラーメン横綱', 'ready_to_eat'],
  ['エノキ', 'food_ingredients'],
  ['三ツ矢さくらレモネード', 'snacks_drinks'],
  ['骨付きグリルチキン', 'ready_to_eat'],
  ['ブラックムーン', 'snacks_drinks'],
  ['BPさつま揚げ', 'ready_to_eat'],
  ['S級ワンタン麺超極太', 'ready_to_eat'],
  ['東北産鶏卵', 'food_ingredients'],
  ['まいたけ 大ぶり', 'food_ingredients'],
  ['とろけるカスタードエク', 'snacks_drinks'],
  ['ヤサイ', 'food_ingredients'],
  ['フジ 黒コッペ', 'snacks_drinks'],
  ['さつまあげ', 'ready_to_eat'],
  ['井村屋あずきバー', 'snacks_drinks'],
];

const ALL: Array<[string, Sample[]]> = [
  ['Receipt 1', RECEIPT_1],
  ['Receipt 2', RECEIPT_2],
  ['Receipt 3', RECEIPT_3],
  ['Receipt 4', RECEIPT_4],
  ['Receipt 5', RECEIPT_5],
];

describe('productCategory golden dataset (5 real receipts)', () => {
  for (const [receiptName, samples] of ALL) {
    describe(receiptName, () => {
      for (const [name, expected] of samples) {
        it(`${name} -> ${expected}`, () => {
          expect(classifyItemByName(name)).toBe(expected);
        });
      }
    });
  }
});
