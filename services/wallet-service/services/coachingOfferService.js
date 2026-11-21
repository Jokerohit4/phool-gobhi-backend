import { coachingCatalog, coachingOffer, trainerAddonOffer } from './coachingCatalog.js';
import { getCoachingConfig } from './coachingConfigService.js';

export async function loadCoachingCatalog(city) { return coachingCatalog(city, (await getCoachingConfig()).config); }
export async function loadCoachingOffer(product, city, offerId) { return coachingOffer(product, city, offerId, (await getCoachingConfig()).config); }
export async function loadTrainerAddon(offerId) {
  const offer = trainerAddonOffer((await getCoachingConfig()).config);
  if (!offer.available) throw Object.assign(new Error('Trainer add-ons are currently unavailable'), { status: 409 });
  if (offer.offerId !== offerId) throw Object.assign(new Error('The add-on changed. Refresh before checkout.'), { status: 409 });
  return offer;
}
