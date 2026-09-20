let token=localStorage.getItem("dorm_token")||"";
const $=s=>document.querySelector(s);
const money=n=>Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2});
async function login(e){
 e.preventDefault();
 const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("#username").value,password:$("#password").value})});
 const d=await r.json();
 if(!r.ok){$("#loginError").textContent=d.error||"เข้าสู่ระบบไม่สำเร็จ";return}
 token=d.token;localStorage.setItem("dorm_token",token);
 $("#login").style.display="none";$("#system").style.display="block";show("dashboard");
}
function logout(){localStorage.removeItem("dorm_token");location.reload()}
async function get(u){
 const r=await fetch(u,{headers:{Authorization:"Bearer "+token}});
 if(r.status===401){logout();return {}}
 return r.json();
}
async function send(u,method,data){
 const r=await fetch(u,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(data)});
 if(r.status===401){logout();return {}}
 return r.json();
}
async function show(page){if(page==="dashboard")return dashboard();if(page==="rooms")return rooms();if(page==="tenants")return tenants();if(page==="bills")return bills();if(page==="settings")return settings()}
async function dashboard(){
 const d=await get("/api/dashboard");
 $("#app").innerHTML="<h2>ภาพรวม</h2><div class='cards'>"+
 "<div class='card'>ห้องทั้งหมด<div class='num'>"+d.rooms.length+"</div></div>"+
 "<div class='card'>มีผู้เช่า<div class='num'>"+d.occupied+"</div></div>"+
 "<div class='card'>ผู้เช่า<div class='num'>"+d.tenantCount+"</div></div>"+
 "<div class='card'>ยอดค้างชำระ<div class='num'>"+money(d.unpaid)+" ฿</div></div></div>"+
 "<div class='panel'><h3>รายรับเดือนนี้</h3><div class='num'>"+money(d.paid)+" ฿</div></div>"+
 "<div class='panel'><h3>บิลล่าสุด</h3>"+billTable(d.bills)+"</div>";
}
function billTable(a){if(!a||!a.length)return "ยังไม่มีบิล";return "<table><tr><th>เดือน</th><th>ห้อง</th><th>ผู้เช่า</th><th>ยอด</th><th>สถานะ</th></tr>"+a.map(b=>"<tr><td>"+b.bill_month+"</td><td>"+(b.room_no||"-")+"</td><td>"+b.name+"</td><td>"+money(b.total)+"</td><td>"+b.status+"</td></tr>").join("")+"</table>"}
async function rooms(){
 const r=await get("/api/rooms");
 $("#app").innerHTML="<h2>ห้องพัก</h2><div class='grid'>"+r.map(x=>"<div class='card'><h2>ห้อง "+x.room_no+"</h2><p class='"+(x.status==="ว่าง"?"ok":"bad")+"'>"+x.status+"</p><p>ค่าเช่า: "+money(x.rent)+" บาท/เดือน</p><p>ผู้เช่า: "+(x.name||"-")+"</p><button onclick='editRoom("+x.id+")'>แก้ไข</button></div>").join("")+"</div>"
}
async function editRoom(id){
 const r=await get("/api/rooms");const x=r.find(a=>a.id===id);if(!x)return;
 const ns=prompt("สถานะ (ว่าง/ไม่ว่าง)",x.status);if(ns===null)return;
 const nr=prompt("ค่าเช่าต่อเดือน",x.rent);if(nr===null)return;
 await send("/api/rooms/"+id,"PUT",{status:ns,rent:Number(nr)});rooms()
}
async function tenants(){
 const [t,r]=await Promise.all([get("/api/tenants"),get("/api/rooms")]);
 $("#app").innerHTML="<h2>ผู้เช่า</h2><div class='panel'><h3>เพิ่มผู้เช่า</h3><form onsubmit='addTenant(event)'><div class='grid'><label>ชื่อ<input name='name' required></label><label>โทรศัพท์<input name='phone'></label><label>LINE User ID<input name='line_user_id' placeholder='ถ้ามี'></label><label>ห้อง<select name='room_id'><option value=''>ไม่ระบุ</option>"+r.filter(x=>x.status==="ว่าง").map(x=>"<option value='"+x.id+"'>ห้อง "+x.room_no+"</option>").join("")+"</select></label></div><button>บันทึกผู้เช่า</button></form></div><div class='panel'><table><tr><th>ห้อง</th><th>ชื่อ</th><th>โทร</th><th>LINE</th><th></th></tr>"+t.map(x=>"<tr><td>"+(x.room_no||"-")+"</td><td>"+x.name+"</td><td>"+x.phone+"</td><td>"+(x.line_user_id?"เชื่อมแล้ว":"-")+"</td><td><button onclick='delTenant("+x.id+")'>ลบ</button></td></tr>").join("")+"</table></div>"
}
async function addTenant(e){e.preventDefault();const f=new FormData(e.target);const d=Object.fromEntries(f.entries());d.room_id=d.room_id?Number(d.room_id):null;await send("/api/tenants","POST",d);tenants()}
async function delTenant(id){if(!confirm("ลบผู้เช่ารายนี้?"))return;await send("/api/tenants/"+id,"DELETE",{});tenants()}
async function bills(){
 const [b,t]=await Promise.all([get("/api/bills"),get("/api/tenants")]);
 $("#app").innerHTML="<h2>บิลและการชำระเงิน</h2><div class='panel'><h3>สร้างบิล</h3><form onsubmit='addBill(event)'><div class='grid'><label>ผู้เช่า<select name='tenant_id' required>"+t.map(x=>"<option value='"+x.id+"'>ห้อง "+(x.room_no||"-")+" - "+x.name+"</option>").join("")+"</select></label><label>เดือน<input type='month' name='bill_month' value='"+new Date().toISOString().slice(0,7)+"'></label><label>ค่าเช่า<input name='rent' type='number' value='2800'></label><label>ค่าไฟ<input name='electricity' type='number' value='0'></label><label>ค่าน้ำ<input name='water' type='number' value='0'></label><label>อื่นๆ<input name='other' type='number' value='0'></label></div><button>สร้างบิล</button></form></div><div class='panel'><table><tr><th>เดือน</th><th>ห้อง</th><th>ผู้เช่า</th><th>ยอด</th><th>สถานะ</th><th>จัดการ</th></tr>"+b.map(x=>"<tr><td>"+x.bill_month+"</td><td>"+x.room_no+"</td><td>"+x.name+"</td><td>"+money(x.total)+"</td><td>"+x.status+"</td><td>"+(x.status==="ชำระแล้ว"?"เรียบร้อย":"<button onclick='payBill("+x.id+","+x.total+")'>รับชำระ</button> <button onclick='sendBill("+x.id+")'>ส่ง LINE</button>")+"</td></tr>").join("")+"</table></div>"
}
async function addBill(e){e.preventDefault();const f=new FormData(e.target);const d=Object.fromEntries(f.entries());d.tenant_id=Number(d.tenant_id);["rent","electricity","water","other"].forEach(k=>d[k]=Number(d[k]||0));await send("/api/bills","POST",d);bills()}
async function payBill(id,total){const a=prompt("จำนวนเงิน",total);if(a===null)return;await send("/api/bills/"+id+"/pay","POST",{amount:Number(a),method:"เงินสด"});bills()}
async function sendBill(id){const r=await send("/api/line/send-bill","POST",{bill_id:id});alert(r.ok?"ส่งบิลทาง LINE แล้ว":"ส่งไม่ได้: "+(r.error||"ตรวจสอบการตั้งค่า LINE"))}
if(token){$("#login").style.display="none";$("#system").style.display="block";show("dashboard")}
async function settings(){
 const a=await get("/api/settings");const s=Object.fromEntries(a.map(x=>[x.key,x.value]));
 $("#app").innerHTML="<h2>ตั้งค่าระบบ</h2><div class='panel'><h3>LINE Messaging API</h3><p>LINE ต้องใช้ Official Account + Messaging API</p><label>Channel Access Token<input id='lineToken' type='password' value='"+(s.line_channel_token||"")+"'></label><label>Public URL<input id='publicUrl' placeholder='https://example.com' value='"+(s.line_public_url||"")+"'></label><label>Channel Secret<input id='lineSecret' type='password' value='"+(s.line_channel_secret||"")+"'></label><button onclick='saveLine()'>บันทึก LINE</button></div><div class='panel'><h3>เปลี่ยนรหัสผ่านแอดมิน</h3><label>รหัสผ่านเดิม<input id='oldPw' type='password'></label><label>รหัสผ่านใหม่<input id='newPw' type='password'></label><button onclick='changePw()'>เปลี่ยนรหัสผ่าน</button></div><div class='panel'><p>บัญชีผู้ดูแลมีเพียง 1 บัญชี ชื่อผู้ใช้: <b>admin</b></p></div>"
}
async function saveLine(){
 const r=await send("/api/settings","POST",{line_channel_token:$("#lineToken").value,line_public_url:$("#publicUrl").value,line_channel_secret:$("#lineSecret").value});
 alert(r.ok?"บันทึกแล้ว":"บันทึกไม่สำเร็จ");
}
async function changePw(){
 const r=await send("/api/change-password","POST",{old_password:$("#oldPw").value,new_password:$("#newPw").value});
 alert(r.ok?"เปลี่ยนรหัสผ่านแล้ว":"เปลี่ยนไม่ได้: "+(r.error||""));
}
