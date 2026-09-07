export const COLLECTIONS = Object.freeze([
  { id: 'tomorrowland_winter', name: 'A Letter from the Universe' },
  { id: 'the_reflection_of_love', name: 'The Reflection of Love' },
  { id: 'tomorrowland_love_unity', name: 'The Symbol of Love and Unity' },
]);
export const TARGETS = [...COLLECTIONS.map(({ id }) => id), 'medallion'];
export const LAMPORTS_PER_SOL = 1_000_000_000;
