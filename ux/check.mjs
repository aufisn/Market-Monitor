import fs from 'node:fs'; import vm from 'node:vm';
const ctx={module:{}}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('./src/messages.js',import.meta.url),'utf8')+';this.MM=MM;',ctx);
const MM=ctx.MM; let bad=0;
for(const a of ['A','B','C']) for(const sc of MM.scenes(a)) for(const m of sc.items){
  const vs=(m.variants||[{label:'x',s:{}}]);
  for(const v of vs){ const s=Object.assign(JSON.parse(JSON.stringify(m.init)),v.s); const r=m.view(s);
    r.text.split('\n').forEach(l=>{ if(MM.width(l)>38){bad++;console.log(a,m.id,v.label,MM.width(l),JSON.stringify(l));} });
    if(r.text.length>4096){bad++;console.log('LEN',m.id)} } }
console.log('over-width lines:',bad);
