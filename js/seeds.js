// Seed cards: what 'Cargar ejemplos' (Inicio) does with ./seeds/base.json. PURE: no database,
// no DOM, inputs never mutated. The view writes the plan with db.importCards() in ONE transaction.
//
// planSeeds(rows, allCards):
//   - a row whose front + type is not among the live cards becomes a NEW card with the
//     deterministic id 'seed:' + dupKey, so the same seed loaded on two devices is ONE card
//     after a merge (cards merge by id; a random id per device would leave two copies)
//   - a row that already exists as a live card is left alone, with one exception: a card that
//     still shows the seed's example but has no Korean translation (exampleKo) receives the
//     seed's translation (the translations were added to the seed file on 2026-11-08, after
//     the cards had already been loaded on the first devices)
//   - a seed the learner deleted (its 'seed:' id is in the Papelera) is never re-added
//   - rows without a front are counted as invalid
//   - ids, timestamps and srs inside the seed file are ignored (newCard assigns fresh ones)

import { newCard, dupKey } from './db.js';

function text(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * { exampleKo } when the stored card still shows the seed's example without a translation,
 * otherwise null. A translation belongs to its sentence: a card whose example the learner
 * changed never gets the seed's translation.
 */
function translationPatch(existing, seed) {
  if (!seed.exampleKo) return null;
  if (text(existing.exampleKo) !== '') return null;
  if (text(existing.example) === '' || text(existing.example) !== seed.example) return null;
  return { exampleKo: seed.exampleKo };
}

/**
 * @param {object[]} rows      partial cards from the seed file
 * @param {object[]} allCards  every stored card, tombstones included (db.allCardsIncludingDeleted)
 * @returns {{ toAdd: object[], toUpdate: {id: string, patch: object}[],
 *             counts: { added, updated, existing, trashed, invalid } }}
 */
export function planSeeds(rows, allCards) {
  const liveByKey = new Map(); // dupKey -> live card
  const ids = new Set(); // every stored id, deleted cards included
  for (const c of Array.isArray(allCards) ? allCards : []) {
    if (!c || typeof c.id !== 'string') continue;
    ids.add(c.id);
    if (c.deletedAt) continue;
    const key = dupKey(c.front, c.type);
    if (!liveByKey.has(key)) liveByKey.set(key, c);
  }

  const toAdd = [];
  const toUpdate = [];
  const counts = { added: 0, updated: 0, existing: 0, trashed: 0, invalid: 0 };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.front !== 'string' || row.front.trim() === '') {
      counts.invalid += 1;
      continue;
    }
    // Seeds never carry ids/timestamps/srs of another device: newCard assigns fresh ones.
    const { id, createdAt, updatedAt, deletedAt, srs, ...content } = row;
    // Build the card first so the duplicate key uses the same coerced type that newCard
    // stores (an unknown row.type becomes 'otro' on disk).
    const card = newCard(content);
    const key = dupKey(card.front, card.type);

    const existing = liveByKey.get(key);
    if (existing) {
      counts.existing += 1; // also counts a repeated expression inside the seed file
      const patch = translationPatch(existing, card);
      if (patch) {
        toUpdate.push({ id: existing.id, patch });
        counts.updated += 1;
      }
      continue;
    }

    const seedId = 'seed:' + key;
    if (ids.has(seedId)) {
      counts.trashed += 1; // deleted by the learner: the Papelera keeps it, we do not resurrect it
      continue;
    }
    card.id = seedId;
    liveByKey.set(key, card);
    ids.add(seedId);
    toAdd.push(card);
    counts.added += 1;
  }

  return { toAdd, toUpdate, counts };
}
