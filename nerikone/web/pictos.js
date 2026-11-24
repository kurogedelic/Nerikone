// Solid pictograms for the modelling commands: one isometric drawing language (24 x 24, 1.5 stroke, the same 30 degree view), drawn in
// currentColor so they take the state colours of the interface. `.fa` is the face that carries the tint, `.mv` the part that moves
// a little on hover (see .pic in style.css). Anything not listed here keeps its Fukiai / Tabler icon.
const S = (body, label) => `<svg class="pic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const PICTO = {
  box: S('<path class="f1" d="M12 3.2 19.6 7.6 12 12 4.4 7.6z"/><path class="f2" d="M4.4 7.6 12 12v8.8L4.4 16.4z"/><path class="f3" d="M19.6 7.6 12 12v8.8l7.6-4.4z"/><path d="M12 3.2 19.6 7.6v8.8L12 20.8l-7.6-4.4V7.6zM12 12v8.8M4.4 7.6 12 12l7.6-4.4"/>'),
  cylinder: S('<path class="f2" d="M5.5 6.5v11c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3v-11c0 1.7-2.9 3-6.5 3s-6.5-1.3-6.5-3z"/><ellipse class="f1" cx="12" cy="6.5" rx="6.5" ry="3"/><path d="M5.5 6.5v11c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3v-11"/>'),
  sphere: S('<circle class="f2" cx="12" cy="12" r="8.2"/><path class="f1" d="M6.2 6.2a8.2 8.2 0 0 1 11.6 0 12 12 0 0 1-11.6 0z" opacity=".9"/><path d="M3.8 12c0 1.8 3.7 3.2 8.2 3.2s8.2-1.4 8.2-3.2" /><path class="mv" d="M12 3.8c-2.6 2.3-2.6 14.1 0 16.4"/>'),
  cone: S('<path class="f2" d="M12 3.4 5 17.4c0 1.7 3.1 3.1 7 3.1s7-1.4 7-3.1z"/><path class="f3" d="M12 3.4 19 17.4c0 1.7-3.1 3.1-7 3.1z"/><path d="M5 17.4c0 1.7 3.1 3.1 7 3.1s7-1.4 7-3.1"/>'),
  torus: S('<ellipse class="f2" cx="12" cy="12" rx="9" ry="5.8"/><path d="M7.4 12.6c1.2 1.3 2.8 2 4.6 2s3.4-.7 4.6-2"/><path d="M8.6 11.6c.9-.8 2.1-1.2 3.4-1.2s2.5.4 3.4 1.2"/>'),
  extrude: S('<path class="f2" d="M5.6 7v5.2L12 15.8v-5.2z"/><path class="f3" d="M18.4 7v5.2L12 15.8v-5.2z"/><path class="f1 up" d="M12 3.4 18.4 7 12 10.6 5.6 7z"/><path d="M5.6 7v5.2L12 15.8l6.4-3.6V7M12 10.6v5.2"/><path d="M12 21v-3.6M9.8 19.2 12 21l2.2-1.8"/>'),
  surface: S('<path class="fa" d="M3.5 15c3-.2 4-4.2 8-4.2s5 4 9 3.8V9.2c-4 .2-5-3.8-9-3.8s-5 4-8 4.2z"/><path d="M3.5 15v2.4c3-.2 4-4.2 8-4.2s5 4 9 3.8V14.6"/>'),
  loft: S('<path class="fa" d="M8 4.2h8l1.2 3H6.8z"/><path d="M6.8 7.2 3.6 18.6h16.8L17.2 7.2M12 7.2v11.4"/>'),
  revolve: S('<path class="fa" d="M12 4v16M12 4c4 0 6 3 6 8s-2 8-6 8"/><path class="mv" d="M18.4 6.6l.4-2.4-2.3.6"/>'),
  sweep: S('<ellipse class="fa" cx="6.2" cy="17.6" rx="2.8" ry="2.8"/><path d="M9 17.6c6 0 4.6-9.8 10.4-9.8"/><path class="mv" d="M17.2 5.6l2.4 2.2-2.4 2.2"/>'),
  union: S('<path class="fa" d="M9.2 5.4a6 6 0 1 0 0 12 6 6 0 0 0 5.6 0 6 6 0 1 0 0-12 6 6 0 0 0-5.6 0z"/>'),
  cut: S('<path class="fa" d="M12.4 6.4a6 6 0 1 0 0 11.2 6 6 0 0 1 0-11.2z"/><circle class="mv" cx="15" cy="12" r="6" stroke-dasharray="2.2 2.2"/>'),
  intersect: S('<circle class="mv" cx="9" cy="12" r="6" stroke-dasharray="2.2 2.2"/><circle cx="15" cy="12" r="6" stroke-dasharray="2.2 2.2"/><path class="fa" d="M12 7.2a6 6 0 0 1 0 9.6 6 6 0 0 1 0-9.6z" stroke-width="1.7"/>'),
  fillet: S('<path class="f2" d="M4 20V10.5A6.5 6.5 0 0 1 10.5 4H20v16z"/><path class="sharp" d="M4 20V4h16" opacity=".55" stroke-dasharray="2 2"/><path d="M4 20V10.5A6.5 6.5 0 0 1 10.5 4H20"/>'),
  chamfer: S('<path class="f2" d="M4 20V9.5L9.5 4H20v16z"/><path class="sharp" d="M4 20V4h16" opacity=".55" stroke-dasharray="2 2"/><path d="M4 20V9.5L9.5 4H20"/>'),
  shell: S('<path class="f2" d="M4.4 7.6 12 12v8.8L4.4 16.4z"/><path class="f3" d="M19.6 7.6 12 12v8.8l7.6-4.4z"/><path class="f1" d="M12 3.2 19.6 7.6 12 12 4.4 7.6z"/><path d="M12 3.2 19.6 7.6v8.8L12 20.8l-7.6-4.4V7.6z"/><path class="hole" d="M12 7 16 9.3 12 11.6 8 9.3z"/>'),
};
