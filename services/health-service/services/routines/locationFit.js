// Where a catalogue routine can be done, derived from the equipment of its main
// exercises rather than from exercise names. (The customer app used to decide
// this with a name regex in core/utils/starter_equipment.dart; the library's
// own Exercise.equipment is the single source now, the same one `equipmentFit`
// reads for the home-setup badge.)
//
// Only main rows count: a warm-up march or a cool-down stretch never makes a
// routine "need a gym".
import { EXERCISE_EQUIPMENT_NEEDS } from '../homeSetup.js';

const GYM_NEEDS = new Set(['full_home_gym']);

/**
 * template.exercises[] rows carry the nested `exercise` ({ equipment }).
 * Returns:
 *   equipmentNeeded  distinct home-equipment needs of the main work
 *                    (dumbbells | kettlebell | full_home_gym), sorted
 *   needsGym         a barbell, cable or machine is required
 *   isHomeRoutine    needs nothing but a body and floor: no gym, no weights,
 *                    not a mobility session, and not only outdoor moves
 */
export function locationFit(template) {
  const main = (template?.exercises ?? []).filter((e) => (e.phase ?? 'main') === 'main');
  const needs = new Set();
  let onlyOutdoor = main.length > 0;
  for (const row of main) {
    const equipment = row.exercise?.equipment;
    const need = EXERCISE_EQUIPMENT_NEEDS[equipment] ?? null;
    if (need) needs.add(need);
    // Equipment 'other' is the outdoor / open-space moves (walk, jog, cycle).
    if (equipment !== 'other') onlyOutdoor = false;
  }
  const needsGym = [...needs].some((n) => GYM_NEEDS.has(n));
  const isHomeRoutine = needs.size === 0 && template?.goal !== 'mobility' && !onlyOutdoor;
  return { equipmentNeeded: [...needs].sort(), needsGym, isHomeRoutine };
}
