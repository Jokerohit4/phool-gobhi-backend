// Name matching against the food catalogue.
//
// This was a private function in foodPhotoService.js, which meant the one place
// a user types a food name by hand had no way to use it. Both callers now share
// it, and that is the point of the extraction: "rice" has to mean the same row
// whether it arrived from a vision model or from a thumb on a keyboard, or the
// same dish gets two different nutrient values depending on how it was entered.
//
// It is its own module rather than living in nutritionService because
// foodPhotoService imports nutritionService. Putting it there would make the
// search path import the photo path, and the ranking below is the reason the
// photo path calls searchFoods in the first place.

// Bumped well above every other tier so an exact hit always outranks a prefix
// hit regardless of name length. The per-tier deductions are what order rows
// WITHIN a tier, not what separate the tiers - hence the gaps of 100 rather
// than 10: the maximum deduction is 99, so tiers can touch the tier below and
// still not invert.
//
// The one ordering that is a genuine judgement rather than a rule of the tiers:
// PREFIX sits above ALIAS_EXACT. "rice" as an alias of "Rice, cooked" and as an
// alias of "Fried rice balls" are the same evidence, but "rice" is the START of
// one of those names and merely the middle of the other, and a user who typed
// "rice" is describing a dish they know by that word rather than a dish that
// happens to contain it. Both rows here score on the alias branch, so the name
// position has to be what separates them.
const TIER_EXACT = 1000;
const TIER_PREFIX = 900;
const TIER_ALIAS_EXACT = 800;
const TIER_WORD = 500;
const TIER_ALIAS_WORD = 300;

// What counts as part of a word. Unicode property escapes rather than [a-z] so a
// transliterated or non-Latin food name is not treated as a string of word
// boundaries - which would make every character in it a boundary and turn the
// word-start rule below into the substring rule it is replacing.
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * True when `needle` occurs in `haystack` at the START of a word.
 *
 * This is the difference between "tea" finding "Green tea" and "tea" finding
 * "Momos, steamed", which is a real result and was a real bug: s-T E A-m-e-d
 * contains "tea" at index 1, so plain `includes` scored a steamed momo as a
 * legitimate hit for a drink. It surfaced only against a real seeded database;
 * the unit tests had no row containing the word "steamed" and no query that
 * found it.
 *
 * Only the boundary BEFORE the match is checked, never the one after. That is
 * what keeps partial typing working: "ric" must still reach "Rice, cooked",
 * where the match is followed by an 'e' and would fail an end-of-word test.
 * Requiring a start boundary but not an end boundary means the rule is
 * "matches a word, or the beginning of one" - which is what a person typing
 * the beginning of a food name is doing.
 *
 * Occurrences are scanned in turn because the first one can be mid-word while a
 * later one is a real word start: "steamed tea" contains "tea" at index 1 (no)
 * and index 8 (yes), and that row must still match.
 */
function containsWordStart(haystack, needle) {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (at === 0 || !WORD_CHAR.test(haystack[at - 1])) return true;
    from = at + 1;
  }
}

// matchToCatalogue's floor, and the LOWEST a row can score while still being in
// the alias-word tier at all - not the tier's nominal value. Each tier deducts
// up to 99 for name length, so the bottom of a tier is TIER_X - 99, and a floor
// set to the tier value itself would reject every alias-word match against a
// name longer than a few characters while accepting them against a short one.
// That would make the photo path's behaviour depend on how long a food's name
// happens to be.
//
// The meaning is unchanged: "dal" cannot be satisfied by "Dalia", because that
// scores 0 (see the short-query rule below), not because it lost to length.
const MAX_LENGTH_DEDUCTION = 99;
export const MIN_MATCH_SCORE = TIER_ALIAS_WORD - MAX_LENGTH_DEDUCTION;

/**
 * Scores a catalogue row against a query string.
 *
 * Exact name, then name prefix, then exact alias, then name word-start, then
 * alias word-start. Within each tier the SHORTEST name wins - a longer name
 * containing the query is a more specific dish, and matching a general name
 * against it is how "rice" becomes a plate of biryani.
 *
 * A query of two characters or fewer scores 0 at the word tiers. A two-letter
 * query against a few hundred rows matches a large slice of the catalogue, and
 * the picker then shows the user a wall of near-nonsense in alphabetical order
 * - the case where ordering cannot save the result. Exact name and exact alias
 * still match at that length: refusing to find a food because its name is two
 * letters long would be cleverness in the wrong direction.
 */
export function scoreMatch(food, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;

  const name = String(food.name || '').trim().toLowerCase();
  const aliases = (food.aliases || []).map((a) => String(a).trim().toLowerCase());

  if (name === q) return TIER_EXACT;

  const shortQuery = q.length >= 3;
  if (shortQuery) {
    // The deduction is what orders rows WITHIN a tier - a shorter name is a more
    // general dish, so "rice" should reach "Rice, cooked" before "Rice and
    // lentils with brown basmati". It is capped so no name can deduct enough to
    // drop itself into the tier below, which would let "Fried chicken katsu
    // with..." outrank a plain prefix match on a short name.
    const deduction = Math.min(name.length, MAX_LENGTH_DEDUCTION);

    // Prefix before alias-exact, deliberately - see the note on TIER_PREFIX.
    // Checking alias-exact first is the obvious order and it is wrong: "rice" is
    // an alias of both "Rice, cooked" and "Fried rice balls", and if that check
    // ran first the two rows would tie at the alias tier and fall through to
    // alphabetical, putting "Curd rice" above plain rice for a user who typed
    // exactly the word on the label.
    if (name.startsWith(q)) return TIER_PREFIX - deduction;
    if (aliases.includes(q)) return TIER_ALIAS_EXACT - deduction;
    if (containsWordStart(name, q)) return TIER_WORD - deduction;
    if (aliases.some((a) => containsWordStart(a, q))) return TIER_ALIAS_WORD - deduction;
  }

  // A one or two character query survives here only as an exact match - which
  // was handled above - or as an exact alias. That last case is real and worth
  // keeping: "id" is not a dish, but a food someone named "PI" or "HK" is a row
  // somebody can find, and refusing to find it because its name is short would
  // be the wrong kind of cleverness.
  if (aliases.includes(q)) return TIER_ALIAS_EXACT;
  return 0;
}

/**
 * Ranks rows best-first for the picker.
 *
 * Rows that scored 0 are dropped. The caller has already narrowed by SQL, so a
 * zero here means the query matched somewhere scoreMatch will not accept - most
 * often a partial word, since "tea" is inside "steamed" but is not a word of it.
 * SQL says "contains", this says "starts a word"; the gap between the two is the
 * false positives the second one exists to reject.
 *
 * Name breaks ties, so the order is stable across calls and a client rendering
 * the list does not reshuffle equal-scoring rows between keystrokes.
 */
export function rankFoods(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  return rows
    .map((food) => ({ food, score: scoreMatch(food, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.food.name || '').localeCompare(String(b.food.name || ''));
    })
    .map((r) => r.food);
}

/**
 * Maps one name onto a single best catalogue row, or null when nothing is
 * close enough.
 *
 * The threshold is a floor on the score, not on similarity. Below it we return
 * null and let the caller report an unmatched name, which is honest - a wrong
 * food in the ledger is worse than a name the user has to look up themselves.
 */
export function matchToCatalogue(foods, proposedName) {
  const best = rankFoods(foods, proposedName)[0];
  if (!best) return null;
  return scoreMatch(best, proposedName) >= MIN_MATCH_SCORE ? best : null;
}

/**
 * The denormalised haystack the SQL prefilter searches.
 *
 * Prisma's `has` on a String[] is an exact array-element match, so a column
 * holding only `aliases` can never satisfy "omlet" or "plain ric". Folding the
 * name and every alias into one lowercased string turns that into an ordinary
 * `contains`, which is what actually needs to happen - and it keeps the search
 * in the database instead of pulling the whole catalogue into Node to filter it
 * there.
 *
 * Derived rather than stored on FoodLog, and recomputed on every write by the
 * seeder, so there is exactly one definition of what belongs in the haystack.
 */
export function buildSearchText(name, aliases) {
  return [String(name || ''), ...(aliases || [])]
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}