# Privacy Policy / プライバシーポリシー

## English

**Last Updated: 2024**

### Data Collection

Receipt Scanner App ("we", "our", "us") collects and processes the following data:

1. **Receipt Images**: Images you capture or select are processed locally on your device and sent to our OCR service (Supabase Edge Function) for text extraction. Images are NOT permanently stored on our servers.

2. **OCR Usage Data**: We record anonymized usage statistics (request counts, token usage) for cost analysis and abuse prevention. This data does NOT include:
   - Your receipt images
   - Full receipt content
   - Merchant names or addresses
   - Personal information

3. **Local Storage**: All receipt data (extracted text, totals, items) is stored locally on your device using SQLite. We do NOT have access to this data.

4. **Device ID**: We use a device-specific identifier (hashed) for rate limiting and usage tracking. This cannot be used to identify you personally.

### Data Usage

- OCR processing: Extract text from receipt images
- Analytics: Aggregate spending statistics (computed locally)
- Cost tracking: Monitor API usage to prevent abuse

### Data Sharing

We do NOT share your data with third parties except:
- Supabase (hosting OCR service) - images are processed and immediately discarded
- Google Gemini API (OCR processing) - images are sent for text extraction only

### Your Rights

- All data is stored locally on your device
- You can delete all data by uninstalling the app
- No account required - fully anonymous usage

### Contact

For privacy concerns, please contact us through the in-app feedback feature.

---

## 日本語

**最終更新日: 2024年**

### データ収集

レシートスキャナーアプリ（「当社」「私たち」）は、以下のデータを収集・処理します：

1. **レシート画像**: 撮影または選択した画像は、デバイス上でローカルに処理され、テキスト抽出のためにOCRサービス（Supabase Edge Function）に送信されます。画像は当社のサーバーに永続的に保存されません。

2. **OCR使用データ**: コスト分析と不正利用防止のため、匿名化された使用統計（リクエスト数、トークン使用量）を記録します。このデータには以下は含まれません：
   - レシート画像
   - レシート全文
   - 店舗名や住所
   - 個人情報

3. **ローカルストレージ**: すべてのレシートデータ（抽出されたテキスト、合計金額、商品）は、SQLiteを使用してデバイス上にローカルに保存されます。当社はこのデータにアクセスできません。

4. **デバイスID**: レート制限と使用状況追跡のために、デバイス固有の識別子（ハッシュ化）を使用します。これは個人を特定するために使用できません。

### データの使用

- OCR処理: レシート画像からテキストを抽出
- 分析: 支出統計の集計（ローカルで計算）
- コスト追跡: 不正利用を防ぐためのAPI使用状況の監視

### データ共有

以下の場合を除き、データを第三者と共有しません：
- Supabase（OCRサービスのホスティング）- 画像は処理され、即座に破棄されます
- Google Gemini API（OCR処理）- テキスト抽出のみのために画像が送信されます

### あなたの権利

- すべてのデータはデバイス上にローカルに保存されます
- アプリをアンインストールすることで、すべてのデータを削除できます
- アカウント不要 - 完全匿名での使用が可能です

### お問い合わせ

プライバシーに関する懸念については、アプリ内のフィードバック機能からお問い合わせください。
