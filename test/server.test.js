import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { catalog, createServer, permissionHandler, validateSuggestions, validateSuggestionRequest, validatePlan } from '../server.js';
import { allowed, defaultPlan, totals, ingredientAvailability, dishAvailability, baselineMenus } from '../domain.js';

const preferences = { ...defaultPlan().preferences, date: '2026-10-10' };
const request = { context: 'dishes', preferences, currentRows: [], availableIngredients: {} };
const suggestion = id => ({ id, reason: 'Fits the party.', confidence: 0.9 });

test('catalog references, ingredient allergens, and store inventories are complete', () => {
  assert.ok(catalog.recipes.length >= 15);
  assert.ok(catalog.stores.length >= 5);
  assert.equal(new Set(catalog.recipes.map(r => r.id)).size, catalog.recipes.length);
  for (const recipe of catalog.recipes) {
    for (const [id, quantity] of Object.entries(recipe.ingredients)) {
      assert.ok(catalog.ingredients[id]);
      assert.ok(quantity > 0);
    }
  }
  for (const store of catalog.stores) {
    assert.deepEqual(Object.keys(store.inventory).sort(), Object.keys(catalog.ingredients).sort());
    for (const item of Object.values(store.inventory)) {
      assert.ok(item.currentStock >= 0);
      assert.ok(['now', 'soon', 'unknown'].includes(item.status));
      if (item.status === 'soon') assert.match(item.restockDate, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('suggestions discard unknown, duplicate, selected, allergic, and invalid scores', () => {
  const raw = [suggestion('missing'), suggestion('peanut-tofu'), suggestion('lime-slaw'), suggestion('lime-slaw'),
    { ...suggestion('fruit-cups'), confidence: 1.1 }, suggestion('bean-tacos')];
  const result = validateSuggestions(raw, { ...request, currentRows: ['bean-tacos'] });
  assert.deepEqual(result.map(r => r.id), ['lime-slaw']);
  assert.equal(result[0].name, 'Lime cabbage slaw');
  assert.equal(result[0].availability, 'now');
  assert.equal(validateSuggestions([suggestion('chicken-tacos')], { ...request, preferences: { ...preferences, diet: 'veg' } }).length, 0);
  const recipe = { ...catalog.recipes.find(r => r.id === 'berry-yogurt'), allergens: [] };
  assert.equal(allowed(recipe, { ...preferences, allergies: ['milk'] }, catalog.ingredients), false);
});

test('alternatives preserve dish type, vegetarian rules, dates, and stock quantities', () => {
  const req = { ...request, context: 'alternatives', currentRows: ['cilantro-slaw'], targetId: 'cilantro-slaw', servings: 20 };
  assert.deepEqual(validateSuggestions([suggestion('lime-slaw'), suggestion('chicken-tacos'), suggestion('guacamole')], req).map(r => r.id), ['lime-slaw']);
  const starter = { ...req, currentRows: ['bean-dip'], targetId: 'bean-dip' };
  assert.equal(validateSuggestions([suggestion('guacamole')], { ...starter, storeId: 'market-b' }).length, 0);
  assert.equal(validateSuggestions([suggestion('guacamole')], starter)[0].availability, 'soon');
  const tiny = [{ inventory: { lime: { status: 'now', currentStock: 1 } } }];
  assert.equal(ingredientAvailability('lime', 2, tiny).status, 'unknown');
  assert.equal(dishAvailability(catalog.recipes.find(r => r.id === 'lime-slaw'), 500, [catalog.stores[4]]).status, 'unknown');
});

test('alternative stock includes other dishes sharing ingredients', () => {
  const req = {
    ...request, context: 'alternatives', currentRows: ['cilantro-slaw', 'bean-tacos'],
    targetId: 'cilantro-slaw', servings: 20, storeId: 'corner',
    menuRows: [{ id: 'cilantro-slaw', servings: 20 }, { id: 'bean-tacos', servings: 40 }]
  };
  assert.equal(validateSuggestions([suggestion('lime-slaw')], req).length, 0);
  assert.throws(() => validateSuggestionRequest({ ...req, servings: 10 }), /servings must match/);
});

test('scaled ingredient quantities and baseline dietary exclusions', () => {
  assert.deepEqual(totals([{ id: 'chicken-tacos', servings: 12 }, { id: 'bean-tacos', servings: 8 }], catalog.recipes),
    { tortillas: 40, chicken: 2400, lime: 5, oil: 60, beans: 1200, tomato: 400 });
  for (const diet of ['veg', 'nonveg', 'both']) {
    for (const menu of baselineMenus(catalog, { ...preferences, diet })) {
      for (const row of menu.rows) assert.ok(allowed(catalog.recipes.find(r => r.id === row.id), { ...preferences, diet }, catalog.ingredients));
    }
  }
});

test('permissions fail closed for shell, writes, traversal, and managed approval', () => {
  for (const kind of ['shell', 'shell_execution', 'write', 'filesystem_operations', 'url', 'mcp']) {
    const result = permissionHandler({ kind });
    assert.equal(result.kind, 'reject');
    assert.match(result.feedback, /blocked/);
  }
  assert.equal(permissionHandler({ kind: 'read', path: '.env' }).kind, 'reject');
  assert.equal(permissionHandler({ kind: 'read', path: 'data/../.env' }).kind, 'reject');
  assert.equal(permissionHandler({ kind: 'read', path: 'data/recipes.json' }).kind, 'approved');
  assert.equal(permissionHandler({ kind: 'read', path: 'data/recipes.json', resolvedPath: '/etc/passwd' }).kind, 'reject');
  assert.equal(permissionHandler({ kind: 'custom-tool', toolName: 'catalog_lookup' }).kind, 'approved');
  assert.equal(permissionHandler({ kind: 'custom-tool', toolName: 'catalog_lookup', managedApprovalRequired: true }).kind, 'reject');
});

test('reject malformed request preferences and unsafe saved plans', () => {
  assert.throws(() => validateSuggestionRequest({ ...request, preferences: { ...preferences, guests: -1 } }));
  assert.throws(() => validateSuggestionRequest({ ...request, preferences: { ...preferences, date: '2026-02-30' } }));
  assert.throws(() => validateSuggestionRequest({ ...request, currentRows: ['invalid'] }));
  assert.throws(() => validateSuggestionRequest({ ...request, availableIngredients: { lime: 'available' } }));
  assert.throws(() => validatePlan({ ...defaultPlan(), id: '../../.env' }));
  assert.throws(() => validatePlan({ ...defaultPlan(), preferences: { ...preferences, diet: 'veg' }, rows: [{ id: 'chicken-tacos', servings: 1 }] }));
  assert.throws(() => validatePlan({ ...defaultPlan(), history: [{ context: 'dishes', date: 'invalid', suggestions: [] }] }));
  assert.throws(() => validatePlan({ ...defaultPlan(), selectedStore: 'missing-store' }));
});

test('HTTP catalog, suggestion fallback, persistent resume, and static isolation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'partypal-test-'));
  const server = createServer({
    plansDir: join(dir, 'plans'), logsDir: join(dir, 'logs'),
    suggest: async req => {
      if (req.query === 'offline') throw new Error('Simulated provider failure');
      return [suggestion('lime-slaw'), suggestion('peanut-tofu')];
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/catalog')).status, 200);
  const page = await (await fetch(base)).text();
  assert.equal((page.match(/data-step="/g) || []).length, 7);
  const ai = await post('/api/suggestions', request);
  assert.deepEqual((await ai.json()).suggestions.map(s => s.id), ['lime-slaw']);
  const offline = await post('/api/suggestions', { ...request, query: 'offline' });
  assert.equal(offline.status, 503);
  assert.match((await offline.json()).error, /manual selection/);
  assert.equal((await post('/api/suggestions', request, { Origin: 'https://evil.example' })).status, 403);
  const party = { ...defaultPlan(), preferences, rows: [{ id: 'bean-tacos', servings: 20 }], originalRows: [{ id: 'bean-tacos', servings: 20 }], selectedStore: 'market-a', step: 3 };
  const saved = await (await post('/api/plans', party)).json();
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal((await (await fetch(base + '/api/plans')).json()).length, 1);
  const resumed = await (await fetch(base + `/api/plans/${saved.id}`)).json();
  assert.deepEqual(resumed.rows, party.rows);
  assert.equal(resumed.step, 3);
  assert.equal(resumed.selectedStore, 'market-a');
  const updated = await (await post('/api/plans', { ...saved, step: 4 })).json();
  assert.equal(updated.id, saved.id);
  assert.equal((await (await fetch(base + '/api/plans')).json()).length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'plans', `${saved.id}.json`), 'utf8')).step, 4);
  const history = Array.from({ length: 100 }, () => ({
    context: 'dishes', date: new Date().toISOString(),
    suggestions: ['lime-slaw', 'fruit-cups', 'bean-dip'].map(id => ({ ...suggestion(id), reason: '☃'.repeat(500), availability: 'now' }))
  }));
  assert.equal((await post('/api/plans', { ...saved, history })).status, 200);
  for (const path of ['/.env', '/data/plans/' + saved.id + '.json', '/logs/api.jsonl', '/server.js', '/package.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await post('/api/plans', { ...party, id: '../secret' })).status, 400);
  assert.equal((await fetch(base + '/api/plans/../secret')).status, 404);
  assert.match(await readFile(join(dir, 'logs', 'api.jsonl'), 'utf8'), /"status":503/);
});

test('missing Copilot authentication has a clear manual fallback', async () => {
  const { copilotSuggestions } = await import('../server.js');
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try { await assert.rejects(copilotSuggestions(request), /choose dishes manually/); }
  finally { if (token !== undefined) process.env.GITHUB_TOKEN = token; }
});
