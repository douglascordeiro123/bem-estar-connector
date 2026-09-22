const express=require('express');
const sql=require('mssql');
const crypto=require('crypto');
const { McpServer }=require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport }=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z }=require('zod');

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));

const cfg={
 user:process.env.DB_USER,
 password:process.env.DB_PASSWORD,
 server:process.env.DB_HOST,
 port:Number(process.env.DB_PORT||1433),
 database:process.env.DB_NAME,
 options:{encrypt:process.env.DB_ENCRYPT==='true',trustServerCertificate:process.env.DB_TRUST_CERT==='true'},
 pool:{max:5,min:0,idleTimeoutMillis:30000},
 connectionTimeout:10000,
 requestTimeout:30000
};
let pool;
async function db(){if(!pool) pool=await new sql.ConnectionPool(cfg).connect(); return pool;}

function auth(req,res,next){
 const expected=process.env.API_KEY;
 if(!expected) return res.status(503).json({ok:false,error:'API key not configured'});
 const got=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
 const a=Buffer.from(got),b=Buffer.from(expected);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({ok:false,error:'unauthorized'});
 next();
}

async function agendaHoje(){
 const p=await db();
 const r=await p.request().query("SELECT COUNT_BIG(*) AS quantidade FROM dbo.View_AgendaDia WHERE DMOV >= CONVERT(date,GETDATE()) AND DMOV < DATEADD(day,1,CONVERT(date,GETDATE()))");
 return Number(r.recordset[0].quantidade);
}
async function agendaResumo(dias){
 const p=await db();
 const q="SELECT CONVERT(date,DMOV) AS data,COUNT_BIG(*) AS quantidade FROM dbo.View_AgendaDia WHERE DMOV >= DATEADD(day,-@dias,CONVERT(date,GETDATE())) AND DMOV < DATEADD(day,1,CONVERT(date,GETDATE())) GROUP BY CONVERT(date,DMOV) ORDER BY data";
 const r=await p.request().input('dias',sql.Int,dias).query(q);
 return r.recordset.map(x=>({data:x.data,quantidade:Number(x.quantidade)}));
}

app.get('/health',async(req,res)=>{
 try{const p=await db();const r=await p.request().query("SELECT DB_NAME() AS banco");res.json({ok:true,database:r.recordset[0].banco,mcp:'/mcp'});}
 catch(e){res.status(503).json({ok:false,error:'database unavailable'});}
});

app.use('/api',auth);
app.get('/api/schema',async(req,res)=>{
 try{const p=await db();const r=await p.request().query("SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS object_name,TABLE_TYPE AS object_type FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA,TABLE_NAME");res.json({ok:true,objects:r.recordset});}
 catch(e){res.status(500).json({ok:false,error:'query failed'});}
});
app.get('/api/agenda/hoje',async(req,res)=>{
 try{res.json({ok:true,periodo:'hoje',quantidade:await agendaHoje()});}
 catch(e){res.status(500).json({ok:false,error:'query failed'});}
});
app.get('/api/agenda/resumo',async(req,res)=>{
 const dias=Math.min(Math.max(parseInt(req.query.dias||'30',10)||30,1),366);
 try{res.json({ok:true,dias,serie:await agendaResumo(dias)});}
 catch(e){res.status(500).json({ok:false,error:'query failed'});}
});

function createMcp(){
 const server=new McpServer({name:'Bem-Estar Gestao',version:'1.0.0'});
 server.registerTool('agenda_hoje',{
   title:'Agendamentos de hoje',
   description:'Retorna somente a quantidade total de agendamentos de hoje na Bem-Estar. Consulta somente leitura.',
   inputSchema:z.object({})
 },async()=>({content:[{type:'text',text:JSON.stringify({periodo:'hoje',quantidade:await agendaHoje()})}]}));
 server.registerTool('agenda_resumo',{
   title:'Resumo de agendamentos',
   description:'Retorna quantidades agregadas de agendamentos por dia. Não retorna nomes, CPF, telefone ou dados clínicos.',
   inputSchema:z.object({dias:z.number().int().min(1).max(366).default(30)})
 },async({dias})=>({content:[{type:'text',text:JSON.stringify({dias,serie:await agendaResumo(dias)})}]}));
 return server;
}

app.post('/mcp',async(req,res)=>{
 try{
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   res.on('close',()=>transport.close());
   const server=createMcp();
   await server.connect(transport);
   await transport.handleRequest(req,res,req.body);
 }catch(e){
   if(!res.headersSent) res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal server error'},id:null});
 }
});
app.get('/mcp',(req,res)=>res.status(405).json({error:'Use MCP Streamable HTTP POST'}));
app.delete('/mcp',(req,res)=>res.status(405).end());

const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log('Bem-Estar REST + MCP listening on '+port));
