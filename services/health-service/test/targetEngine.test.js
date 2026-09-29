import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTargets, bmr, goalAdjustmentKcal, maxDeficitKcal, bandForMeasuredBurn } from '../services/ledger/targetEngine.js';
import {
  SAFETY,
  POINTS,
  DAILY_MAX_GAIN,
  DAILY_MAX_LOSS,
  microAllowances,
} from '../services/ledger/constants.js';

const MALE_29 = { weightKg: 70, heightCm: 175, age: 29, sex: 'male', activity: 'moderate' };

// --- The medical line ------------------------------------------------------
//
// These are the tests that matter most in this file. Everything else here
// checks arithmetic; these check that the feature stays on the right side of
// a regulatory line, and they are written to fail loudly if someone later adds
// a convenient shortcut.

test('a goal type cannot raise a nutrient above the RDA table', () => {
  // Every goal, every sex, every age band: the micronutrient targets must be
  // byte-identical for a given (sex, age). If a condition or a goal could
  // influence them, this is where it would show up.
  const goals = ['build_muscle', 'lose_fat', 'gain_weight', 'endurance', 'general_health', 'doctor_plan'];
  const bySexAndAge = new Map();

  for (const sex of ['male', 'female', 'other']) {
    for (const age of [22, 40, 60]) {
      for (const goal of goals) {
        const r = computeTargets(goal, { ...MALE_29, sex, age });
        assert.ok(r.ok);
        const key = `${sex}/${age}`;
        const micros = JSON.stringify(r.targets.micros);
        if (bySexAndAge.has(key)) {
          assert.equal(
            micros,
            bySexAndAge.get(key),
            `${key}: goal "${goal}" changed the micronutrient targets`,
          );
        } else {
          bySexAndAge.set(key, micros);
        }
      }
    }
  }

  // Sanity on the shape of the table itself: male and other share bands, and
  // the only thing that separates the male 19-50 band from the 51+ band is
  // calcium. If this count ever changes, the RDA table changed and the
  // "never a therapeutic level" test above needs re-reading.
  assert.equal(bySexAndAge.size, 9, 'one entry per (sex, age) pair');
  assert.equal(microAllowances('male', 60).calcium, 1200);
  assert.equal(microAllowances('male', 30).calcium, 1000);
});

test('there is no therapeutic micronutrient value anywhere in the table', () => {
  // A "therapeutic" variant would show up here as a number above the RDA.
  // The iron RDA for menstruating women (29 mg) is the highest in the table
  // and it is a POPULATION allowance, not a dose.
  const f = microAllowances('female', 25);
  assert.equal(f.iron, 29);
  assert.equal(f.magnesium, 360);
  assert.equal(f.calcium, 1000);
  assert.equal(f.zinc, 13);

  // No value anywhere exceeds the highest RDA by more than rounding, which is
  // the property that makes "we never recommend a dose" mechanically true.
  const all = [];
  for (const sex of ['male', 'female', 'other']) {
    for (const band of [25, 40, 60]) all.push(...Object.values(microAllowances(sex, band)));
  }
  assert.ok(Math.max(...all) <= 1200, 'no micronutrient target exceeds an RDA ceiling');
});

// --- The eating-disorder guard --------------------------------------------

test('a fat-loss target never drops below BMR', () => {
  // A small, sedentary person asking for the most aggressive cut the formula
  // offers. This is the case the guard exists for.
  const r = computeTargets('lose_fat', { weightKg: 42, heightCm: 150, age: 24, sex: 'female', activity: 'sedentary' });
  assert.ok(r.ok);
  const b = bmr({ weightKg: 42, heightCm: 150, age: 24, sex: 'female' });
  assert.ok(r.targets.kcal >= Math.round(b), `kcal ${r.targets.kcal} must be >= BMR ${Math.round(b)}`);
  // The ABSOLUTE floor is what binds here, not BMR: her BMR is ~1077 and the
  // female floor is 1200, so 1200 is the number that actually stopped it.
  // Both floors were applied — the binding one is just the higher.
  assert.equal(r.inputs.kcalFloorReason, 'absolute_floor');
  assert.equal(r.inputs.kcalFloorApplied, SAFETY.kcalFloorFemale);
});

test('BMR itself is the binding floor when it is higher than the sex floor', () => {
  // A tall, heavy man: BMR clears 1500 comfortably, so the floor that stops a
  // crash diet is his own BMR and nothing else.
  const r = computeTargets('lose_fat', { weightKg: 95, heightCm: 190, age: 40, sex: 'male', activity: 'sedentary' });
  const b = Math.round(bmr({ weightKg: 95, heightCm: 190, age: 40, sex: 'male' }));
  assert.ok(b > SAFETY.kcalFloorMale, `precondition: BMR ${b} must exceed the male floor`);
  assert.equal(r.inputs.kcalFloorReason, 'bmr');
  assert.equal(r.inputs.kcalFloorApplied, b);
});

test('the absolute floor binds when BMR is lower than it', () => {
  // BMR here is well under 1200, so the sex floor is what stops it.
  const r = computeTargets('lose_fat', { weightKg: 40, heightCm: 145, age: 22, sex: 'female', activity: 'sedentary' });
  assert.ok(r.targets.kcal >= SAFETY.kcalFloorFemale);
  assert.equal(r.inputs.kcalFloorReason, 'absolute_floor');
});

test('no goal can produce a target faster than 0.75 kg/week', () => {
  // The weight range deliberately runs well past the point where the
  // proportional 1%-of-body-weight bound stops being the tighter one. The
  // original test stopped at 130 kg, which is below the ~143 kg crossover, so
  // it never exercised the case that was actually broken.
  for (const weightKg of [42, 55, 70, 95, 130, 143, 150, 200, 250, 300]) {
    for (const sex of ['female', 'male']) {
      const r = computeTargets('lose_fat', { ...MALE_29, weightKg, sex });
      const actualDeficit = r.inputs.maintenanceKcal - r.targets.kcal;
      // 7700 kcal per kg of body fat, per week.
      const kgPerWeek = (actualDeficit * 7) / 7700;
      assert.ok(
        kgPerWeek <= SAFETY.maxWeeklyLossKg + 0.01,
        `${weightKg} kg ${sex}: ${kgPerWeek.toFixed(2)} kg/week exceeds the cap`,
      );
    }
  }
});

test('the loss ceiling is a real 0.75 kg/week at every weight', () => {
  // The direct assertion. The bounds cross at 0.75 / 0.01 = 75 kg: below it the
  // 1%-of-body-weight rule is tighter, above it the absolute 0.75 kg/week rule
  // is. Either way the realised rate must never exceed the number the intake
  // screen states out loud.
  //
  // This is the case the old formula got wrong. It computed
  // 0.75 x weightKg x 7700, which is a fraction of body weight wearing the
  // name of an absolute limit — under the cap at 130 kg, but 1.05 kg/week at
  // 200 kg and 1.31 at 250 kg. No test caught it because the only goal that
  // asks for a deficit asks for -400, which is below the ceiling for every
  // adult above ~36 kg, so the wrong value was never actually used.
  for (const weightKg of [30, 42, 55, 75, 95, 130, 143, 200, 250, 300]) {
    const ceiling = maxDeficitKcal(weightKg);
    const kgPerWeek = (ceiling.value * 7) / 7700;
    assert.ok(
      kgPerWeek <= SAFETY.maxWeeklyLossKg + 1e-9,
      `${weightKg} kg: ceiling implies ${kgPerWeek.toFixed(3)} kg/week`,
    );
  }

  // And each bound is named correctly on its own side of the crossover.
  assert.equal(maxDeficitKcal(30).rule, 'max_weekly_loss_pct_body_weight');
  assert.equal(maxDeficitKcal(75).rule, 'max_weekly_loss_pct_body_weight');
  assert.equal(maxDeficitKcal(76).rule, 'max_weekly_loss_0.75kg');
  assert.equal(maxDeficitKcal(300).rule, 'max_weekly_loss_0.75kg');
});

test('neither bound steals the adjustment from an ordinary adult', () => {
  // Guards the opposite failure: "fixing" the 200 kg bug by over-tightening the
  // ceiling would silently under-serve every normal user, and that is harder to
  // notice because nobody complains about a smaller deficit.
  for (const weightKg of [42, 55, 70, 100, 250, 300]) {
    assert.equal(
      goalAdjustmentKcal('lose_fat', weightKg).value,
      -400,
      `${weightKg} kg should get the full -400`,
    );
  }
});

test('a light user is protected by the kcal floor, not by the loss cap', () => {
  // Worth stating explicitly because the previous test claimed the kg/week cap
  // was what protected a 42 kg woman. It was not: 1% of 42 kg allows 462
  // kcal/day, so -400 passed through unclamped. What actually bound was the
  // 1200 kcal floor, which is the real protection and is reported as such.
  const r = computeTargets('lose_fat', {
    weightKg: 42, heightCm: 150, age: 24, sex: 'female', activity: 'light',
  });
  assert.equal(r.inputs.goalAdjustmentKcal, -400);
  assert.equal(r.inputs.clampedBy, undefined);
  assert.equal(r.inputs.kcalFloorApplied, SAFETY.kcalFloorFemale);
  assert.equal(r.inputs.kcalFloorReason, 'absolute_floor');
  // And the realised rate is well inside the cap, because the floor raised it.
  const kgPerWeek = ((r.inputs.maintenanceKcal - r.targets.kcal) * 7) / 7700;
  assert.ok(kgPerWeek <= SAFETY.maxWeeklyLossKg, kgPerWeek.toFixed(3));
});

test('a clamp is reported rather than silent, and names its bound', () => {
  // A 30 kg adult asking for the nominal -400 kcal. The 1%-of-body-weight rule
  // allows 330, so the clamp binds and the response has to SAY SO — a target
  // that quietly differs from the formula is worse than one that explains
  // itself, because the intake screen promises a stated safe pace.
  //
  // The bound named has to be the one that actually applied. Labeling the
  // proportional clamp as the 0.75 kg/week cap would tell the user their
  // target was limited by a rule that was not the one doing the limiting.
  const r = computeTargets('lose_fat', { weightKg: 30, heightCm: 140, age: 22, sex: 'female', activity: 'light' });
  assert.equal(r.inputs.clampedBy, 'max_weekly_loss_pct_body_weight');
  assert.equal(r.inputs.clampedFromKcal, -400);
  // Weaker in magnitude than asked for, and never stronger.
  assert.ok(r.inputs.goalAdjustmentKcal > -400);
  assert.ok(r.inputs.goalAdjustmentKcal < 0);
  // And the realised loss rate is inside the cap.
  const kgPerWeek = ((r.inputs.maintenanceKcal - r.targets.kcal) * 7) / 7700;
  assert.ok(kgPerWeek <= SAFETY.maxWeeklyLossKg + 0.01, `${kgPerWeek.toFixed(2)} kg/week`);
});

test('a large person asking for a fat loss is NOT clamped', () => {
  // The clamp is a guard, not a blanket. A 95 kg man can safely take the full
  // -400, and silently giving him less would be the engine under-serving him.
  const r = computeTargets('lose_fat', { weightKg: 95, heightCm: 180, age: 35, sex: 'male', activity: 'light' });
  assert.equal(r.inputs.clampedBy, undefined);
  assert.equal(r.inputs.goalAdjustmentKcal, -400);
});

test('macros always sum back to the calorie target', () => {
  // A target whose macros do not add up to its own headline number is a lie
  // the user can check in five seconds.
  for (const goal of ['build_muscle', 'lose_fat', 'gain_weight', 'endurance', 'general_health', 'doctor_plan']) {
    for (const sex of ['male', 'female']) {
      const r = computeTargets(goal, { ...MALE_29, sex });
      const sum = r.targets.proteinG * 4 + r.targets.carbsG * 4 + r.targets.fatG * 9;
      assert.ok(
        Math.abs(sum - r.targets.kcal) <= 15,
        `${goal}/${sex}: macros sum to ${sum} vs kcal ${r.targets.kcal}`,
      );
    }
  }
});

test('carbohydrate target is never negative', () => {
  // A very heavy, very short person on a high-protein target: protein + fat
  // can exceed the calories outright. The engine must rebalance rather than
  // print a negative.
  const r = computeTargets('build_muscle', { weightKg: 140, heightCm: 160, age: 30, sex: 'male', activity: 'sedentary' });
  assert.ok(r.targets.carbsG >= 0);
  assert.ok(r.targets.fatG >= 0);
});

// --- Ordinary arithmetic ---------------------------------------------------

test("the plan's own worked example reproduces", () => {
  // From phool-gobhi-health-ledger-plan-20260927.html §8, "Muscular at the
  // same 70 kg": male, 29, 175 cm, 4 workouts/week. BMR ~1670, daily burn
  // ~2590, and the goal is RECOMPOSITION at ~2500 kcal, protein 133 g (1.9
  // g/kg), fat 78 g (28%), carbs ~300 g, magnesium 440, zinc 17.
  //
  // The goal matters: `recomp` carries a -100..0 adjustment, so a recomposing
  // 70 kg man is told to hold near maintenance. Testing this against
  // `build_muscle` would assert a ~2,760 kcal surplus against a 2,500 kcal
  // figure and look like an engine bug when it is a spec mismatch.
  //
  // The doc's BMR and burn are ~1% high against a straight Mifflin-St Jeor
  // (which gives 1654 and 2564). It says "≈" in both places, so the tolerance
  // is 20 kcal rather than exact — these are the doc's worked illustration,
  // not a spec, and pinning a test to a figure the doc itself rounded loosely
  // would make the test the thing that is wrong.
  const b = bmr({ weightKg: 70, heightCm: 175, age: 29, sex: 'male' });
  assert.ok(Math.abs(b - 1670) <= 20, `BMR ${b.toFixed(0)} should be ~1670`);

  const maintenance = b * 1.55;
  assert.ok(Math.abs(maintenance - 2590) <= 30, `maintenance ${maintenance.toFixed(0)} should be ~2590`);

  const r = computeTargets('recomp', { ...MALE_29 });
  assert.ok(r.ok);

  // ~2500 kcal: a small deficit off 2563 maintenance, matching the -50 the
  // engine takes as the midpoint of recomp's -100..0 range.
  assert.ok(Math.abs(r.targets.kcal - 2500) <= 25, `kcal ${r.targets.kcal} should be ~2500`);
  // Protein 1.9 g/kg at the midpoint of recomp's 1.8-2.0.
  assert.equal(r.targets.proteinG, 133);
  // Fat is the midpoint of 25-30% of the target.
  assert.ok(Math.abs(r.targets.fatG - 78) <= 6, `fat ${r.targets.fatG} should be ~78`);
  // Carbs take the remainder and land in the doc's ~300 g range.
  assert.ok(r.targets.carbsG > 260 && r.targets.carbsG < 330, `carbs ${r.targets.carbsG} should be ~300`);
  // The doc's micronutrient figures for this exact persona.
  assert.deepEqual(r.targets.micros, { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 });
  // Fibre: 14 g per 1,000 kcal. British spelling throughout, matching the
  // ICMR-NIN source and the NutritionTarget column.
  assert.equal(r.targets.fibreG, 35);
});

test('water is 35 ml/kg, plus a separate workout addend', () => {
  // The doc §7 gives the METHOD (35 ml/kg, plus workout days) and §8 gives
  // one instance of it ("water 3.2 L"). The method is the spec; the instance
  // does not reconcile with it — 35 x 70 is 2450, and 3.2 L would need a
  // 750 ml addend. 500 ml is kept because it is a defensible standard
  // addend and because the doc describes the addend as "small"; fitting a
  // constant to one illustrative number would be the same error as pinning
  // the calorie target to the doc's rounded BMR.
  const rest = computeTargets('recomp', { ...MALE_29 });
  assert.equal(rest.targets.waterMl, 2450);

  const workout = computeTargets('recomp', { ...MALE_29, hasWorkoutToday: true });
  assert.equal(workout.targets.waterMl, 2950);

  // The addend must be visible in the inputs so the UI can answer "why is my
  // water target higher today" with a number rather than a shrug.
  assert.equal(rest.inputs.waterAddend, 0);
  assert.equal(workout.inputs.waterAddend, 500);
  assert.equal(workout.inputs.hasWorkoutToday, true);
});

test('recomposition never gets a surplus, and muscle gain always does', () => {
  // The two are easy to conflate because both are "get more muscle", and
  // conflating them tells someone whose weight is meant to hold still to eat
  // several hundred extra calories. Asserted as a property across the whole
  // input space rather than for one persona.
  for (const weightKg of [50, 70, 100]) {
    for (const activity of ['sedentary', 'moderate', 'very_active']) {
      const base = { weightKg, heightCm: 175, age: 30, sex: 'male', activity };
      const recomposition = computeTargets('recomp', base);
      const muscle = computeTargets('build_muscle', base);

      assert.ok(recomposition.ok && muscle.ok);
      assert.ok(
        recomposition.targets.kcal <= Math.round(muscle.inputs.maintenanceKcal) + 1,
        `${weightKg}kg/${activity}: recomp ${recomposition.targets.kcal} must not exceed maintenance`,
      );
      assert.ok(
        muscle.targets.kcal > recomposition.targets.kcal,
        `${weightKg}kg/${activity}: muscle ${muscle.targets.kcal} must exceed recomp ${recomposition.targets.kcal}`,
      );
    }
  }
});

test('a missing input yields no target rather than a guessed one', () => {
  const r = computeTargets('build_muscle', { weightKg: 70, heightCm: null, age: 29, sex: 'male', activity: 'moderate' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['height']);
  assert.equal(r.targets, null);
});

test('every missing field is reported at once, not one at a time', () => {
  // The intake screen asks only for what is missing. If this returned just
  // the first one, the user would have to walk back through setup four times.
  const r = computeTargets('build_muscle', { weightKg: null, heightCm: null, age: null, sex: null, activity: null });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 5);
});

test('an out-of-range age is rejected rather than clamped', () => {
  // Clamping 8 to 19 would produce a plausible-looking adult target for a
  // child, which is the one input where being wrong matters most.
  const r = computeTargets('build_muscle', { ...MALE_29, age: 8 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['age']);
});

test('measured activity picks a band and the guess picks the same vocabulary', () => {
  assert.equal(bandForMeasuredBurn(800, 3), 'very_active');
  assert.equal(bandForMeasuredBurn(450, 3), 'moderate');
  assert.equal(bandForMeasuredBurn(200, 2), 'light');
  assert.equal(bandForMeasuredBurn(50, 1), 'sedentary');
  assert.equal(bandForMeasuredBurn(null, 3), null);
});

test('session count cannot override an implausibly low burn', () => {
  // Regression. The band was `burn >= 750 || sessions >= 6`, so six very short
  // sessions a week — 10 kcal of active burn per day — read as "very active"
  // and raised the activity multiplier on a target that then overshot badly.
  // Frequency is a tiebreaker between neighbouring bands, not an override.
  assert.equal(bandForMeasuredBurn(10, 30), 'sedentary');
  assert.equal(bandForMeasuredBurn(10, 6), 'sedentary');
  assert.equal(bandForMeasuredBurn(100, 7), 'sedentary');
  // Burn in the moderate band is where frequency legitimately decides.
  assert.equal(bandForMeasuredBurn(450, 3), 'moderate');
  assert.equal(bandForMeasuredBurn(450, 5), 'very_active');
  // Above the top threshold, frequency is irrelevant.
  assert.equal(bandForMeasuredBurn(900, 0), 'very_active');
  // Nonsense input is not a band.
  assert.equal(bandForMeasuredBurn(-5, 3), null);
  assert.equal(bandForMeasuredBurn(Number.NaN, 3), null);
});

// --- Constants that are load-bearing ---------------------------------------

test('the daily caps are asymmetric, and that asymmetry is intentional', () => {
  // A good day should be able to out-earn a bad day, or the chart spends its
  // life below the line and reads as punishment.
  assert.ok(DAILY_MAX_GAIN > Math.abs(DAILY_MAX_LOSS));
});

test('under-eating and over-eating cost exactly the same', () => {
  // Asserted as an equality of the single constant rather than two
  // comparisons, because this is the invariant most likely to be broken by a
  // well-meaning "but undereating is worse!" change.
  assert.equal(POINTS.caloriesOffTarget, -8);
});

