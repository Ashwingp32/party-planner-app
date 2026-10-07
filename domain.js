export const steps = ['Party setup', 'Choose menu', 'Edit items', 'Ingredients', 'Alternatives', 'Updated menu', 'Where to buy'];
export const allergyNames = ['peanuts', 'milk', 'wheat', 'soy', 'sesame'];

export function defaultPlan() {
  const date = new Date();
  date.setDate(date.getDate() + 3);
  return {
    step: 0, preferences: { diet: 'both', guests: 20, vegetarians: 8, allergies: ['peanuts'], eventType: 'Birthday dinner', date: date.toISOString().slice(0, 10) },
    rows: [], originalRows: [], selectedMenu: '', history: [], changes: []
  };
}

export function validPreferences(p) {
  if (!p || !['veg', 'nonveg', 'both'].includes(p.diet) ||
      !Number.isInteger(p.guests) || p.guests < 1 || p.guests > 500 ||
      !Number.isInteger(p.vegetarians) || p.vegetarians < 0 || p.vegetarians > p.guests ||
      !Array.isArray(p.allergies) || p.allergies.length > allergyNames.length ||
      p.allergies.some(a => !allergyNames.includes(a)) ||
      typeof p.eventType !== 'string' || !p.eventType.trim() || p.eventType.length > 100 ||
      typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return false;
  const date = new Date(`${p.date}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === p.date;
}

export function allowed(recipe, preferences, ingredients) {
  if (!recipe || (preferences.diet === 'veg' && !recipe.vegetarian)) return false;
  if (preferences.diet === 'nonveg' && recipe.type === 'main' && recipe.vegetarian) return false;
  const allergens = [...recipe.allergens, ...Object.keys(recipe.ingredients).flatMap(id => ingredients[id].allergens)];
  return !preferences.allergies.some(a => allergens.includes(a));
}

export function totals(rows, recipes) {
  const result = {};
  for (const row of rows) {
    const recipe = recipes.find(r => r.id === row.id);
    if (!recipe) continue;
    for (const [id, quantity] of Object.entries(recipe.ingredients)) {
      result[id] = Math.round(((result[id] || 0) + quantity * row.servings) * 100) / 100;
    }
  }
  return result;
}

export function ingredientAvailability(id, quantity, stores) {
  const inventory = stores.map(s => s.inventory[id]).filter(Boolean);
  const stock = inventory.reduce((sum, i) => sum + (i.status === 'now' ? i.currentStock : 0), 0);
  if (stock >= quantity) return { status: 'now', stock };
  const restocks = inventory.filter(i => i.restockDate && i.restockStock > 0).sort((a, b) => a.restockDate.localeCompare(b.restockDate));
  let projected = stock;
  for (const item of restocks) {
    projected += item.restockStock;
    if (projected >= quantity) return { status: 'soon', date: item.restockDate, stock };
  }
  return { status: 'unknown', stock };
}

export function dishAvailability(recipe, servings, stores) {
  const values = Object.entries(recipe.ingredients).map(([id, qty]) => ingredientAvailability(id, qty * servings, stores));
  if (values.some(v => v.status === 'unknown')) return { status: 'unknown' };
  const dates = values.filter(v => v.status === 'soon').map(v => v.date).sort();
  return dates.length ? { status: 'soon', date: dates.at(-1) } : { status: 'now' };
}

export function readyBy(availability, date) {
  return availability.status === 'now' || (availability.status === 'soon' && availability.date <= date);
}

export function reuseRate(recipe, rows, recipes) {
  const existing = totals(rows, recipes);
  const ids = Object.keys(recipe.ingredients);
  return Math.round(ids.filter(id => existing[id] > 0).length / ids.length * 100);
}

export function baselineMenus(catalog, preferences) {
  const themes = [
    { name: 'Taco night', ids: ['chicken-tacos', 'bean-tacos', 'cilantro-slaw', 'roasted-corn', 'fruit-cups'] },
    { name: 'Comfort classics', ids: ['chicken-bowls', 'chickpea-bowls', 'lime-slaw', 'melon-slices'] },
    { name: 'Mediterranean table', ids: ['chicken-bowls', 'chickpea-bowls', 'tomato-salad', 'sesame-chickpeas', 'fruit-cups'] }
  ];
  const safe = catalog.recipes.filter(r => allowed(r, preferences, catalog.ingredients));
  return themes.map(theme => {
    const rows = theme.ids.map(id => safe.find(r => r.id === id)).filter(Boolean).map(r => {
      let servings = preferences.guests;
      if (r.type === 'main' && preferences.diet === 'both') {
        servings = r.vegetarian ? preferences.vegetarians : preferences.guests - preferences.vegetarians;
      }
      return { id: r.id, servings };
    }).filter(r => r.servings > 0);
    return { name: theme.name, rows };
  });
}
