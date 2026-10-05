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
  { name: 'Dosa, plain', aliases: ['dosa', 'plain dosa'], basis: 'cooked', veg: true,
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
  { name: 'Rava / semolina (dry)', aliases: ['rava', 'sooji', 'semolina'], basis: 'raw', veg: true,
    kcal: 360, proteinG: 10.0, carbsG: 72.0, fatG: 1.0, fibreG: 1.5,
    ironMg: 2.0, magnesiumMg: 40, calciumMg: 20, zincMg: 1.5 },
  { name: 'Bread, brown', aliases: ['brown bread', 'whole wheat bread', 'multigrain bread', 'atta bread'], basis: 'cooked', veg: true,
    kcal: 247, proteinG: 13.0, carbsG: 41.0, fatG: 3.4, fibreG: 7.0,
    ironMg: 2.5, magnesiumMg: 76, calciumMg: 60, zincMg: 1.2,
    servings: [{ label: '2 slices', grams: 60 }] },
  { name: 'Pasta, cooked', aliases: ['pasta', 'macaroni', 'noodles', 'spaghetti'], basis: 'cooked', veg: true,
    // Plain boiled pasta. A sauced or cheesed plate is a different dish with a
    // different number, and nobody logs "pasta" meaning one of those.
    kcal: 155, proteinG: 5.8, carbsG: 30.9, fatG: 0.9, fibreG: 1.8,
    ironMg: 1.3, magnesiumMg: 30, calciumMg: 7, zincMg: 1.0,
    servings: [{ label: '1 cup', grams: 140 }] },
  { name: 'Vermicelli, cooked', aliases: ['vermicelli', 'sev', 'thin noodles'], basis: 'cooked', veg: true,
    kcal: 140, proteinG: 3.5, carbsG: 29.0, fatG: 0.5, fibreG: 0.5,
    ironMg: 0.5, magnesiumMg: 12, calciumMg: 8, zincMg: 0.5 },
  { name: 'Sheera / sooji halwa', aliases: ['sheera', 'halwa', 'sooji halwa', 'sheerkhurd'], basis: 'cooked', veg: true,
    // Sweet, so it is logged as eaten rather than avoided - the ledger's job is
    // to be honest, not to make anybody feel good about dinner.
    kcal: 200, proteinG: 3.0, carbsG: 25.0, fatG: 10.5, fibreG: 0.5,
    ironMg: 1.0, magnesiumMg: 15, calciumMg: 25, zincMg: 0.8 },
  { name: 'Idli, pan-fried', aliases: ['fried idli', 'tawa idli', 'crispy idli'], basis: 'cooked', veg: true,
    // Not a different food, a different amount of oil. The 45 kcal gap against
    // plain steamed idli is most of the difference in a breakfast, so merging
    // the two would have one of them wrong for everyone who owns a tawa.
    kcal: 190, proteinG: 5.5, carbsG: 30.0, fatG: 6.5, fibreG: 1.1,
    ironMg: 0.7, magnesiumMg: 19, calciumMg: 22, zincMg: 0.6,
    servings: [{ label: '2 idli', grams: 100 }] },
  { name: 'Dosa, masala', aliases: ['masala dosa', 'masala dosa with chutney'], basis: 'cooked', veg: true,
    // Separate from plain dosa because the potato filling is most of the meal.
    kcal: 180, proteinG: 3.8, carbsG: 30.0, fatG: 5.4, fibreG: 1.4,
    ironMg: 1.4, magnesiumMg: 25, calciumMg: 25, zincMg: 0.8,
    servings: [{ label: '1 medium', grams: 180 }] },
  { name: 'Appam', aliases: ['appam', 'appams', 'neyyappam'], basis: 'cooked', veg: true,
    kcal: 150, proteinG: 3.0, carbsG: 30.0, fatG: 1.5, fibreG: 1.0,
    ironMg: 0.5, magnesiumMg: 15, calciumMg: 20, zincMg: 0.5,
    servings: [{ label: '1 appam', grams: 90 }] },
  { name: 'Uttapam', aliases: ['uttapam', 'uthappam', 'onion uttapam'], basis: 'cooked', veg: true,
    kcal: 160, proteinG: 4.0, carbsG: 30.0, fatG: 2.5, fibreG: 1.5,
    ironMg: 0.7, magnesiumMg: 18, calciumMg: 25, zincMg: 0.6,
    servings: [{ label: '1 uttapam', grams: 100 }] },
  { name: 'Thepla', aliases: ['thepla', 'methi thepla'], basis: 'cooked', veg: true,
    kcal: 300, proteinG: 7.0, carbsG: 45.0, fatG: 11.0, fibreG: 5.0,
    ironMg: 2.5, magnesiumMg: 45, calciumMg: 45, zincMg: 1.2,
    servings: [{ label: '1 thepla', grams: 45 }] },
  { name: 'Bajra roti', aliases: ['bajra roti', 'bajra phulka', 'pearl millet roti'], basis: 'cooked', veg: true,
    kcal: 350, proteinG: 12.0, carbsG: 65.0, fatG: 6.0, fibreG: 11.0,
    ironMg: 3.5, magnesiumMg: 100, calciumMg: 40, zincMg: 1.8,
    servings: [{ label: '1 roti', grams: 50 }] },
  { name: 'Jowar roti', aliases: ['jowar roti', 'jowar phulka', 'sorghum roti'], basis: 'cooked', veg: true,
    kcal: 340, proteinG: 11.0, carbsG: 66.0, fatG: 4.5, fibreG: 10.0,
    ironMg: 3.5, magnesiumMg: 90, calciumMg: 30, zincMg: 1.6,
    servings: [{ label: '1 roti', grams: 50 }] },
  { name: 'Multigrain roti', aliases: ['multigrain roti', 'mixed roti', 'besan roti'], basis: 'cooked', veg: true,
    kcal: 300, proteinG: 11.0, carbsG: 55.0, fatG: 5.0, fibreG: 9.0,
    ironMg: 3.5, magnesiumMg: 70, calciumMg: 50, zincMg: 1.8,
    servings: [{ label: '1 roti', grams: 50 }] },
  { name: 'Besan chilla', aliases: ['besan chilla', 'chilla', 'gram flour pancake', 'besan cheela'], basis: 'cooked', veg: true,
    kcal: 190, proteinG: 10.0, carbsG: 20.0, fatG: 9.0, fibreG: 3.0,
    ironMg: 2.5, magnesiumMg: 45, calciumMg: 45, zincMg: 1.5,
    servings: [{ label: '1 chilla', grams: 90 }] },
  { name: 'Puri', aliases: ['puri', 'poori', 'deep fried bread'], basis: 'cooked', veg: true,
    kcal: 320, proteinG: 7.0, carbsG: 45.0, fatG: 14.5, fibreG: 2.0,
    ironMg: 2.0, magnesiumMg: 38, calciumMg: 45, zincMg: 1.0,
    servings: [{ label: '2 puri', grams: 50 }] },
  { name: 'Khichdi', aliases: ['khichdi', 'khichadi', 'moong dal khichdi'], basis: 'cooked', veg: true,
    kcal: 130, proteinG: 5.0, carbsG: 22.0, fatG: 2.5, fibreG: 2.5,
    ironMg: 1.8, magnesiumMg: 38, calciumMg: 25, zincMg: 1.0,
    servings: [{ label: '1 katori', grams: 200 }] },

  // --- Pulses and legumes --------------------------------------------------
  { name: 'Toor dal, cooked', aliases: ['toor dal', 'arhar dal', 'tur dal', 'masoor dal'], basis: 'cooked', veg: true,
    kcal: 116, proteinG: 6.0, carbsG: 18.5, fatG: 0.6, fibreG: 4.2,
    ironMg: 2.3, magnesiumMg: 42, calciumMg: 25, zincMg: 1.1 },
  { name: 'Moong dal, cooked', aliases: ['moong dal', 'moong'], basis: 'cooked', veg: true,
    kcal: 104, proteinG: 6.0, carbsG: 15.0, fatG: 0.4, fibreG: 3.0,
    ironMg: 1.7, magnesiumMg: 35, calciumMg: 20, zincMg: 1.0 },
  // Deliberately NOT carrying 'chole' or 'chana masala'. Those belong to the
  // Chole row below: a boiled chickpea is an ingredient, the curry is a dish,
  // and an alias that made a search for chole return both would send the user
  // to the wrong one about half the time.
  { name: 'Chana, cooked', aliases: ['chana', 'chickpea', 'boiled chana'], basis: 'cooked', veg: true,
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

  // --- Vegetables, second pass ---------------------------------------------
  //
  // A deliberately partial second pass. The gaps are the ones people search for
  // and the first pass did not have: mushrooms, sweet potato, corn, the winter
  // vegetables that dominate a North Indian winter, and the "my gym told me to
  // eat this" items that appear in every diet plan and no starter catalogue.
  { name: 'Mushroom, cooked', aliases: ['mushroom', 'mushrooms', 'kumbh', 'button mushroom'], basis: 'cooked', veg: true,
    kcal: 22, proteinG: 3.1, carbsG: 3.3, fatG: 0.3, fibreG: 1.0,
    ironMg: 0.3, magnesiumMg: 9, calciumMg: 2, zincMg: 0.5 },
  { name: 'Sweet potato, boiled', aliases: ['sweet potato', 'shakarkandi', 'garmada'], basis: 'cooked', veg: true,
    kcal: 90, proteinG: 2.0, carbsG: 21.0, fatG: 0.2, fibreG: 3.0,
    ironMg: 0.7, magnesiumMg: 27, calciumMg: 38, zincMg: 0.5,
    servings: [{ label: '1 medium', grams: 130 }] },
  { name: 'Corn, boiled', aliases: ['corn', 'sweet corn', 'bhutta', 'makai'], basis: 'cooked', veg: true,
    kcal: 96, proteinG: 3.4, carbsG: 21.0, fatG: 1.5, fibreG: 2.7,
    ironMg: 0.5, magnesiumMg: 37, calciumMg: 7, zincMg: 0.5,
    servings: [{ label: '1 katori', grams: 100 }] },
  { name: 'Peas, cooked', aliases: ['peas', 'green peas', 'matar'], basis: 'cooked', veg: true,
    kcal: 81, proteinG: 5.4, carbsG: 14.5, fatG: 0.4, fibreG: 5.7,
    ironMg: 1.5, magnesiumMg: 21, calciumMg: 25, zincMg: 1.0 },
  { name: 'Capsicum', aliases: ['capsicum', 'bell pepper', 'shimla mirch', 'green pepper'], basis: 'raw', veg: true,
    kcal: 26, proteinG: 1.0, carbsG: 5.0, fatG: 0.2, fibreG: 2.1,
    ironMg: 0.4, magnesiumMg: 12, calciumMg: 9, zincMg: 0.3 },
  { name: 'Broccoli, cooked', aliases: ['broccoli'], basis: 'cooked', veg: true,
    kcal: 34, proteinG: 2.8, carbsG: 7.0, fatG: 0.4, fibreG: 2.6,
    ironMg: 0.7, magnesiumMg: 21, calciumMg: 47, zincMg: 0.4 },
  { name: 'Pumpkin (kaddu)', aliases: ['pumpkin', 'kaddu', 'lakadi'], basis: 'cooked', veg: true,
    kcal: 26, proteinG: 1.0, carbsG: 6.5, fatG: 0.1, fibreG: 1.5,
    ironMg: 0.8, magnesiumMg: 8, calciumMg: 21, zincMg: 0.1 },
  { name: 'Bitter gourd fry', aliases: ['karela fry', 'bitter gourd fry'], basis: 'cooked', veg: true,
    // Distinct from the plain gourd row for the same reason fried idli is
    // distinct from idli: the oil is not a garnish.
    kcal: 90, proteinG: 1.4, carbsG: 7.0, fatG: 6.5, fibreG: 1.5,
    ironMg: 0.4, magnesiumMg: 17, calciumMg: 20, zincMg: 0.2 },
  { name: 'Aloo gobi', aliases: ['aloo gobi', 'potato cauliflower', 'aloo gobhi'], basis: 'cooked', veg: true,
    kcal: 110, proteinG: 2.5, carbsG: 13.0, fatG: 5.5, fibreG: 2.5,
    ironMg: 1.0, magnesiumMg: 20, calciumMg: 30, zincMg: 0.8,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Bhindi masala', aliases: ['bhindi masala', 'okra curry', 'bhindi curry'], basis: 'cooked', veg: true,
    kcal: 90, proteinG: 2.0, carbsG: 8.0, fatG: 5.0, fibreG: 2.5,
    ironMg: 0.8, magnesiumMg: 24, calciumMg: 45, zincMg: 0.4,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Mixed vegetable curry', aliases: ['mixed veg', 'mixed vegetable curry', 'sabzi'], basis: 'cooked', veg: true,
    kcal: 80, proteinG: 2.5, carbsG: 10.0, fatG: 4.0, fibreG: 2.5,
    ironMg: 0.9, magnesiumMg: 18, calciumMg: 35, zincMg: 0.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Kadhi', aliases: ['kadhi', 'kadi', 'yogurt curry'], basis: 'cooked', veg: true,
    kcal: 60, proteinG: 2.5, carbsG: 7.0, fatG: 2.5, fibreG: 1.0,
    ironMg: 0.8, magnesiumMg: 15, calciumMg: 25, zincMg: 0.6,
    servings: [{ label: '1 katori', grams: 200 }] },
  { name: 'Sambar', aliases: ['sambar', 'sambhar'], basis: 'cooked', veg: true,
    kcal: 45, proteinG: 2.5, carbsG: 7.0, fatG: 1.5, fibreG: 1.5,
    ironMg: 0.9, magnesiumMg: 16, calciumMg: 25, zincMg: 0.5,
    servings: [{ label: '1 katori', grams: 200 }] },
  { name: 'Dal tadka', aliases: ['dal tadka', 'tadka dal', 'dal jeera'], basis: 'cooked', veg: true,
    // Plain dal with a ghee tadka poured over. The fat is not part of the dal,
    // and it is most of the calories on some days.
    kcal: 130, proteinG: 6.0, carbsG: 18.5, fatG: 3.5, fibreG: 4.2,
    ironMg: 2.3, magnesiumMg: 42, calciumMg: 25, zincMg: 1.1,
    servings: [{ label: '1 katori', grams: 200 }] },
  { name: 'Dal makhani', aliases: ['dal makhani', 'makhani dal', 'black dal'], basis: 'cooked', veg: true,
    kcal: 165, proteinG: 7.0, carbsG: 18.0, fatG: 7.5, fibreG: 4.5,
    ironMg: 2.6, magnesiumMg: 45, calciumMg: 30, zincMg: 1.2,
    servings: [{ label: '1 katori', grams: 200 }] },
  { name: 'Chole', aliases: ['chole', 'chana masala', 'punjabi chole'], basis: 'cooked', veg: true,
    // Distinct from plain cooked chana: the gravy and the oil.
    kcal: 180, proteinG: 8.0, carbsG: 22.0, fatG: 6.0, fibreG: 6.0,
    ironMg: 2.9, magnesiumMg: 48, calciumMg: 49, zincMg: 1.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Rajma curry', aliases: ['rajma curry', 'rajma masala', 'kidney bean curry'], basis: 'cooked', veg: true,
    kcal: 140, proteinG: 8.0, carbsG: 22.0, fatG: 3.5, fibreG: 6.0,
    ironMg: 2.3, magnesiumMg: 45, calciumMg: 45, zincMg: 1.0,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Rajma chawal', aliases: ['rajma chawal', 'rajma rice', 'kidney beans with rice'], basis: 'as_served', veg: true,
    // A composite, and logged as one because that is how it is eaten and how it
    // is ordered. Both components are still rows for anyone counting them apart.
    kcal: 165, proteinG: 5.5, carbsG: 28.0, fatG: 3.0, fibreG: 3.5,
    ironMg: 1.5, magnesiumMg: 35, calciumMg: 30, zincMg: 0.9,
    servings: [{ label: '1 plate', grams: 350 }] },
  // ---- Paneer dishes -------------------------------------------------------
  //
  // Paneer is the commonest "is there a row for this" gap after omelette, and
  // the gap is not the ingredient - plain Paneer is already there - it is the
  // DISHES. Somebody logging dinner types "palak paneer", and a catalogue with
  // only the block of cheese answers with a piece of paneer and a completely
  // wrong calorie count for the plate.
  //
  // These are the ones that come up constantly in an Indian household. Not a
  // restaurant menu: shahi and khurchan are here because they are everyday
  // enough, and because a user who finds their dish gets an approximate number,
  // which is worth more than an exact number for a different food.
  { name: 'Paneer curry', aliases: ['paneer curry', 'paneer masala', 'masala paneer'], basis: 'cooked', veg: true,
    // Home-style gravy: the plain-Paneer row's numbers plus a little onion,
    // tomato and oil. The dish is not a mystery to anyone who eats it, and
    // saying so is more useful than refusing to log it.
    kcal: 200, proteinG: 11.0, carbsG: 8.0, fatG: 13.0, fibreG: 1.5,
    ironMg: 1.3, magnesiumMg: 32, calciumMg: 190, zincMg: 1.2,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Palak paneer', aliases: ['palak paneer', 'shak paneer', 'saag paneer'], basis: 'cooked', veg: true,
    // Spinach carries the iron and the colour; the paneer carries the protein
    // and most of the fat. Logged together because that is the dish.
    kcal: 180, proteinG: 9.5, carbsG: 7.0, fatG: 12.5, fibreG: 2.5,
    ironMg: 3.0, magnesiumMg: 60, calciumMg: 210, zincMg: 1.4,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Paneer butter masala', aliases: ['paneer butter masala', 'butter paneer', 'paneer makhani'], basis: 'cooked', veg: true,
    // The richest of these by a distance, and the one most worth having its own
    // row: cashew, cream, butter and sugar. Rolled into "paneer curry" it would
    // be off by about 80 kcal a katori, which is the difference between a
    // dish somebody planned for and one they did not.
    kcal: 320, proteinG: 12.0, carbsG: 12.0, fatG: 26.0, fibreG: 1.5,
    ironMg: 1.5, magnesiumMg: 40, calciumMg: 230, zincMg: 1.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Shahi paneer', aliases: ['shahi paneer', 'kaju paneer', 'cashew paneer'], basis: 'cooked', veg: true,
    // Between the home curry and butter masala: a cashew gravy, no cream. Kept
    // separate rather than folded into either neighbour because it is the dish
    // that shows up on a restaurant menu and gets logged by somebody eating out.
    kcal: 260, proteinG: 11.5, carbsG: 11.0, fatG: 19.0, fibreG: 1.5,
    ironMg: 1.6, magnesiumMg: 45, calciumMg: 215, zincMg: 1.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Matar paneer', aliases: ['matar paneer', 'paneer with peas'], basis: 'cooked', veg: true,
    kcal: 200, proteinG: 12.0, carbsG: 11.0, fatG: 12.0, fibreG: 3.0,
    ironMg: 2.0, magnesiumMg: 45, calciumMg: 165, zincMg: 1.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Paneer tikka', aliases: ['paneer tikka', 'paneer tikka masala'], basis: 'cooked', veg: true,
    // Dry-roasted, so the fat is what the paneer brought and the gravy does not
    // add. Half the calories of the butter masala for a similar portion - the
    // gap between these two rows is the reason they are both here.
    kcal: 200, proteinG: 15.0, carbsG: 5.0, fatG: 14.0, fibreG: 1.0,
    ironMg: 1.4, magnesiumMg: 32, calciumMg: 240, zincMg: 1.4,
    servings: [{ label: '1 plate', grams: 150 }] },
  { name: 'Paneer bhurji', aliases: ['paneer bhurji', 'paneer keema', 'matar paneer bhurji'], basis: 'cooked', veg: true,
    // Scrambled with onion and spice, usually eaten with bread. NO bare 'bhurji'
    // alias: the egg row carries it, and a shared alias makes a search for
    // "bhurji" return two dishes that differ by every calorie in them, with
    // alphabetical order deciding which one the user logs.
    kcal: 230, proteinG: 16.0, carbsG: 7.0, fatG: 16.0, fibreG: 1.5,
    ironMg: 1.5, magnesiumMg: 35, calciumMg: 245, zincMg: 1.5,
    servings: [{ label: '1 plate', grams: 150 }] },
  { name: 'Vegetable biryani', aliases: ['veg biryani', 'vegetable biryani', 'subzi dum biryani'], basis: 'cooked', veg: true,
    kcal: 175, proteinG: 4.0, carbsG: 27.0, fatG: 6.0, fibreG: 1.5,
    ironMg: 1.4, magnesiumMg: 20, calciumMg: 30, zincMg: 0.9,
    servings: [{ label: '1 plate', grams: 300 }] },
  { name: 'Vegetable pulao', aliases: ['pulao', 'vegetable pulao', 'palak pulao'], basis: 'cooked', veg: true,
    kcal: 150, proteinG: 3.5, carbsG: 26.0, fatG: 3.0, fibreG: 1.2,
    ironMg: 1.1, magnesiumMg: 18, calciumMg: 22, zincMg: 0.8,
    servings: [{ label: '1 katori', grams: 250 }] },
  { name: 'Fried rice, vegetable', aliases: ['veg fried rice', 'vegetable fried rice', 'chinese rice'], basis: 'cooked', veg: true,
    kcal: 155, proteinG: 4.0, carbsG: 25.0, fatG: 4.5, fibreG: 1.0,
    ironMg: 0.9, magnesiumMg: 15, calciumMg: 20, zincMg: 0.7,
    servings: [{ label: '1 plate', grams: 250 }] },
  { name: 'Jeera rice', aliases: ['jeera rice', 'cumin rice'], basis: 'cooked', veg: true,
    kcal: 145, proteinG: 3.0, carbsG: 28.0, fatG: 1.5, fibreG: 0.4,
    ironMg: 0.3, magnesiumMg: 13, calciumMg: 12, zincMg: 0.6,
    servings: [{ label: '1 katori', grams: 200 }] },
  { name: 'Curd rice', aliases: ['curd rice', 'dahi chawal'], basis: 'cooked', veg: true,
    kcal: 120, proteinG: 3.5, carbsG: 22.0, fatG: 2.0, fibreG: 0.4,
    ironMg: 0.2, magnesiumMg: 13, calciumMg: 35, zincMg: 0.6,
    servings: [{ label: '1 katori', grams: 200 }] },

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
  { name: 'Banana, raw (unripe)', aliases: ['raw banana', 'kela kaccha'], basis: 'raw', veg: true,
    kcal: 89, proteinG: 1.1, carbsG: 22.8, fatG: 0.3, fibreG: 2.6,
    ironMg: 0.3, magnesiumMg: 27, calciumMg: 5, zincMg: 0.2 },
  { name: 'Chikoo (sapodilla)', aliases: ['chikoo', 'sapodilla', 'chiku'], basis: 'raw', veg: true,
    kcal: 90, proteinG: 0.5, carbsG: 21.0, fatG: 0.5, fibreG: 2.0,
    ironMg: 0.4, magnesiumMg: 10, calciumMg: 27, zincMg: 0.1 },
  { name: 'Jamun', aliases: ['jamun', 'jambul', 'black plum'], basis: 'raw', veg: true,
    kcal: 60, proteinG: 0.7, carbsG: 16.0, fatG: 0.3, fibreG: 0.4,
    ironMg: 0.4, magnesiumMg: 9, calciumMg: 15, zincMg: 0.1 },
  { name: 'Sitaphal (custard apple)', aliases: ['sitaphal', 'custard apple', 'sharifa'], basis: 'raw', veg: true,
    kcal: 125, proteinG: 1.7, carbsG: 30.0, fatG: 1.2, fibreG: 3.0,
    ironMg: 0.6, magnesiumMg: 21, calciumMg: 20, zincMg: 0.1 },
  { name: 'Grapes', aliases: ['grapes', 'angur', 'draksha'], basis: 'raw', veg: true,
    kcal: 69, proteinG: 0.7, carbsG: 18.0, fatG: 0.2, fibreG: 0.9,
    ironMg: 0.4, magnesiumMg: 11, calciumMg: 10, zincMg: 0.1 },
  { name: 'Kiwi', aliases: ['kiwi', 'kiwifruit', 'chinese gooseberry'], basis: 'raw', veg: true,
    kcal: 61, proteinG: 1.1, carbsG: 15.0, fatG: 0.5, fibreG: 3.0,
    ironMg: 0.3, magnesiumMg: 17, calciumMg: 27, zincMg: 0.3 },
  { name: 'Pineapple', aliases: ['pineapple', 'ananas'], basis: 'raw', veg: true,
    kcal: 50, proteinG: 0.5, carbsG: 13.0, fatG: 0.1, fibreG: 1.4,
    ironMg: 0.3, magnesiumMg: 12, calciumMg: 13, zincMg: 0.1 },
  { name: 'Butter', aliases: ['butter', 'makhan', 'mohan'], basis: 'as_served', veg: true,
    kcal: 717, proteinG: 0.9, carbsG: 0.1, fatG: 81.1, fibreG: 0,
    ironMg: 0.2, magnesiumMg: 2, calciumMg: 24, zincMg: 0.1,
    servings: [{ label: '1 tsp', grams: 5 }] },
  { name: 'Cream', aliases: ['cream', 'malai', 'haldi'], basis: 'as_served', veg: true,
    kcal: 340, proteinG: 2.0, carbsG: 3.0, fatG: 35.0, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 9, calciumMg: 65, zincMg: 0.1,
    servings: [{ label: '1 tbsp', grams: 15 }] },
  { name: 'Khoya / mawa', aliases: ['khoya', 'mawa', 'condensed milk'], basis: 'as_served', veg: true,
    kcal: 216, proteinG: 5.9, carbsG: 24.0, fatG: 11.0, fibreG: 0,
    ironMg: 0.6, magnesiumMg: 27, calciumMg: 190, zincMg: 0.8 },
  { name: 'Cheese, processed slice', aliases: ['cheese slice', 'processed cheese', 'cheese'], basis: 'as_served', veg: true,
    kcal: 350, proteinG: 22.0, carbsG: 3.0, fatG: 28.0, fibreG: 0,
    ironMg: 0.6, magnesiumMg: 10, calciumMg: 250, zincMg: 1.1,
    servings: [{ label: '1 slice', grams: 20 }] },
  { name: 'Cheese, mozzarella', aliases: ['mozzarella', 'pizza cheese'], basis: 'as_served', veg: true,
    kcal: 280, proteinG: 28.0, carbsG: 3.0, fatG: 17.0, fibreG: 0,
    ironMg: 0.4, magnesiumMg: 12, calciumMg: 505, zincMg: 2.9 },
  { name: 'Lassi, sweet', aliases: ['lassi', 'sweet lassi', 'chhaas lassi'], basis: 'as_served', veg: true,
    kcal: 70, proteinG: 3.0, carbsG: 10.0, fatG: 2.5, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 9, calciumMg: 90, zincMg: 0.3,
    servings: [{ label: '1 glass', grams: 200 }] },
  { name: 'Coconut water', aliases: ['coconut water', 'nariyal pani'], basis: 'as_served', veg: true,
    kcal: 20, proteinG: 0.7, carbsG: 3.7, fatG: 0.2, fibreG: 0.5,
    ironMg: 0.2, magnesiumMg: 8, calciumMg: 20, zincMg: 0.1,
    servings: [{ label: '1 glass', grams: 250 }] },
  { name: 'Coconut, grated', aliases: ['coconut', 'nariyal', 'coconut flesh'], basis: 'raw', veg: true,
    kcal: 354, proteinG: 3.3, carbsG: 15.2, fatG: 33.5, fibreG: 9.0,
    ironMg: 2.4, magnesiumMg: 32, calciumMg: 14, zincMg: 2.3 },
  { name: 'Lemon', aliases: ['lemon', 'nimbu', 'nimbu ka phal'], basis: 'raw', veg: true,
    // Lemon's peel is most of the carbohydrate and all of the fibre, and nobody
    // eats the peel. The figures below describe the juice: 29 kcal against
    // IFCT's 29 for the whole fruit, with the macros brought down to match. A
    // juice row that carried the whole-fruit macros would overstate every
    // lemon-shaped thing logged by about 4x.
    kcal: 29, proteinG: 0.4, carbsG: 6.2, fatG: 0.2, fibreG: 0.3,
    ironMg: 0.6, magnesiumMg: 12, calciumMg: 2, zincMg: 0.1 },
  { name: 'Orange juice', aliases: ['orange juice', 'santra juice', 'juice'], basis: 'as_served', veg: true,
    kcal: 45, proteinG: 0.7, carbsG: 10.4, fatG: 0.2, fibreG: 0.2,
    ironMg: 0.1, magnesiumMg: 10, calciumMg: 40, zincMg: 0.1,
    servings: [{ label: '1 glass', grams: 250 }] },
  { name: 'Milk, chocolate flavoured', aliases: ['chocolate milk', 'coco milk'], basis: 'as_served', veg: true,
    kcal: 83, proteinG: 2.7, carbsG: 13.0, fatG: 2.4, fibreG: 0,
    ironMg: 0.2, magnesiumMg: 12, calciumMg: 105, zincMg: 0.5 },
  { name: 'Coconut, milk', aliases: ['coconut milk', 'nariyal doodh'], basis: 'as_served', veg: true,
    kcal: 230, proteinG: 2.3, carbsG: 5.5, fatG: 23.8, fibreG: 0,
    ironMg: 0.6, magnesiumMg: 20, calciumMg: 5, zincMg: 0.6 },
  { name: 'Chai, black', aliases: ['black tea', 'chai no sugar'], basis: 'as_served', veg: true,
    // Deliberately near-zero. A plain black chai with no milk and no sugar is
    // almost nothing, and logging it as 70 kcal - the number on the milk-and-sugar
    // row - would attach a cup of somebody's tea to their day as a snack.
    kcal: 2, proteinG: 0.1, carbsG: 0.3, fatG: 0, fibreG: 0,
    ironMg: 0, magnesiumMg: 1, calciumMg: 2, zincMg: 0.1,
    servings: [{ label: '1 cup', grams: 150 }] },
  { name: 'Green tea', aliases: ['green tea', 'herbal tea'], basis: 'as_served', veg: true,
    kcal: 1, proteinG: 0, carbsG: 0.2, fatG: 0, fibreG: 0,
    ironMg: 0, magnesiumMg: 1, calciumMg: 1, zincMg: 0.1,
    servings: [{ label: '1 cup', grams: 200 }] },
  { name: 'Whey protein shake', aliases: ['protein shake', 'whey', 'whey protein', 'protein drink'], basis: 'as_served', veg: true,
    // A supplement rather than a food, and in the catalogue because it is what
    // a large share of this app's users drink every day. Labelled so a
    // nutritionist can replace it with a real brand's label.
    kcal: 60, proteinG: 10.0, carbsG: 3.0, fatG: 1.2, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 5, calciumMg: 40, zincMg: 0.2,
    servings: [{ label: '1 scoop in water', grams: 30 }] },

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

  // --- Eggs ----------------------------------------------------------------
  //
  // Four separate egg rows rather than one. A boiled egg, an omelette and
  // bhurji are three foods that happen to share an ingredient, and the
  // difference between them is the whole reason someone logging breakfast wants
  // a picker: 155 kcal of boiled white against 180 kcal of an omelette cooked
  // with oil is a third of a roti, and merging them would make one of the two
  // wrong for everybody.
  { name: 'Egg, whole (boiled)', aliases: ['egg', 'anda', 'boiled egg', 'eggs', 'hard boiled egg'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 155, proteinG: 12.6, carbsG: 1.1, fatG: 10.6, fibreG: 0,
    ironMg: 1.8, magnesiumMg: 12, calciumMg: 50, zincMg: 1.1,
    servings: [{ label: '1 large egg', grams: 50 }] },
  { name: 'Omelette, cooked', aliases: ['omelette', 'omelet', 'anda omelette', 'egg omelette', 'omelette with oil'], basis: 'cooked', veg: false, nonVeg: true,
    // Two eggs with a little oil, which is how almost every omelette is made.
    // Without oil it is a different row's worth of calories, and pretending
    // otherwise would flatter the most common version of this dish.
    kcal: 180, proteinG: 12.0, carbsG: 2.0, fatG: 13.0, fibreG: 0,
    ironMg: 1.7, magnesiumMg: 13, calciumMg: 60, zincMg: 1.2,
    servings: [{ label: '2 eggs', grams: 110 }, { label: '1 egg', grams: 55 }] },
  { name: 'Egg bhurji', aliases: ['bhurji', 'anda bhurji', 'scrambled egg', 'eggs bhurji', 'spicy scrambled egg'], basis: 'cooked', veg: false, nonVeg: true,
    // Scrambled with onion and green chilli, oil included - bhurji is a dish,
    // not a technique applied to a plain egg, and it carries vegetables the
    // boiled row does not.
    kcal: 190, proteinG: 12.5, carbsG: 3.0, fatG: 14.0, fibreG: 0,
    ironMg: 1.9, magnesiumMg: 15, calciumMg: 65, zincMg: 1.3,
    servings: [{ label: '2 eggs', grams: 115 }] },
  { name: 'Egg white, boiled', aliases: ['egg white', 'boiled egg white', 'white egg', 'anda ka petha'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 52, proteinG: 11.0, carbsG: 0.7, fatG: 0.2, fibreG: 0,
    ironMg: 0.1, magnesiumMg: 11, calciumMg: 7, zincMg: 0.1,
    servings: [{ label: '1 large white', grams: 33 }] },
  { name: 'Egg curry', aliases: ['egg curry', 'anda curry', 'masala egg', 'eggs in curry'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 180, proteinG: 11.0, carbsG: 3.0, fatG: 13.5, fibreG: 0.5,
    ironMg: 1.6, magnesiumMg: 16, calciumMg: 50, zincMg: 1.2,
    servings: [{ label: '2 eggs', grams: 150 }] },

  // --- Non-veg, meat and fish ---------------------------------------------
  // Chicken breast, boiled egg and plain fish are the three rows the original
  // starter catalogue carried, kept exactly as they were and left in the group
  // below rather than duplicated here. Moving them is churn; a re-seed rewrites
  // them identically and a diff that shows a file being reorganised is a diff
  // nobody reviews.
  { name: 'Chicken curry, home style', aliases: ['chicken curry', 'murgh curry', 'chicken masala', 'chicken gravy'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 170, proteinG: 16.0, carbsG: 4.0, fatG: 10.0, fibreG: 0.8,
    ironMg: 1.2, magnesiumMg: 18, calciumMg: 30, zincMg: 1.2,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Chicken tikka, cooked', aliases: ['chicken tikka', 'murgh tikka', 'tandoori chicken', 'chicken tandoori'], basis: 'cooked', veg: false, nonVeg: true,
    // Marinated and grilled, so the marinade's yoghurt and spice are in here.
    kcal: 160, proteinG: 25.0, carbsG: 2.0, fatG: 6.0, fibreG: 0,
    ironMg: 1.2, magnesiumMg: 25, calciumMg: 20, zincMg: 1.3 },
  { name: 'Chicken 65', aliases: ['chicken 65', 'fried chicken', 'chicken pakora', 'deep fried chicken'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 250, proteinG: 18.0, carbsG: 5.0, fatG: 17.0, fibreG: 0.3,
    ironMg: 1.4, magnesiumMg: 22, calciumMg: 25, zincMg: 1.3,
    servings: [{ label: '1 piece', grams: 90 }] },
  { name: 'Chicken biryani', aliases: ['biryani', 'chicken biryani', 'murgh biryani', 'dum biryani'], basis: 'cooked', veg: false, nonVeg: true,
    // Rice, meat and ghee in one dish. The oil is not separable at the table,
    // which is exactly why it has to be its own row.
    kcal: 180, proteinG: 8.0, carbsG: 24.0, fatG: 6.5, fibreG: 1.0,
    ironMg: 1.3, magnesiumMg: 20, calciumMg: 25, zincMg: 1.1,
    servings: [{ label: '1 plate', grams: 300 }] },
  { name: 'Mutton curry', aliases: ['mutton', 'mutton curry', 'bakra', 'lamb curry', 'mutton masala'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 200, proteinG: 16.0, carbsG: 3.0, fatG: 14.5, fibreG: 0.5,
    ironMg: 2.0, magnesiumMg: 22, calciumMg: 25, zincMg: 2.4,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Fish curry', aliases: ['fish curry', 'machli curry', 'fish masala', 'fish gravy'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 130, proteinG: 12.0, carbsG: 5.0, fatG: 6.5, fibreG: 0.8,
    ironMg: 1.1, magnesiumMg: 28, calciumMg: 45, zincMg: 0.9,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Prawns, cooked', aliases: ['prawns', 'jhinga', 'shrimp', 'prawn'], basis: 'cooked', veg: false, nonVeg: true,
    kcal: 100, proteinG: 20.0, carbsG: 1.0, fatG: 1.5, fibreG: 0,
    ironMg: 2.7, magnesiumMg: 40, calciumMg: 70, zincMg: 1.3 },
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
  { name: 'Potato chips', aliases: ['chips', 'lays', 'crisps', 'potato crisps'], basis: 'as_served', veg: true,
    kcal: 550, proteinG: 6.0, carbsG: 53.0, fatG: 33.0, fibreG: 4.0,
    ironMg: 1.8, magnesiumMg: 67, calciumMg: 24, zincMg: 1.1,
    servings: [{ label: '1 small packet', grams: 35 }] },
  { name: 'Samosa', aliases: ['samosa', 'singara', 'samosa chaat'], basis: 'as_served', veg: true,
    kcal: 300, proteinG: 6.0, carbsG: 32.0, fatG: 15.0, fibreG: 2.5,
    ironMg: 1.8, magnesiumMg: 40, calciumMg: 45, zincMg: 1.2,
    servings: [{ label: '1 samosa', grams: 80 }] },
  { name: 'Pakoda / bhaji', aliases: ['pakoda', 'pakora', 'bhaji', 'aloo bhaji', 'onion pakoda'], basis: 'as_served', veg: true,
    kcal: 250, proteinG: 5.0, carbsG: 28.0, fatG: 13.0, fibreG: 3.0,
    ironMg: 1.8, magnesiumMg: 40, calciumMg: 45, zincMg: 1.1,
    servings: [{ label: '1 katori', grams: 100 }] },
  { name: 'Chana chaat', aliases: ['chana chaat', 'dahi chaat', 'salli chaat'], basis: 'as_served', veg: true,
    kcal: 180, proteinG: 8.0, carbsG: 25.0, fatG: 5.0, fibreG: 6.0,
    ironMg: 2.5, magnesiumMg: 40, calciumMg: 30, zincMg: 1.5,
    servings: [{ label: '1 katori', grams: 150 }] },
  { name: 'Bhel puri', aliases: ['bhel puri', 'bhelpuri', 'puri chaat'], basis: 'as_served', veg: true,
    kcal: 180, proteinG: 4.5, carbsG: 28.0, fatG: 6.0, fibreG: 2.0,
    ironMg: 1.5, magnesiumMg: 35, calciumMg: 40, zincMg: 1.0,
    servings: [{ label: '1 plate', grams: 200 }] },
  // Street food that never appears in an app because it is only ever bought
  // from a stall and called by one word. Momos and kachori were the two the
  // request flow would otherwise have collected on day one: a search for momos
  // returning nothing is not a nutrition question, it is a catalogue hole.
  { name: 'Momos, steamed', aliases: ['momos', 'momo', 'dumpling', 'steamed momos'], basis: 'cooked', veg: true,
    kcal: 190, proteinG: 9.0, carbsG: 22.0, fatG: 8.0, fibreG: 1.5,
    ironMg: 1.8, magnesiumMg: 28, calciumMg: 40, zincMg: 1.2,
    servings: [{ label: '6 pieces', grams: 150 }] },
  { name: 'Momos, fried', aliases: ['fried momos', 'tandoori momos'], basis: 'cooked', veg: true,
    // The same food in deep oil is roughly double the calories and four times
    // the fat. Rolling it up under "momos" would quietly erase the
    // distinction between the version somebody is trying to eat and the version
    // they actually order.
    kcal: 350, proteinG: 11.0, carbsG: 28.0, fatG: 22.0, fibreG: 1.5,
    ironMg: 2.0, magnesiumMg: 30, calciumMg: 45, zincMg: 1.3,
    servings: [{ label: '6 pieces', grams: 150 }] },
  { name: 'Kachori', aliases: ['kachori', 'kachauri', 'aloo kachori'], basis: 'as_served', veg: true,
    kcal: 320, proteinG: 6.0, carbsG: 34.0, fatG: 18.0, fibreG: 2.5,
    ironMg: 1.8, magnesiumMg: 40, calciumMg: 40, zincMg: 1.1,
    servings: [{ label: '1 kachori', grams: 90 }] },
  { name: 'Bread pakoda', aliases: ['bread pakoda', 'bread pakora'], basis: 'as_served', veg: true,
    kcal: 300, proteinG: 6.0, carbsG: 34.0, fatG: 16.0, fibreG: 2.0,
    ironMg: 2.0, magnesiumMg: 45, calciumMg: 45, zincMg: 1.1,
    servings: [{ label: '2 pieces', grams: 100 }] },
  { name: 'Spring roll, veg', aliases: ['spring roll', 'spring rolls'], basis: 'as_served', veg: true,
    kcal: 250, proteinG: 5.0, carbsG: 28.0, fatG: 13.0, fibreG: 2.0,
    ironMg: 1.6, magnesiumMg: 35, calciumMg: 40, zincMg: 1.0,
    servings: [{ label: '1 roll', grams: 100 }] },
  // 'makai' stays on the boiled corn row and NOT here: makai is the word for corn
  // itself, so a search for it should return corn. Popcorn is makai chattai, and
  // that is the alias that finds this row.
  { name: 'Popcorn, plain', aliases: ['popcorn', 'makkai chattai', 'popcorn plain'], basis: 'as_served', veg: true,
    kcal: 550, proteinG: 8.0, carbsG: 60.0, fatG: 30.0, fibreG: 14.0,
    ironMg: 3.0, magnesiumMg: 90, calciumMg: 10, zincMg: 2.0,
    servings: [{ label: '1 packet', grams: 40 }] },
  { name: 'Dates (khajur)', aliases: ['dates', 'khajur', 'chhota khajur'], basis: 'raw', veg: true,
    kcal: 277, proteinG: 2.5, carbsG: 75.0, fatG: 0.2, fibreG: 6.7,
    ironMg: 2.7, magnesiumMg: 83, calciumMg: 27, zincMg: 0.3,
    servings: [{ label: '3 dates', grams: 24 }] },
  { name: 'Raisins (kishmish)', aliases: ['raisins', 'kishmish', 'munaqka'], basis: 'raw', veg: true,
    kcal: 299, proteinG: 3.1, carbsG: 79.0, fatG: 0.5, fibreG: 3.7,
    ironMg: 2.5, magnesiumMg: 30, calciumMg: 50, zincMg: 1.0,
    servings: [{ label: '1 tbsp', grams: 10 }] },
  { name: 'Walnuts', aliases: ['walnut', 'akhrot', 'walnuts'], basis: 'raw', veg: true,
    kcal: 654, proteinG: 15.2, carbsG: 13.7, fatG: 65.2, fibreG: 6.7,
    ironMg: 2.9, magnesiumMg: 158, calciumMg: 98, zincMg: 3.1,
    servings: [{ label: '5 halves', grams: 15 }] },
  { name: 'Chia seeds', aliases: ['chia', 'chia seeds', 'tukm'], basis: 'raw', veg: true,
    // Low kcal per 100 g because it is mostly fibre and water, and the seed is
    // eaten in grams. The 34 g of fibre is the row's whole point.
    kcal: 486, proteinG: 16.5, carbsG: 42.1, fatG: 30.7, fibreG: 34.4,
    ironMg: 7.7, magnesiumMg: 335, calciumMg: 631, zincMg: 4.6,
    servings: [{ label: '1 tbsp', grams: 12 }] },
  { name: 'Flaxseed (alsi)', aliases: ['flaxseed', 'alsi', 'linseed'], basis: 'raw', veg: true,
    kcal: 534, proteinG: 18.3, carbsG: 28.9, fatG: 42.2, fibreG: 27.3,
    ironMg: 5.7, magnesiumMg: 392, calciumMg: 255, zincMg: 4.5,
    servings: [{ label: '1 tbsp', grams: 10 }] },
  { name: 'Honey', aliases: ['honey', 'madhu', 'shahad'], basis: 'as_served', veg: true,
    kcal: 304, proteinG: 0.3, carbsG: 82.4, fatG: 0, fibreG: 0.2,
    ironMg: 0.4, magnesiumMg: 2, calciumMg: 5, zincMg: 0.2,
    servings: [{ label: '1 tsp', grams: 5 }] },
  { name: 'Jam', aliases: ['jam', 'murabba', 'strawberry jam'], basis: 'as_served', veg: true,
    kcal: 250, proteinG: 0.4, carbsG: 62.0, fatG: 0.2, fibreG: 1.0,
    ironMg: 0.3, magnesiumMg: 8, calciumMg: 15, zincMg: 0.1,
    servings: [{ label: '1 tbsp', grams: 20 }] },
  { name: 'Peanut butter', aliases: ['peanut butter', 'screwdriver'], basis: 'as_served', veg: true,
    kcal: 588, proteinG: 25.1, carbsG: 20.0, fatG: 50.4, fibreG: 6.0,
    ironMg: 2.7, magnesiumMg: 168, calciumMg: 90, zincMg: 3.3,
    servings: [{ label: '1 tbsp', grams: 16 }] },
  { name: 'Dark chocolate', aliases: ['dark chocolate', '85% chocolate', 'chocolate'], basis: 'as_served', veg: true,
    kcal: 598, proteinG: 7.8, carbsG: 45.9, fatG: 42.6, fibreG: 10.9,
    ironMg: 2.4, magnesiumMg: 228, calciumMg: 73, zincMg: 2.3,
    servings: [{ label: '2 squares', grams: 20 }] },
  { name: 'Biscuit, packaged', aliases: ['biscuit', 'biscuits', 'cookie', 'parle g', 'digestive biscuit'], basis: 'as_served', veg: true,
    kcal: 480, proteinG: 5.0, carbsG: 68.0, fatG: 22.0, fibreG: 1.5,
    ironMg: 2.5, magnesiumMg: 40, calciumMg: 30, zincMg: 1.0,
    servings: [{ label: '2 biscuits', grams: 20 }] },
  { name: 'Gulab jamun', aliases: ['gulab jamun', 'gulab', 'jamun sweet'], basis: 'as_served', veg: true,
    kcal: 300, proteinG: 2.0, carbsG: 45.0, fatG: 13.0, fibreG: 0.2,
    ironMg: 0.8, magnesiumMg: 12, calciumMg: 40, zincMg: 0.6,
    servings: [{ label: '1 piece', grams: 35 }] },
  { name: 'Jalebi', aliases: ['jalebi', 'imarti', 'jalebi sweet'], basis: 'as_served', veg: true,
    kcal: 380, proteinG: 1.5, carbsG: 62.0, fatG: 15.0, fibreG: 0.2,
    ironMg: 0.6, magnesiumMg: 10, calciumMg: 25, zincMg: 0.5,
    servings: [{ label: '3 pieces', grams: 60 }] },
  { name: 'Rava kheer', aliases: ['kheer', 'rava kheer', 'payasam', 'basundi'], basis: 'as_served', veg: true,
    kcal: 130, proteinG: 3.5, carbsG: 21.0, fatG: 4.5, fibreG: 0.3,
    ironMg: 0.8, magnesiumMg: 15, calciumMg: 45, zincMg: 0.6,
    servings: [{ label: '1 katori', grams: 150 }] },
  // No 'kulfi' here, despite the near-identical macros: kulfi is a denser,
  // milk-solid frozen bar, it is a distinct row below, and an alias shared
  // between them would make one of the two unreachable by name.
  { name: 'Ice cream, vanilla', aliases: ['ice cream', 'vanilla ice cream'], basis: 'as_served', veg: true,
    kcal: 207, proteinG: 3.5, carbsG: 24.0, fatG: 11.0, fibreG: 0.7,
    ironMg: 0.1, magnesiumMg: 14, calciumMg: 84, zincMg: 0.4,
    servings: [{ label: '1 scoop', grams: 65 }] },
  { name: 'Kulfi', aliases: ['kulfi', 'matki kulfi', 'kulfi bar'], basis: 'as_served', veg: true,
    kcal: 217, proteinG: 3.8, carbsG: 22.0, fatG: 13.0, fibreG: 0,
    ironMg: 0.2, magnesiumMg: 15, calciumMg: 110, zincMg: 0.4,
    servings: [{ label: '1 stick', grams: 65 }] },
  { name: 'Chapati, multigrain (store bought)', aliases: ['multigrain chapati', 'store bought chapati'], basis: 'cooked', veg: true,
    kcal: 310, proteinG: 11.0, carbsG: 52.0, fatG: 6.0, fibreG: 8.0,
    ironMg: 3.5, magnesiumMg: 75, calciumMg: 50, zincMg: 1.8,
    servings: [{ label: '1 chapati', grams: 45 }] },
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
