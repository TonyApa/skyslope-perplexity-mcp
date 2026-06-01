require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_SHARED_API_KEY || 'changeme';
const SKYSLOPE_ACCESS_KEY = process.env.SKYSLOPE_ACCESS_KEY;
const SKYSLOPE_SECRET_KEY = process.env.SKYSLOPE_SECRET_KEY;
const SKYSLOPE_BASE_URL = process.env.SKYSLOPE_BASE_URL || 'https://api.skyslope.com';
const SKYSLOPE_AUTH_MODE = process.env.SKYSLOPE_AUTH_MODE || 'basic';

// SSE client sessions
const sessions = new Map();

// SkySlope HTTP client
function skyslopeHeaders() {
  if (SKYSLOPE_AUTH_MODE === 'basic') {
    const encoded = Buffer.from(`${SKYSLOPE_ACCESS_KEY}:${SKYSLOPE_SECRET_KEY}`).toString('base64');
    return { 'Authorization': `Basic ${encoded}`, 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${SKYSLOPE_ACCESS_KEY}`, 'Content-Type': 'application/json' };
}

async function skyslopeGet(path, params = {}) {
  const url = `${SKYSLOPE_BASE_URL}${path}`;
  const response = await axios.get(url, { headers: skyslopeHeaders(), params });
  return response.data;
}

// MCP Tool definitions
const TOOLS = [
  {
    name: 'list_transactions',
    description: 'List SkySlope transactions for Oregon Life Property Group. Filter by status (open/pending/closed/all), agent name, office name, start date, end date, and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'pending', 'closed', 'all'], default: 'all' },
        agent_name: { type: 'string' },
        office_name: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      }
    }
  },
  {
    name: 'get_listing_file',
    description: 'Get a SkySlope listing or sale file and document metadata by file ID or property address.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        address: { type: 'string' }
      }
    }
  },
  {
    name: 'missing_documents_report',
    description: 'Return a report of missing compliance documents for a SkySlope transaction file.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: { type: 'string' },
        transaction_type: { type: 'string', enum: ['listing', 'buyer_sale', 'seller_sale'] }
      }
    }
  },
  {
    name: 'transaction_summary',
    description: 'Get a full summary of a SkySlope transaction including participants, timeline, prices, status, and documents.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        include_doc_list: { type: 'boolean', default: true }
      }
    }
  }
];

// Tool implementations
async function callTool(name, args = {}) {
  switch (name) {
    case 'list_transactions': return await listTransactions(args);
    case 'get_listing_file': return await getListingFile(args);
    case 'missing_documents_report': return await missingDocumentsReport(args);
    case 'transaction_summary': return await transactionSummary(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function listTransactions(args = {}) {
  const params = {};
  if (args.status && args.status !== 'all') params.status = args.status;
  if (args.agent_name) params.agentName = args.agent_name;
  if (args.office_name) params.officeName = args.office_name;
  if (args.start_date) params.startDate = args.start_date;
  if (args.end_date) params.endDate = args.end_date;
  if (args.limit) params.limit = args.limit;
  return await skyslopeGet('/v1/transactions', params);
}

async function getListingFile(args = {}) {
  if (args.file_id) return await skyslopeGet(`/v1/transactions/${args.file_id}`);
  if (args.address) return await skyslopeGet('/v1/transactions', { address: args.address, limit: 1 });
  throw new Error('Provide file_id or address');
}

async function missingDocumentsReport(args = {}) {
  const file = await skyslopeGet(`/v1/transactions/${args.file_id}`);
  const docs = await skyslopeGet(`/v1/transactions/${args.file_id}/documents`);
  const uploaded = (docs.documents || []).map(d => d.name?.toLowerCase());
  const required = requiredDocs(args.transaction_type || file.transactionType);
  const missing = required.filter(r => !uploaded.some(u => u && u.includes(r.toLowerCase())));
  return { file_id: args.file_id, address: file.address || file.propertyAddress, status: file.status, agent: file.agentName, missing_documents: missing, uploaded_count: uploaded.length };
}

async function transactionSummary(args = {}) {
  const id = args.file_id;
  if (!id) throw new Error('Provide file_id');
  const file = await skyslopeGet(`/v1/transactions/${id}`);
  const docs = args.include_doc_list !== false ? await skyslopeGet(`/v1/transactions/${id}/documents`) : { documents: [] };
  return { file_id: id, address: file.address || file.propertyAddress, status: file.status, transaction_type: file.transactionType, agent: file.agentName, office: file.officeName, buyers: file.buyers || [], sellers: file.sellers || [], list_date: file.listDate, close_date: file.closeDate, list_price: file.listPrice, sale_price: file.salePrice, documents: (docs.documents || []).map(d => ({ name: d.name, status: d.status })) };
}

function requiredDocs(type) {
  const base = ['Purchase Agreement', 'Agency Disclosure', 'Lead Paint Disclosure'];
  if (type === 'listing') return [...base, 'Listing Agreement', 'Seller Disclosure'];
  if (type === 'buyer_sale') return [...base, 'Buyer Representation Agreement', 'Final Settlement Statement'];
  return [...base, 'Seller Disclosure', 'Final Settlement Statement'];
}

// MCP JSON-RPC handler
async function handleMcpRequest(body) {
  const { jsonrpc, id, method, params } = body;
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'skyslope-mcp', version: '1.0.0' } } };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    }
    if (method === 'notifications/initialized') {
      return null;
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
  }
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'skyslope-perplexity-mcp', version: '1.0.0' }));

// SSE endpoint - MCP over SSE transport
app.get('/sse', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== MCP_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const sessionId = crypto.randomUUID();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send endpoint event with POST URL for this session
  const postUrl = `/messages?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${JSON.stringify(postUrl)}\n\n`);

  sessions.set(sessionId, res);

  req.on('close', () => sessions.delete(sessionId));
});

// Messages endpoint - receives JSON-RPC from client
app.post('/messages', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== MCP_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const sessionId = req.query.sessionId;
  const sseRes = sessions.get(sessionId);
  if (!sseRes) return res.status(400).json({ error: 'Session not found' });

  res.status(202).send('Accepted');

  const response = await handleMcpRequest(req.body);
  if (response) {
    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  }
});

// Streamable HTTP endpoint
app.post('/mcp', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== MCP_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  res.setHeader('Content-Type', 'application/json');
  const response = await handleMcpRequest(req.body);
  if (response) res.json(response);
  else res.status(204).send();
});

app.listen(PORT, () => console.log(`SkySlope MCP server running on port ${PORT} (SSE: /sse, HTTP: /mcp)`));
