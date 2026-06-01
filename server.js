require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());
app.use((req,res,next) => { console.log('REQ HEADERS:', JSON.stringify(req.headers)); next(); });

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_SHARED_API_KEY || 'changeme';
const SKYSLOPE_ACCESS_KEY = process.env.SKYSLOPE_ACCESS_KEY;
const SKYSLOPE_SECRET_KEY = process.env.SKYSLOPE_SECRET_KEY;
const SKYSLOPE_BASE_URL = process.env.SKYSLOPE_BASE_URL || 'https://api.skyslope.com';
const SKYSLOPE_AUTH_MODE = process.env.SKYSLOPE_AUTH_MODE || 'basic';

const sessions = new Map();

function getApiKey(req) {
    return req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ','') || req.query.api_key || req.headers['api-key'];
}
function skyslopeHeaders() {
  if (SKYSLOPE_AUTH_MODE === 'basic') {
    const encoded = Buffer.from(`${SKYSLOPE_ACCESS_KEY}:${SKYSLOPE_SECRET_KEY}`).toString('base64');
    return { 'Authorization': `Basic ${encoded}`, 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${SKYSLOPE_ACCESS_KEY}`, 'Content-Type': 'application/json' };
}

async function skyslopeGet(path, params = {}) {
  const response = await axios.get(`${SKYSLOPE_BASE_URL}${path}`, { headers: skyslopeHeaders(), params });
  return response.data;
}

const TOOLS = [
  { name: 'list_transactions', description: 'List SkySlope transactions for Oregon Life Property Group filtered by status, agent, office, date range.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open','pending','closed','all'] }, agent_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'get_listing_file', description: 'Get a SkySlope listing or sale file by file ID or property address.', inputSchema: { type: 'object', properties: { file_id: { type: 'string' }, address: { type: 'string' } } } },
  { name: 'missing_documents_report', description: 'Report missing compliance documents for a SkySlope transaction file.', inputSchema: { type: 'object', required: ['file_id'], properties: { file_id: { type: 'string' }, transaction_type: { type: 'string' } } } },
  { name: 'transaction_summary', description: 'Full summary of a SkySlope transaction including participants, timeline, prices, documents.', inputSchema: { type: 'object', properties: { file_id: { type: 'string' }, include_doc_list: { type: 'boolean' } } } }
];

async function callTool(name, args = {}) {
  if (name === 'list_transactions') {
    const p = {};
    if (args.status && args.status !== 'all') p.status = args.status;
    if (args.agent_name) p.agentName = args.agent_name;
    if (args.start_date) p.startDate = args.start_date;
    if (args.end_date) p.endDate = args.end_date;
    if (args.limit) p.limit = args.limit;
    return await skyslopeGet('/v1/transactions', p);
  }
  if (name === 'get_listing_file') {
    if (args.file_id) return await skyslopeGet(`/v1/transactions/${args.file_id}`);
    if (args.address) return await skyslopeGet('/v1/transactions', { address: args.address, limit: 1 });
    throw new Error('Provide file_id or address');
  }
  if (name === 'missing_documents_report') {
    const file = await skyslopeGet(`/v1/transactions/${args.file_id}`);
    const docs = await skyslopeGet(`/v1/transactions/${args.file_id}/documents`);
    const uploaded = (docs.documents||[]).map(d=>d.name?.toLowerCase());
    const base = ['Purchase Agreement','Agency Disclosure','Lead Paint Disclosure'];
    const required = args.transaction_type === 'listing' ? [...base,'Listing Agreement','Seller Disclosure'] : [...base,'Seller Disclosure','Final Settlement Statement'];
    return { file_id: args.file_id, address: file.address||file.propertyAddress, status: file.status, agent: file.agentName, missing_documents: required.filter(r=>!uploaded.some(u=>u&&u.includes(r.toLowerCase()))), uploaded_count: uploaded.length };
  }
  if (name === 'transaction_summary') {
    const file = await skyslopeGet(`/v1/transactions/${args.file_id}`);
    const docs = args.include_doc_list !== false ? await skyslopeGet(`/v1/transactions/${args.file_id}/documents`) : { documents: [] };
    return { file_id: args.file_id, address: file.address||file.propertyAddress, status: file.status, agent: file.agentName, office: file.officeName, list_price: file.listPrice, sale_price: file.salePrice, list_date: file.listDate, close_date: file.closeDate, documents: (docs.documents||[]).map(d=>({name:d.name,status:d.status})) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleJsonRpc(body) {
  const { id, method, params } = body;
  if (method === 'initialize') return { jsonrpc:'2.0', id, result: { protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'skyslope-mcp', version:'1.0.0' } } };
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc:'2.0', id, result:{} };
  if (method === 'tools/list') return { jsonrpc:'2.0', id, result:{ tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments||{});
      return { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text: JSON.stringify(result,null,2) }] } };
    } catch(e) {
      return { jsonrpc:'2.0', id, error:{ code:-32603, message: e.message } };
    }
  }
  return { jsonrpc:'2.0', id, error:{ code:-32601, message:`Method not found: ${method}` } };
}

app.get('/health', (req,res) => res.json({ status:'ok', service:'skyslope-perplexity-mcp', version:'1.0.0' }));

// Streamable HTTP MCP endpoint (POST)
app.post('/mcp', async (req,res) => {
  const key = getApiKey(req);
  if (key !== MCP_API_KEY) return res.status(401).json({ error:'Unauthorized' });

  const accept = req.headers['accept'] || '';
  const wantsStream = accept.includes('text/event-stream');

  const response = await handleJsonRpc(req.body);

  if (wantsStream) {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    if (response) res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    res.end();
  } else {
    res.setHeader('Content-Type','application/json');
    if (response) res.json(response);
    else res.status(204).end();
  }
});

// GET /mcp for Streamable HTTP session init
app.get('/mcp', (req,res) => {
  const key = getApiKey(req);
  if (key !== MCP_API_KEY) return res.status(401).json({ error:'Unauthorized' });
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, res);
  res.write(`event: endpoint\ndata: "/mcp?sessionId=${sessionId}"\n\n`);
  req.on('close', () => sessions.delete(sessionId));
});

// SSE endpoint
app.get('/sse', (req,res) => {
  const key = getApiKey(req);
  if (key !== MCP_API_KEY) return res.status(401).json({ error:'Unauthorized' });
  const sessionId = crypto.randomUUID();
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  sessions.set(sessionId, res);
  res.write(`event: endpoint\ndata: "/messages?sessionId=${sessionId}"\n\n`);
  req.on('close', () => sessions.delete(sessionId));
});

app.post('/messages', async (req,res) => {
  const key = getApiKey(req);
  if (key !== MCP_API_KEY) return res.status(401).json({ error:'Unauthorized' });
  const sseRes = sessions.get(req.query.sessionId);
  if (!sseRes) return res.status(400).json({ error:'Session not found' });
  res.status(202).end();
  const response = await handleJsonRpc(req.body);
  if (response) sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
});

app.listen(PORT, () => console.log(`SkySlope MCP ready on port ${PORT}`));
