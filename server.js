import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import XLSX from "xlsx";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const usePostgres = !!process.env.DATABASE_URL;
const sqlite = usePostgres ? null : new DatabaseSync(path.join(__dirname, "dorm.db"));
if (sqlite) sqlite.exec("PRAGMA foreign_keys = ON");
const pool = usePostgres ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
}) : null;

const sessions = new Set();
function hashPassword(p) {
  return crypto.createHash("sha256").update(p).digest("hex");
}
function newSession() {
  const t = crypto.randomBytes(32).toString("hex");
  sessions.add(t);
  return t;
}
function authed(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") && sessions.has(h.slice(7));
}
function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + (++i));
}
async function all(sql, p = []) {
  if (usePostgres) return (await pool.query(pgSql(sql), p)).rows;
  return sqlite.prepare(sql).all(...p);
}
async function one(sql, p = []) {
  if (usePostgres) return (await pool.query(pgSql(sql), p)).rows[0];
  return sqlite.prepare(sql).get(...p);
}
async function run(sql, p = []) {
  if (usePostgres) {
    const r = await pool.query(pgSql(sql), p);
    return { rows: r.rows, rowCount: r.rowCount, lastInsertRowid: r.rows[0]?.id };
  }
  return sqlite.prepare(sql).run(...p);
}
async function insert(sql, p = []) {
  if (usePostgres) {
    const r = await pool.query(pgSql(sql) + " RETURNING id", p);
    return Number(r.rows[0].id);
  }
  return Number((await run(sql, p)).lastInsertRowid);
}
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => s += c);
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function today() { return new Date().toISOString().slice(0, 10); }
function month() { return new Date().toISOString().slice(0, 7); }
async function initDb() {
  if (usePostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY, room_no TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'ว่าง', rent NUMERIC NOT NULL DEFAULT 2800, note TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY, room_id INTEGER UNIQUE,
        name TEXT NOT NULL, phone TEXT DEFAULT '', id_card TEXT DEFAULT '',
        move_in TEXT, deposit NUMERIC DEFAULT 0, note TEXT DEFAULT '', line_user_id TEXT DEFAULT '',
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS bills (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, bill_month TEXT NOT NULL,
        rent NUMERIC DEFAULT 0, electricity NUMERIC DEFAULT 0, water NUMERIC DEFAULT 0,
        other NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0, due_date TEXT,
        status TEXT DEFAULT 'ค้างชำระ', paid_at TEXT, note TEXT DEFAULT '',
        FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY, bill_id INTEGER NOT NULL, amount NUMERIC NOT NULL,
        paid_at TEXT NOT NULL, method TEXT DEFAULT 'เงินสด', note TEXT DEFAULT '',
        FOREIGN KEY(bill_id) REFERENCES bills(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS meter_readings (id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL, reading_month TEXT NOT NULL, electricity_prev NUMERIC DEFAULT 0, electricity_current NUMERIC DEFAULT 0, water_prev NUMERIC DEFAULT 0, water_current NUMERIC DEFAULT 0, electricity_rate NUMERIC DEFAULT 0, water_rate NUMERIC DEFAULT 0, note TEXT DEFAULT '', UNIQUE(room_id, reading_month), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
    `);
    try { await pool.query("ALTER TABLE meter_readings ADD COLUMN electricity_rate NUMERIC DEFAULT 0"); } catch {}
    try { await pool.query("ALTER TABLE meter_readings ADD COLUMN water_rate NUMERIC DEFAULT 0"); } catch {}
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, room_no TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'ว่าง', rent REAL NOT NULL DEFAULT 2800, note TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER UNIQUE, name TEXT NOT NULL, phone TEXT DEFAULT '', id_card TEXT DEFAULT '', move_in TEXT, deposit REAL DEFAULT 0, note TEXT DEFAULT '', line_user_id TEXT DEFAULT '', FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, bill_month TEXT NOT NULL, rent REAL DEFAULT 0, electricity REAL DEFAULT 0, water REAL DEFAULT 0, other REAL DEFAULT 0, total REAL DEFAULT 0, due_date TEXT, status TEXT DEFAULT 'ค้างชำระ', paid_at TEXT, note TEXT DEFAULT '', FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, amount REAL NOT NULL, paid_at TEXT NOT NULL, method TEXT DEFAULT 'เงินสด', note TEXT DEFAULT '', FOREIGN KEY(bill_id) REFERENCES bills(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS meter_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, reading_month TEXT NOT NULL, electricity_prev REAL DEFAULT 0, electricity_current REAL DEFAULT 0, water_prev REAL DEFAULT 0, water_current REAL DEFAULT 0, electricity_rate REAL DEFAULT 0, water_rate REAL DEFAULT 0, note TEXT DEFAULT '', UNIQUE(room_id, reading_month), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
    `);
    try { sqlite.exec("ALTER TABLE tenants ADD COLUMN line_user_id TEXT DEFAULT ''"); } catch {}
    try { sqlite.exec("ALTER TABLE meter_readings ADD COLUMN electricity_rate REAL DEFAULT 0"); } catch {}
    try { sqlite.exec("ALTER TABLE meter_readings ADD COLUMN water_rate REAL DEFAULT 0"); } catch {}
  }
  if (!await one("SELECT value FROM settings WHERE key='admin_password'"))
    await run("INSERT INTO settings(key,value) VALUES(?,?)", ["admin_password", hashPassword("admin1234")]);
  if (!await one("SELECT value FROM settings WHERE key='admin_username'"))
    await run("INSERT INTO settings(key,value) VALUES(?,?)", ["admin_username", "admin"]);
  if (Number((await one("SELECT COUNT(*) c FROM rooms")).c) === 0) {
    for (let i = 1; i <= 8; i++)
      await run("INSERT INTO rooms(room_no,status,rent) VALUES(?,?,?)", ["R"+i, "ว่าง", 2800]);
  } else {
    const roomMap = { "101":"R1", "102":"R2", "103":"R3", "104":"R4", "105":"R5", "106":"R6", "107":"R7", "108":"R8" };
    for (const [oldNo,newNo] of Object.entries(roomMap)) {
      try { await run("UPDATE rooms SET room_no=? WHERE room_no=?", [newNo, oldNo]); } catch {}
    }
  }
}
async function api(req, res, url) {
  const method = req.method, p = url.pathname;
  if (method === "POST" && p === "/api/login") {
    const d = await body(req);
    const u = (await one("SELECT value FROM settings WHERE key='admin_username'"))?.value;
    const pw = (await one("SELECT value FROM settings WHERE key='admin_password'"))?.value;
    if (d.username === u && hashPassword(d.password || "") === pw)
      return json(res, 200, { token: newSession(), username: u });
    return json(res, 401, { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  }
  if (p.startsWith("/api/") && !authed(req))
    return json(res, 401, { error: "กรุณาเข้าสู่ระบบ" });

  if (method === "GET" && p === "/api/dashboard") {
    const paidSql = "SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(paid_at,1,7)=?";
    return json(res, 200, {
      rooms: await all("SELECT * FROM rooms ORDER BY room_no"),
      tenantCount: Number((await one("SELECT COUNT(*) c FROM tenants")).c),
      occupied: Number((await one("SELECT COUNT(*) c FROM rooms WHERE status='ไม่ว่าง'")).c),
      unpaid: Number((await one("SELECT COALESCE(SUM(total),0) s FROM bills WHERE status!='ชำระแล้ว'")).s),
      paid: Number((await one(paidSql, [month()])).s),
      bills: await all("SELECT b.*,t.name,r.room_no FROM bills b JOIN tenants t ON t.id=b.tenant_id LEFT JOIN rooms r ON r.id=t.room_id ORDER BY b.id DESC LIMIT 10")
    });
  }
  if (method === "GET" && p === "/api/rooms")
    return json(res, 200, await all("SELECT r.*,t.name,t.phone FROM rooms r LEFT JOIN tenants t ON t.room_id=r.id ORDER BY r.room_no"));
  if (method === "GET" && p === "/api/tenants")
    return json(res, 200, await all("SELECT t.*,r.room_no FROM tenants t LEFT JOIN rooms r ON r.id=t.room_id ORDER BY t.id DESC"));
  if (method === "GET" && p === "/api/bills")
    return json(res, 200, await all("SELECT b.*,t.name,r.room_no FROM bills b JOIN tenants t ON t.id=b.tenant_id LEFT JOIN rooms r ON r.id=t.room_id ORDER BY b.id DESC"));
  if (method === "GET" && p === "/api/meter-readings")
    return json(res, 200, await all("SELECT m.*,r.room_no FROM meter_readings m JOIN rooms r ON r.id=m.room_id ORDER BY m.reading_month DESC,r.room_no"));
  if (method === "POST" && p === "/api/meter-readings") {
    const d = await body(req);
    const roomId = Number(d.room_id), m = d.reading_month || month();
    if (!roomId) return json(res, 400, { error: "กรุณาเลือกห้อง" });
    const vals = [roomId,m,Number(d.electricity_prev||0),Number(d.electricity_current||0),Number(d.water_prev||0),Number(d.water_current||0),Number(d.electricity_rate||0),Number(d.water_rate||0),d.note||""];
    await run("INSERT INTO meter_readings(room_id,reading_month,electricity_prev,electricity_current,water_prev,water_current,electricity_rate,water_rate,note) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id,reading_month) DO UPDATE SET electricity_prev=excluded.electricity_prev,electricity_current=excluded.electricity_current,water_prev=excluded.water_prev,water_current=excluded.water_current,electricity_rate=excluded.electricity_rate,water_rate=excluded.water_rate,note=excluded.note", vals);
    return json(res, 200, { ok: true });
  }
  if (method === "DELETE" && p.startsWith("/api/meter-readings/")) {
    await run("DELETE FROM meter_readings WHERE id=?", [Number(p.split("/").pop())]);
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && p === "/api/settings")
    return json(res, 200, await all("SELECT key,value FROM settings WHERE key IN ('line_channel_token','line_public_url','line_channel_secret') ORDER BY key"));

  if (method === "GET" && p === "/api/export/payments") {
    const m = url.searchParams.get("month") || month();
    const rows = await all("SELECT b.bill_month,t.name,r.room_no,p.amount,p.paid_at,p.method,p.note FROM payments p JOIN bills b ON b.id=p.bill_id JOIN tenants t ON t.id=b.tenant_id LEFT JOIN rooms r ON r.id=t.room_id WHERE substr(p.paid_at,1,7)=? ORDER BY p.paid_at,p.id", [m]);
    const data = [["เดือน","ห้อง","ผู้เช่า","จำนวนเงิน","วันที่จ่าย","วิธีชำระ","หมายเหตุ"], ...rows.map(x=>[x.bill_month,x.room_no||"-",x.name,Number(x.amount),x.paid_at,x.method||"เงินสด",x.note||""])];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{wch:12},{wch:10},{wch:28},{wch:14},{wch:14},{wch:16},{wch:30}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "การจ่ายเงิน");
    const buf = XLSX.write(wb, {type:"buffer", bookType:"xlsx"});
    res.writeHead(200, { "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return res.end(buf);
  }
  if (method === "POST" && p === "/api/change-password") {
    const d = await body(req);
    if (!d.new_password || String(d.new_password).length < 8)
      return json(res, 400, { error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร" });
    const old = (await one("SELECT value FROM settings WHERE key='admin_password'"))?.value;
    if (hashPassword(d.old_password || "") !== old)
      return json(res, 400, { error: "รหัสผ่านเดิมไม่ถูกต้อง" });
    await run("UPDATE settings SET value=? WHERE key='admin_password'", [hashPassword(d.new_password)]);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && p === "/api/line/send-bill") {
    const d = await body(req);
    const b = await one("SELECT b.*,t.name,t.line_user_id,r.room_no FROM bills b JOIN tenants t ON t.id=b.tenant_id LEFT JOIN rooms r ON r.id=t.room_id WHERE b.id=?", [Number(d.bill_id)]);
    const token = (await one("SELECT value FROM settings WHERE key='line_channel_token'"))?.value;
    const publicUrl = (await one("SELECT value FROM settings WHERE key='line_public_url'"))?.value;
    if (!b?.line_user_id) return json(res, 400, { error: "ผู้เช่ายังไม่มี LINE User ID" });
    if (!token) return json(res, 400, { error: "ยังไม่ได้ตั้งค่า LINE Channel Access Token" });
    if (!publicUrl) return json(res, 400, { error: "ยังไม่ได้ตั้งค่า Public URL" });
    const billUrl = publicUrl.replace(/\/$/, "") + "/bill/" + b.id;
    const payload = { to: b.line_user_id, messages: [{ type: "text", text: "แจ้งบิลค่าเช่า ห้อง " + (b.room_no || "-") + " ประจำเดือน " + b.bill_month + "\nยอดรวม " + Number(b.total).toLocaleString("th-TH") + " บาท\nดูบิล: " + billUrl }] };
    const rr = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(payload) });
    if (!rr.ok) return json(res, 400, { error: "LINE ส่งไม่สำเร็จ: " + await rr.text() });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && p === "/api/tenants") {
    const d = await body(req);
    if (!d.name) return json(res, 400, { error: "กรุณาระบุชื่อผู้เช่า" });
    const id = await insert("INSERT INTO tenants(room_id,name,phone,id_card,move_in,deposit,note,line_user_id) VALUES(?,?,?,?,?,?,?,?)",
      [d.room_id || null, d.name, d.phone || "", d.id_card || "", d.move_in || today(), Number(d.deposit || 0), d.note || "", d.line_user_id || ""]);
    if (d.room_id) await run("UPDATE rooms SET status='ไม่ว่าง' WHERE id=?", [d.room_id]);
    return json(res, 201, { id });
  }
  if (method === "PUT" && p.startsWith("/api/tenants/")) {
    const id = Number(p.split("/").pop()), d = await body(req);
    const old = await one("SELECT room_id FROM tenants WHERE id=?", [id]);
    await run("UPDATE tenants SET room_id=?,name=?,phone=?,id_card=?,move_in=?,deposit=?,note=?,line_user_id=? WHERE id=?",
      [d.room_id || null, d.name, d.phone || "", d.id_card || "", d.move_in || null, Number(d.deposit || 0), d.note || "", d.line_user_id || "", id]);
    if (old?.room_id && old.room_id !== Number(d.room_id)) await run("UPDATE rooms SET status='ว่าง' WHERE id=?", [old.room_id]);
    if (d.room_id) await run("UPDATE rooms SET status='ไม่ว่าง' WHERE id=?", [d.room_id]);
    return json(res, 200, { ok: true });
  }
  if (method === "DELETE" && p.startsWith("/api/tenants/")) {
    const id = Number(p.split("/").pop()), t = await one("SELECT room_id FROM tenants WHERE id=?", [id]);
    await run("DELETE FROM tenants WHERE id=?", [id]);
    if (t?.room_id) await run("UPDATE rooms SET status='ว่าง' WHERE id=?", [t.room_id]);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && p === "/api/bills") {
    const d = await body(req), tenant = await one("SELECT * FROM tenants WHERE id=?", [Number(d.tenant_id)]);
    if (!tenant) return json(res, 400, { error: "ไม่พบผู้เช่า" });
    const rent = Number(d.rent || 0), electricity = Number(d.electricity || 0), water = Number(d.water || 0), other = Number(d.other || 0);
    const total = rent + electricity + water + other;
    const id = await insert("INSERT INTO bills(tenant_id,bill_month,rent,electricity,water,other,total,due_date,note) VALUES(?,?,?,?,?,?,?,?,?)",
      [tenant.id, d.bill_month || month(), rent, electricity, water, other, total, d.due_date || "", d.note || ""]);
    return json(res, 201, { id, total });
  }
  if (method === "POST" && p.startsWith("/api/bills/") && p.endsWith("/pay")) {
    const id = Number(p.split("/")[3]), d = await body(req), b = await one("SELECT * FROM bills WHERE id=?", [id]);
    if (!b) return json(res, 404, { error: "ไม่พบบิล" });
    const amount = Number(d.amount || b.total), paidAt = d.paid_at || today();
    await run("INSERT INTO payments(bill_id,amount,paid_at,method,note) VALUES(?,?,?,?,?)", [id, amount, paidAt, d.method || "เงินสด", d.note || ""]);
    await run("UPDATE bills SET status='ชำระแล้ว',paid_at=? WHERE id=?", [paidAt, id]);
    return json(res, 200, { ok: true });
  }
  if (method === "DELETE" && p.startsWith("/api/bills/")) {
    await run("DELETE FROM bills WHERE id=?", [Number(p.split("/").pop())]);
    return json(res, 200, { ok: true });
  }
  if (method === "PUT" && p.startsWith("/api/rooms/")) {
    const id = Number(p.split("/").pop()), d = await body(req);
    await run("UPDATE rooms SET status=?,rent=?,note=? WHERE id=?", [d.status || "ว่าง", Number(d.rent || 2800), d.note || "", id]);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && p === "/api/settings") {
    const d = await body(req);
    for (const [key, value] of Object.entries(d))
      await run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(value)]);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "API not found" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);
  try {
    if (url.pathname.startsWith("/bill/")) {
      const id = Number(url.pathname.split("/")[2]);
      const b = await one("SELECT b.*,t.name,r.room_no FROM bills b JOIN tenants t ON t.id=b.tenant_id LEFT JOIN rooms r ON r.id=t.room_id WHERE b.id=?", [id]);
      if (!b) { res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); return res.end("ไม่พบบิล"); }
      const html = `<!doctype html><html lang="th"><meta charset="utf-8"><title>ใบแจ้งค่าใช้จ่าย</title><style>body{font-family:Arial;max-width:700px;margin:40px auto;padding:20px}h1{text-align:center}table{width:100%;border-collapse:collapse}td{padding:12px;border-bottom:1px solid #ddd}.total{font-size:24px;font-weight:bold;text-align:right}@media print{button{display:none}}</style><h1>ใบแจ้งค่าใช้จ่าย</h1><p>ห้อง: ${b.room_no||"-"}<br>ผู้เช่า: ${b.name}<br>ประจำเดือน: ${b.bill_month}</p><table><tr><td>ค่าเช่า</td><td align="right">${Number(b.rent).toLocaleString()} บาท</td></tr><tr><td>ค่าไฟ</td><td align="right">${Number(b.electricity).toLocaleString()} บาท</td></tr><tr><td>ค่าน้ำ</td><td align="right">${Number(b.water).toLocaleString()} บาท</td></tr><tr><td>อื่นๆ</td><td align="right">${Number(b.other).toLocaleString()} บาท</td></tr></table><p class="total">รวม ${Number(b.total).toLocaleString()} บาท</p><button onclick="print()">พิมพ์ / บันทึก PDF</button></html>`;
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"}); return res.end(html);
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const publicDir = path.join(__dirname, "public"), full = path.join(publicDir, file);
    if (!full.startsWith(publicDir)) return json(res, 403, {error:"Forbidden"});
    if (!fs.existsSync(full)) return json(res, 404, {error:"Not found"});
    res.writeHead(200, {"Content-Type":mime[path.extname(full)] || "application/octet-stream"});
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, {error:e.message});
  }
});

await initDb();
server.listen(PORT, HOST, () => console.log("Dorm Manager running on port " + PORT));
