export function Pager({ page, pages, onPage, previous = "Previous", next = "Next" }: { page: number; pages: number; onPage: (page: number) => void; previous?: string; next?: string }) {
  return <><button className="desk-btn" type="button" disabled={page === 0} onClick={() => { onPage(page - 1); }}>{previous}</button><span>Page {page + 1} of {pages}</span><button className="desk-btn" type="button" disabled={page + 1 >= pages} onClick={() => { onPage(page + 1); }}>{next}</button></>;
}
