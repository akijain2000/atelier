# Atelier — Project Context

Tenant chat and lead scoring platform for property managers.
Node.js + Express backend, React 19 + Vite frontend, PostgreSQL (Neon), Anthropic Claude AI.

## Deploy Configuration (configured by /setup-deploy)
- Platform: Render
- Production URL: https://atelier-production-b43e.up.railway.app
- Deploy workflow: auto-deploy on push to main
- Deploy status command: HTTP health check
- Merge method: squash
- Project type: web app
- Post-deploy health check: https://atelier-production-b43e.up.railway.app/api/health

### Custom deploy hooks
- Pre-merge: npm run build (verified by render.yaml buildCommand)
- Deploy trigger: automatic on push to main
- Deploy status: poll production URL
- Health check: /api/health

## Health Stack

- build: npx vite build
- audit: npm audit

## Key files
- server.js — Express backend (API routes, scoring, MCP integration)
- src/App.jsx — React frontend shell
- src/components/ — ChatPanel, ConversationList, ScoringSidebar, ListingSelector, MarkdownText
- lib/chatRuntime.js — Anthropic Claude chat with MCP tool calling
- mcp/ — MCP server for StayPortal/Supabase integration
- prompts/ — System prompts (Prompt.md, LeadScoring.md)
- prompts/listings/ — Listing data files

## Environment variables (set in Render dashboard)
- DATABASE_URL — Neon PostgreSQL connection string
- ANTHROPIC_API_KEY — Claude API key
- SUPABASE_URL — StayPortal MCP Supabase URL
- SUPABASE_ANON_KEY — StayPortal MCP anon key
- STAYPORTAL_EMAIL — MCP auth email
- STAYPORTAL_PASSWORD — MCP auth password
