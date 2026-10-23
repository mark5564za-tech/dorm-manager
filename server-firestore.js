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
function validMonth(value) { return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(value||"")); }
function validMoneyValues(values) { return values.every(v=>Number.isFinite(v)&&v>=0); }
async function init() {
  const rooms=await docs("rooms");
  if(!rooms.length) for(let i=1;i<=8;i++) await save("rooms",i,{id:i,room_no:"R"+i,status:"ว่าง",rent:2800,note:""});
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
function authed(req){const h=req.headers.authorization||"";return h.startsWith("Bearer ")&&sessions.has(h.slice(7));}
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
  if(method==="POST"&&p==="/api/login"){
    const d=await body(req);const u=await setting("admin_username"),pw=await setting("admin_password");
    if(d.username===u&&hash(d.password||"")===pw){const token=crypto.randomBytes(32).toString("hex");sessions.add(token);return json(res,200,{token,username:u});}
    return json(res,401,{error:"ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"});
  }
  if(method==="GET"&&p==="/api/public/rooms"){
    const rooms=(await docs("rooms")).sort((a,b)=>String(a.room_no).localeCompare(String(b.room_no),undefined,{numeric:true}));
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"});return res.end(JSON.stringify(rooms.map(({room_no,status})=>({room_no,status}))));
  }
  if(p.startsWith("/api/")&&!authed(req)) return json(res,401,{error:"กรุณาเข้าสู่ระบบ"});
  const d=await enrich();
  if(method==="GET"&&p==="/api/dashboard"){
    const paid=d.payments.filter(x=>String(x.paid_at||"").slice(0,7)===month()).reduce((s,x)=>s+Number(x.amount||0),0);
    return json(res,200,{rooms:d.rooms,tenantCount:d.tenants.length,occupied:d.rooms.filter(x=>x.status==="ไม่ว่าง").length,unpaid:d.bills.filter(x=>x.status!=="ชำระแล้ว").reduce((s,x)=>s+Number(x.total||0),0),paid,bills:d.billsFull.sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,10)});
  }
  if(method==="GET"&&p==="/api/rooms") return json(res,200,d.rooms.map(r=>({...r,name:d.tenants.find(t=>Number(t.room_id)===Number(r.id))?.name||null,phone:d.tenants.find(t=>Number(t.room_id)===Number(r.id))?.phone||null})).sort((a,b)=>String(a.room_no).localeCompare(String(b.room_no),undefined,{numeric:true})));
  if(method==="GET"&&p==="/api/tenants") return json(res,200,d.tenantsWithRoom.sort((a,b)=>Number(b.id)-Number(a.id)));
  if(method==="GET"&&p==="/api/bills") return json(res,200,d.billsFull.sort((a,b)=>Number(b.id)-Number(a.id)));
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
    if(roomId){const r=await get("rooms",roomId);if(r)await save("rooms",r.id,{...r,status:"ไม่ว่าง"});}return json(res,201,{id});
  }
  if(method==="PUT"&&p.startsWith("/api/tenants/")){
    const id=p.split("/").pop(),x=await body(req),old=await get("tenants",id);if(!old)return json(res,404,{error:"ไม่พบผู้เช่า"});
    const roomId=x.room_id?Number(x.room_id):null;if(!String(x.name||"").trim())return json(res,400,{error:"กรุณาระบุชื่อผู้เช่า"});
    if(roomId){const r=await get("rooms",roomId);if(!r)return json(res,400,{error:"ไม่พบห้องที่เลือก"});if(d.tenants.some(t=>Number(t.room_id)===roomId&&Number(t.id)!==Number(id)))return json(res,409,{error:"ห้องนี้มีผู้เช่าแล้ว"});}
    await save("tenants",id,{...old,room_id:roomId,name:String(x.name).trim(),phone:x.phone||"",id_card:x.id_card||"",move_in:x.move_in||null,deposit:Number(x.deposit||0),note:x.note||"",line_user_id:x.line_user_id||""});
    if(old.room_id&&Number(old.room_id)!==Number(roomId)){const r=await get("rooms",old.room_id);if(r){const occupied=d.tenants.some(t=>Number(t.room_id)===Number(old.room_id)&&Number(t.id)!==Number(id));await save("rooms",r.id,{...r,status:occupied?"ไม่ว่าง":"ว่าง"});}}if(roomId){const r=await get("rooms",roomId);if(r)await save("rooms",r.id,{...r,status:"ไม่ว่าง"});}return json(res,200,{ok:true});
  }
  if(method==="DELETE"&&p.startsWith("/api/tenants/")){const id=p.split("/").pop(),t=await get("tenants",id);if(!t)return json(res,404,{error:"ไม่พบผู้เช่า"});if(d.bills.some(b=>Number(b.tenant_id)===Number(id)))return json(res,409,{error:"ผู้เช่ารายนี้มีประวัติบิลอยู่ กรุณาเก็บประวัติไว้และแก้ไขข้อมูลผู้เช่าแทนการลบ"});await remove("tenants",id);if(t.room_id){const r=await get("rooms",t.room_id);if(r){const occupied=d.tenants.some(v=>Number(v.room_id)===Number(t.room_id)&&Number(v.id)!==Number(id));await save("rooms",r.id,{...r,status:occupied?"ไม่ว่าง":"ว่าง"});}}return json(res,200,{ok:true});}
  if(method==="POST"&&p==="/api/bills"){
    const x=await body(req),t=await get("tenants",Number(x.tenant_id));if(!t)return json(res,400,{error:"ไม่พบผู้เช่า"});
    const billMonth=String(x.bill_month||month()),rent=Number(x.rent??0),electricity=Number(x.electricity??0),water=Number(x.water??0),other=Number(x.other??0),amounts=[rent,electricity,water,other];if(!validMonth(billMonth)||!validMoneyValues(amounts))return json(res,400,{error:"เดือนบิลหรือจำนวนเงินไม่ถูกต้อง"});if(d.bills.some(b=>Number(b.tenant_id)===Number(t.id)&&String(b.bill_month)===billMonth))return json(res,409,{error:"ผู้เช่ารายนี้มีบิลของเดือนนี้แล้ว"});const total=amounts.reduce((sum,v)=>sum+v,0);
    const public_token=crypto.randomBytes(24).toString("hex");const id=await add("bills",{tenant_id:Number(t.id),bill_month:billMonth,rent,electricity,water,other,total,due_date:x.due_date||"",status:"ค้างชำระ",paid_at:null,note:x.note||"",public_token});const configuredUrl=String(await setting("line_public_url")||"").trim().replace(/\/+$/,"");const host=req.headers.host||"localhost:"+PORT;const protocol=(req.headers["x-forwarded-proto"]||"http").toString().split(",")[0].trim();const base=configuredUrl||protocol+"://"+host;const link=base+"/bill/"+id+"/"+public_token;return json(res,201,{id,total,link});
  }
  if(method==="POST"&&p.startsWith("/api/bills/")&&p.endsWith("/pay")){
    const id=p.split("/")[3],x=await body(req),b=await get("bills",id);if(!b)return json(res,404,{error:"ไม่พบบิล"});if(b.status==="ชำระแล้ว"||d.payments.some(v=>Number(v.bill_id)===Number(id)))return json(res,409,{error:"บิลนี้มีรายการชำระเงินแล้ว ป้องกันการบันทึกซ้ำ"});
    const amount=Number(x.amount??b.total);if(!Number.isFinite(amount)||amount<=0||Math.abs(amount-Number(b.total))>0.001)return json(res,400,{error:"กรุณารับชำระเต็มจำนวนตามยอดบิล หากรับชำระบางส่วนต้องบันทึกแยกก่อน"});
    const paid_at=String(x.paid_at||today());if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(paid_at)||Number.isNaN(Date.parse(paid_at+"T00:00:00Z")))return json(res,400,{error:"วันที่ชำระเงินไม่ถูกต้อง"});await add("payments",{bill_id:Number(id),amount,paid_at,method:String(x.method||"เงินสด").slice(0,40),note:String(x.note||"").slice(0,500)});await save("bills",id,{...b,status:"ชำระแล้ว",paid_at});return json(res,200,{ok:true});
  }
  if(method==="DELETE"&&p.startsWith("/api/bills/")){const id=p.split("/").pop(),b=await get("bills",id);if(!b)return json(res,404,{error:"ไม่พบบิล"});const x=await body(req);if(d.payments.some(v=>Number(v.bill_id)===Number(id))&&x.confirm_paid_delete!=="ลบบิลทดลอง")return json(res,409,{error:"บิลนี้มีประวัติชำระเงิน หากเป็นบิลทดลอง ให้ยืนยันด้วยคำว่า ลบบิลทดลอง"});if(d.payments.some(v=>Number(v.bill_id)===Number(id))){for(const payment of d.payments.filter(v=>Number(v.bill_id)===Number(id)))await remove("payments",payment.id);}await remove("bills",id);return json(res,200,{ok:true});}
  if(method==="PUT"&&p.startsWith("/api/rooms/")){const id=p.split("/").pop(),x=await body(req),r=await get("rooms",id);if(!r)return json(res,404,{error:"ไม่พบห้อง"});const occupied=d.tenants.some(t=>Number(t.room_id)===Number(id));const allowed=["ว่าง","ติดจอง","ไม่ว่าง"];if(!allowed.includes(x.status))return json(res,400,{error:"สถานะห้องไม่ถูกต้อง"});if(occupied&&x.status!=="ไม่ว่าง")return json(res,409,{error:"ห้องนี้มีผู้เช่าอยู่ ต้องคงสถานะไม่ว่าง"});const rent=Number(x.rent??r.rent??2800);if(!Number.isFinite(rent)||rent<0)return json(res,400,{error:"ค่าเช่าไม่ถูกต้อง"});await save("rooms",id,{...r,status:x.status,rent,note:x.note??r.note??""});return json(res,200,{ok:true});}
  if(method==="GET"&&p==="/api/export/payments"){
    const m=url.searchParams.get("month")||month(),rows=d.paymentsFull.filter(x=>String(x.paid_at||"").slice(0,7)===m).sort((a,b)=>String(a.paid_at).localeCompare(String(b.paid_at)));
    const data=[["เดือน","ห้อง","ผู้เช่า","จำนวนเงิน","วันที่จ่าย","วิธีชำระ","หมายเหตุ"],...rows.map(x=>[x.bill_month,x.room_no||"-",x.name,Number(x.amount),x.paid_at,x.method||"เงินสด",x.note||""])];
    const ws=XLSX.utils.aoa_to_sheet(data);ws["!cols"]=[{wch:12},{wch:10},{wch:28},{wch:14},{wch:14},{wch:16},{wch:30}];const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"การจ่ายเงิน");const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});res.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});return res.end(buf);
  }
  if(method==="POST"&&p==="/api/line/send-bill"){
    const x=await body(req),b=d.billsFull.find(v=>Number(v.id)===Number(x.bill_id));const token=await setting("line_channel_token"),publicUrl=await setting("line_public_url"),t=d.tenants.find(v=>Number(v.id)===Number(b?.tenant_id));
    if(!b||!t?.line_user_id)return json(res,400,{error:"ไม่พบผู้เช่าหรือยังไม่มี LINE User ID"});if(!token)return json(res,400,{error:"ยังไม่ได้ตั้งค่า LINE Channel Access Token"});if(!publicUrl)return json(res,400,{error:"ยังไม่ได้ตั้งค่า Public URL"});
    if(!b.public_token){b.public_token=crypto.randomBytes(24).toString("hex");await save("bills",b.id,{public_token:b.public_token});}const payload={to:t.line_user_id,messages:[{type:"text",text:"แจ้งบิลค่าเช่า ห้อง "+(b.room_no||"-")+" ประจำเดือน "+b.bill_month+"\nยอดรวม "+Number(b.total).toLocaleString("th-TH")+" บาท\nดูบิล: "+publicUrl.replace(/\/$/,"")+"/bill/"+b.id+"/"+b.public_token}]};
    const rr=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(payload)});if(!rr.ok)return json(res,400,{error:"LINE ส่งไม่สำเร็จ: "+await rr.text()});return json(res,200,{ok:true});
  }
  return json(res,404,{error:"API not found"});
}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://localhost:"+PORT);
 try {
  if(url.pathname.startsWith("/bill/")){
   const parts=url.pathname.split("/"),id=Number(parts[2]),provided=parts[3]||"",d=await enrich(),b=d.billsFull.find(x=>Number(x.id)===id);const valid=Boolean(b&&b.public_token&&provided&&provided.length===b.public_token.length&&crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(b.public_token)));if(!valid){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});return res.end("ไม่พบบิล");}
   const html=`<!doctype html><html lang="th"><meta charset="utf-8"><title>ใบแจ้งค่าใช้จ่าย</title><style>body{font-family:Arial;max-width:700px;margin:40px auto;padding:20px}h1{text-align:center}table{width:100%;border-collapse:collapse}td{padding:12px;border-bottom:1px solid #ddd}.total{font-size:24px;font-weight:bold;text-align:right}@media print{button{display:none}}</style><h1>ใบแจ้งค่าใช้จ่าย</h1><p>ห้อง: ${b.room_no||"-"}<br>ผู้เช่า: ${esc(b.name)}<br>ประจำเดือน: ${esc(b.bill_month)}</p><table><tr><td>ค่าเช่า</td><td align="right">${Number(b.rent).toLocaleString()} บาท</td></tr><tr><td>ค่าไฟ</td><td align="right">${Number(b.electricity).toLocaleString()} บาท</td></tr><tr><td>ค่าน้ำ</td><td align="right">${Number(b.water).toLocaleString()} บาท</td></tr><tr><td>อื่นๆ</td><td align="right">${Number(b.other).toLocaleString()} บาท</td></tr></table><p class="total">รวม ${Number(b.total).toLocaleString()} บาท</p><button onclick="print()">พิมพ์ / บันทึก PDF</button></html>`;
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
