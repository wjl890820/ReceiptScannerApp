import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing env: EXPO_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const filePath = "legal/privacy-policy.html";
if (!fs.existsSync(filePath)) {
  console.error("File not found:", filePath);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const data = fs.readFileSync(filePath);

const { error } = await supabase.storage
  .from("legal")
  .upload("privacy-policy.html", data, {
    upsert: true,
    contentType: "text/html; charset=utf-8",
    cacheControl: "3600",
  });

if (error) {
  console.error("Upload error:", error);
  process.exit(1);
}

// 校验对象存在
const { data: list, error: listErr } = await supabase.storage.from("legal").list("", { limit: 50 });
if (listErr || !list?.length) {
  console.error("Verification failed: could not list bucket or bucket empty", listErr?.message || "");
  process.exit(1);
}
const hasFile = list.some((f) => f.name === "privacy-policy.html");
if (!hasFile) {
  console.error("Verification failed: privacy-policy.html not found in bucket after upload");
  process.exit(1);
}

console.log("OK: uploaded with contentType text/html; charset=utf-8, object verified");
