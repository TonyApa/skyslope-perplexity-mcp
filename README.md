# SkySlope Perplexity MCP Connector

A custom MCP (Model Context Protocol) server that connects SkySlope brokerage data to Perplexity Computer as a remote connector.

## Tools

| Tool | Description |
|------|-------------|
| `list_transactions` | List transactions filtered by status, agent, office, date range |
| `get_listing_file` | Fetch a listing or sale file by ID or address |
| `missing_documents_report` | Report missing compliance documents for a file |
| `transaction_summary` | Full summary including participants, timeline, documents |

## Setup

### 1. Clone and install
```bash
git clone https://github.com/TonyApa/skyslope-perplexity-mcp
cd skyslope-perplexity-mcp
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your real credentials
```

### 3. Deploy to Railway
1. Push repo to GitHub
2. Go to railway.app and create New Project
3. Select Deploy from GitHub Repo
4. Add environment variables in Railway dashboard
5. Generate public domain under Settings > Networking

### 4. Add to Perplexity Computer
1. Go to Perplexity Settings > Connectors
2. Click + Custom Connector > Remote
3. Enter your Railway URL: `https://your-app.railway.app`
4. Set auth header: `x-api-key: your_MCP_SHARED_API_KEY`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SKYSLOPE_ACCESS_KEY` | SkySlope API access key |
| `SKYSLOPE_SECRET_KEY` | SkySlope API secret key |
| `SKYSLOPE_BASE_URL` | SkySlope API base URL (default: https://api.skyslope.com) |
| `SKYSLOPE_AUTH_MODE` | `basic` or `bearer` |
| `MCP_SHARED_API_KEY` | Secret key Perplexity uses to authenticate to this server |
| `PORT` | Server port (Railway sets this automatically) |

## Endpoints

- `GET /health` - Health check (no auth required)
- `GET /mcp/tools` - List available tools
- `POST /mcp/call` - Call a tool with arguments

## Oregon Life Property Group
Built for brokerage operations at Oregon Life Property Group, powered by Jason Mitchell Group.
