import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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

console.log("OK: uploaded with contentType text/html; charset=utf-8");
