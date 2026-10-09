// Fixture for story 033's plugin, relay and E2E tests. The tests locate elements by `id`
// and compute expected lines by searching this file, so lines may move freely.
import { useState } from "react";

const ITEMS = Array.from({ length: 25 }, (_, i) => i + 1);

export function Card(props: { id: string; title: string }) {
  return (
    <div id={props.id} className="card">
      <h2>{props.title}</h2>
    </div>
  );
}

export function App() {
  const [clicks, setClicks] = useState(0);
  return (
    <main id="app-main">
      <p id="ready">Fixture app ready</p>
      <button id="save" type="button" aria-label="Save draft" onClick={() => setClicks((n) => n + 1)}>
        Save draft
      </button>
      <span id="clicks">{clicks}</span>
      <section id="cards">
        <Card id="card-a" title="First card" />
        <Card id="card-b" title="Second card" />
      </section>
      <ul id="list">
        {ITEMS.map((n) => (
          <li key={n} id={`item-${n}`}>
            Item {n}
          </li>
        ))}
      </ul>
      <div id="wide">Wide block</div>
    </main>
  );
}
