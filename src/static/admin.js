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
