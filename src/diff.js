// WorldTracker — minimal deep JSON diff / patch for the snapshot store.
//
// Paths are arrays of keys (never dot-strings) so character names containing
// "." are safe. Values are plain JSON (objects, arrays, scalars). Arrays are
// compared and stored whole — good enough for the small option lists WorldTracker
// keeps. Nothing here throws.

function isPlainObj(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
}

function clone(x) {
    try { return JSON.parse(JSON.stringify(x)); } catch { return x; }
}

function eq(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; }
}

function walk(path, a, b, ops) {
    for (const k of Object.keys(a || {})) {
        if (!(b && k in b)) ops.del.push([...path, k]);
    }
    for (const k of Object.keys(b || {})) {
        const av = a ? a[k] : undefined;
        const bv = b[k];
        if (isPlainObj(av) && isPlainObj(bv)) {
            walk([...path, k], av, bv, ops);
        } else if (!eq(av, bv)) {
            ops.set.push({ path: [...path, k], value: clone(bv) });
        }
    }
}

/** Forward diff turning `a` into `b`. Returns { set: [{path,value}], del: [[...path]] }. */
export function diffJson(a, b) {
    const ops = { set: [], del: [] };
    if (isPlainObj(a) && isPlainObj(b)) walk([], a, b, ops);
    else ops.set.push({ path: [], value: clone(b) }); // whole replace (shouldn't happen at top)
    return ops;
}

function setAt(root, path, value) {
    if (!path.length) return value; // whole-replace sentinel
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
        const k = path[i];
        if (!isPlainObj(node[k])) node[k] = {};
        node = node[k];
    }
    node[path[path.length - 1]] = value;
    return root;
}

function delAt(root, path) {
    if (!path.length) return;
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
        node = node && node[path[i]];
        if (!isPlainObj(node)) return;
    }
    if (isPlainObj(node)) delete node[path[path.length - 1]];
}

/** Apply a diffJson patch to a deep copy of `base`. Never mutates `base`. */
export function applyJsonPatch(base, patch) {
    let out = clone(base);
    for (const p of (patch && patch.del) || []) delAt(out, p);
    for (const s of (patch && patch.set) || []) out = setAt(out, s.path, clone(s.value));
    return out;
}
