/** Line icons on a 20 × 20 grid, drawn with the page's stroke style (styles.css: svg). */
const PATHS = {
  todo: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM7 10.2l2 2 4-4.4",
  inbox: "M3.5 11.5 5.5 5h9l2 6.5V15.5h-13zM3.5 11.5H8l1 2h2l1-2h4.5",
  chat: "M4 5.5h12v8H9l-3.5 3v-3H4z",
  plus: "M10 4.5v11M4.5 10h11",
  clock: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5V10l2.5 1.5",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5 17 17",
  rail: "M3.5 4.5h13v11h-13zM8 4.5v11",
  wide: "M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3",
  narrow: "M4 7h3V4M16 7h-3V4M4 13h3v3M16 13h-3v3",
  panel: "M3.5 4.5h13v11h-13zM12 4.5v11",
  down: "M5 8l5 5 5-5",
  archive: "M4 6h12M5 6v9h10V6M8 9h4",
  close: "M6 6l8 8M14 6l-8 8",
  menu: "M4 6h12M4 10h12M4 14h12",
  code: "M7 6.5 3.5 10 7 13.5M13 6.5l3.5 3.5-3.5 3.5M11.2 4.5l-2.4 11",
  folder: "M3 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.6h6.2A1.5 1.5 0 0 1 17 7.6v6.9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z",
  back: "M12 5l-5 5 5 5",
  check: "M5 10.5l3.2 3.2L15 7",
  model: "M6 6h8v8H6zM8.5 8.5h3v3h-3zM8 3.5V6M12 3.5V6M8 14v2.5M12 14v2.5M3.5 8H6M3.5 12H6M14 8h2.5M14 12h2.5",
  bulb: "M8 15h4M8.5 17.5h3M10 3a5 5 0 0 0-3 9c.6.5 1 1.1 1 1.8V14h4v-.2c0-.7.4-1.3 1-1.8A5 5 0 0 0 10 3",
  gear: "M3.5 6.5h7M14.5 6.5h2M3.5 13.5h2M9.5 13.5h7M12.5 8.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4zM7.5 15.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined}>
      <path d={PATHS[name]} />
    </svg>
  );
}
