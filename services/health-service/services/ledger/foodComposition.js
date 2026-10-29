// Composition is per 100 g of the finished food. Typical recipes are estimates,
// never ingredient/allergen guarantees. Personal changes always create a new row.
export const NUTRIENTS = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fibreG',
  'ironMg', 'magnesiumMg', 'calciumMg', 'zincMg'];
export const DIETARY_TYPES = ['veg', 'egg', 'non_veg', 'unknown'];
const meat = /\b(chicken|mutton|meat|beef|pork|fish|rohu|prawn|shrimp|seafood|lamb|bacon|ham|gelatin)\b/i;
// "Mayonnaise without eggs", "Vegetarian egg kofta" and "egg-less" name the
// absence of egg, so they do not make a food egg by name.
const eggs = /(?<!\b(?:without|no|vegetarian|veg)\s)\b(egg|eggs|omelette|omelet)\b(?!-?less)/i;
export const isGenericFoodName = (name) => /^(burger|sandwich|pizza|wrap|roll|curry)$/i.test(String(name).trim());
const clean = (value, length = 80) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').slice(0, length) : '';
const error = (message, status = 400) => Object.assign(new Error(message), { status });

export function dietaryTypeOf(food) {
  const types = (Array.isArray(food.ingredients) ? food.ingredients : []).map((i) => i.dietaryType);
  if (food.dietaryType === 'non_veg' || meat.test(food.name || '') || types.includes('non_veg')) return 'non_veg';
  if (food.dietaryType === 'egg' || eggs.test(food.name || '') || types.includes('egg')) return 'egg';
  if (DIETARY_TYPES.includes(food.dietaryType)) return food.dietaryType;
  if (types.length) return types.every((type) => type === 'veg') ? 'veg' : 'unknown';
  return food.nonVeg === true ? 'non_veg' : food.veg === true ? 'veg' : 'unknown';
}

export function normaliseIngredients(value) {
  if (!Array.isArray(value) || !value.length || value.length > 40) return [];
  const result = value.map((i) => ({
    name: clean(i?.name), grams: Number(i?.grams),
    dietaryType: dietaryTypeOf(i || {}),
    ...(Number.isSafeInteger(i?.foodItemId) && i.foodItemId > 0 ? { foodItemId: i.foodItemId } : {}),
  }));
  if (result.some((i) => !i.name || !Number.isFinite(i.grams) || i.grams <= 0 || i.grams > 5000)) return [];
  const total = result.reduce((sum, i) => sum + i.grams, 0);
  return result.map((i) => ({ ...i, grams: Math.round(i.grams / total * 1000000) / 10000 }));
}

const recipe = (names, weights) => names.map((name, i) => ({
  name, grams: weights[i], dietaryType: dietaryTypeOf({ name, veg: true }),
}));

// Standard, explicitly estimated recipes for the starter catalogue. Single
// ingredient foods remain a single ingredient; water reflects cooked weight.
export function compositionForFood(food) {
  const hasIngredients = Array.isArray(food.ingredients) && food.ingredients.length;
  const estimatedPlaceholder = hasIngredients && food.createdByUserId == null &&
    food.ingredientsEstimated === true && food.ingredients.length === 1 &&
    food.ingredients[0].name === food.name;
  if (hasIngredients && !estimatedPlaceholder) return {
    dietaryType: dietaryTypeOf(food), ingredients: normaliseIngredients(food.ingredients),
    ingredientsEstimated: food.ingredientsEstimated !== false,
  };
  const n = food.name.toLowerCase();
  let pairs;
  if (/mayonnaise/.test(n)) pairs = /eggless/.test(n)
    ? [['Vegetable oil', 60], ['Milk', 10], ['Starch', 10], ['Water', 15], ['Vinegar', 5]]
    : [['Vegetable oil', 70], ['Egg', 10], ['Water', 10], ['Vinegar', 10]];
  else if (/ketchup/.test(n)) pairs = [['Tomato pulp', 65], ['Sugar', 25], ['Vinegar', 8], ['Salt', 2]];
  else if (/burger bun|^bread,|chapati, multigrain \(store/.test(n)) pairs = [
    [/brown|multigrain/.test(n) ? 'Whole grain flour' : 'Wheat flour', 65], ['Water', 30], ['Yeast', 2], ['Oil', 2], ['Salt', 1]];
  else if (/pasta|vermicelli/.test(n)) pairs = [['Wheat semolina', 40], ['Water', 60]];
  else if (/soya chunks/.test(n)) pairs = [['Textured soy protein', 40], ['Water', 60]];
  else if (/sprouts/.test(n)) pairs = [['Moong sprouts', 60], ['Chana sprouts', 40]];
  else if (/namkeen/.test(n)) pairs = [['Gram flour', 50], ['Peanuts', 20], ['Oil', 25], ['Seasoning', 5]];
  else if (/potato chips/.test(n)) pairs = [['Potato', 70], ['Oil', 28], ['Salt', 2]];
  else if (/aloo tikki/.test(n)) pairs = [['Potato', 75], ['Gram flour', 10], ['Oil', 12], ['Spices', 3]];
  else if (/^jam$/.test(n)) pairs = [['Fruit pulp', 50], ['Sugar', 45], ['Water', 5]];
  else if (/peanut butter/.test(n)) pairs = [['Peanuts', 95], ['Oil', 3], ['Sugar', 1], ['Salt', 1]];
  else if (/dark chocolate/.test(n)) pairs = [['Cocoa solids', 50], ['Sugar', 25], ['Cocoa butter', 25]];
  else if (/biscuit/.test(n)) pairs = [['Wheat flour', 55], ['Sugar', 20], ['Vegetable fat', 20], ['Milk solids', 5]];
  else if (/coconut, milk/.test(n)) pairs = [['Coconut', 30], ['Water', 70]];
  else if (/green tea|coffee, black/.test(n)) pairs = [['Water', 99], [/tea/.test(n) ? 'Tea leaves' : 'Coffee', 1]];
  else if (/curd \/ dahi/.test(n)) pairs = [['Milk', 99], ['Curd culture', 1]];
  else if (/cheese,/.test(n)) pairs = [['Milk curds', 97], ['Salt', 2], ['Culture', 1]];
  else if (/khoya|mawa/.test(n)) pairs = [['Milk solids', 100]];
  else if (/burger/.test(n)) pairs = [['Burger bun', 35],
    [/chicken/.test(n) ? 'Chicken patty' : /egg/.test(n) ? 'Egg' : /paneer/.test(n) ? 'Paneer' : 'Potato patty', 40],
    ['Lettuce', 8], ['Tomato', 7], ['Onion', 5], ['Tomato ketchup', 5]];
  else if (/sandwich/.test(n)) pairs = [['Bread', 45], ['Cucumber', 15], ['Tomato', 15], ['Potato', 15], ['Butter', 5], ['Chutney', 5]];
  else if (/biryani|pulao|fried rice|khichdi|rajma chawal|curd rice|jeera rice/.test(n)) pairs = [['Cooked rice', 60],
    [/chicken/.test(n) ? 'Chicken' : /rajma/.test(n) ? 'Cooked kidney beans' : /curd/.test(n) ? 'Curd' : /khichdi/.test(n) ? 'Cooked moong dal' : 'Mixed vegetables', 30], ['Oil or ghee', 5], ['Onion and spices', 5]];
  else if (/dosa, masala|vada pav|pav bhaji|samosa|kachori|bread pakoda|pani puri/.test(n)) pairs = [
    [/dosa/.test(n) ? 'Rice and urad dal batter' : /pav/.test(n) ? 'Pav bread' : 'Wheat flour casing', 40],
    ['Potato and vegetables', 40], ['Oil', 10], ['Chutney and spices', 10]];
  else if (/momos|spring roll/.test(n)) pairs = [['Wheat flour wrapper', 45], ['Cabbage', 25], ['Carrot', 15], ['Onion', 10], ['Oil and seasoning', 5]];
  else if (/paneer.*(curry|masala|bhurji|tikka)|palak paneer|shahi paneer|matar paneer/.test(n)) pairs = [['Paneer', 50],
    [/palak/.test(n) ? 'Spinach' : /matar/.test(n) ? 'Peas' : 'Tomato', 25], ['Onion', 15], ['Oil or butter', 7], ['Spices', 3]];
  else if (/curry|chicken 65|chicken tikka|aloo gobi|bhindi masala|bitter gourd fry/.test(n)) pairs = [
    [meat.test(n) ? (n.match(meat)?.[0] || 'Meat') : eggs.test(n) ? 'Egg' : /aloo gobi/.test(n) ? 'Potato and cauliflower' : /bhindi/.test(n) ? 'Okra' : /bitter/.test(n) ? 'Bitter gourd' : /rajma/.test(n) ? 'Kidney beans' : 'Mixed vegetables', 65],
    ['Onion', 12], ['Tomato', 12], ['Oil', 8], ['Spices', 3]];
  else if (/dal|chole|sambar|kadhi/.test(n)) pairs = [[/chole/.test(n) ? 'Cooked chickpeas' : /kadhi/.test(n) ? 'Curd and gram flour' : 'Cooked lentils', 70], ['Water and vegetables', 20], ['Oil or ghee', 7], ['Spices', 3]];
  else if (/omelette|bhurji/.test(n)) pairs = [['Egg', 80], ['Onion', 10], ['Oil', 7], ['Spices', 3]];
  else if (/idli|dosa|appam|uttapam/.test(n)) pairs = [['Rice', 45], ['Urad dal', 20], ['Water', 32], ['Oil and salt', 3]];
  else if (/roti|chapati|paratha|thepla|puri/.test(n)) pairs = [[/bajra/.test(n) ? 'Bajra flour' : /jowar/.test(n) ? 'Jowar flour' : /multigrain/.test(n) ? 'Mixed grain flour' : 'Wheat flour', 65], ['Water', 30], ['Oil or ghee', 5]];
  else if (/chilla/.test(n)) pairs = [['Gram flour', 65], ['Water', 25], ['Vegetables', 7], ['Oil', 3]];
  else if (/poha|upma|maggi|noodles/.test(n)) pairs = [[/poha/.test(n) ? 'Flattened rice' : /upma/.test(n) ? 'Semolina' : 'Noodles', 60], ['Water', 20], ['Vegetables', 12], ['Oil', 5], ['Seasoning', 3]];
  else if (/chai|tea.*milk|coffee.*milk|cold coffee|lassi|chaas|shake|chocolate flavoured/.test(n)) pairs = [['Milk or curd', 75], ['Water', 15], [/shake/.test(n) ? 'Whey protein' : 'Sugar', 8], ['Tea, coffee or flavouring', 2]];
  else if (/salad/.test(n)) pairs = [['Cucumber', 40], ['Tomato', 30], ['Carrot', 30]];
  else if (/bhel|chaat/.test(n)) pairs = [['Cooked chickpeas or puffed rice', 55], ['Vegetables', 25], ['Chutney', 15], ['Sev and spices', 5]];
  else if (/pakoda/.test(n)) pairs = [['Vegetables', 45], ['Gram flour', 35], ['Oil', 15], ['Water and spices', 5]];
  else if (/halwa|sheera|kheer/.test(n)) pairs = [['Semolina', 35], ['Milk or water', 40], ['Sugar', 15], ['Ghee', 10]];
  else if (/gulab jamun|jalebi|kulfi|ice cream/.test(n)) pairs = [[/jalebi/.test(n) ? 'Wheat flour' : 'Milk solids', 50], ['Sugar', 25], ['Water or milk', 20], ['Fat', 5]];
  const ingredients = pairs ? recipe(pairs.map((p) => p[0]), pairs.map((p) => p[1]))
    : [{ name: food.name, grams: 100, dietaryType: dietaryTypeOf(food) }];
  return { dietaryType: dietaryTypeOf({ ...food, ingredients }), ingredients, ingredientsEstimated: true };
}

export function assertSpecificName(name) {
  if (isGenericFoodName(name)) throw error('Name the variant, such as Aloo burger, Chicken burger or Egg burger.');
}

export async function customizeFood(prisma, { userId, foodItemId, baseGrams, additions, name }) {
  const weight = Number(baseGrams);
  if (!Number.isSafeInteger(Number(foodItemId)) || !(weight > 0 && weight <= 5000) ||
      !Array.isArray(additions) || !additions.length || additions.length > 20) throw error('Choose ingredients and their amounts.');
  const selected = additions.map((a) => ({ id: Number(a.foodItemId), grams: Number(a.grams) }));
  if (selected.some((a) => !Number.isSafeInteger(a.id) || a.id <= 0 || !Number.isFinite(a.grams) || a.grams <= 0 || a.grams > 5000)) {
    throw error('Each ingredient needs a valid food and an amount in grams.');
  }
  const total = weight + selected.reduce((sum, a) => sum + a.grams, 0);
  if (total > 5000) throw error('That is more than 5000 g for one portion.');
  return prisma.$transaction(async (tx) => {
    const ids = [...new Set([Number(foodItemId), ...selected.map((a) => a.id)])];
    const foods = await tx.foodItem.findMany({ where: {
      id: { in: ids }, OR: [{ createdByUserId: null }, { createdByUserId: userId }],
    } });
    const byId = new Map(foods.map((f) => [f.id, f]));
    if (ids.some((id) => !byId.has(id))) throw error('One of those foods is not available.', 404);
    const base = byId.get(Number(foodItemId));
    const parts = [{ food: base, grams: weight }, ...selected.map((a) => ({ food: byId.get(a.id), grams: a.grams }))];
    const amounts = [];
    for (const ingredient of compositionForFood(base).ingredients) amounts.push({
      ...ingredient, grams: ingredient.grams * weight / 100,
    });
    // Keep each food the user added visible by its chosen name. For example,
    // cheese remains "Cheese" rather than disappearing into milk and salt.
    for (const part of parts.slice(1)) amounts.push({
      foodItemId: part.food.id, name: part.food.name, grams: part.grams,
      dietaryType: dietaryTypeOf(part.food),
    });
    if (amounts.length > 40) throw error('This recipe already has too many ingredients.');
    const ingredients = normaliseIngredients(amounts);
    const dietaryType = dietaryTypeOf({ ingredients });
    const newName = clean(name) || clean(`${base.name} + ${selected.map((a) => byId.get(a.id).name).join(', ')}`);
    assertSpecificName(newName);
    const nutrients = Object.fromEntries(NUTRIENTS.map((key) => [key,
      parts.some((p) => p.food[key] == null) ? null :
        Math.round(parts.reduce((sum, p) => sum + Number(p.food[key]) * p.grams, 0) / total * 100) / 100,
    ]));
    return tx.foodItem.create({ data: {
      name: newName, aliases: [], basis: 'as_served', ...nutrients,
      dietaryType, veg: dietaryType === 'veg', nonVeg: dietaryType === 'non_veg' || dietaryType === 'egg',
      ingredients, ingredientsEstimated: true, baseFoodItemId: base.baseFoodItemId ?? base.id,
      createdByUserId: userId, source: 'user-entered', verified: false,
      servings: [{ label: 'My portion', grams: Math.round(total * 100) / 100 }],
      searchText: buildVariantSearch(newName, ingredients),
    } });
  });
}

const buildVariantSearch = (name, ingredients) => [name, ...ingredients.map((i) => i.name)].join(' ').toLowerCase();
