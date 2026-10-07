import { steps, allergyNames, defaultPlan, validPreferences, allowed, totals, ingredientAvailability, dishAvailability, readyBy, reuseRate, baselineMenus } from './domain.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let catalog = null;
let plan = defaultPlan();
let ai = { loading: false, suggestions: [], error: '' };
let targetId = '';
let storeId = '';
let removed = null;
let query = '';
let searchTimer;
let controller;
let busy = false;
let storageWarning = '';

function notice(message) { $('#notice').textContent = message; }
function localSave() {
  try { localStorage.setItem('partypal-plan', JSON.stringify(plan)); }
  catch { storageWarning = 'Browser storage is blocked. Confirm each step to save on the server.'; notice(storageWarning); }
}

function recover(value) {
  if (!value || !validPreferences(value.preferences) || !Number.isInteger(value.step) || value.step < 0 || value.step > 6) throw new Error('Invalid saved state');
  const clean = defaultPlan();
  clean.preferences = value.preferences;
  for (const field of ['rows', 'originalRows']) {
    if (!Array.isArray(value[field])) throw new Error('Invalid saved rows');
    clean[field] = value[field].filter((r, i, all) => r && Number.isInteger(r.servings) && r.servings > 0 && r.servings <= 500 &&
      all.findIndex(other => other?.id === r.id) === i && (!catalog || allowed(catalog.recipes.find(d => d.id === r.id), value.preferences, catalog.ingredients)));
  }
  clean.step = clean.rows.length || value.step < 2 ? value.step : 1;
  if (typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)) clean.id = value.id;
  clean.selectedMenu = typeof value.selectedMenu === 'string' ? value.selectedMenu.slice(0, 100) : '';
  clean.selectedStore = typeof value.selectedStore === 'string' && (!catalog || catalog.stores.some(s => s.id === value.selectedStore)) ? value.selectedStore : '';
  clean.changes = Array.isArray(value.changes) ? value.changes.filter(c => typeof c === 'string').slice(-100).map(c => c.slice(0, 200)) : [];
  clean.history = Array.isArray(value.history) ? value.history.filter(h =>
    h && ['menu', 'dishes', 'alternatives'].includes(h.context) && typeof h.date === 'string' && Number.isFinite(Date.parse(h.date)) &&
    Array.isArray(h.suggestions) && h.suggestions.length <= 3 && h.suggestions.every(s =>
      s && typeof s.id === 'string' && (!catalog || catalog.recipes.some(r => r.id === s.id)) &&
      typeof s.reason === 'string' && s.reason.length <= 500 && Number.isFinite(s.confidence) &&
      s.confidence >= 0 && s.confidence <= 1 && ['now', 'soon', 'unknown'].includes(s.availability))).slice(-100) : [];
  return clean;
}

try {
  const saved = localStorage.getItem('partypal-plan');
  if (saved) plan = recover(JSON.parse(saved));
} catch { storageWarning = 'Saved browser state could not be loaded. Start a new party or load a server-saved plan.'; }

async function api(path, body, signal) {
  const response = await fetch(path, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

function recipe(id) { return catalog.recipes.find(r => r.id === id); }
function safeRecipes() { return catalog.recipes.filter(r => allowed(r, plan.preferences, catalog.ingredients)); }
function activeStores() { return storeId ? catalog.stores.filter(s => s.id === storeId) : catalog.stores; }
function availabilityLabel(value) {
  const late = value.date && value.date > plan.preferences.date;
  const label = value.status === 'now' ? 'Now' : value.status === 'soon' ? `${value.date}${late ? ' · after your party' : ''}` : 'Ask store';
  return `<span class="${late ? 'late' : value.status}">${escape(label)}</span>`;
}
function resetAI() {
  controller?.abort();
  controller = null;
  clearTimeout(searchTimer);
  ai = { loading: false, suggestions: [], error: '' };
}
function header() {
  return `<div class="progress" aria-hidden="true">${steps.map((_, i) => `<span class="${i <= plan.step ? 'filled' : ''}"></span>`).join('')}</div>
    <div class="eyebrow">Step ${plan.step + 1} of 7 · ${steps[plan.step]}</div>`;
}
function navigation(label) {
  return `<div class="actions"><button data-action="back" ${plan.step === 0 || busy ? 'disabled' : ''}>Back</button>
    <button class="primary" data-action="next" ${busy || !catalog ? 'disabled' : ''}>${busy ? 'Saving…' : label}</button></div>`;
}
function setup() {
  const p = plan.preferences;
  return `<h2>Plan your party</h2><p class="subtitle">Start with your people. We’ll help with the rest.</p>
    <p class="badge">Shopping location · Sample stores within 5 miles</p>
    <form id="setup"><div class="fields">
    <label>Diet<select name="diet">${[['veg', 'Vegetarian'], ['nonveg', 'Non-vegetarian'], ['both', 'Both']].map(([id, name]) => `<option value="${id}" ${p.diet === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <label>Total guests<input name="guests" type="number" min="1" max="500" value="${p.guests}" required></label>
    <label>Vegetarian guests<input name="vegetarians" type="number" min="0" max="500" value="${p.vegetarians}" required></label>
    <label>Party date<input name="date" type="date" value="${escape(p.date)}" required></label>
    <label class="wide">Event<input name="eventType" maxlength="100" value="${escape(p.eventType)}" required></label>
    <fieldset class="wide"><legend>Allergies to exclude</legend>${allergyNames.map(a => `<label><input type="checkbox" name="allergies" value="${a}" ${p.allergies.includes(a) ? 'checked' : ''}>${a}</label>`).join('')}</fieldset>
    </div></form>${!catalog ? '<p class="muted">Connecting to the local catalog…</p>' : ''}${navigation('Generate menus')}`;
}
function dishList(rows) {
  return rows.map(row => `${escape(recipe(row.id).name)} (${row.servings})`).join(' · ');
}
function aiStatus() {
  return ai.loading ? '<div class="ai-status" role="status"><span class="spinner" aria-hidden="true"></span>Copilot is finding dishes that fit your party…</div>' :
    ai.error ? `<p class="warning" role="status">${escape(ai.error)} Manual selection is always available below.</p>` : '';
}
function reasoning(s) {
  return `<p class="reason">${escape(s.reason)}</p><span class="badge">${Math.round(s.confidence * 100)}% confidence</span><span class="badge">AI suggestion</span>`;
}
function aiMenu(s) {
  const menu = baselineMenus(catalog, plan.preferences)[1];
  const dish = recipe(s.id);
  const same = menu.rows.find(row => recipe(row.id).type === dish.type && (dish.type !== 'main' || recipe(row.id).vegetarian === dish.vegetarian));
  if (same) same.id = dish.id;
  else menu.rows.push({ id: dish.id, servings: dish.type === 'main' && plan.preferences.diet === 'both' ?
    (dish.vegetarian ? plan.preferences.vegetarians : plan.preferences.guests - plan.preferences.vegetarians) : plan.preferences.guests });
  menu.rows = menu.rows.filter(row => row.servings > 0);
  return { name: `Copilot · ${dish.name}`, rows: menu.rows };
}
function menus() {
  return `<h2>Choose a menu</h2><p class="subtitle">${plan.preferences.guests} guests · ${escape(plan.preferences.eventType)} · ${escape(plan.preferences.date)}</p>
    <h3>Three starting points</h3><div class="grid">${baselineMenus(catalog, plan.preferences).map((m, i) =>
      `<article class="card ${plan.selectedMenu === m.name ? 'selected' : ''}"><h3>${m.name}</h3><p>${dishList(m.rows)}</p><p class="muted">Recipe prep: ${m.rows.reduce((n, r) => n + recipe(r.id).prepTime, 0)} min (before scaling)</p><button data-action="menu" data-index="${i}">${plan.selectedMenu === m.name ? 'Selected' : 'Choose menu'}</button></article>`).join('')}</div>
    <div class="inline"><h3>Copilot ideas</h3><button data-action="suggest" ${ai.loading ? 'disabled' : ''}>Generate AI menus</button></div>
    <div id="ai-results">${menuAI()}</div>${navigation('Select and edit items')}`;
}
function menuAI() {
  return aiStatus() + `<div class="grid">${ai.suggestions.map((s, i) => {
    const m = aiMenu(s);
    return `<article class="card ${plan.selectedMenu === m.name ? 'selected' : ''}"><h3>${escape(m.name)}</h3><p>${dishList(m.rows)}</p>${reasoning(s)}<br><button data-action="ai-menu" data-index="${i}">Choose this menu</button></article>`;
  }).join('')}</div>`;
}
function edit() {
  return `<h2>Edit menu items</h2><p class="subtitle">${escape(plan.selectedMenu || 'Your menu')} · add, remove, and adjust servings</p>
    ${plan.rows.map(row => `<div class="item"><div><strong>${escape(recipe(row.id).name)}</strong><small>${recipe(row.id).vegetarian ? 'Vegetarian' : 'Non-vegetarian'} · ${recipe(row.id).type}</small></div>
      <div class="inline"><label>Servings<input type="number" data-servings="${row.id}" min="1" max="500" value="${row.servings}"></label><button data-action="remove" data-id="${row.id}">Remove</button></div></div>`).join('') || '<p>Your menu is empty. Add a dish below.</p>'}
    ${removed ? `<p class="warning">${escape(recipe(removed.id).name)} removed. <button data-action="undo">Undo</button></p>` : ''}
    <div class="search"><div class="inline"><label>Search dishes<input id="dish-search" type="search" maxlength="100" value="${escape(query)}" placeholder="Try salad, beans, or dessert"></label><button data-action="suggest">Suggest</button></div>
    <div class="inline"><label>Manual dish selection<select id="dish-select">${manualOptions()}</select></label><button data-action="add-manual">+ Add dish</button></div>
    <div id="ai-results">${dishAI()}</div></div>${navigation('Confirm items')}`;
}
function manualOptions() {
  const dishes = safeRecipes().filter(r => !plan.rows.some(row => row.id === r.id) &&
    `${r.name} ${r.description} ${r.type}`.toLowerCase().includes(query.toLowerCase()));
  return dishes.length ? dishes.map(r => `<option value="${r.id}">${escape(r.name)} · ${r.type}</option>`).join('') : '<option value="">No matching dishes</option>';
}
function dishAI() {
  return aiStatus() + `<div class="grid">${ai.suggestions.map(s => `<article class="card"><h3>${escape(s.name)}</h3>${reasoning(s)}<p>Availability: ${availabilityLabel(dishAvailability(recipe(s.id), newServings(recipe(s.id)), catalog.stores))}</p><button data-action="add" data-id="${s.id}">+ Quick add</button></article>`).join('')}</div>`;
}
function ingredientsTable(rows) {
  const quantities = totals(rows, catalog.recipes);
  return `<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th>Need</th><th>Packs</th><th>Available when?</th></tr></thead><tbody>${Object.entries(quantities).map(([id, qty]) => {
    const ingredient = catalog.ingredients[id];
    return `<tr><td>${escape(ingredient.name)}</td><td>${qty} ${ingredient.unit}</td><td>${Math.ceil(qty / ingredient.packSize)}</td><td>${availabilityLabel(ingredientAvailability(id, qty, catalog.stores))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function ingredients() {
  return `<h2>Ingredients</h2><p class="subtitle">Scaled to your dish servings · party ${escape(plan.preferences.date)}</p>${ingredientsTable(plan.rows)}
    <p class="muted">“Now” may require multiple stores. Restock quantities and dates are estimates; confirm with the store.</p>${navigation('See alternatives')}`;
}
function problemRows(stores = catalog.stores) {
  const quantities = totals(plan.rows, catalog.recipes);
  const missing = Object.keys(quantities).filter(id => !readyBy(ingredientAvailability(id, quantities[id], stores), plan.preferences.date));
  return plan.rows.filter(row => Object.keys(recipe(row.id).ingredients).some(id => missing.includes(id)));
}
function alternatives() {
  const problems = problemRows(activeStores());
  if (!targetId || !plan.rows.some(r => r.id === targetId)) targetId = problems[0]?.id || plan.rows[0]?.id || '';
  return `<h2>Alternatives</h2><p class="subtitle">Find a swap that keeps your dietary rules and uses ingredients available before your party.</p>
    ${storeId ? `<p class="warning">Shopping only at ${escape(activeStores()[0].name)}. <button data-action="all-stores">Use all stores</button></p>` : ''}
    ${problems.length ? `<p class="warning">Check these dishes: ${problems.map(r => escape(recipe(r.id).name)).join(', ')}. Stock may be insufficient or arrive after the party.</p>` : '<p class="now">Your ingredients are expected by the party. Swapping is optional.</p>'}
    <div class="inline"><label>Dish to replace<select id="target-select">${plan.rows.map(r => `<option value="${r.id}" ${r.id === targetId ? 'selected' : ''}>${escape(recipe(r.id).name)}</option>`).join('')}</select></label><button data-action="suggest">Suggest alternatives</button></div>
    <div id="ai-results">${alternativeAI()}</div>
    <h3>Manual alternatives</h3><p class="muted">Same dish type, compatible diet, and ingredients expected in time.</p>
    <div class="grid">${manualAlternatives().map(r => `<article class="card"><h3>${escape(r.name)}</h3><p>${escape(r.description)}</p><p>Ingredient reuse: ${reuseRate(r, plan.rows, catalog.recipes)}%</p><button data-action="swap" data-id="${r.id}">Use this dish</button></article>`).join('') || '<p>No safe swaps available. Edit or remove the dish instead.</p>'}</div>${navigation('Review updated menu')}`;
}
function replacementReady(r) {
  const target = plan.rows.find(row => row.id === targetId);
  if (!target) return false;
  const rows = plan.rows.map(row => row.id === targetId ? { id: r.id, servings: row.servings } : row);
  const need = totals(rows, catalog.recipes);
  return Object.keys(r.ingredients).every(id => readyBy(ingredientAvailability(id, need[id], activeStores()), plan.preferences.date));
}
function manualAlternatives() {
  const target = recipe(targetId);
  return target ? safeRecipes().filter(r => r.id !== targetId && !plan.rows.some(row => row.id === r.id) &&
    r.type === target.type && (!target.vegetarian || r.vegetarian) && replacementReady(r)) : [];
}
function alternativeAI() {
  return aiStatus() + `<div class="grid">${ai.suggestions.map(s => `<article class="card"><h3>${escape(s.name)}</h3><strong>Why this swap works</strong>${reasoning(s)}<p>Ingredient reuse: ${reuseRate(recipe(s.id), plan.rows, catalog.recipes)}%</p><button data-action="swap" data-id="${s.id}">Use this swap</button></article>`).join('')}</div>`;
}
function updated() {
  const before = totals(plan.originalRows, catalog.recipes);
  const after = totals(plan.rows, catalog.recipes);
  const deltas = [...new Set([...Object.keys(before), ...Object.keys(after)])].map(id => [id, Math.round(((after[id] || 0) - (before[id] || 0)) * 100) / 100]).filter(([, qty]) => qty !== 0);
  return `<h2>Updated menu</h2><p class="subtitle">One last look before shopping</p>
    <div class="card">${plan.rows.map(r => `<p><strong>${escape(recipe(r.id).name)}</strong> · ${r.servings} servings</p>`).join('')}</div>
    <h3>Ingredient changes</h3>${deltas.map(([id, qty]) => `<p class="${qty > 0 ? 'now' : 'late'}">${qty > 0 ? '+' : '−'} ${escape(catalog.ingredients[id].name)} · ${Math.abs(qty)} ${catalog.ingredients[id].unit}</p>`).join('') || '<p>No changes from your selected menu.</p>'}
    ${plan.changes.map(c => `<p class="muted">${escape(c)}</p>`).join('')}${ingredientsTable(plan.rows)}${navigation('Find where to buy')}`;
}
function shopping() {
  const quantities = totals(plan.rows, catalog.recipes);
  const ids = Object.keys(quantities);
  const stores = catalog.stores.map(s => ({ ...s, count: ids.filter(id => ingredientAvailability(id, quantities[id], [s]).status === 'now').length }))
    .sort((a, b) => b.count - a.count || a.distance - b.distance);
  return `<h2>Where to buy</h2><p class="subtitle">Most ingredients in stock first, then nearest · sample locations</p>
    <div class="grid">${stores.map((s, i) => {
      const affected = problemRows([s]);
      return `<article class="card ${plan.selectedStore === s.id ? 'selected' : ''}"><h3>${escape(s.name)} ${i === 0 ? '<span class="badge">Recommended</span>' : ''}</h3><p>${s.distance} mi · ${escape(s.location.address)}</p>
        <p class="now">${s.count} of ${ids.length} ingredients in stock at the required quantity</p>
        ${ids.filter(id => ingredientAvailability(id, quantities[id], [s]).status !== 'now').map(id => `<p>${escape(catalog.ingredients[id].name)}: ${availabilityLabel(ingredientAvailability(id, quantities[id], [s]))}</p>`).join('')}
        ${affected.length ? `<p class="warning">If shopping only here, check: ${affected.map(r => escape(recipe(r.id).name)).join(', ')}.</p><button data-action="store-swaps" data-id="${s.id}">Find safe alternate dishes</button>` : '<p class="now">All ingredients expected by your party.</p>'}
        <details><summary>View basket</summary>${ids.map(id => `<p>${escape(catalog.ingredients[id].name)} · ${Math.ceil(quantities[id] / catalog.ingredients[id].packSize)} packs · ${availabilityLabel(ingredientAvailability(id, quantities[id], [s]))}</p>`).join('')}</details>
        <button data-action="shop" data-id="${s.id}">${plan.selectedStore === s.id ? 'Selected' : `Choose ${escape(s.name)}`}</button></article>`;
    }).join('')}</div><details><summary>Suggestion history (${plan.history.length})</summary>${plan.history.map(h =>
      `<p>${escape(h.date)} · ${escape(h.context)} · ${h.suggestions.map(s => escape(recipe(s.id)?.name || s.id)).join(', ')}</p>`).join('') || '<p>No AI suggestions yet.</p>'}</details>${navigation('Save party plan')}`;
}
function render() {
  $('#tracker').querySelectorAll('button').forEach((button, i) => {
    button.className = i === plan.step ? 'current' : i < plan.step ? 'done' : '';
    if (i === plan.step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    button.disabled = busy || (!catalog && i > 0) || (i > 1 && !plan.rows.length);
  });
  const views = [setup, menus, edit, ingredients, alternatives, updated, shopping];
  $('#content').innerHTML = header() + (catalog ? views[plan.step]() : setup());
}
function renderAI() {
  if (!$('#ai-results')) return;
  $('#ai-results').innerHTML = plan.step === 1 ? menuAI() : plan.step === 2 ? dishAI() : alternativeAI();
}
function newServings(dish) {
  if (dish.type === 'main' && plan.preferences.diet === 'both') return Math.max(1, dish.vegetarian ? plan.preferences.vegetarians : plan.preferences.guests - plan.preferences.vegetarians);
  return plan.preferences.guests;
}
async function suggest() {
  if (!catalog || ![1, 2, 4].includes(plan.step) || (plan.step === 4 && !targetId)) return;
  resetAI();
  const current = new AbortController();
  controller = current;
  ai.loading = true;
  renderAI();
  const timeout = setTimeout(() => current.abort(), 60000);
  const context = plan.step === 1 ? 'menu' : plan.step === 2 ? 'dishes' : 'alternatives';
  try {
    const quantities = totals(plan.rows, catalog.recipes);
    const availableIngredients = Object.fromEntries(Object.keys(catalog.ingredients).map(id => [id, ingredientAvailability(id, quantities[id] || 1, activeStores()).status]));
    const response = await api('/api/suggestions', {
      context, preferences: plan.preferences, currentRows: context === 'menu' ? [] : plan.rows.map(r => r.id),
      availableIngredients, query, ...(context === 'alternatives' ? {
        targetId, servings: plan.rows.find(r => r.id === targetId).servings, menuRows: plan.rows, ...(storeId ? { storeId } : {})
      } : {})
    }, current.signal);
    if (controller !== current) return;
    ai.suggestions = response.suggestions;
    plan.history.push({ context, date: new Date().toISOString(), suggestions: ai.suggestions });
    plan.history = plan.history.slice(-100);
    localSave();
  } catch (error) {
    if (controller !== current) return;
    ai.error = error.name === 'AbortError' ? 'AI took too long. Try again later.' : error.message;
  } finally {
    clearTimeout(timeout);
    if (controller === current) { ai.loading = false; renderAI(); }
  }
}
async function save() {
  localSave();
  try {
    const saved = await api('/api/plans', plan);
    plan.id = saved.id;
    localSave();
    notice(`Saved on the server.${storageWarning ? ` ${storageWarning}` : ''}`);
  } catch (error) { notice(`${error.message}${storageWarning ? ` ${storageWarning}` : ' Your plan is saved in this browser.'}`); }
}
function commitSetup() {
  const form = $('#setup');
  if (!form.reportValidity()) return false;
  const data = new FormData(form);
  const p = { diet: data.get('diet'), guests: Number(data.get('guests')), vegetarians: Number(data.get('vegetarians')), allergies: data.getAll('allergies'), eventType: data.get('eventType').trim(), date: data.get('date') };
  if (!validPreferences(p)) { notice('Check guest counts: vegetarians must be between zero and total guests.'); return false; }
  if (JSON.stringify(p) !== JSON.stringify(plan.preferences)) {
    plan.rows = []; plan.originalRows = []; plan.selectedMenu = ''; plan.selectedStore = ''; plan.changes = [];
  }
  plan.preferences = p;
  return true;
}
async function next() {
  if (busy || !catalog) return;
  if (plan.step === 0) {
    if (!commitSetup()) return;
  } else if (!plan.rows.length) return notice('Choose a menu or add at least one dish before continuing.');
  if (plan.step === 1) plan.originalRows = structuredClone(plan.rows);
  resetAI();
  plan.step = Math.min(6, plan.step + 1);
  busy = true;
  render();
  await save();
  busy = false;
  render();
  if ([1, 4].includes(plan.step)) suggest();
}
function add(id) {
  const dish = recipe(id);
  if (!dish || !allowed(dish, plan.preferences, catalog.ingredients) || plan.rows.some(r => r.id === id)) return;
  plan.rows.push({ id, servings: newServings(dish) });
  plan.changes.push(`Added ${dish.name}`);
  plan.changes = plan.changes.slice(-100);
  resetAI(); localSave(); render();
}
function swap(id) {
  const dish = manualAlternatives().find(r => r.id === id);
  if (!dish) return notice('This replacement does not meet your dietary or availability rules.');
  const row = plan.rows.find(r => r.id === targetId);
  plan.changes.push(`${dish.name} replaces ${recipe(targetId).name}`);
  plan.changes = plan.changes.slice(-100);
  row.id = id;
  targetId = '';
  resetAI(); localSave(); render();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled || busy) return;
  if (button.dataset.step !== undefined) {
    const destination = Number(button.dataset.step);
    if (plan.step === 0 && destination > 0) {
      if (!commitSetup()) return;
      resetAI(); plan.step = destination > 1 && !plan.rows.length ? 1 : destination;
      busy = true; render(); await save(); busy = false; render();
      if ([1, 4].includes(plan.step)) suggest();
    } else { resetAI(); plan.step = destination; render(); localSave(); }
    return;
  }
  const action = button.dataset.action;
  if (action === 'next') return next();
  if (action === 'back') { resetAI(); plan.step = Math.max(0, plan.step - 1); render(); localSave(); }
  if (action === 'new' && confirm('Start a new party? Confirmed steps are saved on the server.')) {
    resetAI(); plan = defaultPlan(); removed = null; query = ''; storeId = ''; targetId = ''; localSave(); render(); notice('New party ready.');
  }
  if (action === 'menu' || action === 'ai-menu') {
    const menu = action === 'menu' ? baselineMenus(catalog, plan.preferences)[Number(button.dataset.index)] : aiMenu(ai.suggestions[Number(button.dataset.index)]);
    plan.rows = structuredClone(menu.rows); plan.selectedMenu = menu.name; plan.changes = []; removed = null; localSave(); render();
  }
  if (action === 'suggest') suggest();
  if (action === 'add-manual') add($('#dish-select').value);
  if (action === 'add') add(button.dataset.id);
  if (action === 'remove') {
    removed = plan.rows.find(r => r.id === button.dataset.id);
    plan.rows = plan.rows.filter(r => r.id !== button.dataset.id);
    resetAI(); localSave(); render();
  }
  if (action === 'undo' && removed) { if (!plan.rows.some(r => r.id === removed.id)) plan.rows.push(removed); removed = null; resetAI(); localSave(); render(); }
  if (action === 'swap') swap(button.dataset.id);
  if (action === 'all-stores') { storeId = ''; resetAI(); render(); suggest(); }
  if (action === 'store-swaps') { storeId = button.dataset.id; targetId = ''; plan.step = 4; resetAI(); render(); suggest(); }
  if (action === 'shop') {
    plan.selectedStore = button.dataset.id;
    busy = true; render();
    await save();
    busy = false; render();
    notice(`Selected ${catalog.stores.find(s => s.id === button.dataset.id).name}. Confirm stock with the store before shopping.`);
  }
  if (action === 'load') {
    try {
      const plans = await api('/api/plans');
      $('#saved-plans').hidden = false;
      $('#saved-plans').innerHTML = `<h3>Saved parties</h3>${plans.map(p => `<div class="item"><span>${escape(p.preferences.eventType)} · ${escape(p.preferences.date)} · ${p.preferences.guests} guests · ${steps[p.step]}</span><button data-action="resume" data-id="${escape(p.id)}">Resume</button></div>`).join('') || '<p>No server-saved parties yet. Confirm a step to save.</p>'}`;
    } catch (error) { notice(error.message); }
  }
  if (action === 'resume') {
    try {
      const saved = recover(await api(`/api/plans/${button.dataset.id}`));
      resetAI(); plan = saved; removed = null; storeId = ''; targetId = ''; query = ''; localSave(); render(); $('#saved-plans').hidden = true; notice('Party resumed.');
    } catch (error) { notice(`Could not resume: ${error.message}`); }
  }
});
document.addEventListener('change', event => {
  const id = event.target.dataset.servings;
  if (id) {
    const servings = Number(event.target.value);
    if (!Number.isInteger(servings) || servings < 1 || servings > 500) {
      event.target.value = plan.rows.find(r => r.id === id).servings;
      return notice('Servings must be a whole number from 1 to 500.');
    }
    plan.rows.find(r => r.id === id).servings = servings;
    resetAI(); localSave(); render();
  }
  if (event.target.id === 'target-select') { targetId = event.target.value; resetAI(); render(); suggest(); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'dish-search') return;
  query = event.target.value;
  resetAI(); renderAI();
  $('#dish-select').innerHTML = manualOptions();
  searchTimer = setTimeout(suggest, 500);
});
document.addEventListener('submit', event => { event.preventDefault(); if (event.target.id === 'setup') next(); });

render();
if (storageWarning) notice(storageWarning);
try {
  catalog = await api('/api/catalog');
  plan = recover(plan);
  render();
} catch {
  notice('The catalog could not be loaded. Start the Node server and reload this page. Your setup form remains available.');
}
