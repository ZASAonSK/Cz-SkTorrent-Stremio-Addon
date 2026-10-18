// Smoke test so stubmi (bez siete a bez npm závislostí): node tools/smoke-test.js

process.env.ENCRYPTION_KEY='testkey'; process.env.QUIET_LOGS='1';
const Module=require('module'); const path=require('path');
const ROOT=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const H1='a'.repeat(40), H2='b'.repeat(40), H3='c'.repeat(40);
const calls=[];
const route=(url,method,opts)=>{
  calls.push(method+' '+url);
  if(/v3-cinemeta.*\/meta\/movie\//.test(url)) return {data:{meta:{name:'Test Movie',year:'2010'}}};
  if(/v3-cinemeta.*\/meta\/series\//.test(url)) return {data:{meta:{name:'Test Show',year:'2015-2018'}}};
  if(/checkcached/.test(url)) return {data:{success:true,data:[{hash:H1}]}};
  if(/torbox.*mylist/.test(url)) return {data:{success:true,data:[{hash:H1,id:77,cached:true,files:[{id:5,name:'Test.Movie.2010.1080p.mkv',short_name:'Test.Movie.2010.1080p.mkv',size:4e9}]}]}};
  if(/requestdl/.test(url)) return {data:{data:'https://cdn.example/video.mkv'}};
  if(/createtorrent/.test(url)) return {data:{success:true,data:{torrent_id:99}}};
  if(/real-debrid.*\/torrents\?page/.test(url)) return {data:[]};
  if(/addMagnet/.test(url)) return {data:{id:'RD1'}};
  if(/torrents\/info/.test(url)) return {data:{status:'downloaded',progress:100,files:[{id:1,path:'/Test.Movie.2010.1080p.mkv',selected:1}],links:['l1']}};
  if(/selectFiles/.test(url)) return {status:204,data:''};
  if(/unrestrict/.test(url)) return {data:{download:'https://rd.example/dl'}};
  if(/thetvdb.*login/.test(url)) return {data:{data:{token:'T'}}};
  if(/thetvdb.*translations/.test(url)) return {data:{data:{name:'Test Show'}}};
  throw new Error('stub no route '+method+' '+url);
};
const axios=async()=>({});
axios.get=async(u,o)=>route(u,'GET',o); axios.post=async(u,d,o)=>route(u,'POST',o); axios.delete=async()=>({});
axios.create=()=>({get:async(u,o)=>route(u,'GET',o)});
const routes=[];
function express(){const app=function(){};for(const m of ['get','post','use','set','listen'])app[m]=(...a)=>{routes.push({m,a})};return app;}
express.json=()=>()=>{};
class FD{constructor(){this.f={}}append(k,v){this.f[k]=v}getHeaders(){return{}}}
const stubs={express,cors:()=>()=>{},dotenv:{config(){}},axios,'form-data':FD,cheerio:{load(){}},bncode:{},entities:{decode:s=>s},'@upstash/redis':{Redis:class{}},'playwright-core':{},'@sparticuz/chromium':{}};
const orig=Module._load;
Module._load=function(r,...a){ if(stubs[r]!==undefined) return stubs[r]; return orig.call(this,r,...a); };
const fake=(rel,exp)=>{const p=require.resolve(path.join(ROOT,rel));require.cache[p]={id:p,filename:p,loaded:true,exports:exp,children:[],paths:[]};};
const mk=(name,id,cat='Filmy',z=[])=>({name,id,size:'4 GB',seeds:10,category:cat,zanre:z,downloadUrl:'x'+id});
fake('lib/sktorrent.js',{
  hladatTorrenty:async(q)=>{ if(/Show|Relacia/.test(q)) return [mk('Stiahni si Serialy Test Show S01E02 1080p SK',H3,'Serialy'),mk('Stiahni si Serialy Test Show S02E02 1080p SK','d'.repeat(40),'Serialy')];
     return [mk('Stiahni si Filmy Test Movie 2010 1080p CZ',H1),mk('Stiahni si Filmy Test Movie 2010 WEB-DL 720p',H2),mk('Stiahni si xXx Test Movie 2010 erotika','e'.repeat(40),'xXx hry (18+)',['Eroticky'])]; },
  stiahnutTorrentData:async(u)=>({infoHash:u.includes(H3)?H3:H1,files:[{path:u.includes(H3)?'Test.Show.S01E02.mkv':'Test.Movie.2010.1080p.mkv',index:0,length:4e9}],trackers:['http://tracker.example/announce']}),
  stiahnutSurovyTorrent:async()=>Buffer.alloc(200)});
fake('lib/csfd.js',{ziskatCsfdUrl:async()=>null,normalizujUrl:x=>x,vyberNajlepsiVysledok:()=>null});
const common=require(path.join(ROOT,'lib/common.js'));
const app=require(path.join(ROOT,'sktorrent-addon.js'));
const find=(m,p)=>routes.find(r=>r.m===m&&(Array.isArray(r.a[0])?r.a[0].includes(p):r.a[0]===p));
const mkres=()=>({statusCode:200,headers:{},body:null,setHeader(k,v){this.headers[k]=v},set(o){Object.assign(this.headers,o)},status(c){this.statusCode=c;return this},json(o){this.body=o;this.done=1},send(s){this.body=s;this.done=1},redirect(c,u){this.redir=[c,u];this.done=1},sendFile(p){this.file=p;this.done=1}});
const mkreq=(params,extra={})=>Object.assign({params,query:{},headers:{},protocol:'https',get:()=>'addon.test',originalUrl:'/x',ip:'1.1.1.1',body:{}},extra);
const call=async(m,p,req)=>{const r=find(m,p); if(!r) throw new Error('no route '+p); const h=r.a[r.a.length-1]; const res=mkres(); await h(req,res,(e)=>{if(e)throw e}); return res;};
const tok=(o)=>common.encodeConfig(o);
let fails=0; const ok=(c,msg)=>{console.log((c?'PASS ':'FAIL ')+msg); if(!c)fails++;};
(async()=>{
 // config-token
 let r=await call('post','/api/config-token',mkreq({}, {body:{uid:'1',pass:'p',debridProvider:'torbox',torbox:'K',evil:'x',lang:['sk']}}));
 ok(r.body&&r.body.token&&r.body.token.startsWith('e1.'),'config-token vráti šifrovaný token');
 const dec=common.decodeConfig(r.body.token); ok(dec&&dec.torbox==='K'&&!dec.evil,'token dekóduje a ignoruje cudzie kľúče');
 r=await call('post','/api/config-token',mkreq({}, {body:{}})); ok(r.statusCode===400,'prázdny config -> 400');
 // legacy base64
 const legacy=Buffer.from(JSON.stringify({uid:'1',pass:'p',torbox:'K'})).toString('base64url');
 ok(common.decodeConfig(legacy).torbox==='K','legacy base64 config sa číta');
 // configure + manifest
 r=await call('get','/configure',mkreq({})); ok(typeof r.body==='string'&&r.body.includes('/api/config-token')&&r.body.includes('realdebrid'),'configure page (Judzim UI + šifrovaný token)');
 r=await call('get','/manifest.json',mkreq({})); ok(r.body.idPrefixes.includes('tvdb')&&r.body.idPrefixes.includes('tmdb'),'manifest idPrefixes');
 // TorBox stream
 const tbCfg=tok({uid:'1',pass:'p',debridProvider:'torbox',torbox:'KEY'});
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:tbCfg,type:'movie',id:'tt0000001'}));
 let s=r.body.streams; console.log(' TB:',JSON.stringify(s.map(x=>x.name.split('\n')[0]+' '+(x.url||'').slice(0,60))));
 ok(s.length>=1&&s[0].name.startsWith('[TB ⚡]')&&s[0].url.includes('/play/'+H1),'TorBox: cached stream prvý, /play URL');
 ok(s.some(x=>x.name.startsWith('[TB ⏳]')&&x.url.includes('/download/')),'TorBox: uncached -> /download');
 // RD stream
 const rdCfg=tok({uid:'1',pass:'p',debridProvider:'realdebrid',realdebrid:'RDKEY',adult:['hide']});
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:rdCfg,type:'movie',id:'tt0000001'}));
 s=r.body.streams; console.log(' RD:',JSON.stringify(s.map(x=>x.name.split('\n')[0])));
 ok(s.length>=1&&s.some(x=>x.name.startsWith('[RD ❌]')),'RD: WEB-DL označené ❌');
 ok(!s.some(x=>/xxx/i.test(x.title||'')),'18+ filter skryl xXx');
 // P2P
 const p2pCfg=tok({uid:'1',pass:'p',debridProvider:'p2p'});
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:p2pCfg,type:'movie',id:'tt0000001'}));
 s=r.body.streams; ok(s.length>=1&&s[0].infoHash&&Array.isArray(s[0].sources)&&s[0].sources.length===1&&s[0].name.startsWith('[P2P]'),'P2P: infoHash + trackery (sources)');
 // legacy ZASA config (torbox bez debridProvider)
 const legCfg=tok({uid:'1',pass:'p',torbox:'KEY',showUncached:true,sizeOrder:'desc',qualityOrder:[4,3,2,1,0]});
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:legCfg,type:'movie',id:'tt0000001'}));
 ok(r.body.streams.length>=1&&r.body.streams[0].name.startsWith('[TB'),'Legacy ZASA config funguje');
 // TVDB id serial
 const tvCfg=tok({debridProvider:'torbox',torbox:'KEY',tvdb:'TVDBKEY',uid:'',pass:''});
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:tvCfg,type:'series',id:'tvdb:466037:official:1:2'}));
 s=r.body.streams; console.log(' TVDB:',JSON.stringify(s.map(x=>x.name.split('\n')[0]+' '+(x.title||'').split('\n')[1])));
 ok(s.length===1&&/S01E02|Epiz/.test(JSON.stringify(s)) ,'tvdb:...:official:1:2 -> iba S01E02');
 // serial tt id
 r=await call('get','/:config/stream/:type/:id.json',mkreq({config:p2pCfg,type:'series',id:'tt0000002:1:2'}));
 ok(r.body.streams.length===1,'tt serial S01E02 filter (S02E02 vyradené)');
 // play TorBox
 r=await call('get','/:config/play/:hash/:seria/:epizoda/:fileName',mkreq({config:tbCfg,hash:H1,seria:'0',epizoda:'0',fileName:'Test.Movie.2010.1080p.mkv'}));
 ok(r.redir&&r.redir[1]==='https://cdn.example/video.mkv',`play TorBox redirect (${JSON.stringify(r.redir||r.body)})`);
 // play RD
 r=await call('get','/:config/play/:hash/:seria/:epizoda/:fileName',mkreq({config:rdCfg,hash:H1,seria:'0',epizoda:'0',fileName:'Test.Movie.2010.1080p.mkv'}));
 ok(r.redir&&r.redir[1]==='https://rd.example/dl',`play RD redirect (${JSON.stringify(r.redir||r.body)})`);
 // download TorBox + RD
 r=await call('get','/:config/download/:hash/:sktId',mkreq({config:tbCfg,hash:H2,sktId:H2}));
 ok(r.redir&&r.redir[1]==='https://cdn.example/video.mkv'||r.redir&&r.redir[1]==='/info-video',`download TorBox (${JSON.stringify(r.redir||r.body)})`);
 r=await call('get','/:config/download/:hash/:sktId',mkreq({config:rdCfg,hash:H2,sktId:H2}));
 ok(r.redir&&r.redir[0]===302,`download RD (${JSON.stringify(r.redir||r.body)})`);
 console.log(fails?('FAILS '+fails):'ALL OK'); process.exit(fails?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(2)});
