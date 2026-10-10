/* Pure prompt and transcript helpers shared by the Arena content controller. */
(() => {
  const DIRECT=' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Separate values clearly, start with the first value, and output the complete sequence without explanation.';
  const probes=Object.freeze([
    Object.freeze({id:'plain-1',expected_count:297,prompt:'For each of 297 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.'+DIRECT}),
    Object.freeze({id:'plain-2',expected_count:315,prompt:'Provide exactly 315 whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.'+DIRECT}),
    Object.freeze({id:'plain-3',expected_count:331,prompt:'Fill exactly 331 positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.'+DIRECT}),
  ]);
  function parseRuns(text){
    const source=String(text||''),runs=[];let current=[],previousEnd=0;
    for(const match of source.matchAll(/\d+/g)){
      const separator=source.slice(previousEnd,match.index),value=Number(match[0]);
      if(current.length&&/\p{L}/u.test(separator)){runs.push(current);current=[];}
      if(value>=1&&value<=355)current.push(value);
      previousEnd=match.index+match[0].length;
    }
    if(current.length)runs.push(current);
    return runs;
  }
  function signatures(text){return new Set(parseRuns(text).filter(run=>run.length>=20).map(run=>run.join(',')));}
  function selectCandidate(text,before,expected){
    const minimum=Math.max(80,Math.ceil(expected*.55));
    const candidates=parseRuns(text).filter(run=>run.length>=minimum&&!before.has(run.join(','))&&run.length<=2000);
    candidates.sort((left,right)=>Math.abs(left.length-expected)-Math.abs(right.length-expected)||right.length-left.length);
    return candidates[0]||null;
  }
  const isTaskSuccessText=text=>{
    const value=String(text||'').replace(/\s+/g,' ').trim(),compact=value.replace(/[\s？?！!。．.：:，,、]/g,'');
    return /(?:此)?任务(?:是否)?成功(?:了)?吗/.test(compact)||/(?:was|is|did)\s+(?:this\s+)?task\s+(?:successful|succeed|a success)/i.test(value);
  };
  const isContinueWorkText=text=>{
    const value=String(text||'').replace(/\s+/g,' ').trim(),compact=value.replace(/[\s，,、：:。．.!！]/g,'');
    return /^(?:不|否)?继续工作(?:吧)?$/.test(compact)||/^(?:no[,.]?\s*)?(?:continue|keep)\s+(?:working|work)$/i.test(value);
  };
  const renameTitleForResult=(displayName,status)=>{
    const name=String(displayName||'').trim();
    return status!=='clear'&&name&&!/[?？]$/.test(name)?`${name}?`:name;
  };
  /* v2.1.0 识别模式计划器（纯函数，便于测试）：
     quick   —— 从还没问过的题里随机抽 1 题；
     precise —— 依次补全剩余题目（最多 3 题，按 297/315/331 顺序）。
     used 为已发送过的题号数组；random 可注入，默认 Math.random。 */
  function planProbes(mode,used=[],random=Math.random){
    const indexes=probes.map((_,index)=>index);
    const sent=new Set((Array.isArray(used)?used:[]).filter(index=>indexes.includes(index)));
    const available=indexes.filter(index=>!sent.has(index));
    if(mode!=='quick')return available;
    if(!available.length)return [];
    const draw=Number(random());
    const pick=Math.min(available.length-1,Math.max(0,Math.floor((Number.isFinite(draw)?draw:0)*available.length)));
    return [available[pick]];
  }
    /* v2.7.0 scene 通道：一句带硬约束的中文句子 —— 同模型更可能写出同一句/同风格句子，用作第二指纹。
     校验：恰好 12 个汉字，且除空白外不出现任何标点/数字/拉丁字母。 */
  const sceneProbes=Object.freeze([
    Object.freeze({id:'free-pelican',kind:'free',options:null,subject:'鹈鹕在海边骑自行车',prompt:'写一句描绘鹈鹕在海边骑自行车的中文句子。必须恰好12个汉字，不含标点、空格、数字或拉丁字母。只返回这句话。'}),
    Object.freeze({id:'choice-dream',kind:'choice',options:Object.freeze(['A','B','C','D']),prompt:'只回复一个字母，不要其他文字：A 会飞的企鹅 B 会游泳的猫 C 会算数的章鱼 D 会唱歌的鲸鱼 —— 你觉得哪一个最可能在梦里出现？'}),
    Object.freeze({id:'free-cat',kind:'free',options:null,subject:'猫在深夜便利店煮泡面',prompt:'写一句恰好12个汉字的中文句子：猫在深夜便利店煮泡面。不要标点，只返回句子。'}),
    Object.freeze({id:'pick-ride',kind:'pick',options:null,prompt:'自己想一只动物和一种交通工具，用「动物-交通工具」的形式回复（例如：企鹅-滑板）。只回这一项，不要解释。'}),
    Object.freeze({id:'choice-city',kind:'choice',options:Object.freeze(['A','B','C','D']),prompt:'只回复一个字母：A 东京 B 开罗 C 里约 D 冰岛 —— 如果只能在其中一个地方醒来，你选哪个？只回字母。'}),
    Object.freeze({id:'free-whale',kind:'free',options:null,subject:'鲸鱼在天台放风筝',prompt:'写一句恰好12个汉字的中文句子：鲸鱼在天台放风筝。不要标点，只返回句子。'}),
  ]);
  const sceneParseChoice=(text,options)=>{
    const allowed=options&&options.length?options:['A','B','C','D'];
    const raw=String(text||'').trim().toUpperCase();
    const match=raw.match(new RegExp('(?:^|[^A-Z])('+allowed.join('|')+')(?![A-Z])'));
    return match?match[1]:(allowed.includes(raw)?raw:'');
  };
  const sceneParsePick=text=>{
    const raw=String(text||'').trim();
    const match=raw.match(/([\u4e00-\u9fff]{1,8})[\s\-—–－·、,，:：\/]{1,2}([\u4e00-\u9fff]{1,8})/);
    if(match)return {a:match[1],b:match[2],key:match[1]+'-'+match[2]};
    const runs=(raw.replace(/[^\u4e00-\u9fff]/g,' ').match(/[\u4e00-\u9fff]{1,8}/g))||[];
    return runs.length>=2?{a:runs[0],b:runs[1],key:runs[0]+'-'+runs[1]}:null;
  };
  const histOf=(values,options)=>{const hist={};(options||[]).forEach(option=>{hist[option]=0;});(values||[]).forEach(value=>{if(value)hist[value]=(hist[value]||0)+1;});return hist;};
  const jsdBits=(left,right,alpha=0.05)=>{
    const keys=[...new Set([...Object.keys(left||{}),...Object.keys(right||{})])].filter(key=>((left&&left[key])||0)+((right&&right[key])||0)>0);
    if(!keys.length)return 0;
    const norm=counts=>{const total=keys.reduce((sum,key)=>sum+(counts[key]||0)+alpha,0)||1;const out={};keys.forEach(key=>{out[key]=((counts[key]||0)+alpha)/total;});return out;};
    const entropy=dist=>keys.reduce((sum,key)=>dist[key]>0?sum-dist[key]*Math.log2(dist[key]):sum,0);
    const p=norm(left||{}),q=norm(right||{}),mid={};
    keys.forEach(key=>{mid[key]=(p[key]+q[key])/2;});
    return entropy(mid)-(entropy(p)+entropy(q))/2;
  };
  const distSimilarity=(left,right,options)=>{
    const keys=[...new Set([...Object.keys(left||{}),...Object.keys(right||{})])].filter(key=>((left&&left[key])||0)+((right&&right[key])||0)>0);
    if(!keys.length)return 0;
    if(keys.length<2)return 1;
    const max=Math.log2(keys.length);
    return Math.max(0,Math.min(1,1-jsdBits(left,right)/max));
  };
  function sceneVote(observations,profiles){
    const tally=new Map();
    const add=(label,score)=>{const item=tally.get(label)||{label,score:0,samples:0};item.score+=score;item.samples+=1;tally.set(label,item);};
    for(const obs of observations||[]){
      const profile=(profiles||{})[obs.promptId];
      if(!profile)continue;
      if(obs.kind==='free'){
        const cluster=sceneClusterOf(profile.clusters||[],obs.value);
        if(!cluster)continue;
        const total=Object.values(cluster.labels||{}).reduce((sum,value)=>sum+value,0)||1;
        for(const [label,count] of Object.entries(cluster.labels||{}))add(label,count/total);
      }else{
        for(const [label,counts] of Object.entries(profile.hist||{})){
          const total=Object.values(counts).reduce((sum,value)=>sum+value,0);
          if(total<2)continue;
          add(label,distSimilarity(histOf([obs.value],obs.options),counts,obs.options));
        }
      }
    }
    return [...tally.values()].map(item=>({label:item.label,score:item.score/item.samples,samples:item.samples})).sort((a,b)=>b.score-a.score);
  }
  const validateScene=text=>{
    const clean=String(text||'').trim();
    const han=clean.replace(/[^\u4e00-\u9fff]/g,'');
    const extra=clean.replace(/[\u4e00-\u9fff\s]/g,'');
    return {ok:han.length===12&&extra.length===0,han:han.length,key:han.slice(0,12),extra:extra.slice(0,20)};
  };
  const findSceneSentence=text=>{
    const value=String(text||'').replace(/\s+/g,'');
    const runs=value.match(/[\u4e00-\u9fff]{12,}/g);
    return runs&&runs.length?runs[runs.length-1].slice(0,12):'';
  };
  const sceneKeyOf=text=>String(text||'').replace(/[^\u4e00-\u9fff]/g,'').slice(0,12);
  const sceneGrams=key=>{const out=new Set();for(let i=0;i+2<key.length;i++)out.add(key.slice(i,i+3));return out;};
  const sceneSimilarity=(left,right)=>{const a=sceneGrams(String(left||'')),b=sceneGrams(String(right||''));if(!a.size||!b.size)return 0;let hit=0;for(const gram of a)if(b.has(gram))hit++;return hit/Math.max(a.size,b.size);};
  const sceneClusterOf=(table,key)=>{for(const cluster of table||[])if(sceneSimilarity(cluster.key,key)>=0.5)return cluster;return null;};
  globalThis.ArenaProbeRuntime=Object.freeze({probes,sceneProbes,sceneParseChoice,sceneParsePick,histOf,jsdBits,distSimilarity,sceneVote,parseRuns,signatures,selectCandidate,isTaskSuccessText,isContinueWorkText,renameTitleForResult,planProbes,validateScene,findSceneSentence,sceneKeyOf,sceneSimilarity,sceneClusterOf});
})();
