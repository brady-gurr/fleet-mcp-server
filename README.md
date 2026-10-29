# Fleet MCP wrapper (Coast + Fleetio / Ford Pro)

A small remote MCP server that lets Claude read **Coast** fuel card data and **Fleetio / Ford Pro** fleet data as a custom connector. Same design as the TOA/Quickbase wrapper.

Everything is **read-only**. The clients only ever send GET requests, and only to an allowlist of resources. Nothing Claude does through this connector can create, change or delete data in Coast or Fleetio.

- Claude <-> this server: per-person named secrets (`MCP_SHARED_SECRETS`).
- This server <-> Coast / Fleetio: API keys kept in Railway Variables only. Claude never sees them.

## Tools (4)

- `coast_list` / `coast_get`: purchases (fuel transactions), credits, fees, payments, cards, people (drivers), vehicles, locations, departments, policies, merchants.
- `fleetio_list` / `fleetio_get`: vehicles, fuel entries, odometer (meter) entries, contacts, issues, work orders, service entries, faults, inspections, assignments, and more.

Both list tools support `all` (page through results), `fields`, and `summary {groupBy, sum}` to total things like fuel spend by vehicle. Field names differ by system, so Claude lists a few rows first to see them. Each tool only registers if its API key is set.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MCP_SHARED_SECRETS` | yes | Named secrets, `name:secret,name2:secret2` |
| `COAST_API_KEY` | for Coast | Coast portal -> Integrations -> API keys |
| `FLEETIO_API_KEY` | for Fleetio | API key from your Fleetio instance's API keys page |
| `FLEETIO_ACCOUNT_TOKEN` | for Fleetio | Account token for that Fleetio account |
| `FLEETIO_BASE_URL` | optional | Default `https://fleetio.fordpro.com/api` |
| `FLEETIO_ACCOUNT_TOKEN_HEADER` | optional | Default `Account-Token` |
| `COAST_BASE_URL` | optional | Default `https://public.coastpay.com` (sandbox: `https://public.demo.coastpay.com`) |
| `PORT` | optional | Railway sets this itself |

## Hosting and adding it to Claude

Deploy exactly like the TOA wrapper: GitHub repo -> Railway (Dockerfile detected, redeploys on every push to `main`) -> Variables -> Networking -> Generate Domain.

In Claude: Settings -> Connectors -> Add custom connector, URL `https://<railway-domain>/mcp`, **No sign-in**, request header `authorization` = `Bearer ` + **that person's own secret only** (71 characters). Start a new chat (or Reconnect) after deploys. Then set the tools to Always allow under Customize -> Connectors -> Tool permissions, or keep "Needs approval" for sensitive data.

## Notes

- Stateless: a fresh MCP server and transport per request.
- Coast rate limit is 200 requests per 10 seconds per account (the client retries on 429).
- Fleetio paging is cursor-based, up to 100 records per page.

## Ready-made tools

- `fuel_spend_report` – Coast spend, gallons, avg $/gal and rebates for a date range, grouped by vehicle, driver, department, location, merchant, card, week or month.
- `fuel_flags` – exceptions worth a look: Coast flags, fills over tank size, very large fills, possible duplicates, a card on several trucks, non-fuel merchants, odometer backwards/unchanged, MPG outliers.
- `vehicle_match` – pairs Coast and Fleetio vehicles (VIN, then plate, then name) and lists unmatched ones.
- `trucks_needing_attention` – open issues, open faults, overdue renewals/inspections, open work orders per truck.
- `vehicle_360` – one truck across both systems.

Units: Coast `amount`, `costPerUnit`, `rebate` are cents; `purchaseDetails.fuel.volume` is thousandths of a gallon. All tools are GET-only.
