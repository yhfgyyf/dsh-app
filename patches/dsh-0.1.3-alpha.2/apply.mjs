import { readFile, writeFile, mkdir, cp, mkdtemp, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
const globalRoot=await realpath(process.env.DSH_PATCH_GLOBAL_ROOT??execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim());
const pkg=join(globalRoot,'@deepseek-ai/dsh'),nm=join(pkg,'node_modules');
const sha=x=>createHash('sha256').update(x).digest('hex');
const version=async p=>JSON.parse(await readFile(join(p,'package.json'),'utf8')).version;
if(await version(pkg)!==manifest.dsh)throw Error('This bundle requires DSH '+manifest.dsh);
if(await version(join(nm,'@earendil-works/pi-ai'))!==manifest.piAi)throw Error('Unexpected pi-ai version');
for(const name of new Set(manifest.files.map(x=>x.path.split('/').slice(0,2).join('/')).filter(x=>x.startsWith('@deepseek-ai/'))))if(await version(join(nm,name))!==manifest.dsh)throw Error('Mixed DSH dependency tree: '+name);
if(sha(await readFile(join(dir,'dsh-local-fixes.patch')))!==manifest.patchSha256)throw Error('Patch checksum mismatch');
if(sha(await readFile(join(nm,manifest.officialPersistence.path)))!==manifest.officialPersistence.sha256)throw Error('Official persistence implementation differs');
const states=await Promise.all(manifest.files.map(async f=>{const digest=sha(await readFile(join(nm,f.path)));if(digest!==f.before&&digest!==f.after)throw Error('Unrecognized local changes: '+f.path);return digest===f.after?'patched':'stock';}));
if(states.every(x=>x==='patched')){console.log(`Verified ${states.length} patched files; official lifetime session lock is unchanged.`);process.exit(0);}
if(process.argv.includes('--verify'))throw Error('The complete patch is not installed');
if(states.some(x=>x==='patched'))throw Error('Partial application detected; restore the saved package before retrying');
if(process.argv.includes('--check')){console.log(`Compatible stock runtime: ${states.length} patch targets.`);process.exit(0);}
if(process.argv.slice(2).some(x=>x!=='--apply'))throw Error('Usage: apply.mjs [--apply|--check|--verify]');
const backup=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'backups','local-fixes-alpha2-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(backup,{recursive:true,mode:0o700});
for(const f of manifest.files){const dest=join(backup,f.path);await mkdir(dirname(dest),{recursive:true});await cp(join(nm,f.path),dest);}
await writeFile(join(backup,'manifest.json'),JSON.stringify(manifest,null,2));
const work=await mkdtemp(join(tmpdir(),'dsh-alpha2-patch-'));
try{for(const args of [['--check'],[]]){const result=spawnSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','apply','--unsafe-paths','--directory='+nm.replaceAll('\\','/'),...args,join(dir,'dsh-local-fixes.patch')],{cwd:work,encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||'git apply failed');}
for(const f of manifest.files)if(sha(await readFile(join(nm,f.path)))!==f.after)throw Error('Post-apply checksum mismatch: '+f.path);
console.log(`Applied and SHA-256 verified ${manifest.files.length} files. Backup: ${backup}`);
}finally{await rm(work,{recursive:true,force:true});}
