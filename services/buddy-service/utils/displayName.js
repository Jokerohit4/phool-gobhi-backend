// How a member's name is shown to people who are not their match: the first
// name and the initial of the last, "Rohit S.", never the surname. Matches
// (who are chatting) and the member themselves still see the full name.
//
// A trailing token with no letter in it (a number, say) is not a surname, so
// it is dropped rather than turned into an "initial".
export function shortName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Buddy';
  if (parts.length === 1) return parts[0];
  const last = [...parts[parts.length - 1]][0];
  if (!/\p{L}/u.test(last)) return parts[0];
  return `${parts[0]} ${last.toLocaleUpperCase()}.`;
}
