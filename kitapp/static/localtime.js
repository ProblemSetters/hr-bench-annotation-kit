// Shows <time class="local"> in the reader's own timezone. The server's clock may be in another one (UTC under Docker).
document.querySelectorAll('time.local[datetime]').forEach((t) => {
  const d = new Date(t.getAttribute('datetime'));
  if (isNaN(d)) return;
  t.textContent = `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  t.title = d.toString();
});
