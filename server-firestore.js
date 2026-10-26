import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import XLSX from "xlsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = new Set((process.env.CORS_ORIGINS || "https://dorm-manager-43352.web.app,https://dorm-manager-43352.firebaseapp.com").split(",").map(x => x.trim()).filter(Boolean));
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const firebaseCredential = serviceAccountJson ? cert(JSON.parse(serviceAccountJson)) : applicationDefault();
initializeApp({ credential: firebaseCredential, projectId: process.env.FIREBASE_PROJECT_ID || "dorm-manager-43352" });
const db = getFirestore();
const sessions = new Set();
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8" };
const json = (res, code, data) => { res.writeHead(code, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" }); res.end(JSON.stringify(data)); };
const hash = p => crypto.createHash("sha256").update(p).digest("hex");
const esc = v => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"','&quot;').replaceAll("'","&#39;");
const today = () => new Date().toISOString().slice(0,10);
const month = () => new Date().toISOString().slice(0,7);
async function body(req) { let s=""; for await (const c of req) s+=c; return s ? JSON.parse(s) : {}; }
async function docs(name) { const s=await db.collection(name).get(); return s.docs.map(d=>({ ...d.data(), id: d.data().id ?? (Number.isFinite(Number(d.id)) ? Number(d.id) : d.id) })); }
async function get(name,id) { const d=await db.collection(name).doc(String(id)).get(); return d.exists ? {...d.data(), id:d.data().id ?? (Number.isFinite(Number(d.id))?Number(d.id):d.id)} : null; }
async function save(name,id,data) { await db.collection(name).doc(String(id)).set(data,{merge:true}); }
async function nextId(name) { const ref=db.collection("_counters").doc(name); return db.runTransaction(async tx=>{const s=await tx.get(ref);const n=Number(s.data()?.value||0)+1;tx.set(ref,{value:n});return n;}); }
async function add(name,data) { const id=await nextId(name); await save(name,id,{...data,id}); return id; }
async function remove(name,id) { await db.collection(name).doc(String(id)).delete(); }
async function setting(key) { const x=(await docs("settings")).find(v=>v.key===key); return x?.value; }
async function setSetting(key,value) { const ref=db.collection("settings").doc(String(key)); await ref.set({key,value:String(value)},{merge:true}); }
const ROOM_STATUS = Object.freeze({ VACANT:"\u0e27\u0e48\u0e32\u0e07", RESERVED:"\u0e15\u0e34\u0e14\u0e08\u0e2d\u0e07", OCCUPIED:"\u0e44\u0e21\u0e48\u0e27\u0e48\u0e32\u0e07" });
async function syncRoomStatus(roomId) { const room=await get("rooms",roomId); if(!room)return; const tenants=await docs("tenants"); const occupied=tenants.some(t=>Number(t.room_id)===Number(roomId)); const status=occupied?ROOM_STATUS.OCCUPIED:(room.status===ROOM_STATUS.RESERVED?ROOM_STATUS.RESERVED:ROOM_STATUS.VACANT); if(room.status!==status) await save("rooms",roomId,{...room,status}); }
function validMonth(value) { return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(value||"")); }
function validMoneyValues(values) { return values.every(v=>Number.isFinite(v)&&v>=0); }
async function init() {
  const rooms=await docs("rooms");
  if(!rooms.length) for(let i=1;i<=8;i++) await save("rooms",i,{id:i,room_no:"R"+i,status:"\u0e27\u0e48\u0e32\u0e07",rent:2800,note:""});
  const settings=await docs("settings");
  if(!settings.some(x=>x.key==="admin_password")) await setSetting("admin_password",hash("admin1234"));
  if(!settings.some(x=>x.key==="admin_username")) await setSetting("admin_username","admin");
  const counters=await db.collection("_counters").get();
  for(const n of ["rooms","tenants","bills","payments","meter_readings"]) {
    const list=await docs(n); const max=list.reduce((m,x)=>Math.max(m,Number(x.id)||0),0);
    const r=db.collection("_counters").doc(n); const s=await r.get();
    if(!s.exists || Number(s.data()?.value||0)<max) await r.set({value:max},{merge:true});
  }
}
const FIREBASE_API_KEY = "AIzaSyBq48Razwk20LWDEbwLTnmBTPb7fXIS3P0";
const ADMIN_UID = "SKhyOMyeuzXZz8QMZtENFnsm0WJ2";
async function authed(req){const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return false;try{const r=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+FIREBASE_API_KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:h.slice(7)})});if(!r.ok)return false;const d=await r.json();return d.users?.length===1&&d.users[0].localId===ADMIN_UID;}catch{return false;}}
async function enrich() {
  const [rooms,tenants,bills,payments,meters]=await Promise.all(["rooms","tenants","bills","payments","meter_readings"].map(docs));
  const roomById=new Map(rooms.map(x=>[Number(x.id),x]));
  const tenantById=new Map(tenants.map(x=>[Number(x.id),x]));
  const billById=new Map(bills.map(x=>[Number(x.id),x]));
  const tenantsWithRoom=tenants.map(t=>({...t,room_no:roomById.get(Number(t.room_id))?.room_no||null}));
  const billsFull=bills.map(b=>{const t=tenantById.get(Number(b.tenant_id));return {...b,name:t?.name||"",room_no:roomById.get(Number(t?.room_id))?.room_no||null};});
  const paymentsFull=payments.map(p=>{const b=billById.get(Number(p.bill_id));const t=tenantById.get(Number(b?.tenant_id));return {...p,bill_month:b?.bill_month||"",name:t?.name||"",room_no:roomById.get(Number(t?.room_id))?.room_no||null};});
  const metersFull=meters.map(m=>({...m,room_no:roomById.get(Number(m.room_id))?.room_no||null}));
  return {rooms,tenants,tenantsWithRoom,bills,billsFull,payments,paymentsFull,meters,metersFull,roomById,tenantById,billById};
}
async function api(req,res,url) {
  const method=req.method,p=url.pathname;
  if(method==="POST"&&p==="/api/login") return json(res,410,{error:"โปรดเข้าสู่ระบบผ่าน Firebase Authentication"});
  if(method==="GET"&&p==="/api/public/rooms"){
    const rooms=(await docs("rooms")).sort((a,b)=>String(a.room_no).localeCompare(String(b.room_no),undefined,{numeric:true}));
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"});return res.end(JSON.stringify(rooms.map(({room_no,status})=>({room_no,status}))));
  }
  if(p.startsWith("/api/")&&!(await authed(req))) return json(res,401,{error:"กรุณาเข้าสู่ระบบ"});
  const d=await enrich();
  if(method==="GET"&&p==="/api/dashboard"){
    const paid=d.payments.filter(x=>String(x.paid_at||"").slice(0,7)===month()).reduce((s,x)=>s+Number(x.amount||0),0);
    return json(res,200,{rooms:d.rooms,tenantCount:d.tenants.length,occupied:d.rooms.filter(x=>x.status===ROOM_STATUS.OCCUPIED).length,unpaid:d.bills.filter(x=>x.status!=="\u0e0a\u0e33\u0e23\u0e30\u0e41\u0e25\u0e49\u0e27").reduce((s,x)=>s+Number(x.total||0),0),paid,bills:d.billsFull.sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,10)});
  }
  if(method==="GET"&&p==="/api/rooms") return json(res,200,d.rooms.map(r=>({...r,name:d.tenants.find(t=>Number(t.room_id)===Number(r.id))?.name||null,phone:d.tenants.find(t=>Number(t.room_id)===Number(r.id))?.phone||null})).sort((a,b)=>String(a.room_no).localeCompare(String(b.room_no),undefined,{numeric:true})));
  if(method==="GET"&&p==="/api/tenants") return json(res,200,d.tenantsWithRoom.sort((a,b)=>Number(b.id)-Number(a.id)));
  if(method==="GET"&&p==="/api/bills"){ for(const b of d.billsFull){ if(!b.public_token){ b.public_token=crypto.randomBytes(24).toString("hex"); await save("bills",b.id,{public_token:b.public_token}); } } return json(res,200,d.billsFull.sort((a,b)=>Number(b.id)-Number(a.id))); }
  if(method==="GET"&&p==="/api/meter-readings") return json(res,200,d.metersFull.sort((a,b)=>String(b.reading_month).localeCompare(String(a.reading_month))||String(a.room_no).localeCompare(String(b.room_no))));
  if(method==="POST"&&p==="/api/meter-readings"){
    const x=await body(req),roomId=Number(x.room_id),m=x.reading_month||month();if(!roomId)return json(res,400,{error:"กรุณาเลือกห้อง"});if(!d.roomById.has(roomId))return json(res,400,{error:"ไม่พบห้องที่เลือก"});if(!validMonth(m))return json(res,400,{error:"รูปแบบเดือนต้องเป็น YYYY-MM"});
    const nums=[x.electricity_prev,x.electricity_current,x.water_prev,x.water_current,x.electricity_rate,x.water_rate].map(v=>Number(v??0));if(!validMoneyValues(nums))return json(res,400,{error:"ค่ามิเตอร์และอัตราค่าบริการต้องเป็นตัวเลขตั้งแต่ศูนย์ขึ้นไป"});if(nums[1]<nums[0]||nums[3]<nums[2])return json(res,400,{error:"เลขมิเตอร์ปัจจุบันต้องไม่น้อยกว่าครั้งก่อน"});
    const old=d.meters.find(v=>Number(v.room_id)===roomId&&String(v.reading_month)===String(m));if(old)return json(res,409,{error:"ห้องนี้มีบันทึกมิเตอร์ของเดือนนี้แล้ว กรุณาใช้ปุ่มแก้ไขรายการเดิมเพื่อป้องกันข้อมูลซ้ำ"});const vals={room_id:roomId,reading_month:m,electricity_prev:nums[0],electricity_current:nums[1],water_prev:nums[2],water_current:nums[3],electricity_rate:nums[4],water_rate:nums[5],note:x.note||""};const id=await add("meter_readings",vals);await save("meter_readings",id,{...vals,id});return json(res,201,{ok:true,id});
  }
  if(method==="PUT"&&p.startsWith("/api/meter-readings/")){const id=p.split("/").pop(),x=await body(req),old=await get("meter_readings",id);if(!old)return json(res,404,{error:"ไม่พบบันทึกมิเตอร์"});const roomId=Number(x.room_id),m=String(x.reading_month||"");if(!roomId||!d.roomById.has(roomId)||!validMonth(m))return json(res,400,{error:"ห้องหรือเดือนที่เลือกไม่ถูกต้อง"});const nums=[x.electricity_prev,x.electricity_current,x.water_prev,x.water_current,x.electricity_rate,x.water_rate].map(v=>Number(v??0));if(!validMoneyValues(nums)||nums[1]<nums[0]||nums[3]<nums[2])return json(res,400,{error:"ตรวจสอบเลขมิเตอร์และอัตราค่าบริการอีกครั้ง"});if(d.meters.some(v=>String(v.id)!==String(id)&&Number(v.room_id)===roomId&&String(v.reading_month)===m))return json(res,409,{error:"ห้องนี้มีบันทึกของเดือนดังกล่าวอยู่แล้ว"});await save("meter_readings",id,{...old,room_id:roomId,reading_month:m,electricity_prev:nums[0],electricity_current:nums[1],water_prev:nums[2],water_current:nums[3],electricity_rate:nums[4],water_rate:nums[5],note:x.note||""});return json(res,200,{ok:true});}
  if(method==="DELETE"&&p.startsWith("/api/meter-readings/")){await remove("meter_readings",p.split("/").pop());return json(res,200,{ok:true});}
  if(method==="GET"&&p==="/api/settings")return json(res,200,(await docs("settings")).filter(x=>["line_channel_token","line_public_url","line_channel_secret"].includes(x.key)));
  if(method==="POST"&&p==="/api/settings"){const x=await body(req);const allowed=["line_channel_token","line_public_url","line_channel_secret"];for(const [k,v] of Object.entries(x))if(allowed.includes(k))await setSetting(k,v);return json(res,200,{ok:true});}
  if(method==="POST"&&p==="/api/change-password"){const x=await body(req);if(!x.new_password||String(x.new_password).length<8)return json(res,400,{error:"รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร"});if(hash(x.old_password||"")!==await setting("admin_password"))return json(res,400,{error:"รหัสผ่านเดิมไม่ถูกต้อง"});await setSetting("admin_password",hash(x.new_password));sessions.clear();return json(res,200,{ok:true});}
  if(method==="POST"&&p==="/api/tenants"){
    const x=await body(req);if(!String(x.name||"").trim())return json(res,400,{error:"กรุณาระบุชื่อผู้เช่า"});
    const roomId=x.room_id?Number(x.room_id):null;
    if(roomId){const r=await get("rooms",roomId);if(!r)return json(res,400,{error:"ไม่พบห้องที่เลือก"});if(d.tenants.some(t=>Number(t.room_id)===roomId))return json(res,409,{error:"ห้องนี้มีผู้เช่าแล้ว"});}
    const id=await add("tenants",{room_id:roomId,name:String(x.name).trim(),phone:x.phone||"",id_card:x.id_card||"",move_in:x.move_in||today(),deposit:Number(x.deposit||0),note:x.note||"",line_user_id:x.line_user_id||""});
    if(roomId){const r=await get("rooms",roomId);if(r)await save("rooms",r.id,{...r,status:ROOM_STATUS.OCCUPIED});}return json(res,201,{id});
  }
  if(method==="PUT"&&p.startsWith("/api/tenants/")){
    const id=p.split("/").pop(),x=await body(req),old=await get("tenants",id);if(!old)return json(res,404,{error:"ไม่พบผู้เช่า"});
    const roomId=x.room_id?Number(x.room_id):null;if(!String(x.name||"").trim())return json(res,400,{error:"กรุณาระบุชื่อผู้เช่า"});
    if(roomId){const r=await get("rooms",roomId);if(!r)return json(res,400,{error:"ไม่พบห้องที่เลือก"});if(d.tenants.some(t=>Number(t.room_id)===roomId&&Number(t.id)!==Number(id)))return json(res,409,{error:"ห้องนี้มีผู้เช่าแล้ว"});}
    await save("tenants",id,{...old,room_id:roomId,name:String(x.name).trim(),phone:x.phone||"",id_card:x.id_card||"",move_in:x.move_in||null,deposit:Number(x.deposit||0),note:x.note||"",line_user_id:x.line_user_id||""});
    if(old.room_id&&Number(old.room_id)!==Number(roomId))await syncRoomStatus(old.room_id);if(roomId)await syncRoomStatus(roomId);return json(res,200,{ok:true});
  }
  if(method==="DELETE"&&p.startsWith("/api/tenants/")){const id=p.split("/").pop(),t=await get("tenants",id);if(!t)return json(res,404,{error:"ไม่พบผู้เช่า"});if(d.bills.some(b=>Number(b.tenant_id)===Number(id)))return json(res,409,{error:"ผู้เช่ารายนี้มีประวัติบิลอยู่ กรุณาเก็บประวัติไว้และแก้ไขข้อมูลผู้เช่าแทนการลบ"});await remove("tenants",id);if(t.room_id)await syncRoomStatus(t.room_id);return json(res,200,{ok:true});}
  if(method==="POST"&&p==="/api/bills"){
    const x=await body(req),t=await get("tenants",Number(x.tenant_id));if(!t)return json(res,400,{error:"ไม่พบผู้เช่า"});
    const billMonth=String(x.bill_month||month()),rent=Number(x.rent??0),electricity=Number(x.electricity??0),water=Number(x.water??0),other=Number(x.other??0),amounts=[rent,electricity,water,other];if(!validMonth(billMonth)||!validMoneyValues(amounts))return json(res,400,{error:"เดือนบิลหรือจำนวนเงินไม่ถูกต้อง"});if(d.bills.some(b=>Number(b.tenant_id)===Number(t.id)&&String(b.bill_month)===billMonth))return json(res,409,{error:"ผู้เช่ารายนี้มีบิลของเดือนนี้แล้ว"});const total=amounts.reduce((sum,v)=>sum+v,0);
    const public_token=crypto.randomBytes(24).toString("hex");const id=await add("bills",{tenant_id:Number(t.id),bill_month:billMonth,rent,electricity,water,other,total,due_date:x.due_date||"",status:"\u0e04\u0e49\u0e32\u0e07\u0e0a\u0e33\u0e23\u0e30",paid_at:null,note:x.note||"",public_token});const configuredUrl=String(await setting("line_public_url")||"").trim().replace(/\/+$/,"");const host=req.headers.host||"localhost:"+PORT;const protocol=(req.headers["x-forwarded-proto"]||"http").toString().split(",")[0].trim();const base=configuredUrl||protocol+"://"+host;const link=base+"/bill/"+id+"/"+public_token;return json(res,201,{id,total,link});
  }
  if(method==="POST"&&p.startsWith("/api/bills/")&&p.endsWith("/pay")){
    const id=p.split("/")[3],x=await body(req),b=await get("bills",id);if(!b)return json(res,404,{error:"ไม่พบบิล"});if(b.status==="\u0e0a\u0e33\u0e23\u0e30\u0e41\u0e25\u0e49\u0e27"||d.payments.some(v=>Number(v.bill_id)===Number(id)))return json(res,409,{error:"บิลนี้มีรายการชำระเงินแล้ว ป้องกันการบันทึกซ้ำ"});
    const amount=Number(x.amount??b.total);if(!Number.isFinite(amount)||amount<=0||Math.abs(amount-Number(b.total))>0.001)return json(res,400,{error:"กรุณารับชำระเต็มจำนวนตามยอดบิล หากรับชำระบางส่วนต้องบันทึกแยกก่อน"});
    const paid_at=String(x.paid_at||today());if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(paid_at)||Number.isNaN(Date.parse(paid_at+"T00:00:00Z")))return json(res,400,{error:"วันที่ชำระเงินไม่ถูกต้อง"});await add("payments",{bill_id:Number(id),amount,paid_at,method:String(x.method||"\u0e40\u0e07\u0e34\u0e19\u0e2a\u0e14").slice(0,40),note:String(x.note||"").slice(0,500)});await save("bills",id,{...b,status:"\u0e0a\u0e33\u0e23\u0e30\u0e41\u0e25\u0e49\u0e27",paid_at});return json(res,200,{ok:true});
  }
  if(method==="DELETE"&&p.startsWith("/api/bills/")){const id=p.split("/").pop(),b=await get("bills",id);if(!b)return json(res,404,{error:"ไม่พบบิล"});const x=await body(req);if(d.payments.some(v=>Number(v.bill_id)===Number(id))&&x.confirm_paid_delete!=="ลบบิลทดลอง")return json(res,409,{error:"บิลนี้มีประวัติชำระเงิน หากเป็นบิลทดลอง ให้ยืนยันด้วยคำว่า ลบบิลทดลอง"});if(d.payments.some(v=>Number(v.bill_id)===Number(id))){for(const payment of d.payments.filter(v=>Number(v.bill_id)===Number(id)))await remove("payments",payment.id);}await remove("bills",id);return json(res,200,{ok:true});}
  if(method==="PUT"&&p.startsWith("/api/rooms/")){const id=p.split("/").pop(),x=await body(req),r=await get("rooms",id);if(!r)return json(res,404,{error:"\u0e44\u0e21\u0e48\u0e1e\u0e1a\u0e2b\u0e49\u0e2d\u0e07"});const occupied=d.tenants.some(t=>Number(t.room_id)===Number(id));const allowed=["\u0e27\u0e48\u0e32\u0e07","\u0e15\u0e34\u0e14\u0e08\u0e2d\u0e07","\u0e44\u0e21\u0e48\u0e27\u0e48\u0e32\u0e07"];if(!allowed.includes(x.status))return json(res,400,{error:"\u0e2a\u0e16\u0e32\u0e19\u0e30\u0e2b\u0e49\u0e2d\u0e07\u0e44\u0e21\u0e48\u0e16\u0e39\u0e01\u0e15\u0e49\u0e2d\u0e07"});if(occupied&&x.status!=="\u0e44\u0e21\u0e48\u0e27\u0e48\u0e32\u0e07")return json(res,409,{error:"\u0e2b\u0e49\u0e2d\u0e07\u0e19\u0e35\u0e49\u0e21\u0e35\u0e1c\u0e39\u0e49\u0e40\u0e0a\u0e48\u0e32\u0e2d\u0e22\u0e39\u0e48 \u0e15\u0e49\u0e2d\u0e07\u0e04\u0e07\u0e2a\u0e16\u0e32\u0e19\u0e30\u0e44\u0e21\u0e48\u0e27\u0e48\u0e32\u0e07"});const rent=Number(x.rent??r.rent??2800);if(!Number.isFinite(rent)||rent<0)return json(res,400,{error:"\u0e04\u0e48\u0e32\u0e40\u0e0a\u0e48\u0e32\u0e44\u0e21\u0e48\u0e16\u0e39\u0e01\u0e15\u0e49\u0e2d\u0e07"});await save("rooms",id,{...r,status:x.status,rent,note:x.note??r.note??""});return json(res,200,{ok:true});}
  if(method==="GET"&&p==="/api/export/payments"){
    const m=url.searchParams.get("month")||month(),rows=d.paymentsFull.filter(x=>String(x.paid_at||"").slice(0,7)===m).sort((a,b)=>String(a.paid_at).localeCompare(String(b.paid_at)));
    const data=[["เดือน","ห้อง","ผู้เช่า","จำนวนเงิน","วันที่จ่าย","วิธีชำระ","หมายเหตุ"],...rows.map(x=>[x.bill_month,x.room_no||"-",x.name,Number(x.amount),x.paid_at,x.method||"\u0e40\u0e07\u0e34\u0e19\u0e2a\u0e14",x.note||""])];
    const ws=XLSX.utils.aoa_to_sheet(data);ws["!cols"]=[{wch:12},{wch:10},{wch:28},{wch:14},{wch:14},{wch:16},{wch:30}];const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"การจ่ายเงิน");const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});res.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});return res.end(buf);
  }
  if(method==="POST"&&p==="/api/line/send-bill"){
    const x=await body(req),b=d.billsFull.find(v=>Number(v.id)===Number(x.bill_id));const token=await setting("line_channel_token"),publicUrl=await setting("line_public_url"),t=d.tenants.find(v=>Number(v.id)===Number(b?.tenant_id));
    if(!b||!t?.line_user_id)return json(res,400,{error:"ไม่พบผู้เช่าหรือยังไม่มี LINE User ID"});if(!token)return json(res,400,{error:"ยังไม่ได้ตั้งค่า LINE Channel Access Token"});if(!publicUrl)return json(res,400,{error:"ยังไม่ได้ตั้งค่า Public URL"});
    if(!b.public_token){b.public_token=crypto.randomBytes(24).toString("hex");await save("bills",b.id,{public_token:b.public_token});}const payload={to:t.line_user_id,messages:[{type:"text",text:"แจ้งบิลค่าเช่า ห้อง "+(b.room_no||"-")+" ประจำเดือน "+b.bill_month+"\nยอดรวม "+Number(b.total).toLocaleString("th-TH")+" บาท\n\u0e14\u0e39\u0e1a\u0e34\u0e25: "+publicUrl.replace(/\/$/,"")+"/bill/"+b.id+"/"+b.public_token}]};
    const rr=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(payload)});if(!rr.ok)return json(res,400,{error:"LINE ส่งไม่สำเร็จ: "+await rr.text()});return json(res,200,{ok:true});
  }
  return json(res,404,{error:"API not found"});
}
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(origin && allowedOrigins.has(origin)){
  res.setHeader("Access-Control-Allow-Origin",origin);
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
 }
 const url=new URL(req.url,"http://localhost:"+PORT);
 if(req.method==="OPTIONS") { res.writeHead(204); return res.end(); }
 if(req.method==="GET" && url.pathname==="/health") return json(res,200,{ok:true,service:"dorm-manager-backend"});
 try {
  if(url.pathname.startsWith("/bill/")){
   const parts=url.pathname.split("/"),id=Number(parts[2]),provided=parts[3]||"",d=await enrich(),b=d.billsFull.find(x=>Number(x.id)===id);const valid=Boolean(b&&b.public_token&&provided&&provided.length===b.public_token.length&&crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(b.public_token)));if(!valid){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});return res.end("ไม่พบบิล");}
   const html=`<!doctype html><html lang="th"><meta charset="utf-8"><title>ใบแจ้งค่าใช้จ่าย</title><style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#222}h1{text-align:center}.billitems{width:100%;border-collapse:collapse}.billitems td{padding:12px;border-bottom:1px solid #ddd}.total{font-size:24px;font-weight:bold;text-align:right}.payment{display:flex;align-items:center;gap:28px;margin:30px 0 10px;padding-top:22px;border-top:2px solid #e5e5e5}.qr{width:190px;height:190px;object-fit:contain;flex-shrink:0}.account{border:2px solid #b9c8d8;border-radius:10px;padding:18px;flex:1}.account h2{font-size:18px;margin:0 0 14px}.account .number{font-size:25px;font-weight:bold;letter-spacing:1px;overflow-wrap:anywhere}.account .name{font-size:17px;margin-top:12px}.hint{font-size:12px;color:#555;margin-top:10px}@media(max-width:520px){.payment{flex-direction:column;align-items:stretch}.qr{align-self:center}.account .number{font-size:22px}}@media print{button{display:none}body{margin:0 auto}.payment{break-inside:avoid}}</style><h1>ใบแจ้งค่าใช้จ่าย</h1><p>ห้อง: ${esc(b.room_no||"-")}<br>ผู้เช่า: ${esc(b.name)}<br>ประจำเดือน: ${esc(b.bill_month)}</p><table class="billitems"><tr><td>ค่าเช่า</td><td align="right">${Number(b.rent).toLocaleString("th-TH")} บาท</td></tr><tr><td>ค่าไฟ</td><td align="right">${Number(b.electricity).toLocaleString("th-TH")} บาท</td></tr><tr><td>ค่าน้ำ</td><td align="right">${Number(b.water).toLocaleString("th-TH")} บาท</td></tr><tr><td>อื่น ๆ</td><td align="right">${Number(b.other).toLocaleString("th-TH")} บาท</td></tr></table><p class="total">รวม ${Number(b.total).toLocaleString("th-TH")} บาท</p><section class="payment"><img class="qr" alt="PromptPay QR สำหรับชำระเงิน" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASgAAAEoAQAAAADDfFG0AAAB80lEQVR4nO2ZwW7kMAxD+Rb5/1/mHkQ7TmcX6ClWUfsST0xgCMGSKAbrG+vPd0AHdVCfy54b109bliXdJ13Zv4+6lLggLAlJGCEzT9qy3xMvJTLIZCOL5aQr+70oJztt+f+o93k1ReVmIWHxCNkPYP8S6pLuwi4smWyWk67s98SL2mIZ4yVibOPVFcWddlXlPd8tR13Zb0HVJUJpiszGCBKwi1dfFEKWRT1MqS9Vju7j1RRFNcS7jEngvPQ+Xh1RVzXEKVUrLytakvK6K/st86PHtOiHSs0EaZ/58Ymq62VZ2BW3CPwK4blfX1GL1CrBijH20V//RmFVdxSkMZoUe44/8QVVsp6Rhq4GOc2vk4+fKE91amGGyDdRr73Zv4m6lGKForhmZ8wdQ27Lfps/YUysiVT5ZGYddGW/y59wjGgNgUppC0lHT3ygbLAlHLlVLjQJ4blfy6oCL42+OC/ZsAo58/YHyumFKqUfH5/SXsfPeayk4GMKWr9K6syP61r91SEoYk5EhXHq/bKue3L0iNYsagwl1pX9Hj0xfS88vAr58e22K/td8zZTopYvnWLPkGGt2b+KupZ9DGiUp2dCdmW/FzVUl/OFiFj5u3l1Qq3ft5nifpauDEtd2e+aHyVFP4x5eyQjpz8+1qK/XvrHg/pNqL8F5/oz6c/1bwAAAABJRU5ErkJggg=="><div class="account"><h2>ชำระค่าห้องพัก</h2><div>ธนาคารกสิกรไทย</div><div class="number">2122907948</div><div class="name">ชื่อบัญชี: น.ส.อรพิน ทำจริงจัง</div><div class="hint">โปรดตรวจสอบชื่อบัญชีและยอดเงินก่อนยืนยันการโอน</div></div></section><button onclick="print()">พิมพ์ / บันทึก PDF</button></html>`;
   res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return res.end(html);
  }
  if(url.pathname.startsWith("/api/"))return await api(req,res,url);
  const file=url.pathname==="/" ? "/index.html" : decodeURIComponent(url.pathname),root=path.resolve(here,"public"),full=path.resolve(root,"."+file);
  if(!full.startsWith(root+path.sep)&&full!==root)return json(res,403,{error:"Forbidden"});if(!fs.existsSync(full)||!fs.statSync(full).isFile())return json(res,404,{error:"Not found"});
  res.writeHead(200,{"Content-Type":mime[path.extname(full)]||"application/octet-stream"});fs.createReadStream(full).pipe(res);
 }catch(e){console.error(e);json(res,500,{error:"เกิดข้อผิดพลาดในระบบ"});}
});
await init();
server.listen(PORT,"0.0.0.0",()=>console.log("Dorm Manager Firestore backend running on port "+PORT));

