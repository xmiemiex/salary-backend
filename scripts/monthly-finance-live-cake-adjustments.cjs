require('./monthly-finance-live-runtime.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {PrismaClient,Prisma}=require('@prisma/client'); const db=new PrismaClient(),dir=path.resolve(__dirname,'../tmp/monthly-finance-live');
(async()=>{
 const auth=await(await fetch('http://localhost:3061/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:fs.readFileSync(path.join(dir,'login.json'),'utf8')})).json();assert.ok(auth.token);
 const headers={'content-type':'application/json',authorization:'Bearer '+auth.token}; const aliases=JSON.parse(fs.readFileSync(path.join(dir,'source-aliases.private.json')));const account=aliases.find(a=>a.code==='A03');
 const month=new Date('2026-08-01');
 if(process.argv[2]==='setup'){
  assert.equal(await db.incomeRecord.count({where:{source:'cake_adjustment'}}),0);
  const rows=await db.incomeRecord.findMany({where:{source:'cake',affiliateAccountId:account.id,employeeId:{not:null},subValue:{not:null},settlementMonth:month,status:'confirmed'},orderBy:{subValue:'asc'},take:2});assert.equal(rows.length,2);
  for(const [i,row] of rows.entries()){
   const delta=i===0?'12.34':'-5.67'; const actual=new Prisma.Decimal(row.incomeUsd).plus(delta).toString();
   const response=await fetch('http://localhost:3061/cake-income-adjustments',{method:'POST',headers,body:JSON.stringify({affiliateAccountId:account.id,settlementMonth:'2026-08',subValue:row.subValue,actualRevenueUsd:actual,reason:'ISOLATED_SYNTHETIC_TIMEZONE_ADJUSTMENT_TEST'})});assert.equal(response.status,201);const draft=await response.json();
   const confirmed=await fetch('http://localhost:3061/cake-income-adjustments/'+draft.id+'/confirm',{method:'PATCH',headers});assert.ok(confirmed.ok);const c=await confirmed.json();assert.equal(new Prisma.Decimal(c.incomeUsd).toString(),delta);
  }
 }
 const adjustments=await db.incomeRecord.findMany({where:{source:'cake_adjustment',settlementMonth:month},orderBy:{id:'asc'}});assert.equal(adjustments.length,2);assert.ok(adjustments.every(a=>a.status==='confirmed'));
 const response=await fetch('http://localhost:3061/dashboard/monthly?settlementMonth=2026-08',{headers});const dashboard=await response.json();
 for(const a of adjustments){const aggregate=await db.incomeRecord.aggregate({where:{employeeId:a.employeeId,settlementMonth:month,status:'confirmed'},_sum:{incomeUsd:true}});assert.equal(dashboard.rows.find(r=>r.key===a.employeeId).totalIncome,aggregate._sum.incomeUsd.toString());}
 const result={at:new Date().toISOString(),source:'A03',syntheticAdjustments:true,positiveUsd:'12.34',negativeUsd:'-5.67',netAdjustmentUsd:'6.67',confirmedRows:adjustments.length,dashboardIncludesBasePlusAdjustment:true,hash:createHash('sha256').update(JSON.stringify(adjustments)).digest('hex')};
 if(process.argv[2]==='setup')fs.writeFileSync(path.join(dir,'cake-adjustment-baseline.json'),JSON.stringify(result,null,2));else{const baseline=JSON.parse(fs.readFileSync(path.join(dir,'cake-adjustment-baseline.json')));assert.equal(result.hash,baseline.hash);result.unchangedAfterRefresh=true;}
 fs.writeFileSync(path.join(dir,'cake-adjustment-'+(process.argv[2]||'verify')+'-evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error('CAKE_ADJUSTMENT_VALIDATION_FAILED',e.code||e.name);process.exitCode=1;}).finally(()=>db.$disconnect());
