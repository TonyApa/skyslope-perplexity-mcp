require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_SHARED_API_KEY || 'changeme';
const SKYSLOPE_ACCESS_KEY = process.env.SKYSLOPE_ACCESS_KEY;
const SKYSLOPE_SECRET_KEY = process.env.SKYSLOPE_SECRET_KEY;
const SKYSLOPE_BASE_URL = process.env.SKYSLOPE_BASE_URL || 'https://api.skyslope.com';
const SKYSLOPE_AUTH_MODE = process.env.SKYSLOPE_AUTH_MODE || 'basic';

// Auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== MCP_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'skyslope-perplexity-mcp', version: '1.0.0' });
});

// MCP tools list
app.get('/mcp/tools', authenticate, (req, res) => {
  res.json({
    tools: [
      {
        name: 'list_transactions',
        description: 'List SkySlope transactions filtered by status, agent, office, and date range.',
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
        description: 'Get a SkySlope listing or sale file and related document metadata.',
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
        description: 'Return missing compliance documents for a file using brokerage rules.',
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
        description: 'Summarize a transaction file including participants, timeline, status, and compliance flags.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' },
            address: { type: 'string' },
            include_doc_list: { type: 'boolean', default: true }
          }
        }
      }
    ]
  });
});

// MCP tool call
app.post('/mcp/call', authenticate, async (req, res) => {
  const { name, arguments: args } = req.body;
  try {
    let result;
    switch (name) {
      case 'list_transactions':
        result = await listTransactions(args);
        break;
      case 'get_listing_file':
        result = await getListingFile(args);
        break;
      case 'missing_documents_report':
        result = await missingDocumentsReport(args);
        break;
      case 'transaction_summary':
        result = await transactionSummary(args);
        break;
      default:
        return res.status(400).json({ error: `Unknown tool: ${name}` });
    }
    res.json({ result });
  } catch (err) {
    console.error(`Tool error [${name}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Tool implementations
async function listTransactions(args = {}) {
  const params = {};
  if (args.status && args.status !== 'all') params.status = args.status;
  if (args.agent_name) params.agentName = args.agent_name;
  if (args.office_name) params.officeName = args.office_name;
  if (args.start_date) params.startDate = args.start_date;
  if (args.end_date) params.endDate = args.end_date;
  if (args.limit) params.limit = args.limit;
  const data = await skyslopeGet('/v1/transactions', params);
  return data;
}

async function getListingFile(args = {}) {
  if (args.file_id) {
    const data = await skyslopeGet(`/v1/transactions/${args.file_id}`);
    return data;
  }
  if (args.address) {
    const data = await skyslopeGet('/v1/transactions', { address: args.address, limit: 1 });
    return data;
  }
  throw new Error('Provide file_id or address');
}

async function missingDocumentsReport(args = {}) {
  const file = await skyslopeGet(`/v1/transactions/${args.file_id}`);
  const docs = await skyslopeGet(`/v1/transactions/${args.file_id}/documents`);
  const uploaded = (docs.documents || []).map(d => d.name?.toLowerCase());
  const required = requiredDocs(args.transaction_type || file.transactionType);
  const missing = required.filter(r => !uploaded.some(u => u && u.includes(r.toLowerCase())));
  return {
    file_id: args.file_id,
    address: file.address || file.propertyAddress,
    status: file.status,
    agent: file.agentName,
    missing_documents: missing,
    uploaded_count: uploaded.length,
    last_updated: file.modifiedDate || new Date().toISOString()
  };
}

async function transactionSummary(args = {}) {
  const id = args.file_id;
  if (!id) throw new Error('Provide file_id');
  const file = await skyslopeGet(`/v1/transactions/${id}`);
  const docs = args.include_doc_list !== false
    ? await skyslopeGet(`/v1/transactions/${id}/documents`)
    : { documents: [] };
  return {
    file_id: id,
    address: file.address || file.propertyAddress,
    status: file.status,
    transaction_type: file.transactionType,
    agent: file.agentName,
    office: file.officeName,
    buyers: file.buyers || [],
    sellers: file.sellers || [],
    list_date: file.listDate,
    close_date: file.closeDate,
    list_price: file.listPrice,
    sale_price: file.salePrice,
    documents: (docs.documents || []).map(d => ({ name: d.name, status: d.status }))
  };
}

function requiredDocs(type) {
  const base = ['Purchase Agreement', 'Agency Disclosure', 'Lead Paint Disclosure'];
  if (type === 'listing') return [...base, 'Listing Agreement', 'Seller Disclosure'];
  if (type === 'buyer_sale') return [...base, 'Buyer Representation Agreement', 'Final Settlement Statement'];
  if (type === 'seller_sale') return [...base, 'Seller Disclosure', 'Final Settlement Statement'];
  return [...base, 'Seller Disclosure', 'Final Settlement Statement'];
}

app.listen(PORT, () => console.log(`SkySlope MCP server running on port ${PORT}`));
