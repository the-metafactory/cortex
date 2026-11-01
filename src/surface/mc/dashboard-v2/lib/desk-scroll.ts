export function scrollBelowDesk(element: HTMLElement | null): void {
  if (!element) return;
  const headerHeight = document.querySelector(".desk-top")?.getBoundingClientRect().height ?? 0;
  window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - headerHeight - 16 });
  element.focus({ preventScroll: true });
}
