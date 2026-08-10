# V1 Engineering Standard

ReceiptScannerApp V1 产品冻结与工程红线。后续 Phase 开发须遵守本文档。

## 产品正式目标

日本超市 + 日本便利店小票

→ OCR  
→ 人工审核  
→ 保存  
→ 商品历史  
→ 商品搜索  
→ 消费成长分析  

## 首发不做

- 药妆店正式支持
- 餐厅正式支持
- 电商正式支持
- 健康评分 / 营养评分 / 卡路里分析
- 医疗 / 饮食建议
- 云同步
- 社交 / 家庭共享
- 支付系统本轮改动
- 新 AI provider

## 稳定性红线

- **不重写** `scanPipeline` 主流程
- **不重写** `scan-review` 保存顺序与 draft/queue 语义
- **不改变** draft / queue / retry / multi-image 行为
- **不删除** `receipts_v2.db` 或做 destructive migration
- **DB migration 只能 additive**（`ALTER TABLE ADD COLUMN` 等）
- **`analysis_json` 保持向后兼容**（新字段可增，旧字段不删）
- **新功能失败不能导致 receipt 保存失败**（best-effort / graceful degrade）
- **禁止 repo-wide 无关重构**

## 数据一致性原则

- 用户最终编辑结果（`user_items_json`）优先于 OCR 识别 items
- 统一通过 `lib/receiptItems.ts:getReceiptItems()` 读取商品行（分析/统计模块）
- `receipts` / `analysis_json` 仍为 Source of Truth；派生表仅 additive

## 分类原则

- 新写入数据的活跃分类见 `lib/productCategory.ts` → `V1_ACTIVE_PRODUCT_CATEGORIES`
- 商品 category **逐商品**判断；`merchant_type` 不得映射为商品 category
- 仅 **用户手动改分类** 写入 `item_category_mapping`（`source='user_edit'`）

## AI 成本原则

- 主扫描：OCR（1 次）+ 可选 batch classify-items（0–1 次）
- 逐项 `classify-item` 默认关闭（`allowAi=false`）
- Batch AI 须受 `ENABLE_BATCH_AI_CLASSIFICATION` 控制

## Phase 边界

各 Phase 完成后须停止并汇报，不得自动进入下一阶段，除非明确指令。
