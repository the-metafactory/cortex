import { useEffect, useId, useRef, useState } from "react";
import "./desk-destination-picker.css";

export interface DestinationOption { id: string; label: string }
export function DestinationPicker({ label, value, options, onChange, disabled = false, placeholder = "Choose a destination…", empty = "No destinations available." }: {
  label: string;
  value: string;
  options: DestinationOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  empty?: string;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.id === value);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = Math.max(0, Math.min(active, filtered.length - 1));
  useEffect(() => { if (open && !disabled) list.current?.children[index]?.scrollIntoView({ block: "nearest" }); }, [index, open, disabled, query]);
  const choose = (option: DestinationOption): void => { onChange(option.id); setOpen(false); setQuery(""); };
  const show = (): void => { setOpen(true); setQuery(""); setActive(0); };
  return <div className="desk-destination" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(""); } }}>
    <label htmlFor={id}>{label}</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open && !disabled} aria-controls={`${id}-list`} aria-activedescendant={open && !disabled && filtered[index] ? `${id}-option-${index}` : undefined} aria-invalid={Boolean(value && !selected)} disabled={disabled} value={open ? query : selected?.label ?? (value ? "Destination unavailable — choose again" : "")} placeholder={placeholder} onFocus={show} onClick={() => { if (!open) show(); }} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={event => {
      if (!open && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault(); setOpen(true); setQuery(event.key.length === 1 ? event.key : ""); setActive(0);
      } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(""); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) show();
        else setActive(event.key === "ArrowDown" ? Math.max(0, Math.min(index + 1, filtered.length - 1)) : Math.max(0, index - 1));
      } else if (event.key === "Enter" && open) { event.preventDefault(); const option = filtered[index]; if (option) choose(option); }
    }} />
    {open && !disabled && <div className="desk-destination-menu"><ul ref={list} id={`${id}-list`} role="listbox" aria-label={label}>
      {filtered.map((option, i) => <li key={option.id} id={`${id}-option-${i}`} role="option" aria-selected={value === option.id} className={i === index ? "active" : ""} onMouseDown={event => { event.preventDefault(); }} onMouseMove={() => { setActive(i); }} onClick={() => { choose(option); }}>{option.label}</li>)}
    </ul>{filtered.length === 0 && <p role="status">{options.length ? "No matching destinations." : empty}</p>}</div>}
    {!open && options.length === 0 && <p role="status">{empty}</p>}
    {value && !selected && <p role="alert">This destination is no longer available. Choose another before confirming.</p>}
  </div>;
}
