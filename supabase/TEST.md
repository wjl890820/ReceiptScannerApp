# OCR Edge Function Test Guide

## Test 1: Ping Endpoint (Anonymous)

```bash
curl -i -X POST "https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/ocr-receipt" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -H "x-device-id: test-device-001" \
  -d '{"ping":true}'
```

**Expected Response:**
```json
HTTP/1.1 200 OK
{
  "ok": true,
  "mode": "anon",
  "userId": null,
  "deviceId": "test-devi"
}
```

## Test 2: Ping Endpoint (Logged-in User with JWT)

```bash
curl -i -X POST "https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/ocr-receipt" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <JWT_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "x-device-id: test-device-001" \
  -d '{"ping":true}'
```

**Expected Response (if JWT valid):**
```json
HTTP/1.1 200 OK
{
  "ok": true,
  "mode": "user",
  "userId": "<user-id>",
  "deviceId": "<user-id-prefix>"
}
```

## Test 3: Anonymous OCR Request

```bash
curl -i -X POST "https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/ocr-receipt" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -H "x-device-id: test-device-001" \
  -d '{
    "imageBase64": "<base64-encoded-image>",
    "mimeType": "image/jpeg"
  }'
```

**Expected:** Should NOT return "Invalid JWT" error.

## Test 4: Missing Device ID (Should Fail)

```bash
curl -i -X POST "https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/ocr-receipt" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"ping":true}'
```

**Expected Response:**
```json
HTTP/1.1 400 Bad Request
{
  "success": false,
  "error": {
    "code": "OCR_DEVICE_ID_REQUIRED",
    "message": "x-device-id header is required for anonymous requests"
  }
}
```

## Test 5: CORS Preflight

```bash
curl -i -X OPTIONS "https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/ocr-receipt" \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,apikey,content-type,x-device-id"
```

**Expected:** 200 OK with CORS headers.
