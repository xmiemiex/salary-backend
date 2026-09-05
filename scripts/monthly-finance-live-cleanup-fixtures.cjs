require('./monthly-finance-live-runtime.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const{PrismaClient}=require('@prisma/client');const db=new PrismaClient(),dir=path.resolve(__dirname,'../tmp/monthly-finance-live');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n)));const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
(async()=>{
 const fixture=read('behavior-fixture.private.json'),baseline=read('behavior-baseline.json'),cake=read('cake-adjustment-baseline.json'),month=new Date(fixture.month+'-01');
 const imported=read('import-evidence.json');assert.equal(imported.retainedManualCosts,0);assert.equal(imported.retainedManualIncome,0);
 const originalFile=fs.readdirSync(dir).filter(n=>/^before-refresh-\d+\.json$/.test(n)).sort()[0];assert.ok(originalFile);const original=read(originalFile);assert.equal(original.feeHash,hash([]));assert.equal(original.manualHash,hash([]));
 const manual=await db.manualCardSpendEntry.findMany({orderBy:{id:'asc'}}),fees=await db.monthlyCardProviderFeeRate.findMany({orderBy:{provider:'asc'}}),adjustments=await db.incomeRecord.findMany({where:{source:'cake_adjustment',settlementMonth:month},orderBy:{id:'asc'}});
 assert.equal(hash(manual),baseline.manualHash);assert.equal(hash(fees),baseline.feeHash);assert.equal(hash(adjustments),cake.hash);
 const employee=await db.employee.findUniqueOrThrow({where:{id:fixture.employeeId}});assert.equal(employee.businessSubId,fixture.subId);
 await db.$transaction(async tx=>{
  await tx.incomeRecord.deleteMany({where:{id:{in:adjustments.map(a=>a.id)}}});
  await tx.manualCardSpendEntry.deleteMany({where:{id:{in:manual.map(m=>m.id)}}});
  await tx.monthlyCardProviderFeeRate.deleteMany({where:{id:{in:fees.map(f=>f.id)}}});
  await tx.monthlyAdposFeeRate.deleteMany({where:{settlementMonth:month}});
  await tx.employee.update({where:{id:fixture.employeeId},data:{businessSubId:fixture.originalBusinessSubId}});
 });
 const evidence={at:new Date().toISOString(),isolatedOnly:true,syntheticAdposRemoved:manual.length,syntheticCakeAdjustmentsRemoved:adjustments.length,syntheticFeeRatesRemoved:fees.length,originalBusinessSubIdRestored:true,realProviderLedgersPreserved:true};fs.writeFileSync(path.join(dir,'fixture-cleanup-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
})().catch(()=>{console.error('FIXTURE_CLEANUP_GUARD_FAILED_NO_VALUES_PRINTED');process.exitCode=1;}).finally(()=>db.$disconnect());
