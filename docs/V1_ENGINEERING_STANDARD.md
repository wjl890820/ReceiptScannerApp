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
- Engagement Milestone Engine 必须完全 deterministic，不得调用 AI 或网络服务

## Engagement Milestone Freeze

- 唯一正式阈值由 `lib/engagementMilestones.ts:ENGAGEMENT_MILESTONES` 定义：`1 / 3 / 5 / 10`
- milestone count 只计算 `isV1SupportedReceipt()` 判定为 supermarket / convenience 的 receipts；不得使用 `receipt_items` 行数
- 第 1 / 3 张统计通过 `getReceiptItems()` 读取最终商品；第 5 / 10 张跨小票商品聚合必须使用 `receipt_items INNER JOIN receipts`
- derived index coverage 不完整时 frequent products 必须 graceful degrade，不得同步扫描或重建全库
- normalized price 只允许复用 `productPriceHistory` 的 safe eligibility 结果，不得复制价格公式或生成趋势、推荐、最便宜结论
- milestone engine 输出纯数据与 summary key，不包含 UI、支付、quota 或 notification 行为
- 未来第 3 张成功保存后的 UX 顺序固定为：先展示第 3 张解锁价值，再展示免费额度用尽 / 购买扫描次数；Phase 5A 不实现该 UI
- Post-Save Summary 只能在 receipt 落库、draft 清理、queue 推进、learning 与既有 post-save 工作完成后展示；summary 失败不得改变保存成功事实
- multi-receipt 流程每张保存后都展示独立 Summary，再由 Summary 继续 authoritative queue 中的下一张；必须使用 replace 避免返回已删除 draft
- 未来 paywall / scan-credit 提示只能发生在第 3 张 Summary 的 milestone 价值展示及用户继续操作之后

## Phase 边界

各 Phase 完成后须停止并汇报，不得自动进入下一阶段，除非明确指令。
