import { useEffect, useRef, useState } from "react";

function toDateStr(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function parseDateStr(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
}
function formatBR(s: string) {
  const { y, m, d } = parseDateStr(s);
  return `${String(d).padStart(2, "0")}/${String(m + 1).padStart(2, "0")}/${y}`;
}
const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export function DateRangePicker({
  start,
  end,
  maxDate,
  onChange,
}: {
  start: string;
  end: string;
  maxDate?: string;
  onChange: (start: string, end: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState(start);
  const [pendingEnd, setPendingEnd] = useState<string | null>(end);
  const [hovered, setHovered] = useState<string | null>(null);
  const [viewYear, setViewYear] = useState(parseDateStr(end).y);
  const [viewMonth, setViewMonth] = useState(parseDateStr(end).m);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function openPicker() {
    setPendingStart(start);
    setPendingEnd(end);
    const { y, m } = parseDateStr(start);
    setViewYear(y);
    setViewMonth(m);
    setOpen(true);
  }

  function handleDayClick(dateStr: string) {
    if (maxDate && dateStr > maxDate) return;
    if (!pendingEnd) {
      if (dateStr < pendingStart) {
        setPendingEnd(pendingStart);
        setPendingStart(dateStr);
      } else {
        setPendingEnd(dateStr);
      }
      onChange(dateStr < pendingStart ? dateStr : pendingStart, dateStr < pendingStart ? pendingStart : dateStr);
      setOpen(false);
    } else {
      setPendingStart(dateStr);
      setPendingEnd(null);
    }
  }

  function shiftMonth(delta: number) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  }

  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => toDateStr(viewYear, viewMonth, i + 1))];

  const rangeEndForHighlight = pendingEnd ?? hovered;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button type="button" className="date-range-trigger" onClick={() => (open ? setOpen(false) : openPicker())}>
        {formatBR(start)} <span className="date-range-sep">até</span> {formatBR(end)}
      </button>
      {open && (
        <div className="date-range-popover">
          <div className="date-cal-header">
            <button type="button" onClick={() => shiftMonth(-1)}>‹</button>
            <span>{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button type="button" onClick={() => shiftMonth(1)}>›</button>
          </div>
          <div className="date-cal-weekdays">
            {WEEKDAYS.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
          <div className="date-cal-grid">
            {cells.map((dateStr, i) => {
              if (!dateStr) return <span key={i} className="date-cell empty" />;
              const disabled = !!maxDate && dateStr > maxDate;
              const isStart = dateStr === pendingStart;
              const isEnd = !!pendingEnd && dateStr === pendingEnd;
              const inRange = rangeEndForHighlight
                ? dateStr > (pendingStart < rangeEndForHighlight ? pendingStart : rangeEndForHighlight) &&
                  dateStr < (pendingStart < rangeEndForHighlight ? rangeEndForHighlight : pendingStart)
                : false;
              return (
                <button
                  type="button"
                  key={dateStr}
                  className={`date-cell ${isStart || isEnd ? "selected" : ""} ${inRange ? "in-range" : ""} ${disabled ? "disabled" : ""}`}
                  disabled={disabled}
                  onMouseEnter={() => setHovered(dateStr)}
                  onClick={() => handleDayClick(dateStr)}
                >
                  {parseDateStr(dateStr).d}
                </button>
              );
            })}
          </div>
          <div className="date-cal-hint">{pendingEnd ? "Intervalo selecionado" : "Escolha a data final"}</div>
        </div>
      )}
    </div>
  );
}
