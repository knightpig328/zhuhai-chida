(function(){
  const toggle = document.getElementById('toc-toggle');
  const panel = document.getElementById('toc-panel');
  const toc = document.getElementById('toc');
  const scrim = document.getElementById('toc-scrim');
  const narrow = window.matchMedia('(max-width: 1024px)');
  let open = false;
  function setOpen(v) {
    open = v;
    toc.classList.toggle('toc-open', v);
    document.documentElement.classList.toggle('toc-is-open', v);
    toggle.setAttribute('aria-expanded', String(v));
  }
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
  if (scrim) scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });
  panel.addEventListener('click', (e) => {
    // On narrow screens the drawer covers the text, so close it after jumping;
    // on wide screens it sits beside the text and can stay open.
    if (e.target.closest('.toc-item') && narrow.matches) setOpen(false);
  });
  // Scroll spy
  const sections = document.querySelectorAll('.section[id]');
  const links = document.querySelectorAll('.toc-item');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        links.forEach(l => l.classList.remove('toc-active'));
        const active = panel.querySelector('a[href="#'+entry.target.id+'"]');
        if (active) active.classList.add('toc-active');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach(s => observer.observe(s));
})();
