// Typical edible weights, excluding shells, peels and pits. Whole egg and
// egg white agree with the catalogue's portions. Fruit defaults are approximate
// USDA household measures (banana FDC 173944, pomegranate FDC 169134).
const RAW_PIECE_GRAMS = new Map([
  ['apple', 182],
  ['banana', 118],
  ['dates (khajur)', 8],
  ['grapes', 5],
  ['guava', 55],
  ['kiwi', 69],
  ['mango', 336],
  ['orange', 131],
  ['pomegranate', 282],
]);

const COOKED_PIECE_GRAMS = new Map([
  ['egg, whole (boiled)', 50],
  ['egg white, boiled', 33],
]);

export function foodPieceGrams(food) {
  const name = food.name?.trim().toLowerCase();
  if (food.createdByUserId == null) {
    const grams = food.basis === 'raw'
      ? RAW_PIECE_GRAMS.get(name)
      : food.basis === 'cooked' ? COOKED_PIECE_GRAMS.get(name) : undefined;
    if (grams != null) return grams;
  }
  const servings = Array.isArray(food.servings) ? food.servings : [];
  for (const entry of servings) {
    if (typeof entry?.label !== 'string') continue;
    const count = /^(\d+)\s+(?:pieces?|slices?|biscuits?|rotis?|chapatis?|idlis?|samosas?)$/i
      .exec(entry.label.trim());
    const grams = Number(entry.grams);
    if (count && Number(count[1]) > 0 && Number.isFinite(grams) && grams > 0) {
      return grams / Number(count[1]);
    }
  }
  return null;
}
