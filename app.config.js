import 'dotenv/config';

export default {
  expo: {
    name: 'ReceiptScannerApp',
    slug: 'ReceiptScannerApp',
    scheme: 'receiptscannerapp',
    extra: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    },
  },
};
