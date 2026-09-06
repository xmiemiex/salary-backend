const fs=require('node:fs'),path=require('node:path'),{publicEncrypt,randomBytes,createCipheriv}=require('node:crypto');
const [tokenFile,dir]=process.argv.slice(2),token=fs.readFileSync(tokenFile,'utf8'),origin='https://api-salary.lovemiemie.com';
async function api(route,body){const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('FORMAL_HTTP_'+r.status);return r.json();}
function write(name,data){fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2),{mode:0o644});}
(async()=>{
 const denied=await fetch(origin+'/dashboard/monthly?settlementMonth=2026-08');if(denied.status!==401)throw Error('UNAUTHENTICATED_ACCESS');
 await api('/me');const first=await api('/dashboard/monthly?settlementMonth=2026-08');await api('/dashboard/monthly?settlementMonth=2026-07');
 const summary={startedAt:new Date().toISOString(),formalHttps:true,login:true,unauthenticatedStatus:denied.status,monthSelection:true,sourceCount:first.sources.length,month:'2026-08',syntheticWrites:false};
 // Transfer only an encrypted short-lived real login session for local browser acceptance.
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(token),cipher.final()]);
 write('browser-session.encrypted.json',{key:publicEncrypt(fs.readFileSync(path.join(dir,'browser-public.pem')),key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:data.toString('base64')});
 const refresh=await api('/dashboard/monthly/refresh',{settlementMonth:'2026-08'});summary.refreshAccepted=!!refresh.batchId; if(!summary.refreshAccepted)throw Error('REFRESH_NOT_ACCEPTED');
 write('acceptance-progress.json',summary);console.log('FORMAL_MONTHLY_REFRESH_STARTED');
 const aliases=new Map(first.sources.map((s,i)=>[s.key,['airwallex','photonpay'].includes(s.key)?s.key:'A'+String(i+1).padStart(2,'0')]));
 const deadline=Date.now()+60*60*1000;let status;
 do {await new Promise(r=>setTimeout(r,15000));status=await api('/dashboard/monthly/status?settlementMonth=2026-08');summary.sources=status.sources.map(s=>({source:aliases.get(s.key),status:s.status,reason:s.reason,coverageComplete:s.coverageComplete,coveredThrough:s.coveredThrough}));summary.refreshing=status.refreshing;write('acceptance-progress.json',summary);}while(status.refreshing&&Date.now()<deadline);
 const final=await api('/dashboard/monthly?settlementMonth=2026-08');
 const row=final.rows.find(r=>Number(r.spends.photonpay)>0)||final.rows[0];if(row){const q='/dashboard/monthly/details?settlementMonth=2026-08&category=photonpay&rowKey='+encodeURIComponent(row.key);const a=await api(q+'&page=1'),b=await api(q+'&page=2');if(a.items.length>20||b.items.length>20||a.items.some(x=>b.items.some(y=>y.key===x.key)))throw Error('DETAIL_PAGINATION_REGRESSION');summary.detailPage1Rows=a.items.length;summary.detailPage2Rows=b.items.length;}
 summary.pendingUnifiedRows=final.rows.filter(r=>r.attributionPending).length;summary.rates=final.rates;summary.finishedAt=new Date().toISOString();summary.allSourcesCompleted=summary.sources.every(s=>s.status==='completed');summary.result=summary.refreshing?'REFRESH_STILL_PENDING':summary.allSourcesCompleted?'PASSED':'DEPLOYED_PROVIDER_RESULTS_REQUIRE_REVIEW';write('acceptance-final.json',summary);console.log(summary.result);
})().catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'SAFE_ACCEPTANCE_FAILED');process.exitCode=1});
