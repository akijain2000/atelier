# Atelier — Project Context

Tenant chat and lead scoring platform for property managers.
Node.js + Express backend, React 19 + Vite frontend, PostgreSQL (Neon), Anthropic Claude AI.

## Deploy Configuration (configured by /setup-deploy)
- Platform: Render (see render.yaml for blueprint)
- Production URL: https://atelier.onrender.com (verify actual subdomain in Render dashboard)
- Deploy workflow: auto-deploy on push to main
- Deploy status command: HTTP health check
- Merge method: squash
- Project type: web app
- Post-deploy health check: https://atelier.onrender.com/api/health

### Custom deploy hooks
- Pre-merge: npm run build (verified by render.yaml buildCommand)
- Deploy trigger: automatic on push to main
- Deploy status: poll production URL
- Health check: /api/health

## Health Stack

- build: npx vite build
- audit: npm audit

## Design System

Always read DESIGN.md before making UI changes. It defines the project's type (App UI), color tokens, typography, spacing, layout breakpoints, motion rules, and accessibility requirements.

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
