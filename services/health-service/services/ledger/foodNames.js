// Exact food-name aliases only: never replace fragments inside dish names.
const groups = [
  ['clove','cloves','laung','lavang','\u0932\u094c\u0902\u0917'],
  ['cumin','jeera','jira','\u091c\u0940\u0930\u093e'],
  ['turmeric','haldi','\u0939\u0932\u094d\u0926\u0940'],
  ['cinnamon','dalchini','\u0926\u093e\u0932\u091a\u0940\u0928\u0940'],
  ['ginger','adrak','\u0905\u0926\u0930\u0915'],
  ['asafoetida','hing','heeng','\u0939\u0940\u0902\u0917'],
  ['carom seeds','ajwain','\u0905\u091c\u0935\u093e\u0907\u0928'],
];
export const normalizeFoodName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export function foodQueryTerms(value) {
 const q=normalizeFoodName(value);
 const group=groups.find(names=>names.includes(q));
 return group ? [q,...group.filter(name=>name!==q)] : [q];
}
export function canonicalFoodName(value) {
 const q=normalizeFoodName(value);
 return groups.find(names=>names.includes(q))?.[0] || q;
}

// "Garlic cloves" is not the spice clove. Known aliases must match a food
// label/complete alias, rather than an incidental word in another food's alias.
export function matchesFoodAlias(food, query) {
 const terms=foodQueryTerms(query);
 if(terms.length===1)return true;
 const name=normalizeFoodName(food.name);
 const aliases=(food.aliases||[]).map(normalizeFoodName);
 const canonical=canonicalFoodName(query);
 return terms.some(term=>name===term || name.startsWith(term+',') || name.startsWith(term+' (') || aliases.includes(term)) ||
   name.startsWith(canonical+' ') || ['whole ','ground ','dried ','powdered '].some(prefix=>terms.includes(name.slice(prefix.length)) && name.startsWith(prefix));
}
