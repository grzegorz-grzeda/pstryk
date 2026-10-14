// Asks for confirmation before submitting forms marked with data-confirm.
document.addEventListener('submit', (event) => {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

// Copy buttons: <button data-copy="#element-id">
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const source = document.querySelector(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
});

// Chart tooltips. Marks carry data-tip='{"title": "...", "rows": [{"key", "label", "value"}]}'.
// Shown on hover and keyboard focus; content is set with textContent only.
(() => {
  let tip;
  const ensureTip = () => {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
    return tip;
  };

  const show = (target) => {
    let data;
    try {
      data = JSON.parse(target.dataset.tip);
    } catch {
      return;
    }
    const box = ensureTip();
    box.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = data.title;
    box.append(title);
    for (const row of data.rows ?? []) {
      const line = document.createElement('div');
      line.className = 'tip-row';
      const key = document.createElement('span');
      key.className = `key key-${row.key}`;
      const value = document.createElement('strong');
      value.textContent = String(row.value);
      const label = document.createElement('span');
      label.textContent = row.label;
      line.append(key, value, label);
      box.append(line);
    }
    box.hidden = false;
    const rect = target.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const top = rect.top - height - 8 > 8 ? rect.top - height - 8 : rect.bottom + 8;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  };

  const hide = () => {
    if (tip) tip.hidden = true;
  };

  for (const type of ['pointerover', 'focusin']) {
    document.addEventListener(type, (event) => {
      const target = event.target.closest?.('[data-tip]');
      if (target) show(target);
    });
  }
  for (const type of ['pointerout', 'focusout']) {
    document.addEventListener(type, (event) => {
      if (event.target.closest?.('[data-tip]')) hide();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
})();
