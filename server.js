const express=require('express');
const sql=require('mssql');
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {StreamableHTTPServerTransport}=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {z}=require('zod');
const app=express(); app.disable('x-powered-by'); app.use(express.json({limit:'64kb'}));
const cfg={user:process.env.DB_USER,password:process.env.DB_PASSWORD,server:process.env.DB_HOST,port:Number(process.env.DB_PORT||1433),database:process.env.DB_NAME,options:{encrypt:process.env.DB_ENCRYPT==='true',trustServerCertificate:process.env.DB_TRUST_CERT==='true'},pool:{max:5,min:0,idleTimeoutMillis:30000},connectionTimeout:10000,requestTimeout:30000};
let pool; async function db(){if(!pool)pool=await new sql.ConnectionPool(cfg).connect();return pool;}
const forbidden=['insert','update','delete','merge','drop','alter','create','truncate','execute','exec','grant','revoke','deny','backup','restore','dbcc','kill','shutdown','waitfor','openrowset','opendatasource','bulk'];
function readOnly(q){
 let s=String(q||'').trim();
 if(!s||s.length>8000)throw new Error('consulta invalida');
 if(!/^(select|with)\b/i.test(s))throw new Error('somente SELECT ou CTE');
 const low=s.toLowerCase();
 if(forbidden.some(w=>new RegExp('\\b'+w+'\\b','i').test(low)))throw new Error('comando nao permitido');
 if(low.includes('--')||low.includes('/*')||low.includes('*/'))throw new Error('comentarios nao permitidos');
 if((s.match(/;/g)||[]).length>1||(s.includes(';')&&!/;\s*$/.test(s)))throw new Error('somente uma instrucao');
 return s.replace(/;\s*$/,'');
}
function val(v){if(v instanceof Date)return v.toISOString();if(typeof v==='bigint')return Number(v);if(Buffer.isBuffer(v))return '[binary]';return v;}
function rows(a){return a.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,val(v)])));}
async function query(q){const p=await db();const r=await p.request().query(readOnly(q));const all=r.recordset||[];return {linhas:Math.min(all.length,500),truncado:all.length>500,dados:rows(all.slice(0,500))};}
async function schema(){const p=await db();const r=await p.request().query("SELECT TABLE_SCHEMA AS esquema,TABLE_NAME AS objeto,COLUMN_NAME AS coluna,DATA_TYPE AS tipo FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION");return rows(r.recordset||[]);}
app.get('/health',async(req,res)=>{try{const p=await db();const r=await p.request().query("SELECT DB_NAME() banco");res.json({ok:true,database:r.recordset[0].banco,mcp:'/mcp',mode:'read-only'});}catch(e){res.status(503).json({ok:false,error:'database unavailable'});}});
function mcp(){
 const s=new McpServer({name:'Bem-Estar Gestao',version:'2.0.0'});
 s.registerTool('listar_estrutura_banco',{title:'Listar estrutura do banco',description:'Lista objetos e colunas que o usuario SQL somente leitura pode consultar. Use para descobrir onde esta a informacao solicitada.',inputSchema:z.object({})},async()=>({content:[{type:'text',text:JSON.stringify({modo:'somente leitura',estrutura:await schema()})}]}));
 s.registerTool('consultar_banco',{title:'Consultar banco Bem-Estar',description:'Executa consulta SQL Server somente leitura para responder perguntas sobre qualquer informacao acessivel ao usuario SQL. Apenas SELECT/CTE; alteracoes sao bloqueadas; maximo 500 linhas.',inputSchema:z.object({sql:z.string().min(1).max(8000)})},async({sql:q})=>{try{return {content:[{type:'text',text:JSON.stringify(await query(q))}]};}catch(e){return {isError:true,content:[{type:'text',text:'Consulta recusada ou falhou: '+e.message}]};}});
 return s;
}
app.post('/mcp',async(req,res)=>{try{const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>t.close());const s=mcp();await s.connect(t);await t.handleRequest(req,res,req.body);}catch(e){if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal server error'},id:null});}});
app.get('/mcp',(req,res)=>res.status(405).json({error:'Use MCP Streamable HTTP POST'}));
app.delete('/mcp',(req,res)=>res.status(405).end());
const port=Number(process.env.PORT||3000);app.listen(port,'0.0.0.0',()=>console.log('Bem-Estar universal read-only MCP v2 listening on '+port));
