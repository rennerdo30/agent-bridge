import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {brotliCompressSync,constants} from 'node:zlib';
import {writeFileSync} from 'node:fs';
const db=new DatabaseSync('D:/Development/ab210-copy/bridge.db',{readOnly:true});const out={sizes:[],samples:[]};
for(const name of ['messages','history_documents','conversation_records','conversation_parts','history_fts_data','history_fts_idx','history_fts_docsize']){
console.log('measuring '+name);const size=db.prepare('SELECT name,pgsize bytes,ncell cells FROM dbstat WHERE name=? AND aggregate=TRUE').get(name);out.sizes.push(size);writeFileSync('D:/Development/ab210-copy/targeted-dbstat.json',JSON.stringify(out,null,2));}
for(const [table,cols] of [['conversation_records',['raw','body']],['history_documents',['body','folded']]]){const unique=new Set();let n=0,bytes=0,zbytes=0;for(const row of db.prepare('SELECT '+cols.join(',')+' FROM '+table+' LIMIT 1000').iterate())for(const col of cols){const b=row[col] instanceof Uint8Array?Buffer.from(row[col]):Buffer.from(row[col]);const hash=createHash('sha256').update(b).digest('hex');bytes+=b.length;n++;if(!unique.has(hash)){unique.add(hash);zbytes+=brotliCompressSync(b,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}).length;}}out.samples.push({table,values:n,bytes,unique:unique.size,zbytes});}
writeFileSync('D:/Development/ab210-copy/targeted-dbstat.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));db.close();
