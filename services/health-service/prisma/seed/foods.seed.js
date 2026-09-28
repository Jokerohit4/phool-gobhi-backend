// Starter food seed.
//
// READ THIS BEFORE ADDING TO IT.
//
// These numbers are NOT IFCT 2017 values. They are reasonable approximations
// of the cooked, as-served form of each food, written to make the food log
// usable while the real data is sourced and signed off.
//
// `source: 'estimate'` and `verified: false` on every row is the point, not an
// oversight. Marking these 'ifct2017' would be a false provenance claim, and
// it is the kind of claim nobody re-checks once it is in a database. The pair
// of fields exists so the two things stay separable: a value that is
// *traceable* is not the same as a value that is *authoritative*.
//
// Until a nutritionist signs these off, food search returns them only when the
// caller opts in with `includeUnverified`. A user who wants to log a katori of
// something we do not carry can; nobody is silently scored against a number
// nobody has checked.
//
// TO FINISH THIS PROPERLY:
//   1. Replace `source: 'estimate'` with 'ifct2017' and the real values,
//      per food, from IFCT 2017 (NIN Hyderabad) — the Indian standard.
//   2. Check `basis` matches. A boiled potato and an aloo bhaji are the same
//      food and a 3x difference in calories; several rows here are marked
//      'estimate' in basis terms and that is the first thing to get right.
//   3. Flip `verified` to true ONLY per food that has actually been checked.
//      Never flip it in bulk to make the flag disappear.
//
// Per 100 g, as served. `basis` says which state the numbers describe.

export const FOODS = [
  // --- Staples -------------------------------------------------------------
  { name: 'Rice, cooked (white)', aliases: ['chawal', 'bhaat', 'plain rice'], basis: 'cooked', veg: true,
    kcal: 130, proteinG: 2.7, carbsG: 28.2, fatG: 0.3, fibreG: 0.4,
    ironMg: 0.2, magnesiumMg: 12, calciumMg: 10, zincMg: 0.6 },
  { name: 'Roti / chapati', aliases: ['roti', 'chapati', 'phulka'], basis: 'cooked', veg: true,
    kcal: 297, proteinG: 9.6, carbsG: 56.9, fatG: 3.7, fibreG: 8.1,
    ironMg: 2.2, magnesiumMg: 40, calciumMg: 40, zincMg: 1.0 },
  { name: 'Poha, cooked', aliases: ['poha', 'kanda poha', 'chipta'], basis: 'cooked', veg: true,
    kcal: 150, proteinG: 3.2, carbsG: 30.0, fatG: 3.0, fibreG: 1.5,
    ironMg: 1.1, magnesiumMg: 30, calciumMg: 20, zincMg: 0.8 },
  { name: 'Upma, cooked', aliases: ['upma', 'rava upma'], basis: 'cooked', veg: true,
    kcal: 160, proteinG: 4.0, carbsG: 28.0, fatG: 4.0, fibreG: 2.0,
    ironMg: 1.3, magnesiumMg: 35, calciumMg: 25, zincMg: 0.9 },
  { name: 'Idli', aliases: ['steamed idli'], basis: 'cooked', veg: true,
    kcal: 146, proteinG: 4.6, carbsG: 30.0, fatG: 0.6, fibreG: 1.1,
    ironMg: 0.6, magnesiumMg: 17, calciumMg: 20, zincMg: 0.6 },
  { name: 'Dosa, plain', aliases: ['dosa', 'masala dosa', 'plain dosa'], basis: 'cooked', veg: true,
    kcal: 180, proteinG: 4.0, carbsG: 30.0, fatG: 5.0, fibreG: 1.0,
    ironMg: 1.2, magnesiumMg: 25, calciumMg: 25, zincMg: 0.8 },
  { name: 'Paratha', aliases: ['paratha', 'aloo paratha', 'stuffed paratha'], basis: 'cooked', veg: true,
    kcal: 290, proteinG: 7.0, carbsG: 45.0, fatG: 9.5, fibreG: 4.0,
    ironMg: 1.8, magnesiumMg: 35, calciumMg: 45, zincMg: 1.0 },
  { name: 'Bread, white', aliases: ['bread', 'pav'], basis: 'cooked', veg: true,
    kcal: 265, proteinG: 9.0, carbsG: 49.0, fatG: 3.2, fibreG: 2.7,
    ironMg: 3.6, magnesiumMg: 32, calciumMg: 60, zincMg: 0.8 },
  { name: 'Oats, rolled (dry)', aliases: ['oats', 'jau', 'oatmeal'], basis: 'raw', veg: true,
    kcal: 379, proteinG: 13.2, carbsG: 67.7, fatG: 6.5, fibreG: 10.1,
    ironMg: 4.7, magnesiumMg: 138, calciumMg: 54, zincMg: 3.6 },

  // --- Pulses and legumes --------------------------------------------------
  { name: 'Toor dal, cooked', aliases: ['toor dal', 'arhar dal', 'tur dal', 'masoor dal'], basis: 'cooked', veg: true,
    kcal: 116, proteinG: 6.0, carbsG: 18.5, fatG: 0.6, fibreG: 4.2,
    ironMg: 2.3, magnesiumMg: 42, calciumMg: 25, zincMg: 1.1 },
  { name: 'Moong dal, cooked', aliases: ['moong dal', 'moong'], basis: 'cooked', veg: true,
    kcal: 104, proteinG: 6.0, carbsG: 15.0, fatG: 0.4, fibreG: 3.0,
    ironMg: 1.7, magnesiumMg: 35, calciumMg: 20, zincMg: 1.0 },
  { name: 'Chana, cooked', aliases: ['chana', 'chole', 'chickpea', 'chana masala'], basis: 'cooked', veg: true,
    kcal: 164, proteinG: 8.9, carbsG: 27.4, fatG: 2.6, fibreG: 7.6,
    ironMg: 2.9, magnesiumMg: 48, calciumMg: 49, zincMg: 1.5 },
  { name: 'Rajma, cooked', aliases: ['rajma', 'kidney beans'], basis: 'cooked', veg: true,
    kcal: 127, proteinG: 8.7, carbsG: 22.8, fatG: 0.5, fibreG: 6.4,
    ironMg: 2.3, magnesiumMg: 45, calciumMg: 45, zincMg: 1.0 },
  { name: 'Sprouts (moong/chana)', aliases: ['sprouts', 'sprouted', 'sprout salad'], basis: 'cooked', veg: true,
    kcal: 100, proteinG: 8.0, carbsG: 14.0, fatG: 0.5, fibreG: 5.0,
    ironMg: 2.7, magnesiumMg: 40, calciumMg: 30, zincMg: 1.2 },
  { name: 'Soya chunks, cooked', aliases: ['soya', 'soy', 'soya chunks', 'nuggets'], basis: 'cooked', veg: true,
    kcal: 130, proteinG: 14.0, carbsG: 10.0, fatG: 4.0, fibreG: 5.0,
    ironMg: 4.0, magnesiumMg: 60, calciumMg: 100, zincMg: 2.0 },

  // --- Vegetables ----------------------------------------------------------
  { name: 'Potato, boiled', aliases: ['potato', 'aloo', 'boiled aloo'], basis: 'cooked', veg: true,
    kcal: 87, proteinG: 1.9, carbsG: 20.1, fatG: 0.1, fibreG: 1.8,
    ironMg: 0.5, magnesiumMg: 20, calciumMg: 6, zincMg: 0.3 },
  { name: 'Tomato', aliases: ['tomato', 'tamatar'], basis: 'raw', veg: true,
    kcal: 18, proteinG: 0.9, carbsG: 3.9, fatG: 0.2, fibreG: 1.2,
    ironMg: 0.5, magnesiumMg: 11, calciumMg: 10, zincMg: 0.3 },
  { name: 'Onion', aliases: ['onion', 'pyaz', 'kanda'], basis: 'raw', veg: true,
    kcal: 40, proteinG: 1.1, carbsG: 9.3, fatG: 0.1, fibreG: 1.7,
    ironMg: 0.2, magnesiumMg: 10, calciumMg: 23, zincMg: 0.2 },
  { name: 'Palak / spinach', aliases: ['palak', 'spinach', 'saag'], basis: 'cooked', veg: true,
    kcal: 23, proteinG: 3.0, carbsG: 3.6, fatG: 0.4, fibreG: 2.2,
    ironMg: 6.7, magnesiumMg: 68, calciumMg: 103, zincMg: 0.5 },
  { name: 'Bottle gourd (lauki)', aliases: ['lauki', 'gourd', 'doodhi'], basis: 'cooked', veg: true,
    kcal: 15, proteinG: 0.6, carbsG: 3.0, fatG: 0.2, fibreG: 1.0,
    ironMg: 1.0, magnesiumMg: 19, calciumMg: 14, zincMg: 0.1 },
  { name: 'French beans', aliases: ['beans', 'green beans', 'french beans'], basis: 'cooked', veg: true,
    kcal: 31, proteinG: 1.8, carbsG: 7.0, fatG: 0.2, fibreG: 2.7,
    ironMg: 1.0, magnesiumMg: 18, calciumMg: 25, zincMg: 0.2 },
  { name: 'Bitter gourd (karela)', aliases: ['karela', 'bitter gourd', 'bitter melon'], basis: 'cooked', veg: true,
    kcal: 19, proteinG: 1.0, carbsG: 3.6, fatG: 0.2, fibreG: 1.4,
    ironMg: 0.3, magnesiumMg: 15, calciumMg: 19, zincMg: 0.1 },
  { name: 'Okra (bhindi)', aliases: ['bhindi', 'okra', 'lady finger'], basis: 'cooked', veg: true,
    kcal: 33, proteinG: 1.9, carbsG: 7.0, fatG: 0.2, fibreG: 3.2,
    ironMg: 0.6, magnesiumMg: 22, calciumMg: 40, zincMg: 0.3 },
  { name: 'Cauliflower', aliases: ['cauliflower', 'phool gobhi', 'gobi'], basis: 'cooked', veg: true,
    kcal: 25, proteinG: 1.9, carbsG: 5.0, fatG: 0.3, fibreG: 2.0,
    ironMg: 0.8, magnesiumMg: 19, calciumMg: 22, zincMg: 0.5 },
  { name: 'Cabbage', aliases: ['cabbage', 'patta gobhi'], basis: 'cooked', veg: true,
    kcal: 25, proteinG: 1.3, carbsG: 5.8, fatG: 0.1, fibreG: 2.5,
    ironMg: 0.5, magnesiumMg: 14, calciumMg: 45, zincMg: 0.2 },
  { name: 'Carrot', aliases: ['carrot', 'gajar'], basis: 'raw', veg: true,
    kcal: 41, proteinG: 0.9, carbsG: 9.6, fatG: 0.2, fibreG: 2.8,
    ironMg: 0.3, magnesiumMg: 12, calciumMg: 33, zincMg: 0.3 },
  { name: 'Baingan / eggplant', aliases: ['baingan', 'brinjal', 'eggplant'], basis: 'cooked', veg: true,
    kcal: 25, proteinG: 1.0, carbsG: 5.9, fatG: 0.2, fibreG: 3.0,
    ironMg: 0.4, magnesiumMg: 14, calciumMg: 10, zincMg: 0.2 },
  { name: 'Methi / fenugreek leaves', aliases: ['methi', 'fenugreek', 'methi saag'], basis: 'cooked', veg: true,
    kcal: 44, proteinG: 3.0, carbsG: 4.0, fatG: 0.9, fibreG: 2.8,
    ironMg: 3.1, magnesiumMg: 40, calciumMg: 73, zincMg: 0.4 },
  { name: 'Coriander leaves (dhania)', aliases: ['dhania', 'coriander', 'cilantro'], basis: 'raw', veg: true,
    kcal: 23, proteinG: 2.1, carbsG: 3.7, fatG: 0.5, fibreG: 2.8,
    ironMg: 1.2, magnesiumMg: 28, calciumMg: 101, zincMg: 0.5 },
  { name: 'Mixed salad (cucumber, tomato, carrot)', aliases: ['salad', 'mixed salad', 'koshimbir'], basis: 'as_served', veg: true,
    kcal: 25, proteinG: 1.0, carbsG: 5.0, fatG: 0.2, fibreG: 1.6,
    ironMg: 0.5, magnesiumMg: 15, calciumMg: 25, zincMg: 0.3 },

  // --- Fruits --------------------------------------------------------------
  { name: 'Banana', aliases: ['banana', 'kela'], basis: 'raw', veg: true,
    kcal: 89, proteinG: 1.1, carbsG: 22.8, fatG: 0.3, fibreG: 2.6,
    ironMg: 0.3, magnesiumMg: 27, calciumMg: 5, zincMg: 0.2 },
  { name: 'Apple', aliases: ['apple', 'seb'], basis: 'raw', veg: true,
    kcal: 52, proteinG: 0.3, carbsG: 13.8, fatG: 0.2, fibreG: 2.4,
    ironMg: 0.1, magnesiumMg: 5, calciumMg: 6, zincMg: 0.1 },
  { name: 'Orange', aliases: ['orange', 'santra', 'mosambi'], basis: 'raw', veg: true,
    kcal: 47, proteinG: 0.9, carbsG: 11.8, fatG: 0.1, fibreG: 2.4,
    ironMg: 0.1, magnesiumMg: 10, calciumMg: 40, zincMg: 0.1 },
  { name: 'Papaya', aliases: ['papaya', 'papita'], basis: 'raw', veg: true,
    kcal: 43, proteinG: 0.6, carbsG: 10.8, fatG: 0.1, fibreG: 1.7,
    ironMg: 0.3, magnesiumMg: 21, calciumMg: 20, zincMg: 0.1 },
  { name: 'Guava', aliases: ['guava', 'amrud'], basis: 'raw', veg: true,
    kcal: 68, proteinG: 2.6, carbsG: 14.0, fatG: 0.9, fibreG: 5.4,
    ironMg: 0.9, magnesiumMg: 27, calciumMg: 23, zincMg: 0.3 },
  { name: 'Mango', aliases: ['mango', 'aam'], basis: 'raw', veg: true,
    kcal: 60, proteinG: 0.8, carbsG: 15.0, fatG: 0.4, fibreG: 1.6,
    ironMg: 0.4, magnesiumMg: 10, calciumMg: 7, zincMg: 0.1 },
  { name: 'Pomegranate', aliases: ['pomegranate', 'anaar', 'dalhana'], basis: 'raw', veg: true,
    kcal: 83, proteinG: 1.7, carbsG: 19.0, fatG: 1.2, fibreG: 4.0,
    ironMg: 0.3, magnesiumMg: 10, calciumMg: 10, zincMg: 0.3 },
  { name: 'Watermelon', aliases: ['watermelon', 'tarbooz'], basis: 'raw', veg: true,
    kcal: 30, proteinG: 0.6, carbsG: 7.6, fatG: 0.2, fibreG: 0.4,
    ironMg: 0.2, magnesiumMg: 10, calciumMg: 7, zincMg: 0.1 },

  // --- Dairy ---------------------------------------------------------------
  { name: 'Milk, toned', aliases: ['milk', 'doodh', 'toned milk'], basis: 'as_served', veg: true,
    kcal: 60, proteinG: 3.0, carbsG: 4.8, fatG: 3.0, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 11, calciumMg: 120, zincMg: 0.4 },
  { name: 'Curd / dahi', aliases: ['curd', 'dahi', 'yogurt', 'yoghurt'], basis: 'as_served', veg: true,
    kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.3, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 12, calciumMg: 110, zincMg: 0.5 },
  { name: 'Paneer', aliases: ['paneer', 'cottage cheese', 'indian cheese'], basis: 'as_served', veg: true,
    kcal: 265, proteinG: 18.0, carbsG: 3.6, fatG: 20.0, fibreG: 0,
    ironMg: 1.0, magnesiumMg: 28, calciumMg: 250, zincMg: 1.1 },
  { name: 'Chaas', aliases: ['chaas', 'buttermilk', 'masala chaas'], basis: 'as_served', veg: true,
    kcal: 40, proteinG: 2.0, carbsG: 3.0, fatG: 2.0, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 9, calciumMg: 90, zincMg: 0.3 },
  { name: 'Ghee', aliases: ['ghee', 'clarified butter', 'tup'], basis: 'as_served', veg: true,
    kcal: 900, proteinG: 0.0, carbsG: 0.0, fatG: 100.0, fibreG: 0, servings: [{ label: '1 tsp', grams: 5 }] },

  // --- Nuts, seeds, fats ---------------------------------------------------
  { name: 'Almonds', aliases: ['almond', 'badam'], basis: 'raw', veg: true,
    kcal: 579, proteinG: 21.2, carbsG: 21.6, fatG: 49.9, fibreG: 12.5,
    ironMg: 3.7, magnesiumMg: 270, calciumMg: 269, zincMg: 3.1,
    servings: [{ label: '10 almonds', grams: 12 }] },
  { name: 'Peanuts', aliases: ['peanut', 'moongphali', 'groundnut'], basis: 'raw', veg: true,
    kcal: 567, proteinG: 25.8, carbsG: 16.1, fatG: 49.2, fibreG: 8.5,
    ironMg: 2.7, magnesiumMg: 168, calciumMg: 90, zincMg: 3.3,
    servings: [{ label: '1 katori', grams: 40 }] },
  { name: 'Cashews', aliases: ['cashew', 'kaju'], basis: 'raw', veg: true,
    kcal: 553, proteinG: 18.2, carbsG: 30.2, fatG: 43.9, fibreG: 3.3,
    ironMg: 6.7, magnesiumMg: 292, calciumMg: 37, zincMg: 5.8,
    servings: [{ label: '10 cashews', grams: 15 }] },
  // The plan's own worked example names pumpkin seeds as an iron and
  // magnesium source, so it is seeded rather than left to the user to create.
  { name: 'Pumpkin seeds (kharbuja)', aliases: ['pumpkin seeds', 'kharbuja', 'sag seeds'], basis: 'raw', veg: true,
    kcal: 559, proteinG: 30.2, carbsG: 10.7, fatG: 49.1, fibreG: 6.0,
    ironMg: 8.8, magnesiumMg: 535, calciumMg: 73, zincMg: 7.1,
    servings: [{ label: '1 tbsp', grams: 10 }] },
  { name: 'Sesame seeds (til)', aliases: ['sesame', 'til', 'ajwain til'], basis: 'raw', veg: true,
    kcal: 573, proteinG: 17.7, carbsG: 23.4, fatG: 49.7, fibreG: 11.8,
    ironMg: 7.8, magnesiumMg: 346, calciumMg: 975, zincMg: 5.7,
    servings: [{ label: '1 tbsp', grams: 9 }] },
  { name: 'Mustard oil', aliases: ['mustard oil', 'sarson ka tel', 'tel'], basis: 'as_served', veg: true,
    kcal: 900, proteinG: 0.0, carbsG: 0.0, fatG: 100.0, fibreG: 0, servings: [{ label: '1 tsp', grams: 5 }] },

  // --- Non-veg -------------------------------------------------------------
  { name: 'Egg, whole (boiled)', aliases: ['egg', 'anda', 'boiled egg', 'eggs'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 155, proteinG: 12.6, carbsG: 1.1, fatG: 10.6, fibreG: 0,
    ironMg: 1.8, magnesiumMg: 12, calciumMg: 50, zincMg: 1.1,
    servings: [{ label: '1 large egg', grams: 50 }] },
  { name: 'Chicken breast, cooked', aliases: ['chicken', 'chicken breast', 'murgh'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 165, proteinG: 31.0, carbsG: 0.0, fatG: 3.6, fibreG: 0,
    ironMg: 1.0, magnesiumMg: 29, calciumMg: 15, zincMg: 1.0 },
  { name: 'Rohu / any fish, cooked', aliases: ['fish', 'rohu', 'machli', 'pomfret'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 140, proteinG: 24.0, carbsG: 0.0, fatG: 4.5, fibreG: 0,
    ironMg: 1.0, magnesiumMg: 30, calciumMg: 35, zincMg: 0.8 },

  // --- Common additions ----------------------------------------------------
  { name: 'Sugar', aliases: ['sugar', 'cheeni', 'mitha'], basis: 'as_served', veg: true,
    kcal: 387, proteinG: 0.0, carbsG: 100.0, fatG: 0.0, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 1, calciumMg: 1, zincMg: 0.1,
    servings: [{ label: '1 tsp', grams: 4 }] },
  { name: 'Tea with milk and sugar', aliases: ['chai', 'tea', 'tapri'], basis: 'as_served', veg: true,
    // Per cup. Deliberately not "milk" + "sugar": a cup is what people log.
    kcal: 70, proteinG: 1.5, carbsG: 11.0, fatG: 1.8, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 8, calciumMg: 40, zincMg: 0.2,
    servings: [{ label: '1 cup', grams: 150 }] },
  { name: 'Namkeen / mixed savoury', aliases: ['namkeen', 'savoury', 'mixture', 'mathari'], basis: 'as_served', veg: true,
    // A composite fried snack. Included because it is logged constantly and
    // its absence from the database would push every entry into a custom food
    // with a guess in it — which is worse.
    kcal: 550, proteinG: 8.0, carbsG: 52.0, fatG: 32.0, fibreG: 3.0,
    ironMg: 2.0, magnesiumMg: 40, calciumMg: 40, zincMg: 1.2,
    servings: [{ label: '1 small katori', grams: 30 }] },
];

// Seed-time validation, so a bad row fails the person adding it rather than
// surfacing in production as a food with no name or no calories.
const REQUIRED = [
  'name', 'basis', 'kcal', 'proteinG', 'carbsG', 'fatG', 'fibreG',
];

for (const food of FOODS) {
  for (const field of REQUIRED) {
    if (food[field] === undefined || food[field] === null) {
      throw new Error(`Seed food "${food.name || '(unnamed)'}" is missing ${field}.`);
    }
  }
  if (food.name.trim() !== food.name || !food.name.trim()) {
    throw new Error(`Seed food name has stray whitespace or is empty: "${food.name}".`);
  }
  // An unedited stray edit marker in a name is how a food ends up called
  // "Bhindi... no, Baingan" in a live database.
  if (/\.\.\.|TODO|FIXME|\bXXX\b/i.test(food.name)) {
    throw new Error(`Seed food name looks like a leftover edit: "${food.name}".`);
  }
  // Atwater, fibre-aware: 4 kcal/g protein, 4 kcal/g digestible carbohydrate,
  // 9 kcal/g fat, and ~1 kcal/g for fibre.
  //
  // Fibre has to be subtracted from carbs, not counted at 4 kcal/g like the
  // rest. Most databases count it in the carbohydrate figure but credit it at
  // 1-2 kcal/g (or zero, for insoluble), so deriving energy from raw carbs
  // systematically over-states a high-fibre food — almonds, oats, beans — by
  // tens of percent and rejects exactly the foods this seed most needs to get
  // right.
  //
  // The band is wide and deliberately asymmetric. It is there to catch a
  // transposed digit or a macro pasted into the wrong column, not to referee
  // rounding or re-derive the food database.
  //
  // High side is tight (1.20): deriving MORE energy than the row claims is
  // almost always arithmetic, because every term in the sum is a real,
  // already-accounted-for gram of protein, carb or fat.
  //
  // Low side is loose (0.55) because two real, common cases push it down:
  //   - fibre-dense foods, where the published kcal credits fibre at 0-1 kcal/g
  //     (methi, almonds, seeds);
  //   - cooked pulses and vegetables, where "per 100 g as served" is mostly
  //     water that the macros do not describe (toor dal, moong, sprouts).
  // Both are properties of the food, not transcription errors, so the guard
  // must not reject them.
  const digestibleCarbs = Math.max(0, food.carbsG - food.fibreG);
  const derived =
    food.proteinG * 4 + digestibleCarbs * 4 + food.fibreG * 1 + food.fatG * 9;
  if (food.kcal > 0 && (derived > food.kcal * 1.2 || derived < food.kcal * 0.55)) {
    throw new Error(
      `Seed food "${food.name}" is internally inconsistent: ` +
        `kcal=${food.kcal} but macros imply ~${Math.round(derived)} ` +
        `(P${food.proteinG}/C${food.carbsG}/F${food.fatG}/fibre${food.fibreG}). ` +
        `Likely a typo in a macro.`,
    );
  }
}

const NAMES = new Set();
for (const food of FOODS) {
  const key = `${food.name.trim().toLowerCase()}|${food.basis}`;
  if (NAMES.has(key)) {
    throw new Error(`Duplicate seed food: ${food.name} (basis ${food.basis}).`);
  }
  NAMES.add(key);
}
