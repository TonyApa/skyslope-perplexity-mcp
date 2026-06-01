require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_SHARED_API_KEY || 'changeme';
const SKYSLOPE_ACCESS_KEY = process.env.SKYSLOPE_ACCESS_KEY;
const SKYSLOPE_SECRET_KEY = process.env.SKYSLOPE_SECRET_KEY;
const SKYSLOPE_CLIENT_ID = process.env.SKYSLOPE_CLIENT_ID;
const SKYSLOPE_CLIENT_SECRET = process.env.SKYSLOPE_CLIENT_SECRET;
const SKYSLOPE_BASE_URL = process.env.SKYSLOPE_BASE_URL || 'https://api.skyslope.com';

// Cache session token
let sessionToken = null;
let sessionTokenExpiry = null;

function getApiKey(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || '';
}

async function getSessionToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (sessionToken && sessionTokenExpiry && Date.now() < sessionTokenExpiry - 300000) {
    return sessionToken;
  }

  const timestamp = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', SKYSLOPE_SECRET_KEY)
    .update(`${SKYSLOPE_CLIENT_ID}:${SKYSLOPE_CLIENT_SECRET}:${timestamp}`)
    .digest('base64');

  const authHeader = `SS ${SKYSLOPE_ACCESS_KEY}:${hmac}`;

  const response = await axios.post(`${SKYSLOPE_BASE_URL}/auth/login`, {
    clientID: SKYSLOPE_CLIENT_ID,
    clientSecret: SKYSLOPE_CLIENT_SECRET
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Timestamp': timestamp
    }
  });

  sessionToken = response.data.token || response.data.sessionToken || response.data;
  sessionTokenExpiry = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
  return sessionToken;
}

async function skyslopeGet(path, params = {}) {
  const token = await getSessionToken();
  const response = await axios.get(`${SKYSLOPE_BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    params
  });
  return response.data;
}

// MCP Tools definition
const tools = [
  {
    name: 'list_transactions',
    description: 'List SkySlope transactions (listings and sales files)',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: active, closed, all', enum: ['active', 'closed', 'all'] },
        limit: { type: 'number', description: 'Max number of results (default 25)' },
        offset: { type: 'number', description: 'Pagination offset' }
      }
    }
  },
  {
    name: 'get_listing_file',
    description: 'Get details of a specific SkySlope listing file by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The listing file ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'missing_documents_report',
    description: 'Get a report of missing or incomplete documents for a transaction',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The transaction/file ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'transaction_summary',
    description: 'Get a summary of a SkySlope transaction including parties, dates, and status',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The transaction/file ID' }
      },
      required: ['id']
    }
  }
];

async function callTool(name, args) {
  if (name === 'list_transactions') {
    const p = {};
    if (args.status && args.status !== 'all') p.status = args.status;
    if (args.limit) p.limit = args.limit;
    if (args.offset) p.offset = args.offset;
    return await skyslopeGet('/v1/listings', p);
  }
  if (name === 'get_listing_file') {
    return await skyslopeGet(`/v1/listings/${args.id}`);
  }
  if (name === 'missing_documents_report') {
    return await skyslopeGet(`/v1/listings/${args.id}/checklist`);
  }
  if (name === 'transaction_summary') {
    return await skyslopeGet(`/v1/listings/${args.id}`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// MCP JSON-RPC endpoint
app.post('/mcp', async (req, res) => {
  const key = getApiKey(req);
  if (key !== MCP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { jsonrpc, id, method, params } = req.body;

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'skyslope-mcp', version: '1.0.0' }
        }
      });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const result = await callTool(name, args || {});
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      });
    }

    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found' }
    });
  } catch (err) {
    console.error('Tool error:', err.response?.data || err.message);
    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32000, message: err.message, data: err.response?.data }
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`SkySlope MCP server running on port ${PORT}`));
