require('./monthly-finance-live-runtime.cjs');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const{PrismaClient}=require('@prisma/client');const db=new PrismaClient(),dir=path.resolve(__dirname,'../tmp/monthly-finance-live');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
(async()=>{
 const aliases=read('source-aliases.private.json');const name=id=>aliases.find(a=>a.id===id)?.code||id;
 const tasks=await db.syncTask.findMany({where:{refreshBatchId:{not:null}},orderBy:{createdAt:'asc'}});
 const sourceRecords=[];
 for(const source of [...aliases.map(a=>({key:a.id,alias:a.code})),{key:'airwallex',alias:'airwallex'},{key:'photonpay',alias:'photonpay'}]){
  const matching=tasks.filter(t=>(t.provider||t.affiliateAccountId)===source.key);const last=matching.at(-1);const result=last?.resultPayload||{};
  const rows=source.key==='airwallex'||source.key==='photonpay'?await db.cardSpendEvent.findMany({where:{provider:source.key,settlementMonth:new Date('2026-08-01')},select:{externalEventId:true,spendUsd:true,employeeId:true,status:true},orderBy:{externalEventId:'asc'}}):await db.incomeRecord.findMany({where:{affiliateAccountId:source.key,settlementMonth:new Date('2026-08-01'),source:{in:['cake','everflow']}},select:{externalRecordId:true,incomeUsd:true,employeeId:true,status:true},orderBy:{externalRecordId:'asc'}});
  sourceRecords.push({source:source.alias,real:true,latestStatus:last?.status,attempts:last?.attemptCount,error:last?.lastErrorCategory,finishedAt:last?.finishedAt,coverage:result.monthlyCoverage||null,requestWindow:result.requestWindow||null,counts:Object.fromEntries(Object.entries(result).filter(([k,v])=>/Count$/.test(k)&&typeof v==='number')),providerUsdDebitAmountTotal:result.providerUsdDebitAmountTotal||null,ledgerCount:rows.length,ledgerHash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),history:matching.map(t=>({status:t.status,attempts:t.attemptCount,error:t.lastErrorCategory,started:t.createdAt,finished:t.finishedAt}))});
 }
 const evidence={applicationCandidate:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),applicationChangesUncommitted:!!execFileSync('git',['diff','HEAD','--name-only','--','apps/api/src','prisma'],{encoding:'utf8'}).trim(),recordedAt:new Date().toISOString(),month:'2026-08',productionWrites:false,deployed:false,automaticScheduling:false,sources:sourceRecords,cakeBusinessRule:'Provider-native monthly commission plus confirmed manual GMT+8 adjustment; user confirmed 2026-09-06',independentPortalReconciled:false,cakeAdjustment:read('cake-adjustment-verify-evidence.json'),manualBehavior:read('behavior-verify-evidence.json'),browser:read('browser-evidence.json'),operations:read('operational-evidence.json'),pendingMigrations:read('configuration-integrity-evidence.json').pendingMigrations};
 const destination=path.resolve(__dirname,'../docs/release/monthly-finance-live-evidence.json');fs.writeFileSync(destination,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({file:'docs/release/monthly-finance-live-evidence.json',sources:sourceRecords.map(s=>({source:s.source,status:s.latestStatus,rows:s.ledgerCount,error:s.error}))}));
})().catch(()=>{console.error('EVIDENCE_GENERATION_FAILED_NO_SECRET_OUTPUT');process.exitCode=1;}).finally(()=>db.$disconnect());
