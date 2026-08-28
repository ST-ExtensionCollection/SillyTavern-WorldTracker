// WorldTracker — console logging. Every line is tagged [WorldTracker] so it can
// be filtered in devtools.

const TAG = '[WorldTracker]';

export const log = (...args) => console.log(TAG, ...args);
export const warn = (...args) => console.warn(TAG, ...args);
export const error = (...args) => console.error(TAG, ...args);
