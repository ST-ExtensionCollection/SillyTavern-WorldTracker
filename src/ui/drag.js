// WorldTracker — draggable / resizable helpers for the floating panel.
// Adapted from StoryMode's controller-panel-drag.js; pointer events (mouse +
// touch), viewport-clamped, persists via an onEnd callback.

/**
 * Make `handle` drag `element`. Calls onEnd({ x, y }) on release.
 * excludeSelector: pointerdown inside a matching element won't start a drag.
 */
export function makeDraggable(element, handle, ns, onEnd, excludeSelector) {
    const el = element && element.nodeType ? element : (element && element[0]);
    const hd = handle && handle.nodeType ? handle : (handle && handle[0]);
    if (!el || !hd) return () => {};

    let startX = 0; let startY = 0; let baseX = 0; let baseY = 0; let dragging = false;

    const onMove = (e) => {
        if (!dragging) return;
        const pt = e.touches ? e.touches[0] : e;
        let x = baseX + (pt.clientX - startX);
        let y = baseY + (pt.clientY - startY);
        x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('wt-dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        if (onEnd) onEnd({ x: el.offsetLeft, y: el.offsetTop });
    };
    const onDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        if (excludeSelector && e.target.closest(excludeSelector)) return;
        if (e.target.closest('button, select, input, a')) return;
        const pt = e.touches ? e.touches[0] : e;
        const r = el.getBoundingClientRect();
        startX = pt.clientX; startY = pt.clientY;
        baseX = r.left; baseY = r.top;
        dragging = true;
        el.classList.add('wt-dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
        e.preventDefault();
    };

    hd.addEventListener('pointerdown', onDown);
    hd.addEventListener('touchstart', onDown, { passive: false });
    hd.style.cursor = 'move';

    return () => {
        hd.removeEventListener('pointerdown', onDown);
        hd.removeEventListener('touchstart', onDown);
        onUp();
    };
}

/**
 * Make the children of `listEl` matching `itemSelector` reorderable by HTML5
 * drag-and-drop, started only from a `handleSelector` grip. Mouse only (no
 * touch). The dragged item is moved live as you drag over its neighbours;
 * `onDrop()` fires once when the drag ends (read the new DOM order there).
 *
 * "Handle only" is done by keeping items non-draggable until a mousedown lands
 * on a grip, then clearing that flag on release — a plain `dragstart` guard
 * can't work because its `event.target` is the draggable item, never the grip.
 *
 * Returns a cleanup function.
 */
function scrollParent(node) {
    let el = node && node.parentElement;
    while (el) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
    }
    return null;
}

export function makeSortable(listEl, { itemSelector, handleSelector, onDrop } = {}) {
    const list = listEl && listEl.nodeType ? listEl : (listEl && listEl[0]);
    if (!list || !itemSelector || !handleSelector) return () => {};

    let dragEl = null;

    const clearArmed = () => {
        for (const el of list.querySelectorAll(`${itemSelector}[draggable="true"]`)) {
            el.removeAttribute('draggable');
        }
    };
    const onMouseDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        const handle = e.target.closest(handleSelector);
        if (!handle || !list.contains(handle)) return;
        const item = handle.closest(itemSelector);
        if (item && list.contains(item)) item.setAttribute('draggable', 'true');
    };
    const onDragStart = (e) => {
        const item = e.target.closest(itemSelector);
        if (!item || !list.contains(item) || item.getAttribute('draggable') !== 'true') return;
        dragEl = item;
        item.classList.add('wt-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', ''); } catch { /* IE guard */ }
        }
    };
    const onDragOver = (e) => {
        if (!dragEl) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const over = e.target.closest(itemSelector);
        if (!over || over === dragEl || !list.contains(over)) return;
        const r = over.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        over.parentNode.insertBefore(dragEl, after ? over.nextSibling : over);
    };
    const finish = () => {
        clearArmed();
        if (!dragEl) return;
        // Ending a native drag inside a scroll container (the settings popup)
        // makes the browser yank the scroll position back to the source — grab
        // the current offset and pin it back after the drop settles.
        const sc = scrollParent(list);
        const scTop = sc ? sc.scrollTop : 0;
        dragEl.classList.remove('wt-dragging');
        dragEl = null;
        if (onDrop) onDrop();
        if (sc) {
            const pin = () => { if (sc.scrollTop !== scTop) sc.scrollTop = scTop; };
            requestAnimationFrame(pin);
            setTimeout(pin, 0);
        }
    };

    list.addEventListener('mousedown', onMouseDown);
    list.addEventListener('mouseup', () => setTimeout(clearArmed, 0));
    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('dragover', onDragOver);
    list.addEventListener('drop', (e) => { e.preventDefault(); finish(); });
    list.addEventListener('dragend', finish);

    return () => {
        list.removeEventListener('mousedown', onMouseDown);
        list.removeEventListener('dragstart', onDragStart);
        list.removeEventListener('dragover', onDragOver);
        list.removeEventListener('dragend', finish);
    };
}

/**
 * Add a bottom-right resize grip to `element`. Calls onEnd({ w, h }) on release.
 */
export function makeResizable(element, ns, onEnd, min = { w: 240, h: 160 }) {
    const el = element && element.nodeType ? element : (element && element[0]);
    if (!el) return () => {};

    const grip = document.createElement('div');
    grip.className = 'wt-resize-grip';
    el.appendChild(grip);

    let startX = 0; let startY = 0; let baseW = 0; let baseH = 0; let sizing = false;

    const onMove = (e) => {
        if (!sizing) return;
        const pt = e.touches ? e.touches[0] : e;
        const w = Math.max(min.w, baseW + (pt.clientX - startX));
        const h = Math.max(min.h, baseH + (pt.clientY - startY));
        el.style.width = `${Math.min(w, window.innerWidth - el.offsetLeft)}px`;
        el.style.height = `${Math.min(h, window.innerHeight - el.offsetTop)}px`;
    };
    const onUp = () => {
        if (!sizing) return;
        sizing = false;
        el.classList.remove('wt-sizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        if (onEnd) onEnd({ w: el.offsetWidth, h: el.offsetHeight });
    };
    const onDown = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX; startY = pt.clientY;
        baseW = el.offsetWidth; baseH = el.offsetHeight;
        sizing = true;
        el.classList.add('wt-sizing');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
        e.preventDefault();
        e.stopPropagation();
    };

    grip.addEventListener('pointerdown', onDown);
    grip.addEventListener('touchstart', onDown, { passive: false });

    return () => {
        grip.removeEventListener('pointerdown', onDown);
        grip.removeEventListener('touchstart', onDown);
        grip.remove();
        onUp();
    };
}
