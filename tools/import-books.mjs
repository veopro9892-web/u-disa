import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync,backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const directory=fileURLToPath(new URL('../data/',import.meta.url));
const target=path.join(directory,'udisa.db');
const original=process.argv[2] || path.join(os.homedir(),'Documents','Qoder','2026-10-24','2e36ffdf','data','udisa.db');
if (fs.existsSync(target)) throw Error('This copy already contains books. Import requires a fresh U-Disa folder.');
if (!fs.existsSync(original)) throw Error('Choose your previous data/udisa.db file or drag it onto Import previous books.bat.');
// A WAL database may need to build a shared-memory index even for a reader.
// Stage the database and its WAL together, then verify both still match the source.
const snapshot=fs.mkdtempSync(path.join(directory,'import-'));
const stagedDb=path.join(snapshot,'source.db');
const staging=path.join(snapshot,'verified.db');
async function digest(file) {
  const hash=createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
let source;
try {
  for (const suffix of ['','-wal','-journal']) {
    if (fs.existsSync(original+suffix)) fs.copyFileSync(original+suffix,stagedDb+suffix);
  }
  for (const suffix of ['','-wal','-journal']) {
    const live=original+suffix, copy=stagedDb+suffix;
    if (fs.existsSync(live)!==fs.existsSync(copy) || (fs.existsSync(copy) && await digest(live)!==await digest(copy))) {
      throw Error('The previous books changed during copying. Close the previous app and retry.');
    }
  }
  source=new DatabaseSync(stagedDb);
  for (const table of ['users','items','ledger','movements']) {
    if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('Choose a U-Disa database.');
  }
  await backup(source,staging);
  const check=new DatabaseSync(staging,{readOnly:true});
  try {if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('The copied database did not pass its integrity check.');}
  finally {check.close();}
  fs.copyFileSync(staging,target,fs.constants.COPYFILE_EXCL);
  console.log('Previous books copied. Open Start U-Disa.bat in this folder.');
} finally {source?.close();fs.rmSync(snapshot,{recursive:true,force:true});}
