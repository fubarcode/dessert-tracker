/* db.js — IndexedDB via Dexie (v0: local-first) */

const DB_NAME = "dessert_tracker_v0";
const DB_VERSION = 1;

const db = new Dexie(DB_NAME);

db.version(DB_VERSION).stores({
  dessertTypes: "id, nameLower, archived, createdAt",
  places: "id, nameLower, archived, createdAt",
  items: "id, [dessertTypeId+placeId], archived, createdAt",
  wishlist: "id, itemId, archived, createdAt",
  tastings: "id, itemId, date, archived, createdAt",
  photos: "id, createdAt"
});

/** Utility */
function nowIso() { return new Date().toISOString(); }
function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function normalizeName(str) {
  return (str || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
function assertNonEmpty(str, label) {
  if (!str || !String(str).trim()) throw new Error(`${label} is required`);
}

async function getByNameLower(table, nameLower) {
  return db[table].where("nameLower").equals(nameLower).first();
}

async function upsertTimestamps(existing, patch = {}) {
  const ts = nowIso();
  if (!existing) return { ...patch, createdAt: ts, updatedAt: ts };
  return { ...existing, ...patch, updatedAt: ts };
}

/** Dessert Types */
async function getOrCreateDessertType(name) {
  assertNonEmpty(name, "Dessert type");
  const nameLower = normalizeName(name);
  let dt = await getByNameLower("dessertTypes", nameLower);
  if (dt) {
    // If user typed different casing, keep original name but allow updating to latest display
    const updated = await upsertTimestamps(dt, { name: name.trim(), nameLower });
    await db.dessertTypes.put(updated);
    return updated;
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  dt = { id, name: name.trim(), nameLower, archived: false, createdAt: ts, updatedAt: ts };
  await db.dessertTypes.add(dt);
  return dt;
}

/** Places */
async function getOrCreatePlace(name, mapsUrlOptional = "") {
  assertNonEmpty(name, "Place");
  const nameLower = normalizeName(name);
  let place = await getByNameLower("places", nameLower);
  const mapsUrl = (mapsUrlOptional || "").trim() || undefined;

  if (place) {
    const patch = { name: name.trim(), nameLower };
    // Only update mapsUrl if provided (don’t overwrite existing with blank)
    if (mapsUrl) patch.mapsUrl = mapsUrl;
    const updated = await upsertTimestamps(place, patch);
    await db.places.put(updated);
    return updated;
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  place = {
    id,
    name: name.trim(),
    nameLower,
    mapsUrl,
    archived: false,
    createdAt: ts,
    updatedAt: ts
  };
  await db.places.add(place);
  return place;
}

/** Items (Dessert@Place), unique-ish by (dessertTypeId, placeId) */
async function getOrCreateItem(dessertTypeId, placeId) {
  if (!dessertTypeId || !placeId) throw new Error("Item requires dessertTypeId and placeId");

  // Enforce logical uniqueness via compound index
  const existing = await db.items.where("[dessertTypeId+placeId]").equals([dessertTypeId, placeId]).first();
  if (existing) {
    // Unarchive if it exists but is archived
    if (existing.archived) {
      await db.items.update(existing.id, { archived: false, archivedAt: undefined, updatedAt: nowIso() });
      return await db.items.get(existing.id);
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  const item = { id, dessertTypeId, placeId, archived: false, createdAt: ts, updatedAt: ts };
  await db.items.add(item);
  return item;
}

/** Wishlist */
async function createWishlistEntry(itemId) {
  if (!itemId) throw new Error("Wishlist entry requires itemId");
  const id = crypto.randomUUID();
  const ts = nowIso();
  const row = { id, itemId, archived: false, createdAt: ts, updatedAt: ts };
  await db.wishlist.add(row);
  return row;
}
async function updateWishlistEntry(id, patch) {
  const existing = await db.wishlist.get(id);
  if (!existing) throw new Error("Wishlist entry not found");
  const updated = await upsertTimestamps(existing, patch);
  await db.wishlist.put(updated);
  return updated;
}

/** Photos */
async function createPhoto(blob, mime = "image/jpeg") {
  if (!blob) throw new Error("Photo blob required");
  const id = crypto.randomUUID();
  const ts = nowIso();
  await db.photos.add({ id, blob, mime, createdAt: ts });
  return { id, mime };
}
async function deletePhoto(photoId) {
  if (!photoId) return;
  await db.photos.delete(photoId);
}

/** Tastings */
function clampRating(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n < 1 || n > 5 || Math.floor(n) !== n) throw new Error("Rating must be an integer 1–5");
  return n;
}
async function createTasting(tastingData, photoBlobAndMime /* {blob, mime} | null */) {
  const { itemId, date, rating } = tastingData || {};
  if (!itemId) throw new Error("Tasting requires itemId");
  const safeRating = clampRating(rating);
  const safeDate = date || todayIsoDate();

  let photoId, photoMime;
  if (photoBlobAndMime && photoBlobAndMime.blob) {
    const res = await createPhoto(photoBlobAndMime.blob, photoBlobAndMime.mime || "image/jpeg");
    photoId = res.id;
    photoMime = res.mime;
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  const row = {
    id,
    itemId,
    date: safeDate,
    rating: safeRating,
    wouldRepeat: tastingData.wouldRepeat ?? undefined,
    review: (tastingData.review || "").trim() || undefined,
    photoId,
    photoMime,
    archived: false,
    createdAt: ts,
    updatedAt: ts
  };
  await db.tastings.add(row);
  return row;
}

async function updateTasting(id, patch, photoOp /* {mode:"keep"|"replace"|"remove", blob?, mime?} */) {
  const existing = await db.tastings.get(id);
  if (!existing) throw new Error("Tasting not found");

  const next = { ...existing };

  if (patch.date) next.date = patch.date;
  if (patch.rating !== undefined) next.rating = clampRating(patch.rating);
  next.wouldRepeat = patch.wouldRepeat ?? undefined;
  next.review = (patch.review || "").trim() || undefined;

  // photo ops
  if (photoOp?.mode === "remove") {
    if (next.photoId) await deletePhoto(next.photoId);
    next.photoId = undefined;
    next.photoMime = undefined;
  } else if (photoOp?.mode === "replace") {
    if (next.photoId) await deletePhoto(next.photoId);
    const res = await createPhoto(photoOp.blob, photoOp.mime || "image/jpeg");
    next.photoId = res.id;
    next.photoMime = res.mime;
  }

  next.updatedAt = nowIso();
  await db.tastings.put(next);
  return next;
}

/** Archive / Restore (generic) */
async function archiveEntity(tableName, id) {
  const table = db[tableName];
  if (!table) throw new Error(`Unknown table: ${tableName}`);
  const ts = nowIso();
  await table.update(id, { archived: true, archivedAt: ts, updatedAt: ts });
}
async function restoreEntity(tableName, id) {
  const table = db[tableName];
  if (!table) throw new Error(`Unknown table: ${tableName}`);
  const ts = nowIso();
  await table.update(id, { archived: false, archivedAt: undefined, updatedAt: ts });
}

/** Queries / View models */
async function listDessertTypesActive() {
  return db.dessertTypes.where("archived").equals(false).toArray();
}
async function listPlacesActive() {
  return db.places.where("archived").equals(false).toArray();
}

async function listWishlistActive() {
  const entries = await db.wishlist.where("archived").equals(false).reverse().sortBy("createdAt");
  return enrichWishlistEntries(entries);
}
async function listWishlistArchived() {
  const entries = await db.wishlist.where("archived").equals(true).reverse().sortBy("createdAt");
  return enrichWishlistEntries(entries);
}

async function enrichWishlistEntries(entries) {
  if (!entries.length) return [];
  const itemIds = [...new Set(entries.map(e => e.itemId))];
  const items = (await db.items.bulkGet(itemIds)).filter(Boolean);

  const dessertIds = [...new Set(items.map(i => i.dessertTypeId))];
  const placeIds = [...new Set(items.map(i => i.placeId))];

  const desserts = (await db.dessertTypes.bulkGet(dessertIds)).filter(Boolean);
  const places = (await db.places.bulkGet(placeIds)).filter(Boolean);

  const dessertById = Object.fromEntries(desserts.map(d => [d.id, d]));
  const placeById = Object.fromEntries(places.map(p => [p.id, p]));
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));

  return entries.map(e => {
    const item = itemById[e.itemId];
    const dessert = item ? dessertById[item.dessertTypeId] : null;
    const place = item ? placeById[item.placeId] : null;
    return {
      ...e,
      item,
      dessertName: dessert?.name || "Unknown dessert",
      placeName: place?.name || "Unknown place",
      mapsUrl: place?.mapsUrl
    };
  });
}

async function listRecentTastings(limit = 5) {
  const tastings = await db.tastings.where("archived").equals(false).reverse().sortBy("createdAt");
  const sliced = tastings.slice(0, limit);
  return enrichTastings(sliced);
}

async function enrichTastings(tastings) {
  if (!tastings.length) return [];
  const itemIds = [...new Set(tastings.map(t => t.itemId))];
  const items = (await db.items.bulkGet(itemIds)).filter(Boolean);
  const dessertIds = [...new Set(items.map(i => i.dessertTypeId))];
  const placeIds = [...new Set(items.map(i => i.placeId))];
  const desserts = (await db.dessertTypes.bulkGet(dessertIds)).filter(Boolean);
  const places = (await db.places.bulkGet(placeIds)).filter(Boolean);

  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  const dessertById = Object.fromEntries(desserts.map(d => [d.id, d]));
  const placeById = Object.fromEntries(places.map(p => [p.id, p]));

  return tastings.map(t => {
    const item = itemById[t.itemId];
    const dessert = item ? dessertById[item.dessertTypeId] : null;
    const place = item ? placeById[item.placeId] : null;
    return {
      ...t,
      dessertName: dessert?.name || "Unknown dessert",
      placeName: place?.name || "Unknown place"
    };
  });
}

async function listTriedItemSummariesActive() {
  // Find all unarchived tastings and aggregate by itemId
  const tastings = await db.tastings.where("archived").equals(false).toArray();
  const agg = new Map(); // itemId -> {count,sum}
  for (const t of tastings) {
    const a = agg.get(t.itemId) || { count: 0, sum: 0 };
    a.count += 1;
    a.sum += Number(t.rating) || 0;
    agg.set(t.itemId, a);
  }
  const itemIds = [...agg.keys()];
  if (!itemIds.length) return [];

  const items = (await db.items.bulkGet(itemIds)).filter(Boolean).filter(i => !i.archived);
  const dessertIds = [...new Set(items.map(i => i.dessertTypeId))];
  const placeIds = [...new Set(items.map(i => i.placeId))];

  const desserts = (await db.dessertTypes.bulkGet(dessertIds)).filter(Boolean);
  const places = (await db.places.bulkGet(placeIds)).filter(Boolean);

  const dessertById = Object.fromEntries(desserts.map(d => [d.id, d]));
  const placeById = Object.fromEntries(places.map(p => [p.id, p]));

  return items.map(i => {
    const a = agg.get(i.id) || { count: 0, sum: 0 };
    return {
      itemId: i.id,
      dessertName: dessertById[i.dessertTypeId]?.name || "Unknown dessert",
      placeName: placeById[i.placeId]?.name || "Unknown place",
      count: a.count,
      avg: a.count ? a.sum / a.count : 0
    };
  }).sort((a, b) => b.count - a.count || b.avg - a.avg);
}

async function getItemDetail(itemId) {
  const item = await db.items.get(itemId);
  if (!item) throw new Error("Item not found");

  const dessert = await db.dessertTypes.get(item.dessertTypeId);
  const place = await db.places.get(item.placeId);
  const tastings = await db.tastings.where("itemId").equals(itemId).and(t => !t.archived).toArray();
  tastings.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));

  const count = tastings.length;
  const avg = count ? tastings.reduce((s, t) => s + Number(t.rating || 0), 0) / count : 0;

  return {
    item,
    dessert,
    place,
    tastings,
    stats: { count, avg }
  };
}

async function listArchivedAll() {
  const [dessertTypes, places, items, wishlist, tastings] = await Promise.all([
    db.dessertTypes.where("archived").equals(true).toArray(),
    db.places.where("archived").equals(true).toArray(),
    db.items.where("archived").equals(true).toArray(),
    db.wishlist.where("archived").equals(true).toArray(),
    db.tastings.where("archived").equals(true).toArray()
  ]);

  // Enrich wishlist/tastings with names for display
  const wishlistEnriched = await enrichWishlistEntries(wishlist);
  const tastingsEnriched = await enrichTastings(tastings);

  // Enrich items with names
  const dessertById = Object.fromEntries(dessertTypes.map(d => [d.id, d]));
  const placeById = Object.fromEntries(places.map(p => [p.id, p]));

  // For archived items, we may need active dessert/place too
  const allDesserts = await db.dessertTypes.toArray();
  const allPlaces = await db.places.toArray();
  const allDessertById = Object.fromEntries(allDesserts.map(d => [d.id, d]));
  const allPlaceById = Object.fromEntries(allPlaces.map(p => [p.id, p]));

  const itemsEnriched = items.map(i => ({
    ...i,
    dessertName: allDessertById[i.dessertTypeId]?.name || dessertById[i.dessertTypeId]?.name || "Unknown dessert",
    placeName: allPlaceById[i.placeId]?.name || placeById[i.placeId]?.name || "Unknown place",
  }));

  return { dessertTypes, places, items: itemsEnriched, wishlist: wishlistEnriched, tastings: tastingsEnriched };
}

async function exportBundle() {
  const [dessertTypes, places, items, wishlist, tastings] = await Promise.all([
    db.dessertTypes.toArray(),
    db.places.toArray(),
    db.items.toArray(),
    db.wishlist.toArray(),
    db.tastings.toArray()
  ]);
  const photos = await db.photos.toArray(); // includes blobs; used for ZIP creation
  return { dessertTypes, places, items, wishlist, tastings, photos };
}

// expose
window.DTDB = {
  db,
  nowIso,
  todayIsoDate,
  normalizeName,
  getOrCreateDessertType,
  getOrCreatePlace,
  getOrCreateItem,
  createWishlistEntry,
  updateWishlistEntry,
  createTasting,
  updateTasting,
  archiveEntity,
  restoreEntity,
  listDessertTypesActive,
  listPlacesActive,
  listWishlistActive,
  listWishlistArchived,
  listRecentTastings,
  listTriedItemSummariesActive,
  getItemDetail,
  listArchivedAll,
  exportBundle
};
