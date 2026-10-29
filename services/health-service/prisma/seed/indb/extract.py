"""Turn the Indian Nutrient Databank (INDB) spreadsheets into indb.seed.json.

    python prisma/seed/indb/extract.py <Anuvaad_INDB_2024.11.xlsx> <recipes.xlsx> <recipes_servingsize.xlsx>

Run once per INDB release, then commit the JSON; the import (import-indb.js)
reads only the JSON, so nobody needs the spreadsheets or Python to seed.

Sources (used with permission, 2026-10-29):
  - Anuvaad_INDB_2024.11.xlsx: https://www.anuvaad.org.in/indian-nutrient-databank/
  - recipes*.xlsx: https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-
  Vijayakumar et al. (2024), Current Developments in Nutrition 8(7):103790.
  Values derive mainly from ICMR-NIN IFCT 2017, with UK and US tables for gaps.

Ingredient amounts are converted to grams with the same rules INDB's own
INDB.do uses (see GRAM_RULES), so our ingredient split matches theirs.
Requires openpyxl.
"""
import json
import re
import sys
from pathlib import Path

import openpyxl

RELEASE = '2024.11'

# INDB.do "convert all amounts to grams", in order: a later rule overrides an
# earlier one, exactly like Stata's sequential `replace`. (unit, categories or
# None for any, grams per unit). Categories are the first letter of food_code.
GRAM_RULES = [
    ('g', None, 1),
    ('tsp', 'GHBU', 2), ('tbsp', 'DGHBU', 7), ('tsp', 'D', 2), ('tbsp', 'F', 40),
    ('ml', 'GHIVX', 1), ('tsp', 'A', 2.5), ('tsp', 'M', 5), ('tbsp', 'A', 7),
    ('tsp', 'V', 2), ('tsp', 'T', 4), ('tbsp', 'T', 13.5), ('tsp', 'XW', 6),
    ('tbsp', 'XW', 20), ('tsp', 'I', 4), ('tbsp', 'I', 12), ('C', 'I', 200),
    ('tbsp', 'Z', 15), ('tsp', 'L', 5), ('tbsp', 'L', 15), ('C', 'L', 240),
    ('ml', 'L', 1), ('sprig', 'GUCA', 2), ('tsp', 'C', 0.5), ('tbsp', 'C', 5),
    ('tsp', 'T', 4), ('ml', 'T', 1), ('C', None, 240), ('ml', 'K', 1),
    ('ml', 'E', 1), ('tsp', 'KE', 5), ('tsp', 'E', 5), ('tbsp', 'KE', 15),
    ('tbsp', 'E', 15), ('tbsp', 'V', 8), ('C', 'L', 240), ('small', 'G', 2),
]


def grams(amount, unit, category, food_name):
    out = None
    for rule_unit, cats, factor in GRAM_RULES:
        if unit == rule_unit and (cats is None or category in cats):
            out = amount * factor
    if str(food_name).upper() == 'FENUGREEK LEAVES':
        out = amount * 2
    if unit == 'pinch':
        out = 0.125
    return out


# IFCT 2017 food groups: M egg; N poultry; O meat; P marine fish; Q shellfish;
# R molluscs; S freshwater fish. Other groups fall back to the name, which
# catches stock cubes, gelatine and the like in the miscellaneous groups.
EGG_GROUPS = set('M')
NON_VEG_GROUPS = set('NOPQRS')
MEAT_WORDS = re.compile(r'\b(chicken|mutton|lamb|beef|pork|ham|bacon|salami|sausages?|meat|fish|prawns?|shrimps?|crab|gelatine?|lard|anchov\w*)\b', re.I)
EGG_WORDS = re.compile(r'\b(egg|eggs)\b', re.I)


def ingredient_diet(code, name):
    group = str(code)[0]
    if group in NON_VEG_GROUPS or MEAT_WORDS.search(name):
        return 'non_veg'
    if group in EGG_GROUPS or EGG_WORDS.search(name):
        return 'egg'
    return 'veg'


# Words in a DISH name that say it is non-veg or contains egg, in English and
# Hinglish. INDB's standard recipe for "Pizza" uses sausages and some soups use
# chicken stock; most Indian versions do not. When the recipe has meat or egg
# but the dish name does not say so, the dish is 'unknown' (check), never a
# confident non-veg or veg: the ingredient list still shows what INDB used.
DISH_NON_VEG = re.compile(r'\b(chicken|mutton|meat|keema|kheema|fish|prawns?|shrimps?|lamb|goat|ham|bacon|salami|sausages?|crab|liver|murg[h]?|gosht|machhi|machli|macchi|jhinga|pomfret|rohu|mackerel|surmai|bangda|kebab|boti|roghan|rogan|chops|consomm\w*|stock)\b', re.I)
DISH_EGG = re.compile(r'\b(egg|eggs|anda|ande|omelette|omlet|omelet|cake|custard|souffl\w*|meringue|pavlova|mayonnaise|french toast)\b', re.I)


def dish_diet(name, ingredient_diets):
    if 'non_veg' in ingredient_diets:
        # A dish already named for egg ("Egg drop soup") is not ordered by
        # strict vegetarians, so its meat or stock is stated plainly.
        return 'non_veg' if DISH_NON_VEG.search(name) or DISH_EGG.search(name) else 'unknown'
    if 'egg' in ingredient_diets:
        return 'egg' if DISH_EGG.search(name) else 'unknown'
    return 'veg' if ingredient_diets else 'unknown'


def clean_ingredient(name):
    # "Spinach (Spinacia oleracea)" -> "Spinach": the Latin name is noise in a food log.
    name = re.sub(r'\s*\([A-Z][a-z]+ [a-z].*?\)\s*$', '', str(name).strip())
    return name[:1].upper() + name[1:] if name else name


def rows(path):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    it = ws.iter_rows(values_only=True)
    header = next(it)
    for r in it:
        yield dict(zip(header, r))


def num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def main(indb_path, recipes_path, sizes_path):
    ingredients = {}
    for r in rows(recipes_path):
        code, food_code, amount = r['recipe_code'], r['food_code'], r['amount']
        if not code or not food_code or amount is None:
            continue
        name = str(r['food_name'])
        g = grams(float(amount), r['unit'], str(food_code)[0], name)
        ingredients.setdefault(code, []).append({
            'name': clean_ingredient(name),
            'grams': round(g, 3) if g else None,
            'dietaryType': ingredient_diet(food_code, name),
            'code': str(food_code),
        })

    sizes = {r['recipe_code']: r for r in rows(sizes_path) if r['recipe_code']}

    foods = []
    for r in rows(indb_path):
        code = r['food_code']
        if not code or num(r['energy_kcal']) is None:
            continue
        parts = ingredients.get(code, [])
        diet = dish_diet(str(r['food_name']), {p['dietaryType'] for p in parts})
        if diet == 'unknown':
            # The app derives a dish's type from its ingredients, so the
            # recipe-dependent ingredient is 'unknown' too; its name still says
            # exactly what INDB's recipe used.
            parts = [{**p, 'dietaryType': 'unknown'} if p['dietaryType'] != 'veg' else p for p in parts]
        # Serving weight from INDB's own per-serving and per-100 g values.
        serving = None
        for key in ['energy_kcal', 'carb_g', 'protein_g', 'fat_g']:
            per100, per_serving = num(r[key]), num(r['unit_serving_' + key])
            if per100 and per_serving:
                serving = {'label': '1 ' + str(r['servings_unit'] or 'serving'), 'grams': round(per_serving / per100 * 100)}
                break
        foods.append({
            'code': code,
            'name': str(r['food_name']).strip(),
            'primarySource': r['primarysource'],
            'kcal': num(r['energy_kcal']), 'proteinG': num(r['protein_g']), 'carbsG': num(r['carb_g']),
            'fatG': num(r['fat_g']), 'fibreG': num(r['fibre_g']),
            'ironMg': num(r['iron_mg']), 'magnesiumMg': num(r['magnesium_mg']),
            'calciumMg': num(r['calcium_mg']), 'zincMg': num(r['zinc_mg']),
            'servings': [serving] if serving and serving['grams'] > 0 else [],
            'servingsPerRecipe': num((sizes.get(code) or {}).get('no_of_servings')),
            'dietaryType': diet,
            'ingredients': [p for p in parts if p['grams']],
        })

    out = Path(__file__).with_name('indb.seed.json')
    out.write_text(json.dumps({'release': RELEASE, 'count': len(foods), 'foods': foods}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(foods)} foods -> {out}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
