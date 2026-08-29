// WorldTracker — console logging. Every line is tagged [WorldTracker].
//   log/warn/error : always shown (milestone-level events + problems)
//   vlog           : only when debug logging is enabled in settings

const TAG = '[WorldTracker]';
let verbose = false;

export const setVerbose = (v) => { verbose = !!v; };
export const isVerbose = () => verbose;

export const log = (...args) => console.log(TAG, ...args);
export const vlog = (...args) => { if (verbose) console.log(TAG, ...args); };
export const warn = (...args) => console.warn(TAG, ...args);
export const error = (...args) => console.error(TAG, ...args);
