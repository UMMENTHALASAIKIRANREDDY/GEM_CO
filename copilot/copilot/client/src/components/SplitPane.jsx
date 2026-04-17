import { useCallback, useEffect, useRef, useState } from "react";

export default function SplitPane({ left, right, defaultSplit = 50, minLeft = 25, minRight = 20 }) {
  const containerRef = useRef(null);
  const [split, setSplit] = useState(defaultSplit);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let pct = (x / rect.width) * 100;
    pct = Math.max(minLeft, Math.min(100 - minRight, pct));
    setSplit(pct);
  }, [minLeft, minRight]);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-pane-left" style={{ width: `${split}%` }}>
        {left}
      </div>
      <div className="split-pane-divider" onMouseDown={onMouseDown}>
        <div className="split-pane-handle" />
      </div>
      <div className="split-pane-right" style={{ width: `${100 - split}%` }}>
        {right}
      </div>
    </div>
  );
}
