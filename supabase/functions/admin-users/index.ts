// Admin-only user management: create users with a role, reset passwords.
// Runs with the service role; the caller must be an active admin.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROLES = ["admin", "purchase", "stores", "shop_floor", "production_incharge", "factory_manager", "finance"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("role,is_active").eq("id", user.id).single();
    if (!me || !me.is_active || me.role !== "admin") return json({ error: "Administrator only" }, 403);

    const body = await req.json();
    if (body.action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = String(body.role || "shop_floor");
      if (!email || password.length < 8) return json({ error: "Email and password (min 8 chars) required" }, 400);
      if (!ROLES.includes(role)) return json({ error: "Invalid role" }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: body.full_name || "" },
      });
      if (error) return json({ error: error.message }, 400);
      const { error: perr } = await admin.from("profiles")
        .update({ role, is_active: true, full_name: body.full_name || "" }).eq("id", data.user.id);
      if (perr) return json({ error: perr.message }, 400);
      return json({ ok: true, id: data.user.id });
    }
    if (body.action === "reset_password") {
      if (String(body.password || "").length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
