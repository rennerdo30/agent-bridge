import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {brotliCompressSync,constants} from 'node:zlib';
import {writeFileSync} from 'node:fs';
const db=new DatabaseSync('D:/Development/ab210-copy/bridge.db',{readOnly:true});
db.exec('PRAGMA cache_size=-8192');
const out={sizes:[],tables:[],payload:{values:0,bytes:0,uniqueBytes:0,compressedBytes:0,uniqueValues:0},start:Date.now()};
try{out.sizes=db.prepare('SELECT name,sum(pgsize) bytes,count(*) pages,sum(payload) payload FROM dbstat GROUP BY name ORDER BY bytes DESC').all();}catch(e){out.dbstatError=String(e);}
writeFileSync('D:/Development/ab210-copy/dbstat.json',JSON.stringify(out,null,2));
const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'history_fts_%'").all();
for(const {name} of names){const q='"'+name.replaceAll('"','""')+'"'; const rows=db.prepare('SELECT count(*) n FROM '+q).get().n;out.tables.push({name,rows});}
console.log(JSON.stringify({tables:out.tables,sizes:out.sizes}));
const index=new DatabaseSync('D:/Development/ab210-copy/measure.db');
index.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS texts(sha256 TEXT PRIMARY KEY,bytes INTEGER,zbytes INTEGER,refs INTEGER);');
const put=index.prepare('INSERT INTO texts VALUES(?,?,?,1) ON CONFLICT(sha256) DO UPDATE SET refs=refs+1');
const get=index.prepare('SELECT bytes FROM texts WHERE sha256=?');
for(const [table,cols] of [['conversation_records',['raw','body']],['history_documents',['body','folded']],['history_pending',['body']]]){
if(!names.some(n=>n.name===table))continue;
let n=0;index.exec('BEGIN');
for(const row of db.prepare('SELECT '+cols.join(',')+' FROM '+table).iterate()){
for(const col of cols){const v=row[col];const b=v instanceof Uint8Array?Buffer.from(v):Buffer.from(String(v));const sha=createHash('sha256').update(b).digest('hex');out.payload.values++;out.payload.bytes+=b.length;
if(!get.get(sha)){const z=brotliCompressSync(b,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});put.run(sha,b.length,z.length);out.payload.uniqueBytes+=b.length;out.payload.compressedBytes+=z.length;out.payload.uniqueValues++;}else put.run(sha,b.length,0);}
if(++n%1000===0){index.exec('COMMIT;BEGIN');writeFileSync('D:/Development/ab210-copy/measurement-progress.json',JSON.stringify({table,n,payload:out.payload,seconds:(Date.now()-out.start)/1000}));}}
index.exec('COMMIT');console.log(JSON.stringify({table,rows:n,payload:out.payload}));}
out.duplicateRatio=1-out.payload.uniqueValues/out.payload.values;out.byteDuplicateRatio=1-out.payload.uniqueBytes/out.payload.bytes;out.seconds=(Date.now()-out.start)/1000;
writeFileSync('D:/Development/ab210-copy/measurement.json',JSON.stringify(out,null,2));index.close();db.close();console.log(JSON.stringify(out.payload));
