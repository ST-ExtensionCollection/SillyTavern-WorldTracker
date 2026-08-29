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
