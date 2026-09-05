require('./monthly-finance-live-runtime.cjs');
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const{PrismaClient}=require('@prisma/client');const{CredentialCryptoService}=require('../apps/api/dist/apps/api/src/common/credential-crypto.service');
const db=new PrismaClient();
(async()=>{
 const credentials=[...await db.cardProviderCredential.findMany(),...await db.affiliateAccountCredential.findMany()];const crypto=new CredentialCryptoService();const secrets=[];
 for(const c of credentials){const p=crypto.decryptJson(c.encryptedPayload);for(const[k,v]of Object.entries(p))if(/api.?key|secret|password|token|app.?id|client.?id/i.test(k)&&typeof v==='string'&&v.length>=8)secrets.push(v);}
 const paths=new Set([...execFileSync('git',['diff','HEAD','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/),...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/)]);
 let checked=0;const failures=[];
 for(const file of paths){if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile())continue;const text=fs.readFileSync(file,'utf8');checked++;if(secrets.some(s=>text.includes(s)))failures.push(file);}
 console.log(JSON.stringify({changedFilesChecked:checked,credentialLiteralMatches:failures.length}));if(failures.length)process.exitCode=1;
})().catch(()=>{console.error('SECRET_CHECK_FAILED_NO_VALUES_PRINTED');process.exitCode=1;}).finally(()=>db.$disconnect());
