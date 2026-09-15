// Spaced-repetition state. Step 1 only defines the initial shape; the SM-2
// scheduler itself arrives in step 2. Every card carries srs.rec and srs.prod
// from the moment it is created so that later steps never need a migration.

/** A fresh, never-reviewed SRS state for one direction. */
export function initialState() {
  return {
    state: 'new', // 'new' | 'learning' | 'review' | 'relearning'
    due: null, // ISO string once scheduled
    intervalDays: 0,
    ease: 2.5,
    step: 0,
    reps: 0,
    lapses: 0,
    lastReviewAt: null,
  };
}

/** The srs object stored on every card: one state per direction. */
export function initialSrs() {
  return { rec: initialState(), prod: initialState() };
}
