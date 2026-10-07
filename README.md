# party-planner-app
Interactive party planning application with Copilot-powered menu and alternative suggestions, ingredient sourcing, and nearby store recommendations

## Run locally

Requires Node.js 22.12+.

```sh
npm ci
cp .env.example .env
npm start
```

Open http://127.0.0.1:3000 (not `index.html` via `file://`). The seven-step flow includes setup, three baseline menus, editing, scaled ingredients, alternatives, updated menu, and ranked stores. All manual features work without Copilot authentication.

For AI suggestions, set `GITHUB_TOKEN` in `.env` to a token with access to GitHub Copilot and an eligible subscription. The SDK runs **only on the server**, using its bundled Copilot runtime. Optionally set `COPILOT_CLI_PATH` to an existing CLI. Set `COPILOT_MODEL` to a model available to your account (default `gpt-4o`). Authentication, model, quota, or runtime failures display a manual-selection fallback. Never put your token in browser code or commit `.env`.

## Data and saving

- `data/recipes.json`: per-serving quantities, ingredient references, vegetarian flags, allergens, and prep minutes for 18 dishes.
- `data/ingredients.json`: units, pack sizes, allergens, and storage notes.
- `data/stores.json`: five illustrative stores with location, distance in miles, current stock in ingredient units, expected restock quantities, and dates. **This is sample inventory, not a live store feed.** Update these JSON files and restart the server to change the catalog.
- `data/plans/`: JSON plans and selected shopping stores saved atomically after every step confirmation; load/resume them with **Load saved plan**. The browser also saves edits and suggestion history using guarded localStorage. Invalid state or blocked storage does not stop rendering.
- `logs/api.jsonl`: server-side request outcomes without tokens, raw prompts, or personal party data. Runtime plans and logs are gitignored.

Availability checks use the full ingredient quantity, including shared ingredients when swapping dishes. “Now” can require combining stock from several stores; each store card checks its own stock. Restock dates are estimates, not guarantees. Ingredient reuse is the percentage of a replacement's ingredient IDs already present in the menu. Recipe exclusions do not guarantee protection against allergen cross-contact; check labels and consult the stores.

The server binds to loopback by default. This is a **single-user local application**, not an authenticated multi-user service. Do not expose it publicly: anyone with server access could load saved plans and use the configured Copilot account. `HOST` and `PORT` can be configured for a trusted local environment.

## API

- `GET /api/catalog` returns the recipes, ingredients, and inventory.
- `POST /api/suggestions` accepts `context` (`menu`, `dishes`, or `alternatives`), `preferences` (`diet`: `veg`, `nonveg`, or `both`; `guests`; `vegetarians`; `allergies`; `eventType`; ISO `date`), `currentRows` (catalog dish IDs), and `availableIngredients` (ingredient IDs mapped to `now`, `soon`, or `unknown`). Optional `query` supports dish searches. Alternatives require `targetId`; optional `servings`, `menuRows` (`{id, servings}`), and `storeId` make quantity/store checks more precise.
- Returns `{suggestions: [{id, name, reason, confidence, availability}]}` with up to three verified catalog dishes. Local inventory, not client claims or model output, determines availability. AI menu options combine each recommended dish with complementary baseline dishes.
- `POST /api/plans` creates/updates a plan; `GET /api/plans` lists saved plans; `GET /api/plans/:id` resumes a plan.

Copilot has an explicit tool allowlist: only an in-memory `catalog_lookup`. Permissions deny shell execution, filesystem modifications, external URLs, and other tools. Read permissions are limited to the three catalog files. Every recommendation is checked against recipe and ingredient allergens, diet, catalog membership, and (for alternatives) vegetarian status, dish type, event date, and stock.

## Verify

```sh
npm run check
npm test
```

Tests use Node's built-in runner, temporary plan/log directories, and an injected suggestion provider; no live Copilot credentials are required. They cover dietary/allergen filtering, inventory dates and quantities, ingredient calculations, permission denial, API fallback, saving/resuming, and private-file isolation.
