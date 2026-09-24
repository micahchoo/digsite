// The report viewer's entry (built alone by vite.viewer.config.ts into one
// script, which a report file carries). It reads the document it finds
// itself in: the data block, the pictures in the <defs>, the claim cards
// and figure 1. Then it puts the live sheet, or the web, where the still
// was. Everything it does is added; the document underneath stays whole,
// and is still what prints.
//
// The app's stylesheets go inside a shadow root, so they style the viewer
// and cannot touch the document; the design tokens are custom properties
// on the document's :root, which a shadow tree inherits.
import { isReportData } from '@digsite/shared';
import { createRoot } from 'react-dom/client';
import boardCss from '../../board/board.css?inline';
import appCss from '../../style.css?inline';
import { type Card, Reader } from './Reader.tsx';
import viewerCss from './viewer.css?inline';

function start() {
  const block = document.getElementById('digsite-report');
  let data: unknown;
  try {
    data = JSON.parse(block?.textContent ?? 'null');
  } catch {
    return;
  }
  if (!isReportData(data)) return;

  const pictures: Record<string, string> = {};
  for (const image of document.querySelectorAll<SVGImageElement>(
    'svg.defs image[data-image-id]',
  )) {
    const id = image.getAttribute('data-image-id');
    const href = image.getAttribute('href');
    if (id && href) pictures[id] = href;
  }

  const cards: Card[] = [];
  for (const article of document.querySelectorAll<HTMLElement>(
    'article.claim[data-key]',
  )) {
    const slot = document.createElement('div');
    slot.className = 'rv-actions';
    const link = article.querySelector('.link');
    article.insertBefore(slot, link);
    cards.push({ key: article.dataset.key ?? '', article, slot });
  }

  // Figure 1: the still of the sheet, or a new figure for the web.
  let figure = document.getElementById('sheet');
  if (!figure) {
    figure = document.createElement('figure');
    figure.className = 'sheet-figure';
    figure.id = 'web';
    const caption = document.createElement('figcaption');
    caption.textContent =
      'Figure 1. The web of this report’s connections, around the pictures they join.';
    figure.append(caption);
    document.getElementById('claims')?.before(figure);
  }
  figure.classList.add('is-live');
  const host = document.createElement('div');
  host.className = 'rv-host';
  figure.prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${appCss}\n${boardCss}\n${viewerCss}`;
  const mount = document.createElement('div');
  mount.className = 'rv-root';
  shadow.append(style, mount);

  createRoot(mount).render(
    <Reader data={data} pictures={pictures} cards={cards} figure={figure} />,
  );
  document.documentElement.dataset.viewer = 'on';
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', start);
else start();
