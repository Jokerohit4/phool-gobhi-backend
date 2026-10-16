import { getOnLayerKeys } from './layerState.js';
import { generatePlan } from '../ledger/planGenerator.js';
import { currentNutritionTarget } from '../ledger/currentTarget.js';
import { DECIMAL_PLACES, roundTo, MAX_ACTIVE_PLAN_ITEMS } from '../ledger/constants.js';
import { track } from '../../utils/analytics.js';

// Plan rebuild — the ONE place suggested rows are (re)written.
//
// rebuildPlan(prisma, userId, {reason}) is called from every trigger the
// Contracts list (journey start, unlock, consent, food setup, settings/slot
// edits, supplement schedule changes, the data script) and nowhere else. It
// is a pure diff: load the current suggested rows, generate the desired set
// from the on-layer keys + current targets/slots/schedules, create what is
// new, update what drifted (title/targetValue only — stable ids via the
// (kind, layerKey, schedule, sourceRef) key), deactivate what a now-off
// layer produced. User and doctor rows are never touched.
//
// Rebuild is idempotent: a second call with the same inputs writes nothing.
// Ticks survive because updates never touch completions and matching keeps
// the row's id.
//
// The `reason` is only an analytics label; it does not change the diff.

// The stable-identity key. sourceRef is '' rather than null so a missing
// sourceRef and an empty one are the same slot, not two.
function keyOf(row) {
  return [row.kind, row.layerKey ?? '', row.schedule, row.sourceRef ?? ''].join('|');
}

export async function rebuildPlan(prisma, userId, { reason } = {}) {
  // 1. Which layers are on (includes 'own', and 'medicine' on consent).
  const onLayerKeys = await getOnLayerKeys(prisma, userId);

  // 2. Current inputs: the newest NutritionTarget (may be null), the
  // Prescription (slots/steps/sleep), and the active supplement schedules
  // only when the supplements layer is on.
  const [target, prescription] = await Promise.all([
    currentNutritionTarget(prisma, userId),
    prisma.prescription.findUnique({ where: { userId } }),
  ]);
  const supplements = onLayerKeys.includes('supplements')
    ? await prisma.supplementSchedule.findMany({ where: { userId, active: true }, orderBy: { name: 'asc' } })
    : null;

  // 3. The desired suggested rows.
  const targets = target
    ? {
        kcal: Number(target.kcal),
        proteinG: Number(target.proteinG),
        carbsG: Number(target.carbsG),
        fatG: Number(target.fatG),
        fibreG: Number(target.fibreG),
        waterMl: Number(target.waterMl),
      }
    : null;
  const { items: desired } = generatePlan({
    onLayerKeys,
    targets,
    workoutSlots: prescription?.workoutSlots ?? null,
    stepsPerDay: prescription?.stepsPerDay ?? null,
    sleepMinutes: prescription?.sleepMinutes ?? null,
    supplements,
  });

  // The room cap. Live user/doctor rows count against MAX_ACTIVE_PLAN_ITEMS;
  // the generator's own target (≤8) plus their rows must never exceed it, so
  // desired is sliced to what is free before the diff. The generator's 8 is
  // well under 20, so this is defensive — it binds only when the user has
  // hand-built a large plan of their own.
  const userDoctorCount = await prisma.planItem.count({
    where: { userId, origin: { in: ['user', 'doctor'] }, active: true },
  });
  const room = Math.max(0, MAX_ACTIVE_PLAN_ITEMS - userDoctorCount);
  const capped = desired.slice(0, room);
  const desiredKeys = new Set(capped.map(keyOf));

  // 4. Diff against the existing suggested rows. User/doctor rows are
  // excluded from the query — not merely filtered afterwards — so a
  // malformed origin on a user row can never make it look deactivate-able.
  const existing = await prisma.planItem.findMany({
    where: { userId, origin: 'suggested', active: true },
    orderBy: { id: 'asc' },
  });
  const existingByKey = new Map(existing.map((row) => [keyOf(row), row]));

  const toCreate = [];
  const toUpdate = [];
  for (const item of capped) {
    const match = existingByKey.get(keyOf(item));
    if (!match) {
      toCreate.push(item);
      continue;
    }
    // Update only when the display actually drifted. targetValue compares
    // numerically because the DB hands back a Decimal.
    const titleDiffers = match.title !== item.title;
    const targetDiffers =
      (item.targetValue == null) !== (match.targetValue == null) ||
      (item.targetValue != null && Number(item.targetValue) !== Number(match.targetValue));
    if (titleDiffers || targetDiffers) {
      toUpdate.push({
        id: match.id,
        title: item.title,
        targetValue:
          item.targetValue == null ? null : roundTo(Number(item.targetValue), DECIMAL_PLACES.nutrients),
      });
    }
  }

  // Existing rows whose key has no capped twin: the layer turned off, the
  // schedule vanished, the slot was removed. Deactivate (never delete) so a
  // later unlock can restore matching by key, and history stays readable.
  const toDeactivate = existing.filter((row) => !desiredKeys.has(keyOf(row)));

  // 5. Apply the diff in one transaction. Only called when there is
  // something to do, so an already-current plan performs zero writes.
  let created = 0;
  let updated = 0;
  let deactivated = 0;
  if (toCreate.length || toUpdate.length || toDeactivate.length) {
    await prisma.$transaction(async (tx) => {
      for (const item of toCreate) {
        await tx.planItem.create({
          data: {
            userId,
            kind: item.kind,
            title: item.title,
            schedule: item.schedule,
            origin: 'suggested',
            autoGenerated: true,
            layerKey: item.layerKey ?? null,
            nutrientKey: item.nutrientKey ?? null,
            targetValue:
              item.targetValue == null ? null : roundTo(Number(item.targetValue), DECIMAL_PLACES.nutrients),
            sourceRef: item.sourceRef ?? null,
            active: true,
          },
        });
        created += 1;
      }
      for (const row of toUpdate) {
        await tx.planItem.update({
          where: { id: row.id },
          data: { title: row.title, targetValue: row.targetValue },
        });
        updated += 1;
      }
      for (const row of toDeactivate) {
        await tx.planItem.update({ where: { id: row.id }, data: { active: false } });
        deactivated += 1;
      }
    });
  }

  // 6. Analytics, after the write and fire-and-forget. plan_built always
  // fires (a "nothing changed" rebuild is still a rebuild someone triggered);
  // layer_turned_on fires only for on-layers that had no active suggested
  // rows before this run.
  const layersWithRowsBefore = new Set(existing.map((row) => row.layerKey).filter(Boolean));
  track('plan_built', userId, {
    reason,
    on_layers: onLayerKeys,
    created,
    updated,
    deactivated,
  });
  const onLayerSet = new Set(onLayerKeys);
  for (const layerKey of new Set(capped.map((item) => item.layerKey).filter(Boolean))) {
    if (onLayerSet.has(layerKey) && !layersWithRowsBefore.has(layerKey)) {
      track('layer_turned_on', userId, { layer: layerKey, reason });
    }
  }

  return { created, updated, deactivated, onLayerKeys };
}
