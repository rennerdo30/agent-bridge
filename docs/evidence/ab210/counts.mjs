import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
const db=new DatabaseSync('D:/Development/ab210-copy/bridge.db',{readOnly:true});
const out=[];
for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){
const rows=db.prepare('SELECT count(*) n FROM "'+name.replaceAll('"','""')+'"').get().n;out.push({name,rows});
writeFileSync('D:/Development/ab210-copy/counts.json',JSON.stringify(out,null,2));
}
console.log(JSON.stringify(out));db.close();
