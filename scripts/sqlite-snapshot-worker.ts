import { fastSnapshot } from "../src/core/sqlite-fast-snapshot.js";

const [source,destination,method,authorization]=process.argv.slice(2);
if(!source || !destination || !method || !['copy','backup'].includes(method)) throw new Error('Explicit source, destination and snapshot method required.');
const measurement=await fastSnapshot(source,destination,{
 method:method as 'copy'|'backup',allowCheckpoint:authorization==='--checkpoint-authorized',rate:1_048_576,
 progress:value=>process.stderr.write(`Snapshot pages: ${value.totalPages-value.remainingPages}/${value.totalPages}\n`),
});
process.stdout.write(JSON.stringify(measurement)+'\n');
