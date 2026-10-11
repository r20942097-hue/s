import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const args=process.argv.slice(2);
const option=name=>args[args.indexOf(name)+1];
if(!args.includes('--engine-dir')||!args.includes('--output'))throw new Error('--engine-dir and --output are required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const engine=path.resolve(option('--engine-dir'));
const {AstFilterParser}=await import(pathToFileURL(path.join(engine,'node/js/static-filtering-parser.js')));
const {builtinScriptlets}=await import(pathToFileURL(path.join(engine,'node/js/resources/scriptlets.js')));
const parser=new AstFilterParser(), cosmetic=[],scripts=[];const resourceMap=new Map();
for(const r of builtinScriptlets){resourceMap.set(r.name,r);for(const alias of r.aliases||[])resourceMap.set(alias,r)}
for(const file of ['ad-ubo.txt','japanese-text-softener.txt','japanese-text-softener-deep.txt']){
 for(const rule of fs.readFileSync(path.join(root,file),'utf8').split('\n')){
  if(!rule||rule.startsWith('!')||rule.startsWith('['))continue;parser.parse(rule);
  if(parser.isScriptletFilter()){
   const args=parser.getScriptletArgs();const token=args[0].replace(/\.js$/,'')+'.js';const resource=resourceMap.get(token);const seen=new Set(),code=[];
   function collect(entry){if(seen.has(entry.name))return;seen.add(entry.name);for(const name of entry.dependencies||[])collect(resourceMap.get(name));code.push(entry.fn.toString())}
   collect(resource);scripts.push({file,rule,args,code:'(()=>{const scriptletGlobals={};'+code.join('\n')+'\n'+resource.fn.name+'(...'+JSON.stringify(args.slice(1))+');})();'});
  }else if(parser.isCosmeticFilter()){
   const raw=parser.result.compiled;cosmetic.push({file,rule,domains:rule.split('##')[0].split(',').filter(Boolean),compiled:raw.startsWith('{')?JSON.parse(raw):{selector:raw}});
  }
 }
}
fs.writeFileSync(option('--output'),JSON.stringify({cosmetic,scripts},null,2)+'\n');
console.log('Fixtures exported:',cosmetic.length,'cosmetic rules,',scripts.length,'official scriptlets');
