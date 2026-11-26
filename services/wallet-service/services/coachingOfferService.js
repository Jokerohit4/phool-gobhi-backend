import { coachingCatalog, coachingCatalogV2, coachingOffer, trainerAddonOffer } from './coachingCatalog.js';
import { getCoachingConfig } from './coachingConfigService.js';

export async function loadCoachingCatalog(city) { return coachingCatalog(city, (await getCoachingConfig()).config); }
export async function loadCoachingCatalogV2(city) { return coachingCatalogV2(city, (await getCoachingConfig()).config); }
export async function loadCoachingOfferV2(key, city, offerId) {
  const catalog = await loadCoachingCatalogV2(city);
  const item = catalog.offers.find(offer => offer.key === key) ?? catalog.addons.find(addon => addon.key === key);
  if (!item) throw Object.assign(new Error('This offer is unavailable in your region'), { status: 409 });
  if (item.offerId !== offerId) throw Object.assign(new Error('The offer changed. Refresh before checkout.'), { status: 409 });
  return item;
}
export async function loadCoachingOffer(product, city, offerId) { return coachingOffer(product, city, offerId, (await getCoachingConfig()).config); }
export async function loadTrainerAddon(offerId) {
  const offer = trainerAddonOffer((await getCoachingConfig()).config);
  if (!offer.available) throw Object.assign(new Error('Trainer add-ons are currently unavailable'), { status: 409 });
  if (offer.offerId !== offerId) throw Object.assign(new Error('The add-on changed. Refresh before checkout.'), { status: 409 });
  return offer;
}
