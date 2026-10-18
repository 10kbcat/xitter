// Blocked names: sign-up refused, renames suspend members, staff only refused,
// the admin check lists existing accounts. Run against the live server.
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { SignupError, checkSignup } from "../src/invites";
import { blockedNameIn, normalizeName } from "../src/names";
import { loadSettings } from "../src/settings";

const origin="http://localhost:3000",password="testpass123",WORD="zorbleflax";
let checks=0;
const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);checks++;console.log("ok  ",label);};
async function session(username:string){
	const r=await fetch(origin+"/login",{method:"POST",body:new URLSearchParams({username,password}),redirect:"manual"});
	const cookies=r.headers.getSetCookie().map(c=>c.split(';')[0]);
	const headers={cookie:cookies.join('; '),'x-csrf-token':cookies.find(c=>c.startsWith('ct0='))!.slice(4)};
	return {headers,
		admin:async(action:string,body:any={})=>{const r=await fetch(origin+'/admin/api/'+action,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};},
		post:async(path:string,f:Record<string,string>)=>{const r=await fetch(origin+'/i/api'+path,{method:'POST',headers,body:new URLSearchParams(f)});return {status:r.status,text:await r.text()};},
	};
}
const status=async(id:string)=>(await sql`select status from users where id=${id}::bigint`)[0].status;
const created:string[]=[];
const admin=await session('pozo');
const {operations}=(await admin.admin('operations')).data;
try{
	check((await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD]})).status===200,'list saved');
	await loadSettings();
	check(normalizeName('Z0rb_l3-ffLAX')==='z0rbl3fflax','normalised: case and separators');
	check(blockedNameIn('xx_z0rbl3fl4x_xx')===WORD,'matched inside a longer name');
	check(blockedNameIn('ZZZORB1EEEFLAX')===WORD,'repeats and 1 for l');
	check(!blockedNameIn('harmless name'),'clean name passes');
	await admin.admin('saveOperations',{...operations,blocked_names:[WORD,'nigger','kkk']});
	await loadSettings();
	check(blockedNameIn('N_1-GGG3rr')==='nigger','digits, separators and repeats');
	check(!blockedNameIn('Nigeria')&&!blockedNameIn('Niger Delta'),'a doubled letter needs two: Nigeria passes');
	check(blockedNameIn('kkkk')==='kkk'&&!blockedNameIn('kick'),'kkk needs three ks, a single k passes');
	await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD]});
	await loadSettings();
	const signup=async(screenName:string,name:string)=>{try{await checkSignup({screenName,name,password:'longenough1',email:'n@example.com'} as any);return 'ok';}catch(e){return e instanceof SignupError?e.message:String(e);}};
	check((await signup('z0rbleflax','fine')).includes("isn't allowed"),'sign-up refused for a blocked handle');
	check((await signup('cleanhandle','Mr Zorbleflax')).includes("isn't allowed"),'sign-up refused for a blocked display name');
	check(!(await signup('cleanhandle','fine')).includes("isn't allowed"),'clean sign-up not refused for the name');
	const names:string[]=[];
	for(let i=0;i<3;i++){const n='nm'+Date.now().toString().slice(-9)+i;names.push(n);created.push(await createUser(n,n,password));}
	await sql`update users set role='moderator' where id=${created[2]}::bigint`;
	const a=await session(names[0]),b=await session(names[1]),staff=await session(names[2]);
	const r1=await a.post('/1.1/account/update_profile.json',{name:'The Zorbleflax'});
	check(r1.status>=400&&await status(created[0])==='suspended','display-name change suspends');
	check((await fetch(origin+'/i/api/1.1/account/settings.json',{headers:a.headers})).status===401,'and signs them out');
	const r2=await b.post('/1.1/account/settings.json',{screen_name:'zorbleflax_'+names[1].slice(-3)});
	check(r2.status===400&&await status(created[1])==='suspended','handle change suspends');
	check((await sql`select 1 from audit_log where action='auto_suspend_name' and target=${created[1]}`).length===1,'audit line written');
	const r3=await staff.post('/1.1/account/update_profile.json',{name:'Zorbleflax staff'});
	check(r3.status>=400&&await status(created[2])!=='suspended','staff only refused');
	await sql`update users set status='active', name='Zorbleflax old' where id=${created[0]}::bigint or id=${created[2]}::bigint`;
	const hits=(await admin.admin('blockedNameAccounts',{})).data.accounts;
	check(hits.some((u:any)=>u.id===created[0])&&hits.some((u:any)=>u.id===created[2]&&u.staff),'check lists existing matches, staff marked');
	check(await status(created[0])!=='suspended','listing alone suspends nobody');
	await admin.admin('blockedNameAccounts',{suspend:true});
	check(await status(created[0])==='suspended'&&await status(created[2])!=='suspended','suspend button: members only');
	check((await (await fetch(origin+'/admin',{headers:admin.headers})).text()).includes('blockedNames'),'admin page carries the box');
	console.log(`all passed (${checks})`);
}finally{
	await admin.admin('saveOperations',operations);
	for(const id of created){await sql`delete from audit_log where target=${id}`;await sql`delete from users where id=${id}::bigint`;}
	await sql.end();
}
