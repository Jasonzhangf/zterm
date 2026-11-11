export function assertGoalStore(store) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('goals service requires a store with read() and update()');
  }
}

export function assertGoalReferenceReader(references) {
  if (
    !references
    || typeof references.hasTicketReference !== 'function'
  ) {
    throw new TypeError('goals service requires a reference reader with hasTicketReference()');
  }
}
